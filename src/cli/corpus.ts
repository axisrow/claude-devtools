/**
 * Regression corpus CLI (#79) — numeric snapshots of real sessions as the
 * base for every evaluation sub-issue of #78.
 *
 * The corpus holds real sessions (paths, prompts, code) and NEVER enters the
 * repo: its location comes from CORPUS_DIR (env or .env, see .env.example).
 * Only numeric snapshots land in corpus-snapshots/ and are committed: per
 * session a hash of its id, token totals by kind, findings as
 * (type, turnIndex, severity, tokensWasted). No summaries, texts, paths,
 * prompts, or raw ids.
 *
 * Usage:
 *   pnpm corpus:snapshot   recompute over the corpus, write corpus-snapshots/
 *   pnpm corpus:diff       recompute and diff against the committed snapshots
 *
 * Both modes run buildLedger + computeFindings (src/cli/analyzeSession.ts)
 * per session, check the invariants (round sums = totals; tokensWasted >= 0;
 * wasted sum <= billed) and fail non-zero with a report on violations.
 */

import { parseJsonlFile } from '@main/utils/jsonl';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { buildLedger, computeFindings } from './analyzeSession';
import { isDirectRun } from './args';

import type { Finding, SessionLedger } from './analyzeSession';

export const SNAPSHOT_DIR_NAME = 'corpus-snapshots';

// repo root from this file's location (src/cli/), independent of process.cwd();
// vitest hands modules a non-file: import.meta.url → fall back to cwd (pnpm
// scripts and vitest both run at the package root)
const REPO_ROOT = (() => {
  try {
    return fileURLToPath(new URL('../..', import.meta.url));
  } catch {
    return process.cwd();
  }
})();

// =============================================================================
// Pure helpers — unit-tested without touching the corpus
// =============================================================================

/** CORPUS_DIR from the env, else from .env next to package.json; null if unset */
export function resolveCorpusDir(env: NodeJS.ProcessEnv, repoRoot: string): string | null {
  const fromEnv = env.CORPUS_DIR?.trim();
  if (fromEnv) return fromEnv;
  try {
    const text = fs.readFileSync(path.join(repoRoot, '.env'), 'utf8');
    const line = text.split('\n').find((l) => l.startsWith('CORPUS_DIR='));
    let v = (line ?? '').slice('CORPUS_DIR='.length).trim();
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    ) {
      v = v.slice(1, -1);
    }
    return v || null;
  } catch {
    return null; // no .env
  }
}

/** all session files under the corpus root (recursive, agent-* sidechains skipped), sorted */
export function listSessionFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl') && !e.name.startsWith('agent-')) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => a.localeCompare(b));
}

// 16 hex chars of sha256 — enough to spot a regression diff, useless for
// recovering the session
export function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

export interface SnapshotFinding {
  type: Finding['type'];
  turnIndex: number | null;
  severity: Finding['severity'];
  tokensWasted: number;
}

/** numeric-only snapshot: no summary, no texts, no paths, no raw ids (#79) */
export interface SessionSnapshot {
  session: string;
  turns: number;
  rounds: number;
  totals: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    outputTokens: number;
    billedTokens: number;
    thinkingTokens: number;
    noUsageRounds: number;
    retryCopies: number;
  };
  findings: SnapshotFinding[];
}

export function buildSnapshot(
  sessionId: string,
  ledger: SessionLedger,
  findings: Finding[]
): SessionSnapshot {
  const t = ledger.totals;
  return {
    session: hashSessionId(sessionId),
    turns: ledger.turns.length,
    rounds: ledger.rounds.length,
    totals: {
      inputTokens: t.inputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheCreationTokens: t.cacheCreationTokens,
      outputTokens: t.outputTokens,
      billedTokens: t.billedTokens,
      thinkingTokens: t.thinkingTokens,
      noUsageRounds: t.noUsageRounds,
      retryCopies: t.retryCopies,
    },
    findings: findings.map((f) => ({
      type: f.type,
      turnIndex: f.turnIndex ?? null,
      severity: f.severity,
      tokensWasted: f.tokensWasted,
    })),
  };
}

// =============================================================================
// Invariants (#79) — checked on every corpus session
// =============================================================================

export interface InvariantViolation {
  invariant: 'rounds-sum-equals-total' | 'tokensWasted-non-negative' | 'wasted-le-billed';
  detail: string;
}

export function checkInvariants(ledger: SessionLedger, findings: Finding[]): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const t = ledger.totals;
  const sum = {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
  };
  for (const r of ledger.rounds) {
    sum.inputTokens += r.inputTokens;
    sum.cacheReadTokens += r.cacheReadTokens;
    sum.cacheCreationTokens += r.cacheCreationTokens;
    sum.outputTokens += r.outputTokens;
  }
  for (const [kind, v] of Object.entries(sum) as [keyof typeof sum, number][]) {
    if (v !== t[kind]) {
      out.push({
        invariant: 'rounds-sum-equals-total',
        detail: `${kind}: round sum ${v} != totals ${t[kind]}`,
      });
    }
  }
  const kindsSum =
    sum.inputTokens + sum.cacheReadTokens + sum.cacheCreationTokens + sum.outputTokens;
  if (kindsSum !== t.billedTokens) {
    out.push({
      invariant: 'rounds-sum-equals-total',
      detail: `billedTokens: kind sum ${kindsSum} != totals ${t.billedTokens}`,
    });
  }
  for (const f of findings) {
    if (f.tokensWasted < 0) {
      out.push({ invariant: 'tokensWasted-non-negative', detail: `${f.type}: ${f.tokensWasted}` });
    }
  }
  const wasted = findings.reduce((s, f) => s + f.tokensWasted, 0);
  if (wasted > t.billedTokens) {
    out.push({
      invariant: 'wasted-le-billed',
      detail: `findings wasted ${wasted} > billed ${t.billedTokens}`,
    });
  }
  return out;
}

// =============================================================================
// Diff
// =============================================================================

export interface SnapshotDiff {
  session: string;
  totalsChanges: { field: string; before: number; after: number }[];
  structuralChanges: { field: 'turns' | 'rounds'; before: number; after: number }[];
  added: SnapshotFinding[];
  removed: SnapshotFinding[];
}

const findingEq = (a: SnapshotFinding, b: SnapshotFinding): boolean =>
  a.type === b.type &&
  a.turnIndex === b.turnIndex &&
  a.severity === b.severity &&
  a.tokensWasted === b.tokensWasted;

/** multiset diff of findings (same key with different tokensWasted = removed + added) */
export function diffSnapshots(before: SessionSnapshot, after: SessionSnapshot): SnapshotDiff {
  const totalsChanges: SnapshotDiff['totalsChanges'] = [];
  for (const [field, afterV] of Object.entries(after.totals)) {
    const beforeV = before.totals[field as keyof typeof before.totals];
    if (beforeV !== afterV) totalsChanges.push({ field, before: beforeV, after: afterV });
  }
  const structuralChanges: SnapshotDiff['structuralChanges'] = [];
  if (before.turns !== after.turns) {
    structuralChanges.push({ field: 'turns', before: before.turns, after: after.turns });
  }
  if (before.rounds !== after.rounds) {
    structuralChanges.push({ field: 'rounds', before: before.rounds, after: after.rounds });
  }
  const beforeLeft = [...before.findings];
  const added: SnapshotFinding[] = [];
  for (const f of after.findings) {
    const i = beforeLeft.findIndex((b) => findingEq(b, f));
    if (i >= 0) beforeLeft.splice(i, 1);
    else added.push(f);
  }
  return { session: after.session, totalsChanges, structuralChanges, added, removed: beforeLeft };
}

// =============================================================================
// CLI plumbing
// =============================================================================

interface ComputedSession {
  file: string;
  ledger: SessionLedger;
  findings: Finding[];
  snapshot: SessionSnapshot;
}

async function computeSession(file: string, corpusDir: string): Promise<ComputedSession> {
  // hash the path RELATIVE to CORPUS_DIR, not the bare basename: a nested tree
  // (project dirs, subagent sidechains) can hold same-named files in different
  // folders — a basename hash would collide and abort the whole run. For a
  // flat curated corpus relPath == basename, so hashes stay as before.
  const sessionId = path.relative(corpusDir, file);
  const messages = await parseJsonlFile(file);
  const ledger = buildLedger(messages);
  const findings = computeFindings(messages, ledger);
  return { file, ledger, findings, snapshot: buildSnapshot(sessionId, ledger, findings) };
}

async function computeCorpus(corpusDir: string): Promise<ComputedSession[]> {
  const files = listSessionFiles(corpusDir);
  if (files.length === 0) {
    throw new Error(`no .jsonl sessions found in CORPUS_DIR: ${corpusDir}`);
  }
  const out: ComputedSession[] = [];
  for (const file of files) out.push(await computeSession(file, corpusDir));
  // a hash collision would silently merge two sessions in the snapshot dir
  const byHash = new Map<string, string>();
  for (const s of out) {
    const prev = byHash.get(s.snapshot.session);
    if (prev) throw new Error(`session id hash collision: ${prev} and ${s.file}`);
    byHash.set(s.snapshot.session, s.file);
  }
  return out;
}

async function runSnapshot(corpusDir: string): Promise<number> {
  const sessions = await computeCorpus(corpusDir);
  const snapshotDir = path.join(REPO_ROOT, SNAPSHOT_DIR_NAME);
  fs.mkdirSync(snapshotDir, { recursive: true });

  let written = 0;
  let violations = 0;
  const keptHashes = new Set<string>();
  for (const s of sessions) {
    keptHashes.add(s.snapshot.session);
    const bad = checkInvariants(s.ledger, s.findings);
    if (bad.length > 0) {
      violations += bad.length;
      for (const v of bad) {
        console.error(`INVARIANT [${v.invariant}] ${path.basename(s.file)}: ${v.detail}`);
      }
      continue; // a session violating invariants must not be snapshotted
    }
    fs.writeFileSync(
      path.join(snapshotDir, `${s.snapshot.session}.json`),
      JSON.stringify(s.snapshot, null, 2) + '\n'
    );
    written += 1;
  }
  // prune snapshots of sessions no longer in the corpus
  let pruned = 0;
  for (const e of fs.readdirSync(snapshotDir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.json') && !keptHashes.has(e.name.replace(/\.json$/, ''))) {
      fs.rmSync(path.join(snapshotDir, e.name));
      pruned += 1;
    }
  }
  console.log(
    `corpus:snapshot — ${sessions.length} sessions, ${written} snapshots written to ${SNAPSHOT_DIR_NAME}/, ${pruned} stale pruned, ${violations} invariant violation(s)`
  );
  return violations > 0 ? 1 : 0;
}

async function runDiff(corpusDir: string): Promise<number> {
  const snapshotDir = path.join(REPO_ROOT, SNAPSHOT_DIR_NAME);
  const committed = new Map<string, SessionSnapshot>();
  if (fs.existsSync(snapshotDir)) {
    for (const e of fs.readdirSync(snapshotDir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const raw = JSON.parse(
        fs.readFileSync(path.join(snapshotDir, e.name), 'utf8')
      ) as SessionSnapshot;
      committed.set(raw.session, raw);
    }
  }

  const sessions = await computeCorpus(corpusDir);
  let changed = 0;
  let violations = 0;
  const seenHashes = new Set<string>();
  for (const s of sessions) {
    seenHashes.add(s.snapshot.session);
    const bad = checkInvariants(s.ledger, s.findings);
    for (const v of bad) {
      violations += 1;
      console.error(`INVARIANT [${v.invariant}] ${path.basename(s.file)}: ${v.detail}`);
    }
    const before = committed.get(s.snapshot.session);
    if (!before) {
      changed += 1;
      console.log(`${s.snapshot.session} (${path.basename(s.file)}): NEW — no committed snapshot`);
      continue;
    }
    const d = diffSnapshots(before, s.snapshot);
    if (
      d.totalsChanges.length === 0 &&
      d.structuralChanges.length === 0 &&
      d.added.length === 0 &&
      d.removed.length === 0
    ) {
      continue;
    }
    changed += 1;
    console.log(`${s.snapshot.session} (${path.basename(s.file)}):`);
    for (const c of d.structuralChanges) console.log(`  ${c.field}: ${c.before} -> ${c.after}`);
    for (const c of d.totalsChanges) console.log(`  totals.${c.field}: ${c.before} -> ${c.after}`);
    for (const f of d.removed) {
      console.log(`  - finding ${f.type}@${f.turnIndex ?? '—'} ${f.severity} ${f.tokensWasted}`);
    }
    for (const f of d.added) {
      console.log(`  + finding ${f.type}@${f.turnIndex ?? '—'} ${f.severity} ${f.tokensWasted}`);
    }
  }
  for (const hash of committed.keys()) {
    if (!seenHashes.has(hash)) {
      changed += 1;
      console.log(`${hash}: REMOVED from corpus (snapshot still committed)`);
    }
  }
  if (changed === 0 && violations === 0) console.log('corpus:diff — no changes');
  else
    console.log(`corpus:diff — ${changed} session(s) differ, ${violations} invariant violation(s)`);
  return changed > 0 || violations > 0 ? 1 : 0;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== 'snapshot' && mode !== 'diff') {
    console.error('usage: pnpm corpus:snapshot | pnpm corpus:diff');
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
  process.exitCode = mode === 'snapshot' ? await runSnapshot(corpusDir) : await runDiff(corpusDir);
}

// run only when executed directly — vitest imports the pure helpers
if (isDirectRun(import.meta.url)) {
  void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
