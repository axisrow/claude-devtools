/**
 * spend:compare (#86) — before/after spend comparison over the regression
 * corpus: the «did the behaviour change actually reduce spend» test (#78).
 *
 * Two disjoint session sets from the corpus (CORPUS_DIR, see corpus.ts):
 *   --before SPEC / --after SPEC   SPEC = DATE | DATE..DATE (local day bounds;
 *                                  a session belongs to a set when its LAST
 *                                  billed round falls in the window — the same
 *                                  last-activity heuristic as session-inventory)
 *   --before-list F / --after-list F
 *                                  text file, one 16-hex session hash per line
 *                                  (same hashes as corpus-snapshots/, #79);
 *                                  '#' comments and blank lines are skipped
 * A session matching both sets (overlapping windows, or a listed hash inside
 * the other window) is excluded from both and counted — disjoint sets are
 * what make the comparison mean anything.
 *
 * Per turn (ledger turnIndex), the #74 golden family of totals:
 *   costUsd     — Σ roundCostUsd over the turn's rounds; turns holding a
 *                 round with no price row are excluded from cost metrics
 *   inputSide   — input + cacheRead + cacheWrite (pricing-immune token currency)
 *   wasteShare  — Σ finding wastedUsd / turn cost (#82/#84)
 *   per finding type — frequency (share of turns with ≥1 finding) and
 *                 tokensWasted per turn
 *
 * Statistics per metric: medians of both sets, bootstrap 95% CI of the median
 * difference (percentile method, seeded mulberry32 — same seed, same CI) and a
 * two-sided Mann–Whitney p (normal approximation, tie- and continuity-corrected).
 *
 * Confounders surfaced (#86): each turn is attributed to its dominant model
 * (most billed tokens) and compared per model; model-mix, overlapping-period
 * and small-sample (< MIN_TURNS_FOR_STABLE turns) mismatches are flagged.
 * Costs come from the repo's static pricing table — historical price changes
 * are not reflected; turn inputSide is the pricing-immune companion.
 *
 * Prints aggregates only; corpus content never enters the output (#79).
 *
 * Usage: pnpm spend:compare -- --before 2026-09-01..2026-09-14 --after 2026-09-15 [--json]
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  type Finding,
  type FindingType,
  pad,
  padL,
  roundCostUsd,
  type RoundRow,
  type SessionLedger,
} from './analyzeSession';
import { inDateRange, isDirectRun, parseDayBound, takeFlagValue, wantsHelp } from './args';
import { computeCorpus, hashSessionId, REPO_ROOT, resolveCorpusDir } from './corpus';
import { mulberry32 } from './precision';

import type { ComputedSession } from './corpus';

export const DEFAULT_SEED = 86;
export const DEFAULT_BOOTSTRAP_ROUNDS = 2000;
/** below this many turns per set, medians/CI/p are flagged as unstable */
export const MIN_TURNS_FOR_STABLE = 30;
/** warn when a dominant model's turn share differs by more than this between sets */
export const MODEL_MIX_SHARE_PTS = 0.05;

// =============================================================================
// Pure helpers — unit-tested without touching the corpus
// =============================================================================

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface CiInterval {
  lower: number;
  upper: number;
}

/** Percentile bootstrap of median(after) − median(before). Fixed seed → the
 * same interval to the last digit (#86 acceptance). Null on an empty side. */
export function bootstrapMedianDiff(
  before: number[],
  after: number[],
  seed = DEFAULT_SEED,
  rounds = DEFAULT_BOOTSTRAP_ROUNDS
): CiInterval | null {
  if (before.length === 0 || after.length === 0 || rounds <= 0) return null;
  const rnd = mulberry32(seed);
  const diffs: number[] = [];
  for (let i = 0; i < rounds; i += 1) {
    const b = median(before.map(() => before[Math.floor(rnd() * before.length)])) ?? 0;
    const a = median(after.map(() => after[Math.floor(rnd() * after.length)])) ?? 0;
    diffs.push(a - b);
  }
  diffs.sort((x, y) => x - y);
  return { lower: diffs[Math.floor(0.025 * rounds)], upper: diffs[Math.ceil(0.975 * rounds) - 1] };
}

// Abramowitz–Stegun 7.1.26 — |error| < 1.5e-7, ample for a p-value column
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

const normalCdf = (z: number): number => 0.5 * (1 + erf(z / Math.SQRT2));

/** Two-sided Mann–Whitney p, normal approximation with tie and continuity
 * corrections. Null on an empty side; 1 when every value ties. */
export function mannWhitneyP(before: number[], after: number[]): number | null {
  const n1 = before.length;
  const n2 = after.length;
  if (n1 === 0 || n2 === 0) return null;
  const tagged = [
    ...before.map((v) => ({ v, inBefore: true })),
    ...after.map((v) => ({ v, inBefore: false })),
  ].sort((x, y) => x.v - y.v);
  let rankSumBefore = 0;
  let tieTerm = 0;
  let i = 0;
  while (i < tagged.length) {
    let j = i;
    while (j + 1 < tagged.length && tagged[j + 1].v === tagged[i].v) j += 1;
    const t = j - i + 1;
    const avgRank = (i + j + 2) / 2; // 1-based ranks i+1..j+1, averaged for ties
    for (let k = i; k <= j; k += 1) if (tagged[k].inBefore) rankSumBefore += avgRank;
    if (t > 1) tieTerm += t * t * t - t;
    i = j + 1;
  }
  const n = n1 + n2;
  const u = rankSumBefore - (n1 * (n1 + 1)) / 2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1))));
  if (sigma === 0) return 1; // everything tied — no evidence of a difference
  const d = u - (n1 * n2) / 2;
  const z = (d - Math.sign(d) * 0.5) / sigma;
  return Math.min(1, Math.max(0, 2 * (1 - normalCdf(Math.abs(z)))));
}

/** One comparison row: medians, their difference, bootstrap CI, Mann–Whitney. */
export interface MetricStat {
  nBefore: number;
  nAfter: number;
  medianBefore: number | null;
  medianAfter: number | null;
  /** median(after) − median(before) */
  delta: number | null;
  ci: CiInterval | null;
  /** two-sided Mann–Whitney */
  p: number | null;
}

export function compareValues(
  before: number[],
  after: number[],
  seed: number,
  rounds: number
): MetricStat {
  const mb = median(before);
  const ma = median(after);
  return {
    nBefore: before.length,
    nAfter: after.length,
    medianBefore: mb,
    medianAfter: ma,
    delta: mb !== null && ma !== null ? ma - mb : null,
    ci: bootstrapMedianDiff(before, after, seed, rounds),
    p: mannWhitneyP(before, after),
  };
}

// =============================================================================
// Turn samples — one row per ledger turn, the unit of every distribution
// =============================================================================

export interface TurnSample {
  turnIndex: number;
  /** dominant model: most billed tokens in the turn (lexicographic tie-break) */
  model: string;
  /** more than one model billed tokens in the turn */
  mixedModels: boolean;
  /** Σ roundCostUsd over the turn's rounds; null when any round has no price row */
  costUsd: number | null;
  /** input + cacheRead + cacheWrite — the pricing-immune token currency */
  inputSide: number;
  /** Σ finding wastedUsd in the turn (0 when nothing priced) */
  wasteUsd: number;
  /** tokensWasted per finding type in the turn */
  typeTokens: Map<FindingType, number>;
  /** types with ≥1 finding in the turn (frequency source) */
  typeTurns: Set<FindingType>;
}

export interface TurnSamplesResult {
  turns: TurnSample[];
  /** findings without a turnIndex — outside per-turn stats */
  unattributedFindings: number;
}

/** Per-turn metrics from the ledger + findings — the same allocation the
 * corpus snapshots and session:sums already validated (#79, #84). */
export function turnSamples(ledger: SessionLedger, findings: Finding[]): TurnSamplesResult {
  const wasteByTurn = new Map<number, number>();
  const tokensByTurn = new Map<number, Map<FindingType, number>>();
  const presenceByTurn = new Map<number, Set<FindingType>>();
  let unattributed = 0;
  for (const f of findings) {
    if (f.turnIndex === undefined) {
      unattributed += 1;
      continue;
    }
    if (f.wastedUsd !== undefined) {
      wasteByTurn.set(f.turnIndex, (wasteByTurn.get(f.turnIndex) ?? 0) + f.wastedUsd);
    }
    let tokens = tokensByTurn.get(f.turnIndex);
    if (!tokens) {
      tokens = new Map<FindingType, number>();
      tokensByTurn.set(f.turnIndex, tokens);
    }
    tokens.set(f.type, (tokens.get(f.type) ?? 0) + f.tokensWasted);
    let present = presenceByTurn.get(f.turnIndex);
    if (!present) {
      present = new Set<FindingType>();
      presenceByTurn.set(f.turnIndex, present);
    }
    present.add(f.type);
  }

  const byTurn = new Map<number, RoundRow[]>();
  for (const r of ledger.rounds) {
    const list = byTurn.get(r.turnIndex);
    if (list) list.push(r);
    else byTurn.set(r.turnIndex, [r]);
  }

  const turns: TurnSample[] = [];
  for (const [turnIndex, rounds] of byTurn) {
    let costUsd = 0;
    let priced = true;
    let inputSide = 0;
    const billedByModel = new Map<string, number>();
    for (const r of rounds) {
      const roundInputSide = r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens;
      inputSide += roundInputSide;
      const billed = roundInputSide + r.outputTokens;
      billedByModel.set(r.model, (billedByModel.get(r.model) ?? 0) + billed);
      const c = roundCostUsd(r);
      if (c === null) priced = false;
      else costUsd += c;
    }
    // dominant model = most billed tokens; lexicographic tie-break keeps it stable
    let model = '';
    let modelBilled = -1;
    for (const [m, b] of billedByModel) {
      if (b > modelBilled || (b === modelBilled && m < model)) {
        model = m;
        modelBilled = b;
      }
    }
    turns.push({
      turnIndex,
      model,
      mixedModels: billedByModel.size > 1,
      costUsd: priced ? costUsd : null,
      inputSide,
      wasteUsd: wasteByTurn.get(turnIndex) ?? 0,
      typeTokens: tokensByTurn.get(turnIndex) ?? new Map<FindingType, number>(),
      typeTurns: presenceByTurn.get(turnIndex) ?? new Set<FindingType>(),
    });
  }
  return { turns, unattributedFindings: unattributed };
}

// =============================================================================
// Comparison
// =============================================================================

export interface SampleSet {
  source: string;
  /** sessions that contributed at least one turn */
  sessions: number;
  turns: TurnSample[];
  unattributedFindings: number;
}

export interface SideSummary {
  source: string;
  sessions: number;
  turns: number;
  /** turns excluded from cost/wasteShare metrics (a round has no price row) */
  unpricedTurns: number;
  mixedModelTurns: number;
  /** dominant-model turn counts */
  models: Record<string, number>;
  unattributedFindings: number;
}

export interface TypeStat {
  /** share of the set's turns with ≥1 finding of the type */
  freqBefore: number;
  freqAfter: number;
  /** Mann–Whitney on the per-turn 0/1 indicators */
  freqP: number | null;
  tokensPerTurn: MetricStat;
}

export interface ModelStat {
  turnsBefore: number;
  turnsAfter: number;
  turnCostUsd: MetricStat;
  turnInputSide: MetricStat;
  turnWasteShare: MetricStat;
}

export interface CompareReport {
  before: SideSummary;
  after: SideSummary;
  metrics: {
    turnCostUsd: MetricStat;
    turnInputSide: MetricStat;
    turnWasteShare: MetricStat;
  };
  findingTypes: Record<string, TypeStat>;
  byModel: Record<string, ModelStat>;
  warnings: string[];
  params: { seed: number; bootstrapRounds: number };
}

const costValues = (ts: TurnSample[]): number[] =>
  ts.filter((t) => t.costUsd !== null).map((t) => t.costUsd!);
const shareValues = (ts: TurnSample[]): number[] =>
  ts.filter((t) => t.costUsd !== null && t.costUsd > 0).map((t) => t.wasteUsd / t.costUsd!);

function sideSummary(set: SampleSet): SideSummary {
  const models: Record<string, number> = {};
  let unpriced = 0;
  let mixed = 0;
  for (const t of set.turns) {
    models[t.model] = (models[t.model] ?? 0) + 1;
    if (t.costUsd === null) unpriced += 1;
    if (t.mixedModels) mixed += 1;
  }
  return {
    source: set.source,
    sessions: set.sessions,
    turns: set.turns.length,
    unpricedTurns: unpriced,
    mixedModelTurns: mixed,
    models,
    unattributedFindings: set.unattributedFindings,
  };
}

export function compareTurnSets(
  before: SampleSet,
  after: SampleSet,
  opts: { seed: number; bootstrapRounds: number }
): CompareReport {
  const { seed, bootstrapRounds } = opts;
  const cmp = (b: number[], a: number[]): MetricStat => compareValues(b, a, seed, bootstrapRounds);
  const beforeSummary = sideSummary(before);
  const afterSummary = sideSummary(after);

  const metrics = {
    turnCostUsd: cmp(costValues(before.turns), costValues(after.turns)),
    turnInputSide: cmp(
      before.turns.map((t) => t.inputSide),
      after.turns.map((t) => t.inputSide)
    ),
    turnWasteShare: cmp(shareValues(before.turns), shareValues(after.turns)),
  };

  // finding types present in either set, sorted for stable output
  const typeSet = new Set<FindingType>();
  for (const t of [...before.turns, ...after.turns]) for (const ty of t.typeTurns) typeSet.add(ty);
  const findingTypes: Record<string, TypeStat> = {};
  for (const ty of [...typeSet].sort((a, b) => a.localeCompare(b))) {
    const tokens = (ts: TurnSample[]): number[] => ts.map((t) => t.typeTokens.get(ty) ?? 0);
    const indicators = (ts: TurnSample[]): number[] => ts.map((t) => (t.typeTurns.has(ty) ? 1 : 0));
    const indB = indicators(before.turns);
    const indA = indicators(after.turns);
    findingTypes[ty] = {
      freqBefore:
        before.turns.length > 0 ? indB.filter((v) => v === 1).length / before.turns.length : 0,
      freqAfter:
        after.turns.length > 0 ? indA.filter((v) => v === 1).length / after.turns.length : 0,
      freqP: mannWhitneyP(indB, indA),
      tokensPerTurn: cmp(tokens(before.turns), tokens(after.turns)),
    };
  }

  // per dominant model — the «compare within one model» confounder control (#86)
  const modelSet = new Set<string>([
    ...Object.keys(beforeSummary.models),
    ...Object.keys(afterSummary.models),
  ]);
  const byModel: Record<string, ModelStat> = {};
  const modelNames = [...modelSet].sort((a, b) => a.localeCompare(b));
  for (const m of modelNames) {
    const b = before.turns.filter((t) => t.model === m);
    const a = after.turns.filter((t) => t.model === m);
    byModel[m] = {
      turnsBefore: b.length,
      turnsAfter: a.length,
      turnCostUsd: cmp(costValues(b), costValues(a)),
      turnInputSide: cmp(
        b.map((t) => t.inputSide),
        a.map((t) => t.inputSide)
      ),
      turnWasteShare: cmp(shareValues(b), shareValues(a)),
    };
  }

  const warnings: string[] = [];
  if (before.turns.length < MIN_TURNS_FOR_STABLE || after.turns.length < MIN_TURNS_FOR_STABLE) {
    warnings.push(
      `small sample: ${before.turns.length}/${after.turns.length} turns (< ${MIN_TURNS_FOR_STABLE}) — medians, CI and p are unstable`
    );
  }
  const mixParts: string[] = [];
  for (const m of modelNames) {
    const sb = before.turns.length > 0 ? (beforeSummary.models[m] ?? 0) / before.turns.length : 0;
    const sa = after.turns.length > 0 ? (afterSummary.models[m] ?? 0) / after.turns.length : 0;
    if (Math.abs(sb - sa) > MODEL_MIX_SHARE_PTS) {
      mixParts.push(`${m} ${(sb * 100).toFixed(0)}%→${(sa * 100).toFixed(0)}%`);
    }
  }
  if (mixParts.length > 0) {
    warnings.push(
      `model mix differs: ${mixParts.join(', ')} — prices differ per model, compare within model (byModel section)`
    );
  }
  const unpriced = beforeSummary.unpricedTurns + afterSummary.unpricedTurns;
  if (unpriced > 0) {
    warnings.push(
      `${unpriced} turn(s) excluded from cost/wasteShare metrics — a round has no price row`
    );
  }
  const unattributed = before.unattributedFindings + after.unattributedFindings;
  if (unattributed > 0) {
    warnings.push(`${unattributed} finding(s) without a turn excluded from per-turn stats`);
  }

  return {
    before: beforeSummary,
    after: afterSummary,
    metrics,
    findingTypes,
    byModel,
    warnings,
    params: { seed, bootstrapRounds },
  };
}

// =============================================================================
// Set specs and assignment
// =============================================================================

export type SetSpec =
  | { kind: 'period'; since: Date; until: Date; source: string }
  | { kind: 'list'; hashes: Set<string>; source: string };

/** DATE | DATE..DATE → local day bounds (parseDayBound); null when malformed */
export function parsePeriodSpec(s: string): SetSpec | null {
  const sep = s.indexOf('..');
  if (sep !== -1) {
    const since = parseDayBound(s.slice(0, sep), false);
    const until = parseDayBound(s.slice(sep + 2), true);
    return since && until ? { kind: 'period', since, until, source: s } : null;
  }
  const since = parseDayBound(s, false);
  const until = parseDayBound(s, true);
  return since && until ? { kind: 'period', since, until, source: s } : null;
}

/** list file: one 16-hex session hash per line; '#' comments and blanks skipped */
export function readHashList(file: string): string[] {
  const hashes: string[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const v = line.trim();
    if (v === '' || v.startsWith('#')) continue;
    if (!/^[0-9a-f]{16}$/.test(v)) {
      throw new Error(`list ${file}: not a 16-hex session hash: '${v}'`);
    }
    hashes.push(v);
  }
  return hashes;
}

export interface AssignmentResult {
  before: ComputedSession[];
  after: ComputedSession[];
  unused: number;
  /** matched both sets (overlapping windows / listed hash inside the other window) */
  ambiguous: number;
}

/** a session's date = its LAST billed round's timestamp — the inventory's
 * last-activity heuristic, restricted to the data the ledger actually bills */
function lastRoundTs(ledger: SessionLedger): Date | null {
  let max: number | null = null;
  for (const r of ledger.rounds) {
    const t = r.timestamp.getTime();
    if (max === null || t > max) max = t;
  }
  return max === null ? null : new Date(max);
}

/** each session lands in at most one set; matching both drops it from both */
export function assignSets(
  sessions: ComputedSession[],
  corpusDir: string,
  before: SetSpec,
  after: SetSpec
): AssignmentResult {
  const matches = (s: ComputedSession, spec: SetSpec): boolean => {
    if (spec.kind === 'list') {
      return spec.hashes.has(hashSessionId(path.relative(corpusDir, s.file)));
    }
    const ts = lastRoundTs(s.ledger);
    return ts !== null && inDateRange(ts, spec.since, spec.until);
  };
  const out: AssignmentResult = { before: [], after: [], unused: 0, ambiguous: 0 };
  for (const s of sessions) {
    const inB = matches(s, before);
    const inA = matches(s, after);
    if (inB && inA) out.ambiguous += 1;
    else if (inB) out.before.push(s);
    else if (inA) out.after.push(s);
    else out.unused += 1;
  }
  return out;
}

// =============================================================================
// Rendering
// =============================================================================

const fmtUsd = (v: number): string => v.toFixed(4);
const fmtTok = (v: number): string => Math.round(v).toLocaleString('en-US');
const fmtPct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const fmtP = (v: number | null): string =>
  v === null ? '—' : v < 0.0001 ? '<0.0001' : v.toFixed(4);
const fmtSigned = (v: number, fmt: (x: number) => string): string =>
  v >= 0 ? `+${fmt(v)}` : fmt(v);

function statRow(label: string, stat: MetricStat, fmt: (v: number) => string): string {
  const mb = stat.medianBefore === null ? '—' : fmt(stat.medianBefore);
  const ma = stat.medianAfter === null ? '—' : fmt(stat.medianAfter);
  const d = stat.delta === null ? '—' : fmtSigned(stat.delta, fmt);
  const ci = stat.ci ? `[${fmt(stat.ci.lower)}, ${fmt(stat.ci.upper)}]` : '—';
  return (
    pad(label, 22) +
    mb.padStart(12) +
    ma.padStart(12) +
    d.padStart(12) +
    ('  ' + ci).padEnd(30) +
    fmtP(stat.p).padStart(9) +
    `  ${stat.nBefore}/${stat.nAfter}`
  );
}

const MODEL_COL = 28;

export function renderReport(report: CompareReport): string {
  const lines: string[] = [];
  lines.push('spend:compare (#86) — corpus aggregates only');
  const side = (label: string, s: SideSummary): string => {
    let out = `  ${label}: ${s.source} — ${s.sessions} session(s), ${s.turns} turns`;
    if (s.unpricedTurns > 0) out += ` (${s.unpricedTurns} unpriced)`;
    if (s.mixedModelTurns > 0) out += ` (${s.mixedModelTurns} mixed-model)`;
    return out;
  };
  lines.push(side('before', report.before));
  lines.push(side('after ', report.after));
  lines.push(
    `  bootstrap 95% CI of the median difference (seed=${report.params.seed}, rounds=${report.params.bootstrapRounds}); p — two-sided Mann–Whitney`
  );
  lines.push('');
  lines.push(
    `${pad('metric', 22)}${padL('median(b)', 12)}${padL('median(a)', 12)}${padL('delta', 12)}  ${pad('95% CI of delta', 28)}${padL('p', 9)}  n(b/a)`
  );
  lines.push(statRow('turn cost USD', report.metrics.turnCostUsd, fmtUsd));
  lines.push(statRow('turn inputSide tok', report.metrics.turnInputSide, fmtTok));
  lines.push(statRow('turn wasteShare', report.metrics.turnWasteShare, fmtPct));

  const types = Object.entries(report.findingTypes);
  if (types.length > 0) {
    lines.push('');
    lines.push(
      `${pad('finding type', 20)}${padL('freq(b)', 9)}${padL('freq(a)', 9)}${padL('Δpp', 7)}${padL('p(freq)', 9)}  tokens/turn per type:`
    );
    for (const [ty, ts] of types) {
      const pp =
        ts.tokensPerTurn.medianBefore !== null || ts.tokensPerTurn.medianAfter !== null
          ? fmtSigned((ts.freqAfter - ts.freqBefore) * 100, (v) => v.toFixed(1))
          : '—';
      lines.push(
        pad(ty, 20) +
          padL(fmtPct(ts.freqBefore), 9) +
          padL(fmtPct(ts.freqAfter), 9) +
          padL(pp, 7) +
          padL(fmtP(ts.freqP), 9)
      );
    }
    lines.push('');
    lines.push(
      `${pad('finding type', 22)}${padL('median(b)', 12)}${padL('median(a)', 12)}${padL('delta', 12)}  ${pad('95% CI of delta', 28)}${padL('p', 9)}  n(b/a)`
    );
    for (const [ty, ts] of types) {
      lines.push(statRow(ty, ts.tokensPerTurn, fmtTok));
    }
  }

  const modelEntries = Object.entries(report.byModel);
  if (modelEntries.length > 0) {
    lines.push('');
    lines.push('by dominant model — b/a turns, cost USD med(b)→med(a) [95% CI] p:');
    for (const [m, ms] of modelEntries) {
      const cost = ms.turnCostUsd;
      const mb = cost.medianBefore === null ? '—' : fmtUsd(cost.medianBefore);
      const ma = cost.medianAfter === null ? '—' : fmtUsd(cost.medianAfter);
      const ci = cost.ci ? ` [${fmtUsd(cost.ci.lower)}, ${fmtUsd(cost.ci.upper)}]` : '';
      const turns = `${ms.turnsBefore}/${ms.turnsAfter}`.padStart(9);
      lines.push(`  ${pad(m, MODEL_COL)}${turns}   ${mb}→${ma}${ci}  p ${fmtP(cost.p)}`);
    }
  }

  if (report.warnings.length > 0) {
    lines.push('');
    for (const w of report.warnings) lines.push(`WARNING: ${w}`);
  }
  lines.push(
    "note: costs use the repo's static pricing table — historical price changes are not reflected; turn inputSide is pricing-immune"
  );
  return lines.join('\n');
}

// =============================================================================
// CLI
// =============================================================================

const USAGE = [
  'usage: pnpm spend:compare -- --before <SPEC> --after <SPEC> [flags]',
  '',
  'Compare spend before/after a behaviour change over the regression corpus',
  '(CORPUS_DIR). Prints aggregates only — corpus content never enters the output.',
  '',
  'SPEC:  YYYY-MM-DD | YYYYMMDD | START..END  — a session belongs to a set when',
  '       its LAST billed round falls in the window (last-activity heuristic)',
  '  or   --before-list F / --after-list F: file with one 16-hex session hash',
  "       per line (same hashes as corpus-snapshots/; '#' comments allowed)",
  '',
  'flags:',
  '  --seed N       bootstrap seed (default 86) — same seed, same CI',
  '  --rounds N     bootstrap resamples (default 2000)',
  '  --json         machine-readable output',
  '',
  'Metrics per turn: cost USD (priced rounds), inputSide tokens (pricing-immune),',
  'wasteShare (Σ finding wastedUsd / turn cost), and per finding type its',
  'frequency and tokensWasted per turn. Statistics: medians, bootstrap 95% CI of',
  'the median difference, two-sided Mann–Whitney p. Turns are attributed to',
  'their dominant model; model-mix, overlapping-period and small-sample issues',
  'are flagged.',
].join('\n');

interface CompareOpts {
  before?: string;
  after?: string;
  beforeList?: string;
  afterList?: string;
  seed: number;
  rounds: number;
  json: boolean;
  error?: string;
}

export function parseCompareArgs(argv: string[]): CompareOpts {
  const opts: CompareOpts = { seed: DEFAULT_SEED, rounds: DEFAULT_BOOTSTRAP_ROUNDS, json: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    const { value, next } = takeFlagValue(argv, i);
    if (a === '--before') {
      opts.before = value;
      i = next;
      continue;
    }
    if (a === '--after') {
      opts.after = value;
      i = next;
      continue;
    }
    if (a === '--before-list') {
      opts.beforeList = value;
      i = next;
      continue;
    }
    if (a === '--after-list') {
      opts.afterList = value;
      i = next;
      continue;
    }
    if (a === '--seed') {
      const n = parseInt(value, 10);
      if (!Number.isFinite(n)) opts.error = `--seed expects an integer, got '${value}'`;
      else opts.seed = n;
      i = next;
      continue;
    }
    if (a === '--rounds') {
      const n = parseInt(value, 10);
      if (!Number.isFinite(n) || n <= 0)
        opts.error = `--rounds expects a positive integer, got '${value}'`;
      else opts.rounds = n;
      i = next;
      continue;
    }
    if (a === '--json') {
      opts.json = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return opts;
}

/** period flag or list file → spec; error carries a user-facing message */
function buildSpec(
  period: string | undefined,
  listFile: string | undefined,
  flag: string
): { spec?: SetSpec; error?: string } {
  if (period && listFile)
    return { error: `${flag}: give either a period or a list file, not both` };
  if (period) {
    const spec = parsePeriodSpec(period);
    if (!spec) {
      return {
        error: `${flag}: invalid period '${period}' (expected YYYY-MM-DD or YYYY-MM-DD..YYYY-MM-DD)`,
      };
    }
    return { spec };
  }
  if (listFile) {
    try {
      const hashes = readHashList(listFile);
      return {
        spec: {
          kind: 'list',
          hashes: new Set(hashes),
          source: `list: ${listFile} (${hashes.length} hashes)`,
        },
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { error: `${flag} is required (--before/--after period or --before-list/--after-list)` };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (wantsHelp(argv)) {
    console.log(USAGE);
    return;
  }
  const opts = parseCompareArgs(argv);
  if (opts.error) {
    console.error(opts.error);
    process.exitCode = 1;
    return;
  }
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
  const beforeBuilt = buildSpec(opts.before, opts.beforeList, '--before');
  if (beforeBuilt.error || !beforeBuilt.spec) {
    console.error(beforeBuilt.error);
    process.exitCode = 1;
    return;
  }
  const afterBuilt = buildSpec(opts.after, opts.afterList, '--after');
  if (afterBuilt.error || !afterBuilt.spec) {
    console.error(afterBuilt.error);
    process.exitCode = 1;
    return;
  }
  const beforeSpec = beforeBuilt.spec;
  const afterSpec = afterBuilt.spec;
  if (beforeSpec.kind === 'list' && afterSpec.kind === 'list') {
    const inter = [...beforeSpec.hashes].filter((h) => afterSpec.hashes.has(h));
    if (inter.length > 0) {
      console.error(`${inter.length} hash(es) listed in both sets — the sets must be disjoint`);
      process.exitCode = 1;
      return;
    }
  }

  const warnings: string[] = [];
  if (
    beforeSpec.kind === 'period' &&
    afterSpec.kind === 'period' &&
    beforeSpec.since <= afterSpec.until &&
    afterSpec.since <= beforeSpec.until
  ) {
    warnings.push('periods overlap — sessions matching both sets are excluded');
  }

  const sessions = await computeCorpus(corpusDir);
  const assign = assignSets(sessions, corpusDir, beforeSpec, afterSpec);
  if (assign.ambiguous > 0) {
    warnings.push(`${assign.ambiguous} session(s) matched both sets — excluded`);
  }

  const buildSet = (list: ComputedSession[], source: string): SampleSet => {
    const turns: TurnSample[] = [];
    let unattributed = 0;
    let withTurns = 0;
    for (const s of list) {
      const r = turnSamples(s.ledger, s.findings);
      if (r.turns.length > 0) withTurns += 1;
      turns.push(...r.turns);
      unattributed += r.unattributedFindings;
    }
    return { source, sessions: withTurns, turns, unattributedFindings: unattributed };
  };
  const beforeSet = buildSet(assign.before, beforeSpec.source);
  const afterSet = buildSet(assign.after, afterSpec.source);

  const report = compareTurnSets(beforeSet, afterSet, {
    seed: opts.seed,
    bootstrapRounds: opts.rounds,
  });
  report.warnings.unshift(...warnings);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ...report,
          counts: {
            corpusSessions: sessions.length,
            unused: assign.unused,
            ambiguous: assign.ambiguous,
          },
        },
        null,
        2
      )
    );
  } else {
    console.log(renderReport(report));
  }
}

// run only when executed directly — vitest imports the pure helpers
if (isDirectRun(import.meta.url)) {
  void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
