/**
 * Precision CLI (#81) — sample findings for manual labeling, then report
 * precision per type with a Wilson 95% CI.
 *
 * sample: stratified by finding type (fixed seed → the same sample on rerun),
 * writes precision-sample.json next to the corpus (CORPUS_DIR). The file holds
 * summaries and round context — it NEVER enters the repo (privacy, like the
 * corpus itself, #79). A human sets label: "waste" | "not_waste" | "unsure"
 * (+ optional comment) on each item.
 *
 * report: reads the labeled file back, computes per-type precision over
 * waste/not_waste (unsure excluded, counted separately) and flags types with
 * precision < 70% as NOISY — candidates for threshold rework or disabling.
 * Prints aggregates only; safe to paste anywhere.
 *
 * Usage:
 *   pnpm corpus:sample [--n 10] [--seed 79] [--force]
 *   pnpm corpus:report [--sample <path>]   (default CORPUS_DIR/precision-sample.json)
 */

import * as fs from 'fs';
import * as path from 'path';

import { isDirectRun } from './args';
import { computeCorpus, REPO_ROOT, resolveCorpusDir } from './corpus';

import type { Finding, FindingType, RoundRow, SessionLedger } from './analyzeSession';
import type { SessionSnapshot } from './corpus';

export const SAMPLE_FILE_NAME = 'precision-sample.json';
export const NOISY_PRECISION_BELOW = 0.7;

export type Label = 'waste' | 'not_waste' | 'unsure';

// =============================================================================
// Pure helpers — unit-tested without touching the corpus
// =============================================================================

/** Wilson score interval for a binomial proportion; z defaults to 95% two-sided */
export function wilsonInterval(
  successes: number,
  total: number,
  z = 1.959963984540054
): { lower: number; upper: number } {
  if (total <= 0) return { lower: 0, upper: 1 };
  const p = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  return { lower: Math.max(0, center - half), upper: Math.min(1, center + half) };
}

/** mulberry32 — tiny seeded PRNG; enough for reproducible sampling (#81) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** stratified by type: up to perType per type, seeded shuffle → same seed, same sample */
export function stratifiedSample<T>(
  entries: { type: FindingType; item: T }[],
  perType: number,
  seed: number
): T[] {
  const byType = new Map<FindingType, number[]>();
  entries.forEach((e, i) => {
    const list = byType.get(e.type) ?? [];
    list.push(i);
    byType.set(e.type, list);
  });
  const rnd = mulberry32(seed);
  const picked: number[] = [];
  for (const type of [...byType.keys()].sort((a, b) => a.localeCompare(b))) {
    const idxs = byType.get(type)!;
    // Fisher–Yates; one shared PRNG stream keeps the whole draw reproducible
    for (let i = idxs.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
    }
    picked.push(...idxs.slice(0, perType));
  }
  return picked.toSorted((a, b) => a - b).map((i) => (entries[i] as { item: T }).item);
}

/** one sampled finding: everything a labeler needs, nothing that identifies the session */
export interface SampleItem {
  id: string; // sessionHash:type:turn:seq — stable across reruns of the same corpus
  type: FindingType;
  session: string; // 16-hex hash, as in the snapshots
  turn: number | null;
  severity: Finding['severity'];
  tokensWasted: number;
  summary: string;
  /** the finding's turn rounds ±1 neighbor — usage, tools, result sizes (#81) */
  context: {
    round: number;
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    result: number;
    tools: string[];
  }[];
  label: Label | null; // set by hand
  comment: string | null; // set by hand
}

export interface SampleDoc {
  seed: number;
  perType: number;
  items: SampleItem[];
}

interface SampleSourceSession {
  snapshot: SessionSnapshot;
  ledger: SessionLedger;
  findings: Finding[];
}

/** the finding's turn rounds plus one round on each side, numeric-only */
export function contextRounds(turnIndex: number | undefined, rounds: RoundRow[]): RoundRow[] {
  if (turnIndex === undefined) return [];
  const inTurn = rounds.filter((r) => r.turnIndex === turnIndex);
  if (inTurn.length === 0) return [];
  const first = inTurn[0].index;
  const last = inTurn[inTurn.length - 1].index;
  return rounds.filter((r) => r.index >= first - 1 && r.index <= last + 1);
}

export function buildSampleDoc(
  sessions: SampleSourceSession[],
  perType: number,
  seed: number
): SampleDoc {
  const entries: { type: FindingType; item: SampleItem }[] = [];
  for (const s of sessions) {
    s.findings.forEach((f, i) => {
      entries.push({
        type: f.type,
        item: {
          id: `${s.snapshot.session}:${f.type}:${f.turnIndex ?? '-'}:${i}`,
          type: f.type,
          session: s.snapshot.session,
          turn: f.turnIndex ?? null,
          severity: f.severity,
          tokensWasted: f.tokensWasted,
          summary: f.summary,
          context: contextRounds(f.turnIndex, s.ledger.rounds).map((r) => ({
            round: r.index,
            input: r.inputTokens,
            cacheRead: r.cacheReadTokens,
            cacheWrite: r.cacheCreationTokens,
            output: r.outputTokens,
            result: r.resultTokens,
            tools: r.tools,
          })),
          label: null,
          comment: null,
        },
      });
    });
  }
  return { seed, perType, items: stratifiedSample(entries, perType, seed) };
}

// =============================================================================
// Report (#81): precision per type, unsure excluded, Wilson 95% CI
// =============================================================================

export interface TypePrecision {
  type: FindingType;
  waste: number;
  notWaste: number;
  unsure: number;
  unlabeled: number;
  labeled: number;
  /** null when nothing is labeled yet */
  precision: number | null;
  ci: { lower: number; upper: number } | null;
  noisy: boolean;
}

export function precisionReport(doc: SampleDoc): TypePrecision[] {
  const counters = new Map<FindingType, TypePrecision>();
  for (const item of doc.items) {
    const c =
      counters.get(item.type) ??
      ({
        type: item.type,
        waste: 0,
        notWaste: 0,
        unsure: 0,
        unlabeled: 0,
        labeled: 0,
        precision: null,
        ci: null,
        noisy: false,
      } as TypePrecision);
    if (item.label === 'waste') c.waste += 1;
    else if (item.label === 'not_waste') c.notWaste += 1;
    else if (item.label === 'unsure') c.unsure += 1;
    else c.unlabeled += 1;
    counters.set(item.type, c);
  }
  const rows = [...counters.values()].sort((a, b) => a.type.localeCompare(b.type));
  for (const c of rows) {
    c.labeled = c.waste + c.notWaste;
    if (c.labeled > 0) {
      c.precision = c.waste / c.labeled;
      c.ci = wilsonInterval(c.waste, c.labeled);
      c.noisy = c.precision < NOISY_PRECISION_BELOW;
    }
  }
  return rows;
}

// =============================================================================
// CLI plumbing
// =============================================================================

function numFlag(argv: string[], name: string, def: number): number {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = Number(argv[i + 1]);
  if (!Number.isFinite(v) || v <= 0 || !Number.isInteger(v)) {
    throw new Error(`${name} must be a positive integer, got: ${argv[i + 1]}`);
  }
  return v;
}

function strFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function printSampleSummary(doc: SampleDoc, outFile: string): void {
  const byType = new Map<string, number>();
  for (const item of doc.items) byType.set(item.type, (byType.get(item.type) ?? 0) + 1);
  console.log(`precision:sample — ${doc.items.length} findings written to ${outFile}`);
  for (const [type, n] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0])))
    console.log(`  ${type}: ${n}`);
  console.log(
    `seed=${doc.seed}, perType=${doc.perType}. Set "label" to "waste" | "not_waste" | "unsure"` +
      ' (optional "comment") on each item, then run pnpm corpus:report.'
  );
}

async function runSample(
  corpusDir: string,
  perType: number,
  seed: number,
  force: boolean
): Promise<number> {
  const outFile = path.join(corpusDir, SAMPLE_FILE_NAME);
  if (fs.existsSync(outFile) && !force) {
    console.error(
      `${outFile} already exists — refusing to overwrite labels. Re-run with --force to discard them.`
    );
    return 1;
  }
  const sessions = await computeCorpus(corpusDir);
  const doc = buildSampleDoc(sessions, perType, seed);
  fs.writeFileSync(outFile, JSON.stringify(doc, null, 2) + '\n');
  printSampleSummary(doc, outFile);
  return 0;
}

function printReport(rows: TypePrecision[], totalItems: number): void {
  const sum = (
    k: keyof Pick<TypePrecision, 'waste' | 'notWaste' | 'unsure' | 'unlabeled'>
  ): number => rows.reduce((s, r) => s + r[k], 0);
  const labeled = sum('waste') + sum('notWaste');
  console.log(
    `precision report (#81) — ${rows.length} type(s), ${totalItems} sampled: ` +
      `${labeled} labeled (${sum('waste')} waste / ${sum('notWaste')} not_waste), ` +
      `${sum('unsure')} unsure (excluded), ${sum('unlabeled')} unlabeled`
  );
  console.log(
    'type'.padEnd(20) +
      'waste'.padStart(6) +
      'not_w'.padStart(7) +
      'unsure'.padStart(7) +
      'unlab'.padStart(6) +
      'precision'.padStart(10) +
      '  95% Wilson CI'
  );
  for (const r of rows) {
    const prec = r.precision === null ? '—' : `${(r.precision * 100).toFixed(1)}%`;
    const ci =
      r.ci === null ? '—' : `${(r.ci.lower * 100).toFixed(1)}% – ${(r.ci.upper * 100).toFixed(1)}%`;
    console.log(
      r.type.padEnd(20) +
        String(r.waste).padStart(6) +
        String(r.notWaste).padStart(7) +
        String(r.unsure).padStart(7) +
        String(r.unlabeled).padStart(6) +
        prec.padStart(10) +
        ('  ' + ci).padEnd(24) +
        (r.noisy ? 'NOISY (<70%)' : '')
    );
  }
  if (labeled > 0) {
    const overall = wilsonInterval(sum('waste'), labeled);
    console.log(
      `overall precision: ${sum('waste')}/${labeled} = ${((sum('waste') / labeled) * 100).toFixed(1)}%` +
        ` (95% CI ${(overall.lower * 100).toFixed(1)}% – ${(overall.upper * 100).toFixed(1)}%)`
    );
  }
  const noisy = rows.filter((r) => r.noisy);
  if (noisy.length > 0) {
    console.log(
      `NOISY types (precision < ${NOISY_PRECISION_BELOW * 100}%): ${noisy.map((r) => r.type).join(', ')}`
    );
  }
}

function runReport(samplePath: string): number {
  if (!fs.existsSync(samplePath)) {
    console.error(`sample file not found: ${samplePath} — run pnpm corpus:sample first`);
    return 1;
  }
  const doc = JSON.parse(fs.readFileSync(samplePath, 'utf8')) as SampleDoc;
  if (!Array.isArray(doc.items)) {
    console.error(`malformed sample file: ${samplePath}`);
    return 1;
  }
  printReport(precisionReport(doc), doc.items.length);
  return 0;
}

async function main(): Promise<void> {
  const argv = process.argv;
  const mode = argv[2];
  if (mode !== 'sample' && mode !== 'report') {
    console.error(
      'usage: pnpm corpus:sample [--n 10] [--seed 79] [--force] | pnpm corpus:report [--sample <path>]'
    );
    process.exitCode = 1;
    return;
  }
  const corpusDir = resolveCorpusDir(process.env, REPO_ROOT);
  if (!corpusDir) {
    console.error(
      'CORPUS_DIR is not set — see .env.example. The corpus and its samples never enter the repo.'
    );
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(corpusDir)) {
    console.error(`CORPUS_DIR does not exist: ${corpusDir}`);
    process.exitCode = 1;
    return;
  }
  try {
    if (mode === 'sample') {
      process.exitCode = await runSample(
        corpusDir,
        numFlag(argv, '--n', 10),
        numFlag(argv, '--seed', 79),
        argv.includes('--force')
      );
    } else {
      const samplePath = strFlag(argv, '--sample') ?? path.join(corpusDir, SAMPLE_FILE_NAME);
      process.exitCode = runReport(samplePath);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

// run only when executed directly — vitest imports the pure helpers
if (isDirectRun(import.meta.url)) {
  void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
