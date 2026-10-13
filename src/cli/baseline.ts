/**
 * Baseline comparison CLI (#85) — are the 12 finding types worth their
 * complexity? The rules only earn their keep if they explain more spend than
 * the trivial "flag whatever is expensive" methods.
 *
 * Method (aggregates only — the corpus never enters the repo, #79):
 *   rules$    = #84 non-overlapping waste $ (kind 'waste', cache residency)
 *   baseline$ = cost of the top ceil(10%) rounds ranked by input-side tokens
 *               (in + cr + cw = contextSize), tie → lower round index — the
 *               naive method explains the WHOLE cost of the rounds it flags
 *   baseline2$= the largest tool results filling the same token volume as the
 *               rules' waste, priced with the same residency rates
 *   rules$InTop = rules $ attributed to top rounds (per-round sources #85: the
 *               round that first billed the claimed tokens; thinking_heavy is
 *               spread over its turn ∝ thinkingTokens)
 *
 * Per session: rules$/cost vs baseline$/cost, rules $ outside top rounds, top
 * money not explained by rules, top rounds without any finding. Corpus: medians
 * and quartiles across sessions, per-type $, paired win/tie/loss with a Wilson
 * 95% CI on P(rules > baseline) — same honesty as the precision report (#81).
 * The report never forces a verdict: below MIN_PRICED_SESSIONS (or a majority
 * excluded) it prints CANNOT ANSWER; a CI straddling 50% prints INCONCLUSIVE.
 *
 * Usage: pnpm corpus:baseline   (reads CORPUS_DIR like corpus:snapshot)
 */

import { parseJsonlFile } from '@main/utils/jsonl';
import * as fs from 'fs';

import {
  buildLedger,
  computeFindings,
  listToolResults,
  roundCostUsd,
  sessionWasteTotals,
} from './analyzeSession';
import { isDirectRun } from './args';
import { listSessionFiles, REPO_ROOT, resolveCorpusDir } from './corpus';
import { wilsonInterval } from './precision';

import type { Finding, FindingType, RoundRow, SessionLedger } from './analyzeSession';
import type { ParsedMessage } from '@main/types';

/** naive baseline share: top 10% of the session's rounds */
export const TOP_FRACTION = 0.1;
/** below this many fully priced sessions the corpus cannot answer the question */
export const MIN_PRICED_SESSIONS = 10;
/** $ difference below which a paired outcome counts as a tie */
const TIE_EPS = 1e-9;

// =============================================================================
// Pure helpers — unit-tested without touching the corpus
// =============================================================================

/** the top share of rounds by input-side tokens; ghosts (contextSize 0) and
 * retry copies (counted in sums, excluded from findings) are never "expensive" */
export function pickTopRounds(rounds: RoundRow[], fraction = TOP_FRACTION): RoundRow[] {
  const billed = rounds.filter((r) => r.contextSize > 0 && r.isRetryCopy !== true);
  const count = Math.min(billed.length, Math.max(1, Math.ceil(billed.length * fraction)));
  return billed
    .toSorted((a, b) => b.contextSize - a.contextSize || a.index - b.index)
    .slice(0, count);
}

/** linear-interpolation quantile (type 7) over a pre-sorted array */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}

export interface ShareStats {
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
}

export function summarize(values: number[]): ShareStats | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return {
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

export interface TypeSpend {
  type: FindingType;
  count: number;
  usd: number;
}

export interface BaselineSession {
  status: 'ok' | 'no-cost' | 'partial-cost' | 'unpriced-waste';
  rounds: number;
  topCount: number;
  costUsd?: number;
  rulesUsd?: number;
  baselineUsd?: number;
  /** rules $ attributed to the top rounds (#85 sources) */
  rulesUsdInTop?: number;
  baseline2Volume?: number;
  baseline2Usd?: number;
  rulesShare?: number;
  baselineShare?: number;
  /** rules $ outside the top rounds, share of rules$ */
  lossOutsideTopShare?: number;
  /** top money the rules do not explain — candidates for new rules */
  topUnexplainedShare?: number;
  /** share of top rounds with no finding at all */
  topWithoutFindingsShare?: number;
  /** per-type $ over priced waste findings (kind 'waste') */
  typeUsd?: TypeSpend[];
}

/** one session's comparison row; non-ok statuses carry counts only — the
 * aggregation reports them as exclusions instead of forcing numbers */
export function baselineSession(
  ledger: SessionLedger,
  findings: Finding[],
  messages: ParsedMessage[]
): BaselineSession {
  const rounds = ledger.rounds;
  const top = pickTopRounds(rounds);
  const head = { rounds: rounds.length, topCount: top.length };
  const wt = sessionWasteTotals(findings, ledger);
  const cost = ledger.totals.costUsd;
  const costPartial = ledger.totals.costPartial === true;
  if (rounds.length === 0 || cost === undefined || cost <= 0) return { status: 'no-cost', ...head };
  if (costPartial) return { status: 'partial-cost', ...head };
  if (wt.tokensWasted > 0 && wt.wastedUsd === undefined)
    return { status: 'unpriced-waste', ...head };

  const rulesUsd = wt.wastedUsd ?? 0; // no waste findings → the rules explain nothing
  const baselineUsd = top.reduce((s, r) => s + (roundCostUsd(r) ?? 0), 0);

  // waste → round attribution from #85 sources; thinking_heavy has no claims
  // and spans its whole turn — spread it ∝ thinkingTokens
  const topIdx = new Set(top.map((r) => r.index));
  const wasteOnRound = new Set<number>();
  const flaggedTurns = new Set<number>();
  const byTurn = new Map<number, RoundRow[]>();
  for (const r of rounds) {
    const list = byTurn.get(r.turnIndex);
    if (list) list.push(r);
    else byTurn.set(r.turnIndex, [r]);
  }
  let rulesUsdInTop = 0;
  const typeMap = new Map<FindingType, TypeSpend>();
  for (const f of findings) {
    if (f.kind === 'waste') {
      if (f.tokensWasted > 0) {
        const t = typeMap.get(f.type) ?? { type: f.type, count: 0, usd: 0 };
        t.count += 1;
        t.usd += f.wastedUsd ?? 0;
        typeMap.set(f.type, t);
      }
      if (f.sources?.length) {
        for (const s of f.sources) {
          wasteOnRound.add(s.round);
          if (s.usd !== undefined && topIdx.has(s.round)) rulesUsdInTop += s.usd;
        }
      } else if (f.type === 'thinking_heavy' && f.wastedUsd && f.turnIndex !== undefined) {
        flaggedTurns.add(f.turnIndex);
        const rs = byTurn.get(f.turnIndex) ?? [];
        const totalThink = rs.reduce((a, r) => a + r.thinkingTokens, 0);
        if (totalThink > 0) {
          for (const r of rs) {
            wasteOnRound.add(r.index);
            if (topIdx.has(r.index)) rulesUsdInTop += (f.wastedUsd * r.thinkingTokens) / totalThink;
          }
        }
      }
    } else if (f.turnIndex !== undefined) {
      flaggedTurns.add(f.turnIndex); // observations flag their turn's rounds
    }
  }

  // baseline2: largest tool results, same volume as the rules' waste
  let baseline2Volume = 0;
  let baseline2Usd = 0;
  if (wt.tokensWasted > 0) {
    const rows = listToolResults(messages, ledger).sort((a, b) => b.tokens - a.tokens);
    for (const row of rows) {
      if (baseline2Volume >= wt.tokensWasted) break;
      baseline2Volume += row.tokens;
      baseline2Usd += row.tokens * (row.usdRate ?? 0);
    }
  }

  const topWithoutFindings = top.filter(
    (r) => !wasteOnRound.has(r.index) && !flaggedTurns.has(r.turnIndex)
  ).length;

  return {
    status: 'ok',
    ...head,
    costUsd: cost,
    rulesUsd,
    baselineUsd,
    rulesUsdInTop,
    baseline2Volume,
    baseline2Usd,
    rulesShare: rulesUsd / cost,
    baselineShare: baselineUsd / cost,
    lossOutsideTopShare: rulesUsd > 0 ? (rulesUsd - rulesUsdInTop) / rulesUsd : 0,
    topUnexplainedShare:
      baselineUsd > 0 ? Math.max(0, baselineUsd - rulesUsdInTop) / baselineUsd : 0,
    topWithoutFindingsShare: top.length > 0 ? topWithoutFindings / top.length : 0,
    typeUsd: [...typeMap.values()],
  };
}

// =============================================================================
// Corpus aggregation — paired stats, Wilson CI, verdicts that can be absent
// =============================================================================

export interface Paired {
  win: number;
  tie: number;
  loss: number;
  /** P(win) over non-tie sessions; null without non-tie pairs */
  p: number | null;
  ci: { lower: number; upper: number } | null;
  verdict: 'rules' | 'baseline' | 'inconclusive';
}

/** paired comparison: rules beat the baseline when they book more $ */
export function pairedVerdict(rules: number, baseline: number): 'win' | 'tie' | 'loss' {
  if (Math.abs(rules - baseline) <= TIE_EPS) return 'tie';
  return rules > baseline ? 'win' : 'loss';
}

function aggregatePaired(
  rows: BaselineSession[],
  a: keyof BaselineSession,
  b: keyof BaselineSession
): Paired {
  let win = 0;
  let tie = 0;
  let loss = 0;
  for (const r of rows) {
    const va = r[a] as number | undefined;
    const vb = r[b] as number | undefined;
    if (va === undefined || vb === undefined) continue;
    const outcome = pairedVerdict(va, vb);
    if (outcome === 'win') win += 1;
    else if (outcome === 'loss') loss += 1;
    else tie += 1;
  }
  const n = win + loss;
  if (n === 0) return { win, tie, loss, p: null, ci: null, verdict: 'inconclusive' };
  const p = win / n;
  const ci = wilsonInterval(win, n);
  const verdict = ci.lower > 0.5 ? 'rules' : ci.upper < 0.5 ? 'baseline' : 'inconclusive';
  return { win, tie, loss, p, ci, verdict };
}

export interface CorpusBaseline {
  sessions: number;
  headline: number;
  excluded: { noCost: number; partialCost: number; unpricedWaste: number };
  /** why the corpus cannot answer the question (null = it can try) */
  cannotAnswer: string | null;
  rules: ShareStats | null;
  baseline: ShareStats | null;
  rulesBaseline: Paired;
  rulesBaseline2: Paired;
  baseline2Meaningful: boolean; // any session had waste volume for baseline2
  lossOutsideTop: ShareStats | null;
  topUnexplained: ShareStats | null;
  topWithoutFindings: ShareStats | null;
  types: TypeSpend[];
}

export function aggregateBaseline(rows: BaselineSession[]): CorpusBaseline {
  const excluded = { noCost: 0, partialCost: 0, unpricedWaste: 0 };
  const ok = rows.filter((r) => {
    if (r.status === 'ok') return true;
    // dashed status → camelCase counter key (the report prints the counts)
    const key =
      r.status === 'no-cost'
        ? 'noCost'
        : r.status === 'partial-cost'
          ? 'partialCost'
          : 'unpricedWaste';
    excluded[key] += 1;
    return false;
  });
  const rules = summarize(ok.map((r) => r.rulesShare ?? 0));
  const baseline = summarize(ok.map((r) => r.baselineShare ?? 0));
  const types = new Map<FindingType, TypeSpend>();
  for (const r of ok) {
    for (const t of r.typeUsd ?? []) {
      const acc = types.get(t.type) ?? { type: t.type, count: 0, usd: 0 };
      acc.count += t.count;
      acc.usd += t.usd;
      types.set(t.type, acc);
    }
  }
  let cannotAnswer: string | null = null;
  if (ok.length === 0) cannotAnswer = 'no fully priced sessions';
  else if (ok.length < MIN_PRICED_SESSIONS)
    cannotAnswer = `only ${ok.length} fully priced session(s), need ≥ ${MIN_PRICED_SESSIONS}`;
  else if (ok.length < rows.length / 2)
    cannotAnswer = `majority excluded (${rows.length - ok.length} of ${rows.length} sessions)`;
  return {
    sessions: rows.length,
    headline: ok.length,
    excluded,
    cannotAnswer,
    rules,
    baseline,
    rulesBaseline: aggregatePaired(ok, 'rulesUsd', 'baselineUsd'),
    rulesBaseline2: aggregatePaired(ok, 'rulesUsd', 'baseline2Usd'),
    baseline2Meaningful: ok.some((r) => (r.baseline2Volume ?? 0) > 0),
    lossOutsideTop: summarize(ok.map((r) => r.lossOutsideTopShare ?? 0)),
    topUnexplained: summarize(ok.map((r) => r.topUnexplainedShare ?? 0)),
    topWithoutFindings: summarize(ok.map((r) => r.topWithoutFindingsShare ?? 0)),
    types: [...types.values()].sort((a, b) => b.usd - a.usd),
  };
}

// =============================================================================
// Output
// =============================================================================

const pct = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`;

function printStats(name: string, s: ShareStats | null): void {
  if (!s) {
    console.log(`  ${name}: (no data)`);
    return;
  }
  console.log(
    `  ${name.padEnd(22)} median ${pct(s.median).padStart(7)}  p25 ${pct(s.p25).padStart(7)}  p75 ${pct(s.p75).padStart(7)}  min ${pct(s.min).padStart(7)}  max ${pct(s.max).padStart(7)}`
  );
}

function printPaired(name: string, p: Paired): void {
  console.log(
    `paired ${name}: ${p.win} rules-win / ${p.tie} tie / ${p.loss} baseline-win` +
      (p.p === null || p.ci === null
        ? ''
        : ` — P(rules > baseline) = ${pct(p.p)} (95% Wilson CI ${pct(p.ci.lower)}–${pct(p.ci.upper)}) over ${p.win + p.loss} non-tie`)
  );
  console.log(`  VERDICT: ${p.verdict.toUpperCase()}`);
}

function printReport(agg: CorpusBaseline): void {
  console.log(
    `baseline report (#85) — the 12 finding types' waste $ vs naive baselines, top = ${TOP_FRACTION * 100}% of rounds by input-side tokens`
  );
  console.log(
    `corpus: ${agg.sessions} session(s), headline = ${agg.headline} fully priced; excluded: ` +
      `${agg.excluded.noCost} no-cost, ${agg.excluded.partialCost} partial-cost, ${agg.excluded.unpricedWaste} unpriced-waste`
  );
  if (agg.cannotAnswer) {
    console.log(`CANNOT ANSWER: ${agg.cannotAnswer} — numbers below are descriptive only`);
  }
  console.log('per-session share of session cost $:');
  printStats('rules (waste $)', agg.rules);
  printStats('baseline (top 10%)', agg.baseline);
  printPaired('rules vs top-10%', agg.rulesBaseline);
  if (agg.baseline2Meaningful) {
    printPaired('rules vs largest-results', agg.rulesBaseline2);
  }
  console.log('overlap with the top rounds:');
  printStats('rules $ outside top', agg.lossOutsideTop);
  printStats('top $ not explained', agg.topUnexplained);
  printStats('top rounds w/o finding', agg.topWithoutFindings);
  if (agg.types.length > 0) {
    const total = agg.types.reduce((s, t) => s + t.usd, 0);
    console.log(`waste $ by type (${agg.headline} headline sessions, total $${total.toFixed(2)}):`);
    for (const t of agg.types) {
      console.log(
        `  ${t.type.padEnd(20)} ${String(t.count).padStart(4)} findings  $${t.usd.toFixed(4).padStart(10)}  ${pct(total > 0 ? t.usd / total : 0).padStart(6)} of rules $`
      );
    }
  }
}

// =============================================================================
// CLI plumbing
// =============================================================================

async function main(): Promise<void> {
  const corpusDir = resolveCorpusDir(process.env, REPO_ROOT);
  if (!corpusDir) {
    console.error(
      'CORPUS_DIR is not set — copy .env.example to .env and point CORPUS_DIR at a local dir with session .jsonl files. The corpus never enters the repo.'
    );
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(corpusDir)) {
    console.error(`CORPUS_DIR does not exist: ${corpusDir}`);
    process.exitCode = 1;
    return;
  }
  // parsed messages stay transient (one session at a time) — only the numeric
  // rows accumulate
  const sessionFiles = listSessionFiles(corpusDir);
  if (sessionFiles.length === 0) {
    console.error(`no .jsonl sessions found in CORPUS_DIR: ${corpusDir}`);
    process.exitCode = 1;
    return;
  }
  const rows: BaselineSession[] = [];
  for (const file of sessionFiles) {
    const messages = await parseJsonlFile(file);
    const ledger = buildLedger(messages);
    const findings = computeFindings(messages, ledger, undefined, undefined, true);
    rows.push(baselineSession(ledger, findings, messages));
  }
  printReport(aggregateBaseline(rows));
}

// run only when executed directly — vitest imports the pure helpers
if (isDirectRun(import.meta.url)) {
  void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
