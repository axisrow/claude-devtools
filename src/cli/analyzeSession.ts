/**
 * Session token audit CLI — where do billed tokens go, and what was wasted.
 *
 * Numbers only: exact per-turn/per-round usage from JSONL (input / cache_read /
 * cache_write / output), waste findings, slow-subagent table. No transcript.
 *
 * Usage:
 *   pnpm analyze:session <path-to.jsonl> [flags]
 *   pnpm analyze:session --project <encoded-dir-or-name> --last [flags]
 * Flags:
 *   --rounds N                rounds table length (default 20)
 *   --turn N                  deep-dive into turn N: verdict «цикл или длинный ход», findings, rounds
 *   --subagent-min-minutes N  slow-subagent threshold (default 5)
 *   --min-severity S          low | medium | high (default low = all)
 *   --breakdown               per-model token/cost breakdown
 *   --since / --until DATE    only activity within the range (YYYY-MM-DD or YYYYMMDD)
 *   --last [N]                no value: newest session of --project; N: last N calendar days
 *   --no-cost                 omit cost estimates
 *   --json                    machine-readable output
 */

import { ProjectScanner, SubagentResolver } from '@main/services/discovery';
import { isParsedUserChunkMessage } from '@main/types';
import { deduplicateByRequestId, getTaskCalls, parseJsonlFile } from '@main/utils/jsonl';
import { encodePath, extractSessionId, getProjectsBasePath } from '@main/utils/pathDecoder';
import { isQuietTick, isStalledRound, WAIT_LOOP_MIN_TICKS } from '@shared/constants/loopPolicy';
import { asText, bashStem, normalizeCallKey } from '@shared/utils/callKey';
import { parseModelString } from '@shared/utils/modelParser';
import {
  estimateTokens,
  formatTokensCompact,
  formatTokensDetailed,
} from '@shared/utils/tokenFormatting';
import * as fs from 'fs';
import * as path from 'path';

import {
  inDateRange,
  isDirectRun,
  lastDaysSince,
  parseDayBound,
  takeFlagValue,
  wantsHelp,
} from './args';

import type { ParsedMessage, Process } from '@main/types';

// ponytail: single-file pricing table; extract to a module when something else needs it
// glm: public rates (OpenRouter/z.ai, verified 2026-09-21); cache write assumed = input rate
const PRICE_PER_MTOK: Record<string, [number, number, number, number]> = {
  opus: [15, 75, 1.5, 18.75],
  sonnet: [3, 15, 0.3, 3.75],
  haiku: [1, 5, 0.1, 1.25],
  glm: [0.075, 0.25, 0.015, 0.075],
};

// pricing family: claude via parser; other models — first id segment (glm-5.3-flash → glm)
function priceFamily(model: string): string {
  return parseModelString(model)?.family ?? model.toLowerCase().split('-')[0];
}

export type BillingScheme = 'anthropic-style' | 'router-style' | 'no-cache' | 'mixed';

// anthropic-style billing has cache_write > 0 on rounds; routers typically report
// cache_read without any write counter — cw=0 with cr>0 is the router signature
export function detectBillingScheme(
  rounds: { cacheReadTokens: number; cacheCreationTokens: number }[]
): BillingScheme {
  let sawWrite = false;
  let sawRead = false;
  for (const r of rounds) {
    if (r.cacheCreationTokens > 0) sawWrite = true;
    else if (r.cacheReadTokens > 0) sawRead = true;
  }
  return billingFromFlags(sawWrite, sawRead);
}

export function billingFromFlags(sawWrite: boolean, sawRead: boolean): BillingScheme {
  if (sawWrite && sawRead) return 'mixed';
  if (sawWrite) return 'anthropic-style';
  if (sawRead) return 'router-style';
  return 'no-cache';
}

export const WASTE_THRESHOLDS = {
  oversizedOutputTokens: 8000,
  contextSpikeTokens: 30000,
  cacheDeadContextTokens: 20000,
  thinkingHeavyTokens: 8000,
  longTurnActiveMinutes: 45,
  loopStreakMin: 3,
  waitLoopTicks: WAIT_LOOP_MIN_TICKS, // from @shared/constants/loopPolicy — shared with the renderer
} as const;

// gaps between a turn's rounds longer than this are idle, not work
// ponytail: calibration knob — tune after live runs
export const TURN_IDLE_GAP_CAP_MINUTES = 10;

// wait-loop tick thresholds live in @shared/constants/loopPolicy — the
// renderer's Visible Context wait-loop category uses the same numbers
export { isQuietTick };

// Tool results that look like errors but are normal flow (user said no / aborted)
const REJECTION_PATTERNS = [
  "The user doesn't want to proceed with this tool use",
  '[Request interrupted by user',
];

export type FindingType =
  | 'duplicate_call'
  | 'failed_call'
  | 'oversized_output'
  | 'context_spike'
  | 'cache_dead'
  | 'thinking_heavy'
  | 'long_turn'
  | 'loop_streak'
  | 'stall_streak'
  | 'wait_loop'
  | 'cycle_motif'
  | 'probe_no_progress';

export interface Finding {
  type: FindingType;
  severity: 'low' | 'medium' | 'high';
  tokensWasted: number;
  turnIndex?: number;
  summary: string;
}

// run of back-to-back identical calls being tracked for loop_streak
interface StreakState {
  count: number;
  tokens: number;
  errors: number;
  turn?: number;
  start: Date;
  end: Date;
}

export interface RoundRow {
  index: number;
  timestamp: Date;
  turnIndex: number;
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  contextSize: number;
  contextDelta: number;
  thinkingTokens: number;
  tools: string[];
  /** router-retry copy of the previous round — counted in sums, excluded from findings (#15) */
  isRetryCopy?: boolean;
}

export interface TurnRow {
  index: number;
  start: Date;
  /** active work time: inter-round gaps capped at TURN_IDLE_GAP_CAP_MINUTES */
  activeMinutes: number;
}

export interface SessionLedger {
  turns: TurnRow[];
  rounds: RoundRow[];
  totals: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    outputTokens: number;
    billedTokens: number;
    rereadShare: number;
    thinkingTokens: number;
    noUsageRounds: number;
    retryCopies: number;
    longestTurn?: { turn: number; activeMinutes: number; rounds: number };
    costUsd?: number;
    costPartial?: boolean;
  };
  models: string[];
  durationMs: number;
  /** sum of turn activeMinutes — API work time, idle excluded (the honest "how long did it run") */
  activeMinutes: number;
  billing: BillingScheme;
}

// =============================================================================
// Ledger (port of the validated prototype)
// =============================================================================

function thinkingTokensOf(msg: ParsedMessage): number {
  if (!Array.isArray(msg.content)) return 0;
  let chars = 0;
  for (const block of msg.content) {
    if (block.type === 'thinking') chars += (block.thinking ?? '').length;
  }
  return Math.ceil(chars / 4);
}

// cost of one round at the built-in price table; null = unpriced model
export function roundCostUsd(r: RoundRow): number | null {
  const price = PRICE_PER_MTOK[priceFamily(r.model)] ?? null;
  if (!price) return null;
  return (
    (r.inputTokens * price[0] +
      r.outputTokens * price[1] +
      r.cacheReadTokens * price[2] +
      r.cacheCreationTokens * price[3]) /
    1e6
  );
}

// active work time of a turn: gaps between consecutive rounds, each capped —
// hours of orchestrator silence between pings count as zero, not as a "turn"
export function turnActiveMinutes(rounds: RoundRow[]): number {
  let ms = 0;
  for (let i = 1; i < rounds.length; i++) {
    const gap = rounds[i].timestamp.getTime() - rounds[i - 1].timestamp.getTime();
    ms += Math.min(Math.max(gap, 0), TURN_IDLE_GAP_CAP_MINUTES * 60000);
  }
  return Math.round(ms / 60000);
}

// one grouping of rounds by turn, shared by totals, findings and the report
function roundsByTurn(rounds: RoundRow[]): Map<number, RoundRow[]> {
  const byTurn = new Map<number, RoundRow[]>();
  for (const r of rounds) {
    const list = byTurn.get(r.turnIndex);
    if (list) list.push(r);
    else byTurn.set(r.turnIndex, [r]);
  }
  return byTurn;
}

const countTools = (rs: RoundRow[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const r of rs) {
    for (const name of r.tools) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
};

export function totalsFromRounds(rounds: RoundRow[]): SessionLedger['totals'] {
  const t = {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    billedTokens: 0,
    rereadShare: 0,
    thinkingTokens: 0,
  };
  let costUsd = 0;
  let unpriced = false;
  for (const r of rounds) {
    t.inputTokens += r.inputTokens;
    t.cacheReadTokens += r.cacheReadTokens;
    t.cacheCreationTokens += r.cacheCreationTokens;
    t.outputTokens += r.outputTokens;
    t.thinkingTokens += r.thinkingTokens;
    const c = roundCostUsd(r);
    if (c === null) unpriced = true;
    else costUsd += c;
  }
  t.billedTokens = t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens + t.outputTokens;
  t.rereadShare = t.billedTokens > 0 ? t.cacheReadTokens / t.billedTokens : 0;
  const noUsageRounds = rounds.filter((r) => r.contextSize === 0).length;
  const retryCopies = rounds.filter((r) => r.isRetryCopy === true).length;
  let longestTurn: SessionLedger['totals']['longestTurn'];
  for (const [turn, rs] of roundsByTurn(rounds)) {
    const active = turnActiveMinutes(rs);
    if (!longestTurn || active > longestTurn.activeMinutes) {
      longestTurn = { turn, activeMinutes: active, rounds: rs.length };
    }
  }
  return {
    ...t,
    noUsageRounds,
    retryCopies,
    ...(longestTurn ? { longestTurn } : {}),
    ...(costUsd > 0 ? { costUsd, costPartial: unpriced } : {}),
  };
}

export interface ModelBreakdownRow {
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  billedTokens: number;
  costUsd?: number;
}

// --breakdown: per-model token/cost totals; costUsd dropped when any round of
// that model is unpriced (no partial per-model figures). withCost=false is the
// --no-cost mode: no cost figures at all.
export function breakdownFromRounds(rounds: RoundRow[], withCost = true): ModelBreakdownRow[] {
  const byModel = new Map<string, ModelBreakdownRow>();
  for (const r of rounds) {
    let row = byModel.get(r.model);
    if (!row) {
      row = {
        model: r.model,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        billedTokens: 0,
      };
      byModel.set(r.model, row);
    }
    row.inputTokens += r.inputTokens;
    row.cacheReadTokens += r.cacheReadTokens;
    row.cacheCreationTokens += r.cacheCreationTokens;
    row.outputTokens += r.outputTokens;
    row.billedTokens += r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens + r.outputTokens;
    if (withCost) {
      const c = roundCostUsd(r);
      if (c === null) delete row.costUsd;
      else row.costUsd = (row.costUsd ?? 0) + c;
    }
  }
  return [...byModel.values()].sort((a, b) => b.billedTokens - a.billedTokens);
}

// --since/--until: keep rounds inside the window, recompute everything derived
export function filterLedgerByDate(
  ledger: SessionLedger,
  since?: Date,
  until?: Date
): SessionLedger {
  if (!since && !until) return ledger;
  const rounds = ledger.rounds.filter((r) => inDateRange(r.timestamp, since, until));
  const keptTurns = new Set(rounds.map((r) => r.turnIndex));
  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;
  for (const r of rounds) {
    minTs = Math.min(minTs, r.timestamp.getTime());
    maxTs = Math.max(maxTs, r.timestamp.getTime());
  }
  // turns are copies: activeMinutes must reflect the filtered window, not the
  // whole session
  const byTurn = roundsByTurn(rounds);
  const turns = ledger.turns
    .filter((t) => keptTurns.has(t.index))
    .map((t) => ({ ...t, activeMinutes: turnActiveMinutes(byTurn.get(t.index) ?? []) }));
  return {
    turns,
    rounds,
    totals: totalsFromRounds(rounds),
    models: [...new Set(rounds.map((r) => r.model))],
    durationMs: Number.isFinite(minTs) ? Math.max(0, maxTs - minTs) : 0,
    activeMinutes: turns.reduce((s, t) => s + t.activeMinutes, 0),
    billing: detectBillingScheme(rounds),
  };
}

// router retries re-log the same response without a requestId (#15): identical
// counters, seconds apart. Comparison anchors on the last real round — ghosts
// (#14) and copies themselves never anchor, so ghost runs don't false-match and
// a ghost between original and copy doesn't hide the copy. Used by both the
// ledger (round flags) and findings (skip the copies' tool calls).
export function getRetryCopyMessageIds(allMessages: ParsedMessage[]): Set<string> {
  const copies = new Set<string>();
  let anchor: {
    model: string;
    input: number;
    cr: number;
    cw: number;
    out: number;
    ts: number;
  } | null = null;
  for (const msg of deduplicateByRequestId(allMessages)) {
    if (isParsedUserChunkMessage(msg)) continue;
    if (msg.type !== 'assistant' || msg.isSidechain) continue;
    if (!msg.usage || msg.model === '<synthetic>') continue;
    const u = msg.usage;
    const input = u.input_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const isCopy =
      anchor !== null &&
      !msg.requestId &&
      anchor.model === (msg.model ?? 'unknown') &&
      anchor.input === input &&
      anchor.cr === cacheRead &&
      anchor.cw === cacheWrite &&
      anchor.out === output &&
      msg.timestamp.getTime() - anchor.ts <= 120_000;
    if (isCopy) copies.add(msg.uuid);
    if (input + cacheRead + cacheWrite > 0 && !isCopy) {
      anchor = {
        model: msg.model ?? 'unknown',
        input,
        cr: cacheRead,
        cw: cacheWrite,
        out: output,
        ts: msg.timestamp.getTime(),
      };
    }
  }
  return copies;
}

export function buildLedger(allMessages: ParsedMessage[]): SessionLedger {
  const messages = deduplicateByRequestId(allMessages);
  const retryCopies = getRetryCopyMessageIds(messages);

  const turns: TurnRow[] = [];
  const rounds: RoundRow[] = [];
  const models = new Set<string>();
  let currentTurn: TurnRow | null = null;
  let prevContext = 0;
  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;

  const newTurn = (ts: Date): TurnRow => {
    const turn: TurnRow = { index: turns.length + 1, start: ts, activeMinutes: 0 };
    turns.push(turn);
    currentTurn = turn;
    return turn;
  };

  for (const msg of messages) {
    minTs = Math.min(minTs, msg.timestamp.getTime());
    maxTs = Math.max(maxTs, msg.timestamp.getTime());

    if (msg.isCompactSummary) continue; // structural message — not a turn (app numbering, jsonl.ts:545)
    if (isParsedUserChunkMessage(msg)) {
      newTurn(msg.timestamp);
      continue;
    }
    if (msg.type !== 'assistant' || msg.isSidechain) continue;
    if (!msg.usage || msg.model === '<synthetic>') continue;

    const turn = currentTurn ?? newTurn(msg.timestamp);
    const u = msg.usage;
    const input = u.input_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const contextSize = input + cacheRead + cacheWrite;
    const think = thinkingTokensOf(msg);
    const model = msg.model ?? 'unknown';
    const tools = msg.toolCalls.map((tc) => tc.name);

    const isRetryCopy = retryCopies.has(msg.uuid);

    const round: RoundRow = {
      index: rounds.length + 1,
      timestamp: msg.timestamp,
      turnIndex: turn.index,
      model,
      inputTokens: input,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheWrite,
      outputTokens: output,
      contextSize,
      // empty rounds (provider ghosts, #14) must not drag the baseline to 0
      contextDelta: rounds.length === 0 || contextSize === 0 ? 0 : contextSize - prevContext,
      thinkingTokens: think,
      tools,
      isRetryCopy: isRetryCopy || undefined,
    };
    if (contextSize > 0) prevContext = contextSize;
    rounds.push(round);
    models.add(model);
  }

  const byTurn = roundsByTurn(rounds);
  for (const turn of turns) {
    turn.activeMinutes = turnActiveMinutes(byTurn.get(turn.index) ?? []);
  }

  return {
    turns,
    rounds,
    totals: totalsFromRounds(rounds),
    models: [...models],
    durationMs: Number.isFinite(minTs) ? Math.max(0, maxTs - minTs) : 0,
    activeMinutes: turns.reduce((s, t) => s + t.activeMinutes, 0),
    billing: detectBillingScheme(rounds),
  };
}

// =============================================================================
// Findings
// =============================================================================

export { bashStem, normalizeCallKey } from '@shared/utils/callKey';

function resultText(content: string | unknown[]): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

// since/until scope the tool-call walk (duplicate/failed/oversized) to the same
// window as the ledger; the results map is still built from ALL messages, so a
// call inside the window resolves a result that landed after --until
export function computeFindings(
  messages: ParsedMessage[],
  ledger: SessionLedger,
  since?: Date,
  until?: Date
): Finding[] {
  const findings: Finding[] = [];
  const th = WASTE_THRESHOLDS;

  const results = new Map<string, { content: string | unknown[]; isError: boolean }>();
  for (const msg of messages) {
    if (msg.isSidechain) continue;
    for (const r of msg.toolResults) {
      results.set(r.toolUseId, { content: r.content, isError: r.isError });
    }
  }

  // duplicate / failed / oversized — walk tool calls in order
  // re-logged router copies (#15) are skipped: their calls were already walked
  // with the original — counting them doubles duplicate/failed/oversized
  const retryCopies = getRetryCopyMessageIds(messages);
  const seen = new Map<string, { count: number; tokens: number; first: number }>();

  // loop_streak: the same call repeated back-to-back — model no-op loops
  // (Bash true x114) and env retry loops (same failure hammered). Turn
  // attribution walks the ledger's turn starts (sorted by construction).
  let turnCursor = 0;
  const turnOf = (ts: number): number | undefined => {
    const turns = ledger.turns;
    if (turns.length === 0 || ts < turns[0].start.getTime()) return undefined;
    while (turnCursor + 1 < turns.length && turns[turnCursor + 1].start.getTime() <= ts) {
      turnCursor += 1;
    }
    return turns[turnCursor].index;
  };
  let streakKey: string | null = null;
  let streak: StreakState | null = null;
  const flushStreak = (): void => {
    if (streak && streakKey && streak.count >= th.loopStreakMin) {
      const env = streak.errors === streak.count;
      findings.push({
        type: 'loop_streak',
        severity: streak.count >= 5 ? 'high' : 'medium',
        tokensWasted: streak.tokens,
        turnIndex: streak.turn,
        summary: `${short(streakKey, 60)} — x${streak.count} back-to-back (${env ? 'env loop — same failure each time' : 'no-op loop'}) ${hhmm(streak.start)}–${hhmm(streak.end)}`,
      });
    }
    streak = null;
    streakKey = null;
  };

  for (const msg of messages) {
    if (msg.isSidechain) continue;
    if (retryCopies.has(msg.uuid)) continue;
    if (!inDateRange(msg.timestamp, since, until)) continue;
    for (const call of msg.toolCalls) {
      // bashStem: `git show X | wc -l` variants bucket as one loop — same key
      // as the live LoopDetector and the inventory (one definition everywhere)
      const key = bashStem(normalizeCallKey(call.name, call.input));
      const result = results.get(call.id);
      const text = result ? resultText(result.content) : '';
      const resultTok = estimateTokens(text);

      if (streak && streakKey === key) {
        streak.count += 1;
        streak.tokens += resultTok;
        if (result?.isError) streak.errors += 1;
        streak.end = msg.timestamp;
      } else {
        flushStreak();
        streakKey = key;
        streak = {
          count: 1,
          tokens: 0,
          errors: result?.isError ? 1 : 0,
          turn: turnOf(msg.timestamp.getTime()),
          start: msg.timestamp,
          end: msg.timestamp,
        };
      }

      if (result?.isError) {
        const rejected = REJECTION_PATTERNS.some((p) => text.includes(p));
        if (!rejected) {
          const inputTok = estimateTokens(JSON.stringify(call.input));
          findings.push({
            type: 'failed_call',
            severity: 'medium',
            tokensWasted: inputTok + resultTok,
            summary: `${call.name} failed: ${short(text, 80)}`,
          });
        }
      }
      if (resultTok > th.oversizedOutputTokens) {
        findings.push({
          type: 'oversized_output',
          severity: 'medium',
          tokensWasted: resultTok,
          summary: `${call.name} returned ~${formatTokensCompact(resultTok)} tok: ${short(call.name === 'Bash' ? asText(call.input.command) : JSON.stringify(call.input), 70)}`,
        });
      }

      const prev = seen.get(key);
      if (prev) {
        prev.count += 1;
        prev.tokens += resultTok;
      } else {
        seen.set(key, { count: 1, tokens: resultTok, first: resultTok });
      }
    }
  }
  flushStreak();
  for (const [key, { count, tokens, first }] of seen) {
    if (count > 1) {
      const reread = tokens - first; // repeats only — the first read was legitimate
      findings.push({
        type: 'duplicate_call',
        severity: 'medium',
        tokensWasted: reread,
        summary: `${short(key, 90)} — called ${count}x (~${formatTokensCompact(reread)} tok of results re-read)`,
      });
    }
  }

  // context-side findings from the ledger
  for (const r of ledger.rounds) {
    if (r.isRetryCopy) continue; // findings already reported for the original round
    if (r.contextDelta > th.contextSpikeTokens) {
      findings.push({
        type: 'context_spike',
        severity: 'high',
        tokensWasted: r.contextDelta,
        turnIndex: r.turnIndex,
        summary: `context +${formatTokensCompact(r.contextDelta)} in one round (${formatTokensCompact(r.contextSize - r.contextDelta)} → ${formatTokensCompact(r.contextSize)}), tools: ${r.tools.join(', ') || 'none'}`,
      });
    }
    if (
      r.contextSize > th.cacheDeadContextTokens &&
      r.cacheReadTokens === 0 &&
      r.cacheCreationTokens === 0
    ) {
      findings.push({
        type: 'cache_dead',
        severity: 'high',
        tokensWasted: r.contextSize,
        turnIndex: r.turnIndex,
        summary: `no prompt caching: ${formatTokensCompact(r.contextSize)} tok billed as fresh input (model ${r.model})`,
      });
    }
  }
  const byTurn = roundsByTurn(ledger.rounds);
  for (const turn of ledger.turns) {
    const rs = byTurn.get(turn.index) ?? [];
    const think = rs.reduce((s, r) => s + r.thinkingTokens, 0);
    if (think > th.thinkingHeavyTokens) {
      findings.push({
        type: 'thinking_heavy',
        severity: 'low',
        tokensWasted: think,
        turnIndex: turn.index,
        summary: `thinking ~${formatTokensCompact(think)} tok in turn ${turn.index}`,
      });
    }
    if (turn.activeMinutes >= th.longTurnActiveMinutes) {
      const calls = rs.reduce((s, r) => s + r.tools.length, 0);
      const top = [...countTools(rs)]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([n, c]) => `${n} ${c}`)
        .join(', ');
      findings.push({
        type: 'long_turn',
        severity: 'high',
        // observation, not waste — unlike other findings this books no redundant
        // tokens (the summary carries the activity numbers), so consumers summing
        // tokensWasted don't count a healthy turn's whole billing as waste
        tokensWasted: 0,
        turnIndex: turn.index,
        summary: `active ${turn.activeMinutes} min, ${calls} tool calls (${top || 'no tools'})`,
      });
    }
    // A tick is an IDLE round (no tool call) — see isQuietTick in loopPolicy:
    // with a large baseline context, ordinary working rounds (short tool
    // calls) would otherwise satisfy the context/output thresholds too
    const ticks = rs.filter(
      (r) => !r.isRetryCopy && isQuietTick(r.contextSize, r.outputTokens, r.tools.length)
    );
    if (ticks.length >= th.waitLoopTicks) {
      const wasted = ticks.reduce((s, r) => s + r.contextSize, 0);
      findings.push({
        type: 'wait_loop',
        severity: ticks.length >= 20 ? 'high' : 'medium',
        tokensWasted: wasted,
        turnIndex: turn.index,
        summary: `wait-loop: ${ticks.length} quiet rounds re-read ~${formatTokensCompact(wasted)} tok (≤300 tok of output each)`,
      });
    }

    // A stall is the tool-call counterpart of a quiet tick: rounds that MAKE
    // calls yet stop growing the context (echo-marker loops like `echo w/v/u`
    // — distinct args, so the repeat-key walk above sees no streak). See
    // isStalledRound in loopPolicy.
    let stallStart: RoundRow | null = null;
    let stallEnd: RoundRow | null = null;
    let stallCount = 0;
    let stallWasted = 0;
    const flushStall = (): void => {
      if (stallCount >= th.loopStreakMin && stallStart && stallEnd) {
        findings.push({
          type: 'stall_streak',
          severity: stallCount >= 5 ? 'high' : 'medium',
          tokensWasted: stallWasted,
          turnIndex: turn.index,
          summary: `stall: ${stallCount} rounds with no context growth re-read ~${formatTokensCompact(stallWasted)} tok (${short(stallStart.tools.join(', ') || 'tool calls', 40)}) ${hhmm(stallStart.timestamp)}–${hhmm(stallEnd.timestamp)}`,
        });
      }
      stallStart = null;
      stallEnd = null;
      stallCount = 0;
      stallWasted = 0;
    };
    let stallPrev = 0;
    for (const r of rs) {
      if (r.isRetryCopy) continue; // copies already walked with their original
      if (isStalledRound(stallPrev, r.contextSize, r.outputTokens, r.tools.length)) {
        if (stallCount === 0) stallStart = r;
        stallCount += 1;
        stallWasted += r.contextSize;
        stallEnd = r;
      } else {
        flushStall();
      }
      // ghost rounds must not drag the baseline (same rule as buildLedger)
      if (r.contextSize > 0) stallPrev = r.contextSize;
    }
    flushStall();
  }

  const order = { high: 0, medium: 1, low: 2 } as const;
  findings.push(...detectCycleFindings(messages, ledger, results));
  findings.sort((a, b) => order[b.severity] - order[a.severity] || b.tokensWasted - a.tokensWasted);
  return findings;
}

export function short(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}

// =============================================================================
// Cycle detection — «цикл или длинный ход»
// =============================================================================

// ponytail: calibration knobs — tune after live runs on real sessions
const CYCLE = { minLen: 3, maxLen: 5, minRepeats: 3 } as const;

// Edit/Write results are "updated successfully" by construction — a repeated
// successful mutation is not a probe; probes return DATA (Bash/Read/Grep/…)
const MUTATING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** first + last non-empty line — cheap discriminator (pytest tail, refusal
 * reason); full texts differ in noise while meaning stays the same */
// ponytail: upgrade to fuzzy compare if false positives show up
function resultSignature(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // last line only — the verdict line (pytest tail, refusal summary); first
  // lines are banners (config/vacancy echo) that differ across retries.
  // Volatile ids (run uuids, hashes) are stripped — they differ per attempt.
  return (lines[lines.length - 1] ?? '').replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    '<id>'
  );
}

interface CycleRound {
  turnIndex: number;
  contextSize: number;
  timestamp: Date;
  calls: { toolName: string; key: string; sig: string; tok: number }[];
}

/**
 * Findings invisible to the streak/stall walks: a repeating SEQUENCE of
 * distinct calls (edit → lint → test → battle run) where context keeps
 * growing — diagnose-fix-verify churn. Plus the no-progress signal: a probe
 * call re-run with an identical result signature. Called from
 * computeFindings so every consumer (text + json) gets them.
 */
export function detectCycleFindings(
  messages: ParsedMessage[],
  ledger: SessionLedger,
  results: Map<string, { content: string | unknown[]; isError: boolean }>
): Finding[] {
  const findings: Finding[] = [];
  // same round source as buildLedger (dedup + filters), retry copies dropped
  // on both sides — positional zip with ledger.rounds; drift → skip whole
  // detection (ponytail: the lists have matched on every real session so far)
  const retryCopies = getRetryCopyMessageIds(messages);
  const msgs = deduplicateByRequestId(messages).filter(
    (m) =>
      m.type === 'assistant' &&
      !m.isSidechain &&
      !!m.usage &&
      m.model !== '<synthetic>' &&
      !retryCopies.has(m.uuid)
  );
  const ledgerRounds = ledger.rounds.filter((r) => !r.isRetryCopy);
  if (msgs.length !== ledgerRounds.length) return findings;

  const rounds: CycleRound[] = msgs.map((m, i) => ({
    turnIndex: ledgerRounds[i].turnIndex,
    contextSize: ledgerRounds[i].contextSize,
    timestamp: ledgerRounds[i].timestamp,
    calls: m.toolCalls.map((c) => {
      const res = results.get(c.id);
      const text = res ? resultText(res.content) : '';
      return {
        toolName: c.name,
        key: bashStem(normalizeCallKey(c.name, c.input)),
        sig: res ? resultSignature(text) : '',
        tok: res ? estimateTokens(text) : 0,
      };
    }),
  }));

  const byTurn = new Map<number, CycleRound[]>();
  for (const r of rounds) {
    const list = byTurn.get(r.turnIndex);
    if (list) list.push(r);
    else byTurn.set(r.turnIndex, [r]);
  }

  for (const [turnIndex, rs] of byTurn) {
    // motif = a window of L rounds repeating consecutively ≥ CYCLE.minRepeats;
    // longest L wins, one pass at that L per turn (no re-scan of consumed
    // regions at smaller L — same cycle, not a second finding)
    for (let L = CYCLE.maxLen; L >= CYCLE.minLen; L--) {
      let hit = false;
      let i = 0;
      while (i + L * CYCLE.minRepeats <= rs.length) {
        let reps = 1;
        const eq = (a: number, b: number): boolean => {
          for (let k = 0; k < L; k++) {
            if (
              rs[a + k].calls.length !== rs[b + k].calls.length ||
              rs[a + k].calls.some((c, j) => c.key !== rs[b + k].calls[j].key)
            ) {
              return false;
            }
          }
          return true;
        };
        while (i + (reps + 1) * L <= rs.length && eq(i, i + reps * L)) reps += 1;
        if (reps >= CYCLE.minRepeats) {
          hit = true;
          const motif = rs
            .slice(i, i + L)
            .map((r) => short(r.calls.map((c) => c.key).join('+') || '—', 24))
            .join(' → ');
          const wasted = rs.slice(i + L, i + reps * L).reduce((s, r) => s + r.contextSize, 0);
          findings.push({
            type: 'cycle_motif',
            severity: reps >= 4 ? 'high' : 'medium',
            tokensWasted: wasted,
            turnIndex,
            summary: `cycle: ${motif} — x${reps} repeats re-read ~${formatTokensCompact(wasted)} tok ${hhmm(rs[i].timestamp)}–${hhmm(rs[i + reps * L - 1].timestamp)}`,
          });
          i += reps * L;
        } else {
          i += 1;
        }
      }
      if (hit) break;
    }

    // probe with the same result: same call key re-run, identical first+last
    // line — the loop re-asked its question without learning anything
    const byKey = new Map<string, { sig: string; ts: Date; tok: number }[]>();
    for (const r of rs) {
      for (const c of r.calls) {
        if (!c.sig || MUTATING_TOOLS.has(c.toolName)) continue;
        const list = byKey.get(c.key);
        const entry = { sig: c.sig, ts: r.timestamp, tok: c.tok };
        if (list) list.push(entry);
        else byKey.set(c.key, [entry]);
      }
    }
    for (const [key, list] of byKey) {
      if (list.length < 2) continue;
      let best = { len: 1, start: 0, end: 0 };
      let run = 1;
      for (let j = 1; j < list.length; j++) {
        run = list[j].sig && list[j].sig === list[j - 1].sig ? run + 1 : 1;
        if (run > best.len) best = { len: run, start: j - run + 1, end: j };
      }
      if (best.len < 2) continue;
      const repeats = list.slice(best.start + 1, best.end + 1);
      findings.push({
        type: 'probe_no_progress',
        severity: 'medium',
        tokensWasted: repeats.reduce((s, e) => s + e.tok, 0),
        turnIndex,
        summary: `probe no progress: ${short(key, 60)} — same result x${best.len}: ${short(list[best.start].sig, 70)}`,
      });
    }
  }
  return findings;
}

export type TurnVerdict = 'cycle-churning' | 'cycle-progressing' | 'long-turn' | 'normal';

/** «Цикл или длинный ход?» — the deep-dive verdict, pure function of findings
 * + round stats. Churning beats progressing: same-result probes mean parts of
 * the cycle stopped converging even if the motif is legitimate work. */
export function turnVerdict(
  findings: Finding[],
  rounds: number,
  activeMinutes: number
): TurnVerdict {
  const types = new Set(findings.map((f) => f.type));
  if (types.has('probe_no_progress')) return 'cycle-churning';
  if (types.has('cycle_motif')) return 'cycle-progressing';
  // ponytail: 30 rounds is a working guess; activeMinutes reuses the long-turn knob
  if (rounds >= 30 || activeMinutes >= WASTE_THRESHOLDS.longTurnActiveMinutes) return 'long-turn';
  return 'normal';
}

// =============================================================================
// CLI plumbing
// =============================================================================

interface CliOpts {
  sessionPath?: string;
  projectArg?: string;
  useLast: boolean;
  lastDays?: number;
  rounds: number;
  subagentMinMinutes: number;
  minSeverity: 'low' | 'medium' | 'high';
  json: boolean;
  breakdown: boolean;
  noCost: boolean;
  since?: Date;
  until?: Date;
  turn?: number;
  error?: string;
}

export function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    useLast: false,
    rounds: 20,
    subagentMinMinutes: 5,
    minSeverity: 'low',
    json: false,
    breakdown: false,
    noCost: false,
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    const { value, next } = takeFlagValue(argv, i);
    if (a === '--project') {
      opts.projectArg = value;
      i = next;
      continue;
    }
    if (a === '--rounds') {
      opts.rounds = parseInt(value, 10) || 20;
      i = next;
      continue;
    }
    if (a === '--turn') {
      opts.turn = parseInt(value, 10) || undefined;
      i = next;
      continue;
    }
    if (a === '--subagent-min-minutes') {
      opts.subagentMinMinutes = parseInt(value, 10) || 5;
      i = next;
      continue;
    }
    if (a === '--min-severity') {
      opts.minSeverity = value === 'medium' || value === 'high' ? value : 'low';
      i = next;
      continue;
    }
    if (a === '--since' || a === '--until') {
      const d = parseDayBound(value, a === '--until');
      if (!d) opts.error = `invalid ${a} date (expected YYYY-MM-DD or YYYYMMDD): '${value}'`;
      else if (a === '--since') opts.since = d;
      else opts.until = d;
      i = next;
      continue;
    }
    // numeric --last N = ccusage-style day window; bare --last keeps its older
    // meaning here: pick the newest session file of --project
    if (a === '--last') {
      if (/^[1-9]\d*$/.test(value)) {
        opts.lastDays = parseInt(value, 10);
        opts.since = lastDaysSince(opts.lastDays);
        i = next;
      } else {
        // bare --last, or a token that is not --last's value (e.g. a positional
        // path) — do not swallow it
        opts.useLast = true;
        i += 1;
      }
      continue;
    }
    if (a === '--breakdown') {
      opts.breakdown = true;
      i += 1;
      continue;
    }
    if (a === '--no-cost') {
      opts.noCost = true;
      i += 1;
      continue;
    }
    if (a === '--json') {
      opts.json = true;
      i += 1;
      continue;
    }
    if (!a.startsWith('--')) opts.sessionPath = a;
    i += 1;
  }
  return opts;
}

export function pickNewestSessionFile(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  let newest: { file: string; mtime: number } | null = null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.jsonl') || e.name.startsWith('agent-')) continue;
    const file = path.join(dir, e.name);
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue; // vanished between readdir and stat
    }
    if (!newest || mtime > newest.mtime) newest = { file, mtime };
  }
  return newest?.file ?? null;
}

export function resolveProjectDir(arg: string): string {
  const projectsRoot = getProjectsBasePath();
  // already encoded (full path or bare name) → use under the projects root
  if (path.basename(arg).startsWith('-')) {
    return path.isAbsolute(arg) ? arg : path.join(projectsRoot, arg);
  }
  // plain filesystem path of a project → its encoded sessions dir
  return path.join(projectsRoot, encodePath(path.resolve(arg)));
}

function splitSessionPath(file: string): { projectId: string; sessionId: string } {
  const rel = path.relative(getProjectsBasePath(), path.resolve(file));
  const [projectId, sessionId] = rel.split(path.sep);
  return { projectId, sessionId: sessionId ? extractSessionId(sessionId) : '' };
}

async function resolveSubagentsFor(
  projectId: string,
  sessionId: string,
  messages: ParsedMessage[]
): Promise<Process[]> {
  const scanner = new ProjectScanner();
  const resolver = new SubagentResolver(scanner);
  return resolver.resolveSubagents(projectId, sessionId, getTaskCalls(messages), messages);
}

// =============================================================================
// Output
// =============================================================================

export const pad = (s: string, n: number): string =>
  s.length >= n ? s : s + ' '.repeat(n - s.length);
export const padL = (s: string, n: number): string =>
  s.length >= n ? s : ' '.repeat(n - s.length) + s;
const fmt = (n: number): string => formatTokensDetailed(n);
const hhmm = (d: Date): string =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
export const dur = (ms: number): string =>
  `${Math.floor(ms / 3600000)}h ${String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')}m`;

const VERDICT_LABEL: Record<TurnVerdict, string> = {
  'cycle-churning':
    'ЦИКЛ С ВРАЩЕНИЕМ — участки цикла крутятся без продвижения (проба возвращает тот же результат)',
  'cycle-progressing': 'ЦИКЛ С ПРОДВИЖЕНИЕМ — diagnose-fix-verify, витки отвечают на вопросы',
  'long-turn': 'ДЛИННЫЙ ХОД — много работы, повторяющихся последовательностей нет',
  normal: 'ОБЫЧНЫЙ ХОД',
};

function printTurnDeepDive(
  ledger: SessionLedger,
  findings: Finding[],
  messages: ParsedMessage[],
  turnNo: number,
  opts: CliOpts
): void {
  const turn = ledger.turns[turnNo - 1];
  if (!turn) {
    console.error(`no turn #${turnNo} (session has ${ledger.turns.length})`);
    process.exitCode = 1;
    return;
  }
  const rs = ledger.rounds.filter((r) => r.turnIndex === turnNo);
  const tf = findings.filter((f) => f.turnIndex === turnNo);
  const user = (() => {
    let n = 0;
    for (const m of messages) {
      if (m.isCompactSummary) continue; // same numbering as buildLedger
      if (isParsedUserChunkMessage(m) && ++n === turnNo) return m;
    }
    return null;
  })();
  const preview = user
    ? short(typeof user.content === 'string' ? user.content : JSON.stringify(user.content), 110)
    : '(no user text)';
  const first = rs[0];
  const last = rs[rs.length - 1];
  const span = first ? last.timestamp.getTime() - turn.start.getTime() : 0;
  const verdict = turnVerdict(tf, rs.length, turn.activeMinutes);

  console.log(`=== TURN ${turnNo} ===`);
  console.log(`user  : ${preview}`);
  console.log(
    `span  : ${dur(span)} wall, active ${turn.activeMinutes}m, ${rs.length} rounds, ${rs.reduce((s, r) => s + r.tools.length, 0)} tool calls`
  );
  if (first && last) {
    console.log(
      `ctx   : ${fmt(first.contextSize)} → ${fmt(last.contextSize)} (+${fmt(last.contextSize - first.contextSize)})`
    );
  }
  console.log(`verdict: ${VERDICT_LABEL[verdict]}`);
  console.log('findings:');
  if (tf.length === 0) {
    console.log('  (none)');
  }
  for (const f of tf) {
    console.log(`  [${f.severity}] ${f.type}: ${f.summary}`);
  }
  console.log(`rounds (last ${Math.min(opts.rounds, rs.length)} of ${rs.length}):`);
  for (const r of rs.slice(-opts.rounds)) {
    console.log(
      `  ${padL(String(r.index), 4)} ${pad(hhmm(r.timestamp), 6)} ${padL(fmt(r.contextSize), 9)} ${padL((r.contextDelta >= 0 ? '+' : '') + fmt(r.contextDelta), 9)}  ${short(r.tools.join(','), 48)}`
    );
  }
}

function printReport(
  file: string,
  ledger: SessionLedger,
  findings: Finding[],
  subagents: Process[],
  opts: CliOpts
): void {
  const t = ledger.totals;
  const activeTurns = new Set(ledger.rounds.map((r) => r.turnIndex)).size;
  console.log('=== SESSION ===');
  console.log('file :', path.basename(file));
  console.log(
    `turns: ${activeTurns}  rounds: ${ledger.rounds.length}  active: ${dur(ledger.activeMinutes * 60000)} (wall ${dur(ledger.durationMs)})`
  );
  console.log('models:', ledger.models.join(', ') || 'n/a');
  console.log('billing:', ledger.billing);
  if (t.noUsageRounds > 0) {
    console.log(
      `⚠ ${t.noUsageRounds} rounds have no usage stats — root cause under investigation (#14)`
    );
  }
  if (t.retryCopies > 0) {
    console.log(`ℹ ${t.retryCopies} router-retry copies detected (sums untouched — #15)`);
  }
  if (t.longestTurn) {
    console.log(
      `longest turn: #${t.longestTurn.turn} (active ${t.longestTurn.activeMinutes}m, ${t.longestTurn.rounds} rounds)`
    );
  }
  if (t.costUsd !== undefined && !opts.noCost) {
    const partial = t.costPartial ? ' (partial — unpriced models excluded)' : '';
    console.log('est. cost: $' + t.costUsd.toFixed(2) + partial);
  }
  console.log();
  console.log('=== TOKENS (billed) ===');
  console.log(`input (uncached)     : ${fmt(t.inputTokens)}`);
  console.log(
    `cache_read (reread)  : ${fmt(t.cacheReadTokens)}  <- whole context re-read EVERY round`
  );
  console.log(`cache_write (new)    : ${fmt(t.cacheCreationTokens)}`);
  console.log(`output               : ${fmt(t.outputTokens)}`);
  console.log(`thinking (estimate)  : ~${fmt(t.thinkingTokens)}`);
  console.log(`TOTAL                : ${fmt(t.billedTokens)}`);
  console.log(`reread share         : ${Math.round(t.rereadShare * 100)}%`);
  console.log();
  if (opts.breakdown) {
    const rows = breakdownFromRounds(ledger.rounds);
    console.log('=== BY MODEL ===');
    console.log(
      `${pad('model', 28)} ${padL('in', 8)} ${padL('cr', 8)} ${padL('cw', 8)} ${padL('out', 8)} ${padL('total', 9)}${opts.noCost ? '' : padL('cost', 10)}`
    );
    for (const b of rows) {
      const cost =
        opts.noCost || b.costUsd === undefined ? '' : padL('$' + b.costUsd.toFixed(2), 10);
      console.log(
        `${pad(short(b.model, 28), 28)} ${padL(fmt(b.inputTokens), 8)} ${padL(fmt(b.cacheReadTokens), 8)} ${padL(fmt(b.cacheCreationTokens), 8)} ${padL(fmt(b.outputTokens), 8)} ${padL(fmt(b.billedTokens), 9)}${cost}`
      );
    }
    console.log();
  }
  console.log('=== BY TURN ===');
  console.log(
    `${pad('#', 3)} ${pad('time', 6)} ${padL('dur', 5)} ${padL('context', 9)} ${padL('reread', 9)} ${padL('new', 8)} ${padL('out', 7)} ${pad('think%', 7)}  tools`
  );
  const byTurn = roundsByTurn(ledger.rounds);
  for (const turn of ledger.turns) {
    const rs = byTurn.get(turn.index) ?? [];
    if (rs.length === 0) continue; // trailing user msg / empty implicit turn
    const ctx = rs.filter((r) => r.contextSize > 0).at(-1)?.contextSize ?? 0; // ghosts (#14) don't hide the real context
    const reread = rs.reduce((s, r) => s + r.cacheReadTokens, 0);
    const fresh = rs.reduce((s, r) => s + r.inputTokens + r.cacheCreationTokens, 0);
    const out = rs.reduce((s, r) => s + r.outputTokens, 0);
    const think = rs.reduce((s, r) => s + r.thinkingTokens, 0);
    const genTotal = think + out;
    const thinkPct = genTotal > 0 ? Math.round((think / genTotal) * 100) : 0;
    const toolCounts = countTools(rs);
    const tools = [...toolCounts].map(([n, c]) => `${n} x${c}`).join(', ');
    console.log(
      `${pad(String(turn.index), 3)} ${pad(hhmm(turn.start), 6)} ${padL(turn.activeMinutes + 'm', 5)} ${padL(fmt(ctx), 9)} ${padL(fmt(reread), 9)} ${padL(fmt(fresh), 8)} ${padL(fmt(out), 7)} ${pad(thinkPct + '%', 7)}  ${short(tools, 60)}`
    );
  }
  console.log();
  console.log(`=== ROUNDS (last ${opts.rounds}) ===`);
  console.log(
    `${pad('#', 4)} ${pad('time', 6)} ${padL('context', 9)} ${padL('delta', 9)} ${padL('in', 7)} ${padL('cr', 8)} ${padL('cw', 6)} ${padL('out', 6)}  model`
  );
  for (const r of ledger.rounds.slice(-opts.rounds)) {
    console.log(
      `${pad(String(r.index), 4)} ${pad(hhmm(r.timestamp), 6)} ${padL(fmt(r.contextSize), 9)} ${padL((r.contextDelta >= 0 ? '+' : '') + fmt(r.contextDelta), 9)} ${padL(fmt(r.inputTokens), 7)} ${padL(fmt(r.cacheReadTokens), 8)} ${padL(fmt(r.cacheCreationTokens), 6)} ${padL(fmt(r.outputTokens), 6)}  ${short(r.model, 28)}`
    );
  }
  console.log();

  if (subagents.length > 0) {
    console.log('=== SUBAGENTS ===');
    for (const s of subagents) {
      const slow = s.durationMs > opts.subagentMinMinutes * 60000;
      const flag = slow ? `  !SLOW >${opts.subagentMinMinutes}min` : '';
      const ongoing = s.isOngoing ? ' (ongoing)' : '';
      console.log(
        `${pad(short(s.description ?? s.subagentType ?? s.id, 52), 52)} ${pad(s.subagentType ?? '', 10)} ${padL(dur(s.durationMs), 8)}${flag}${ongoing}  ~${formatTokensCompact(s.metrics?.totalTokens ?? 0)} tok`
      );
    }
    console.log();
  }

  const severityRank = { low: 0, medium: 1, high: 2 } as const;
  const visible = findings.filter(
    (f) => severityRank[f.severity] >= severityRank[opts.minSeverity]
  );
  console.log('=== FINDINGS ===');
  if (visible.length === 0) {
    console.log('(none — clean session)');
  } else {
    for (const f of visible) {
      const turnTag = f.turnIndex === undefined ? '' : ', turn ' + String(f.turnIndex);
      console.log(`[${f.type}${turnTag}] ${f.summary}`);
    }
  }
  console.log();
  console.log(
    'note: this is observation, not prevention — add deny rules for culprit commands in Claude Code settings.'
  );
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  if (wantsHelp(raw)) {
    console.log(
      [
        'usage: pnpm analyze:session <file.jsonl> | --project <dir|encoded> --last [N] [flags]',
        '',
        'flags:',
        '  --rounds N                rounds table length (default 20)',
        '  --turn N                  deep-dive into turn N: verdict «цикл или длинный ход», findings, rounds',
        '  --subagent-min-minutes N  slow-subagent threshold in minutes (default 5)',
        '  --min-severity S          low | medium | high (default low = all)',
        '  --breakdown               per-model token/cost breakdown',
        '  --since DATE              only activity on/after this date (YYYY-MM-DD or YYYYMMDD)',
        '  --until DATE              only activity on/before this date',
        '  --last [N]                no value: analyze newest session of --project;',
        '                            N: only activity of the last N calendar days',
        '  --no-cost                 omit cost estimates',
        '  --json                    machine-readable output',
      ].join('\n')
    );
    return;
  }
  const opts = parseArgs(raw);
  if (opts.error) {
    console.error(opts.error);
    process.exitCode = 1;
    return;
  }

  let sessionFile = opts.sessionPath ? path.resolve(opts.sessionPath) : null;
  if (!sessionFile && opts.projectArg) {
    if (!opts.useLast && opts.lastDays === undefined) {
      console.error('--project requires --last (bare, or with a day count: --last N)');
      process.exitCode = 1;
      return;
    }
    const dir = resolveProjectDir(opts.projectArg);
    if (!fs.existsSync(dir)) {
      console.error(`project dir not found: ${dir}`);
      process.exitCode = 1;
      return;
    }
    sessionFile = pickNewestSessionFile(dir);
    if (!sessionFile) {
      console.error(`no .jsonl sessions found in ${dir}`);
      process.exitCode = 1;
      return;
    }
  }
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    console.error(
      'usage: pnpm analyze:session <file.jsonl>  |  pnpm analyze:session --project <dir> --last'
    );
    process.exitCode = 1;
    return;
  }

  const { projectId, sessionId } = splitSessionPath(sessionFile);
  const messages = await parseJsonlFile(sessionFile);
  const ledger = filterLedgerByDate(buildLedger(messages), opts.since, opts.until);
  const findings = computeFindings(messages, ledger, opts.since, opts.until);
  if (opts.turn) {
    printTurnDeepDive(ledger, findings, messages, opts.turn, opts);
    return;
  }

  let subagents: Process[] = [];
  try {
    subagents = await resolveSubagentsFor(projectId, sessionId, messages);
  } catch (err) {
    console.error(`(subagent resolution unavailable: ${String(err)})`);
  }
  // under --since/--until keep only subagents whose [startTime, endTime]
  // overlaps the same window as the ledger and findings
  if (opts.since || opts.until) {
    subagents = subagents.filter((s) => {
      if (opts.since && s.endTime < opts.since) return false;
      if (opts.until && s.startTime > opts.until) return false;
      return true;
    });
  }

  if (opts.json) {
    // Process carries the full parsed transcript — strip it for the JSON dump
    const subagentSummaries = subagents.map((p) => ({
      id: p.id,
      description: p.description,
      subagentType: p.subagentType,
      durationMs: p.durationMs,
      totalTokens: p.metrics?.totalTokens ?? 0,
      isOngoing: p.isOngoing,
    }));
    // --no-cost: drop cost fields without mutating the live ledger
    const totalsOut = { ...ledger.totals };
    if (opts.noCost) {
      delete totalsOut.costUsd;
      delete totalsOut.costPartial;
    }
    const ledgerOut = opts.noCost ? { ...ledger, totals: totalsOut } : ledger;
    const breakdown = opts.breakdown ? breakdownFromRounds(ledger.rounds, !opts.noCost) : undefined;
    console.log(
      JSON.stringify(
        {
          file: sessionFile,
          projectId,
          sessionId,
          ledger: ledgerOut,
          findings,
          subagents: subagentSummaries,
          ...(breakdown ? { breakdown } : {}),
        },
        null,
        2
      )
    );
    return;
  }
  printReport(sessionFile, ledger, findings, subagents, opts);
}

// run only when executed directly: sessionInventory imports this module for
// helpers, vitest imports it for the pure functions — neither may trigger main
if (isDirectRun(import.meta.url)) {
  void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
