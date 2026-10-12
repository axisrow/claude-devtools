/**
 * Waste injection harness (#80) — ground truth for recall without ML.
 *
 * Takes a clean real session (ParsedMessage[]), inserts one known waste
 * pattern with a known cost, runs the real detector (buildLedger +
 * computeFindings) and measures: recall (did a finding of the type fire) and
 * quantity error |tokensWasted − injected| / injected.
 *
 * Input: corpus sessions (#79, CORPUS_DIR — never enters the repo) for the
 * `pnpm waste:recall` report; test/fixtures/corpus mini-fixtures for the CI
 * gate (test/main/cli/injectWaste.test.ts — fails if any type recalls < 100%).
 *
 * Ledger plausibility: every injected round re-reads the accumulated context
 * (usage.cache_read = running ctx) and every injected result feeds the NEXT
 * round's context; all base rounds after the insertion point are bumped by
 * the same delta, so context stays monotonic and billed tokens grow by at
 * least the injected waste (corpus invariants still hold, see tests).
 *
 * Usage:
 *   pnpm waste:recall    report over CORPUS_DIR: recall + median |err| per type
 */

import { isParsedTeammateRelayMessage, isParsedUserChunkMessage } from '@main/types';
import { parseJsonlFile } from '@main/utils/jsonl';
import { WAIT_TICK_CONTEXT_TOKENS } from '@shared/constants/loopPolicy';
import { estimateTokens } from '@shared/utils/tokenFormatting';

import { buildLedger, computeFindings, WASTE_THRESHOLDS } from './analyzeSession';
import { isDirectRun } from './args';
import { listSessionFiles, resolveCorpusDir } from './corpus';

import type { Finding } from './analyzeSession';
import type { ParsedMessage } from '@main/types';

// =============================================================================
// Injectable patterns — one FindingType per mutator
// =============================================================================

/** the 9 FindingTypes a mutator can plant with a known cost (#80) */
export type InjectableType =
  | 'duplicate_call'
  | 'loop_streak'
  | 'cycle_motif'
  | 'probe_no_progress'
  | 'cache_dead'
  | 'wait_loop'
  | 'stall_streak'
  | 'oversized_output'
  | 'failed_call';

export const INJECTABLE_TYPES: InjectableType[] = [
  'duplicate_call',
  'loop_streak',
  'cycle_motif',
  'probe_no_progress',
  'cache_dead',
  'wait_loop',
  'stall_streak',
  'oversized_output',
  'failed_call',
];

// not injectable (no call/result to plant): context_spike / thinking_heavy /
// long_turn — observing those needs different, round-shaping mutations.

export interface Injection {
  messages: ParsedMessage[];
  /** expected tokensWasted — what a correct detector books for the pattern */
  expected: number;
  /** unique token planted in the inserted calls/results (summary attribution) */
  marker: string;
  /** turn the pattern was planted into (round-shaped findings have no marker) */
  turnIndex: number;
}

export interface InjectionOutcome {
  type: InjectableType;
  session?: string;
  expected: number;
  found: boolean;
  booked: number | null;
  /** |booked − expected| / expected, null when not found */
  relError: number | null;
  /** true when the session had no usable insertion point (too small) */
  skipped?: boolean;
}

// =============================================================================
// Insertion point — mid-session, inside one turn, between two real rounds
// =============================================================================

interface Point {
  insertAt: number; // array index of the next round's message
  prevContext: number; // contextSize of the round before the gap
  tPrev: number; // timestamps bounding the gap
  tNext: number;
  turnIndex: number;
}

const realRound = (m: ParsedMessage): boolean =>
  m.type === 'assistant' && !m.isSidechain && !!m.usage && m.model !== '<synthetic>';

function pickPoint(messages: ParsedMessage[]): Point | null {
  const idx = messages
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => realRound(m) && contextSizeOf(m) > 0);
  if (idx.length < 2) return null;
  const candidates: Point[] = [];
  for (let k = 1; k < idx.length; k++) {
    const prev = idx[k - 1];
    const next = idx[k];
    // keep the pair in one turn: no user/relay message or compact boundary between
    const between = messages.slice(prev.i + 1, next.i);
    const opensTurn = between.some(
      (m) => m.isCompactSummary || (m.type === 'user' && !m.isMeta && !m.isSidechain)
    );
    if (opensTurn) continue;
    // turn numbering parity with buildLedger: openers before the gap, implicit
    // turn 1 when none precede (compact summaries open no turn)
    let openers = 0;
    for (let i = 0; i < next.i; i++) {
      const m = messages[i];
      if (
        !m.isCompactSummary &&
        !m.isSidechain &&
        (isParsedUserChunkMessage(m) || isParsedTeammateRelayMessage(m))
      ) {
        openers += 1;
      }
    }
    candidates.push({
      insertAt: next.i,
      prevContext: contextSizeOf(prev.m),
      tPrev: prev.m.timestamp.getTime(),
      tNext: next.m.timestamp.getTime(),
      turnIndex: Math.max(openers, 1),
    });
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(candidates.length / 2)];
}

/**
 * wait_loop books EVERY quiet tick of a turn (not a consecutive run), so
 * planting it mid-session would merge with the base turn's quiet rounds.
 * Instead the pattern is appended as its own new turn — no base quiet ticks
 * there by construction, so the finding books exactly the injected ticks.
 */
function appendPoint(messages: ParsedMessage[]): Point | null {
  let last: ParsedMessage | null = null;
  for (const m of messages) {
    if (realRound(m) && contextSizeOf(m) > 0) last = m;
  }
  if (!last) return null;
  return {
    insertAt: messages.length,
    prevContext: contextSizeOf(last),
    tPrev: last.timestamp.getTime(),
    tNext: last.timestamp.getTime() + 60_000,
    turnIndex: countOpeners(messages, messages.length) + 1,
  };
}

function contextSizeOf(m: ParsedMessage): number {
  const u = m.usage;
  if (!u) return 0;
  return (
    (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  );
}

/** turn openers before index `until` — buildLedger's numbering (compact summaries open no turn) */
function countOpeners(messages: ParsedMessage[], until: number): number {
  let openers = 0;
  for (let i = 0; i < until; i++) {
    const m = messages[i];
    if (
      !m.isCompactSummary &&
      !m.isSidechain &&
      (isParsedUserChunkMessage(m) || isParsedTeammateRelayMessage(m))
    ) {
      openers += 1;
    }
  }
  return openers;
}

// =============================================================================
// Builders
// =============================================================================

const MARKER = (type: InjectableType): string => `winject-${type}`;
let seq = 0;

/** text of ~n tokens (estimateTokens = ceil(chars/4), so (4n−1) chars = n) */
const filler = (n: number): string => 'w'.repeat(n * 4 - 1);

interface RoundOpts {
  input?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  /** absolute usage counters; default: cache_read carries the whole context */
  usage?: { input: number; cr: number; cw: number; out: number };
}

class Builder {
  messages: ParsedMessage[] = [];
  /** context seen by the NEXT round — grows with every emitted result */
  ctx: number;
  private readonly marker: string;
  constructor(ctx: number, marker: string) {
    this.ctx = ctx;
    this.marker = marker;
  }

  round(name: string, opts: RoundOpts = {}): void {
    const id = `winjc-${++seq}`;
    const u = opts.usage ?? { input: 0, cr: this.ctx, cw: 0, out: 50 };
    this.ctx = Math.max(this.ctx, u.input + u.cr + u.cw); // a round's own context persists
    this.messages.push({
      uuid: `winj-${++seq}`,
      parentUuid: null,
      type: 'assistant',
      timestamp: new Date(),
      content: '',
      model: 'claude-sonnet-5-5',
      isSidechain: false,
      isMeta: true,
      toolCalls: opts.input ? [{ id, name, input: opts.input, isTask: false }] : [],
      toolResults: [],
      usage: {
        input_tokens: u.input,
        cache_read_input_tokens: u.cr,
        cache_creation_input_tokens: u.cw,
        output_tokens: u.out,
      },
      requestId: `req-winject-${++seq}`,
    });
    if (opts.result !== undefined) {
      this.messages.push({
        uuid: `winj-${++seq}`,
        parentUuid: null,
        type: 'user',
        timestamp: new Date(),
        content: '',
        isSidechain: false,
        isMeta: true,
        toolCalls: [],
        toolResults: [{ toolUseId: id, content: opts.result, isError: !!opts.isError }],
      });
      this.ctx += estimateTokens(opts.result); // lands in the next round's gap
    }
  }

  /** a run-breaker: real work round (big output, own call) that is neither a
   *  quiet tick nor stalled — keeps base runs from merging with the injected
   *  one (a stall/quiet run absorbs any neighboring round that fits) */
  wall(tag: string): void {
    this.round('Bash', {
      input: { command: `${this.marker} wall-${tag}` },
      usage: { input: 0, cr: this.ctx, cw: 0, out: 1500 },
    });
  }
}

// =============================================================================
// Mutators — one pattern per InjectableType
// =============================================================================

export function injectWaste(type: InjectableType, source: ParsedMessage[]): Injection | null {
  const pt = type === 'wait_loop' ? appendPoint(source) : pickPoint(source);
  if (!pt) return null;
  const messages = structuredClone(source);
  const marker = MARKER(type);
  const b = new Builder(pt.prevContext, marker);
  let expected = 0;

  switch (type) {
    case 'duplicate_call': {
      // same Read twice — the repeat re-reads ~200 tok of result
      const file = `/tmp/${marker}-source.ts`;
      b.round('Read', { input: { file_path: file }, result: filler(200) });
      b.round('Read', { input: { file_path: file }, result: filler(200) });
      expected = 200; // reread = repeats only
      break;
    }
    case 'loop_streak': {
      // 4 identical calls back-to-back (LOOP_MIN_STREAK), same result
      const cmd = `${marker} check`;
      for (let i = 0; i < 4; i++) {
        b.round('Bash', { input: { command: cmd }, result: filler(100) });
      }
      expected = 3 * 100; // streak books repeats 2..4
      break;
    }
    case 'cycle_motif': {
      // A→B→C ×3 with +400 tok of fresh result each round (> stall delta 300)
      const cmds = ['alpha', 'beta', 'gamma'].map((s) => `${marker} ${s}`);
      let roundNo = 0;
      for (let rep = 0; rep < 3; rep++) {
        for (const cmd of cmds) {
          roundNo += 1;
          if (roundNo >= 4) expected += b.ctx; // motif books repeated windows
          b.round('Bash', {
            input: { command: cmd },
            result: `${filler(400)}\n${marker} rep-${rep} ${cmd}`,
          });
        }
      }
      break;
    }
    case 'probe_no_progress': {
      // probe re-run with an identical result signature, separated by other work
      const probe = `${marker} check`;
      const res = (n: number): string => `attempt ${n}\n${marker}: verdict unchanged`;
      b.round('Bash', { input: { command: probe }, result: res(1) });
      b.round('Bash', { input: { command: `${marker} other step` }, result: filler(20) });
      b.round('Bash', { input: { command: probe }, result: res(2) });
      expected = estimateTokens(res(2)); // books the repeat only
      break;
    }
    case 'cache_dead': {
      // one round billed as fresh input, no cache read/write
      const ctx = b.ctx + 25_000; // > cacheDeadContextTokens (20k)
      b.round('Bash', {
        input: { command: `${marker} run` },
        result: filler(50),
        usage: { input: ctx, cr: 0, cw: 0, out: 50 },
      });
      expected = ctx; // books the whole dead round's context
      break;
    }
    case 'wait_loop': {
      // appended turn (see appendPoint): user opener + 5 quiet ticks, no tools,
      // ≥50k context, tiny output. No walls needed — the turn is all ours.
      b.messages.push({
        uuid: `winj-${++seq}`,
        parentUuid: null,
        type: 'user',
        timestamp: new Date(),
        content: `${marker}: keep watching`,
        isSidechain: false,
        isMeta: false,
        toolCalls: [],
        toolResults: [],
      });
      const ctx = Math.max(b.ctx, WAIT_TICK_CONTEXT_TOKENS);
      // ramp below the context-spike threshold when the jump is big: a single
      // +44.9k step would book a context_spike whose waste nothing bills back
      // (ramp = target − 25k < 50k, so it never counts as a quiet tick itself)
      if (ctx - b.ctx > WASTE_THRESHOLDS.contextSpikeTokens) {
        b.round('Ramp', { usage: { input: 0, cr: ctx - 25_000, cw: 0, out: 20 } });
      }
      for (let i = 0; i < 5; i++) {
        b.round('Wait', { usage: { input: 0, cr: ctx, cw: 0, out: 20 } });
      }
      expected = 5 * ctx;
      break;
    }
    case 'stall_streak': {
      // 4 rounds with calls, distinct args, no context growth, tiny output;
      // walls keep base low-delta rounds (delta ≤ 300) from joining
      b.wall('pre');
      for (let i = 0; i < 4; i++) {
        expected += b.ctx; // stall books every stalled round's context
        b.round('Bash', { input: { command: `${marker} tick-${i}` }, result: `ok ${i}` });
      }
      b.wall('post');
      break;
    }
    case 'oversized_output': {
      const text = `${marker} dump\n${filler(8500)}`; // > oversizedOutputTokens (8k)
      b.round('Bash', { input: { command: `${marker} dump-all` }, result: text });
      expected = estimateTokens(text);
      break;
    }
    case 'failed_call': {
      const input = { command: `${marker} probe` };
      const text = `Error: ${marker} connection refused\n${filler(100)}`;
      b.round('Bash', { input, result: text, isError: true });
      expected = estimateTokens(JSON.stringify(input)) + estimateTokens(text);
      break;
    }
  }

  // keep the ledger plausible: every base round after the gap sees the full
  // injected context (cache_read carries it, same as the fixture idiom)
  const delta = b.ctx - pt.prevContext;
  if (delta > 0) {
    for (let i = pt.insertAt; i < messages.length; i++) {
      const m = messages[i];
      if (realRound(m)) {
        m.usage!.cache_read_input_tokens = (m.usage!.cache_read_input_tokens ?? 0) + delta;
      }
    }
  }

  // restamp inside the gap: timestamps stay between the bounding rounds
  const step = Math.max(1, (pt.tNext - pt.tPrev) / (b.messages.length + 1));
  for (let i = 0; i < b.messages.length; i++) {
    b.messages[i].timestamp = new Date(pt.tPrev + step * (i + 1));
  }

  messages.splice(pt.insertAt, 0, ...b.messages);
  return { messages, expected, marker, turnIndex: pt.turnIndex };
}

// =============================================================================
// Evaluation — recall + quantity error per type on one session
// =============================================================================

export function evaluateInjection(source: ParsedMessage[], session?: string): InjectionOutcome[] {
  return INJECTABLE_TYPES.map((type) => {
    const inj = injectWaste(type, source);
    if (!inj) {
      return {
        type,
        session,
        expected: 0,
        found: false,
        booked: null,
        relError: null,
        skipped: true,
      };
    }
    const ledger = buildLedger(inj.messages);
    const findings = computeFindings(inj.messages, ledger);
    // Marker hits attribute summary-carried patterns; round-shaped ones
    // (cache_dead, wait_loop) attribute by exact amount inside the injected
    // turn. Since #124's claim allocation, overlapping findings share the
    // same result tokens: probe_no_progress's repeats are served to its
    // co-firing duplicate_call first, so the pattern's booked amount is the
    // sum over ALL marker-carrying findings of the pattern (probe + dup).
    const sameType = findings.filter((f) => f.type === type && f.summary.includes(inj.marker));
    let hit: Finding | undefined = sameType[0];
    let booked: number | null = sameType.length
      ? sameType.reduce((s, f) => s + f.tokensWasted, 0)
      : null;
    if (type === 'probe_no_progress' && hit) {
      const dup = findings.find(
        (f) => f.type === 'duplicate_call' && f.summary.includes(inj.marker)
      );
      if (dup) booked = (booked ?? 0) + dup.tokensWasted;
    }
    if (!hit) {
      hit = findings.find(
        (f) => f.type === type && f.tokensWasted === inj.expected && f.turnIndex === inj.turnIndex
      );
      booked = hit?.tokensWasted ?? null;
    }
    return {
      type,
      session,
      expected: inj.expected,
      found: hit !== undefined,
      booked,
      relError: hit ? Math.abs((booked ?? 0) - inj.expected) / inj.expected : null,
    };
  });
}

export interface TypeScore {
  type: InjectableType;
  attempts: number;
  recalled: number;
  /** recalled / attempts, null when nothing was attempted */
  recall: number | null;
  /** median of |booked − expected| / expected over recalled injections */
  medianRelError: number | null;
}

export function scoreOutcomes(outcomes: InjectionOutcome[]): TypeScore[] {
  return INJECTABLE_TYPES.map((type) => {
    const rows = outcomes.filter((o) => o.type === type && !o.skipped);
    const errs = rows
      .filter((r) => r.found)
      .map((r) => r.relError!)
      .sort((a, b) => a - b);
    const mid = Math.floor(errs.length / 2);
    const median =
      errs.length === 0
        ? null
        : errs.length % 2 === 1
          ? errs[mid]
          : (errs[mid - 1] + errs[mid]) / 2;
    return {
      type,
      attempts: rows.length,
      recalled: errs.length,
      recall: rows.length > 0 ? errs.length / rows.length : null,
      medianRelError: median,
    };
  });
}

// =============================================================================
// CLI report — pnpm waste:recall (CORPUS_DIR, never prints session content)
// =============================================================================

const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

async function main(): Promise<void> {
  const corpusDir = resolveCorpusDir(process.env, process.cwd());
  if (!corpusDir) {
    console.error(
      'CORPUS_DIR is not set — copy .env.example to .env and point CORPUS_DIR at a local dir with session .jsonl files. The corpus never enters the repo.'
    );
    process.exitCode = 1;
    return;
  }
  const files = listSessionFiles(corpusDir);
  if (files.length === 0) {
    console.error(`no .jsonl sessions found in CORPUS_DIR: ${corpusDir}`);
    process.exitCode = 1;
    return;
  }

  const outcomes: InjectionOutcome[] = [];
  for (const file of files) {
    const messages = await parseJsonlFile(file);
    outcomes.push(...evaluateInjection(messages, file.slice(corpusDir.length + 1)));
  }
  const scores = scoreOutcomes(outcomes);

  console.log(
    `waste:recall — ${files.length} corpus session(s), ${INJECTABLE_TYPES.length} injected pattern types`
  );
  console.log('recall = found/attempts; |err| = |tokensWasted − injected| / injected');
  console.log(
    `${pad('type', 20)} ${padL('recall', 8)} ${padL('median|err|', 12)} ${padL('recalled', 9)} ${padL('attempts', 9)}`
  );
  for (const s of scores) {
    console.log(
      `${pad(s.type, 20)} ${padL(pct(s.recall), 8)} ${padL(pct(s.medianRelError), 12)} ${padL(String(s.recalled), 9)} ${padL(String(s.attempts), 9)}`
    );
  }
  const missed = outcomes.filter((o) => !o.found && !o.skipped);
  const skipped = outcomes.filter((o) => o.skipped);
  if (missed.length > 0) {
    console.log('\nmissed injections:');
    for (const m of missed)
      console.log(`  ${m.session ?? '(session)'}: ${m.type} (expected ${m.expected} tok)`);
  }
  if (skipped.length > 0) {
    console.log(`\n${skipped.length} skipped (no insertion point — session too small)`);
  }
}

function padL(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

if (isDirectRun(import.meta.url)) {
  void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
