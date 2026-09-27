/**
 * LoopDetector — live detection of tool-call loops in growing session files.
 *
 * Fed incrementally by FileWatcher with appended messages. Flags maximal
 * back-to-back runs of identical tool calls, keyed like the inventory's
 * cycles (bashStem(normalizeCallKey)) so `git show X | wc -l` variants and
 * offset-only Read repeats bucket as one loop. Notification policy: first
 * incident when a run reaches `threshold`, re-notify when it doubles — a
 * 7-hour loop escalates (4 → 8 → 16 …) instead of pinging every round.
 */

import { type ParsedMessage } from '@main/types';
import { billedRequestKey } from '@main/utils/jsonl';
import { isStalledRound } from '@shared/constants/loopPolicy';
import { billedTotalTokens, inputSideTokens, isTurnBoundary } from '@shared/turnAccounting';
import { bashStem, normalizeCallKey } from '@shared/utils/callKey';

export interface LoopIncident {
  /** normalized key of the looping call */
  key: string;
  /** current run length */
  count: number;
  /** billed tokens burned by the rounds of this run so far (requestKey-deduped) */
  tokens: number;
  /** toolUseId of the run's latest call — deep-link target */
  toolUseId: string;
  /** cwd of the last fed message carrying one, for project naming */
  cwd?: string;
  /** index of the incident's message within this batch (lineNumber is approximate) */
  batchIndex: number;
}

interface FileLoopState {
  lastKey: string;
  streak: number;
  /** billed tokens of the current run's rounds — survives batches, resets with the streak */
  streakTokens: number;
  /** billedRequestKey of the last processed request — GLM-proxy fragment dedup */
  lastRequestKey?: string;
  lastToolUseId: string;
  /** streak length at last notification; 0 = not yet notified for this run */
  notifiedCount: number;
  cwd?: string;
}

const freshState = (): FileLoopState => ({
  lastKey: '',
  streak: 0,
  streakTokens: 0,
  lastToolUseId: '',
  notifiedCount: 0,
});

export class LoopDetector {
  private perFile = new Map<string, FileLoopState>();

  /** Drop state — file was truncated/rewritten, counters no longer describe it. */
  reset(filePath: string): void {
    this.perFile.delete(filePath);
  }

  /** Drop state for every file (full tracking cleanup). */
  resetAll(): void {
    this.perFile.clear();
  }

  /**
   * Feed one batch of appended messages. Returns an incident when the current
   * run reaches `threshold` for the first time or doubles the last notified
   * length; null otherwise.
   */
  feed(filePath: string, messages: ParsedMessage[], threshold: number): LoopIncident | null {
    const state = this.perFile.get(filePath) ?? freshState();
    this.perFile.set(filePath, state);

    // One incident per batch (the first): keep scanning to the end so
    // streak/lastToolUseId stay accurate — FileWatcher marks the whole
    // batch processed, so an early return would strand the remainder.
    let incident: LoopIncident | null = null;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      // main-chain assistant lines only — same accounting as the inventory scan
      if (msg.type !== 'assistant' || msg.isSidechain || msg.model === '<synthetic>') continue;
      if (msg.cwd) state.cwd = msg.cwd;
      // one request streamed as several lines (each with the full usage) bills once
      const billed = billedTotalTokens(msg.usage);
      const requestKey = billedRequestKey(msg);
      const doubleBilled = requestKey !== undefined && requestKey === state.lastRequestKey;
      if (requestKey) state.lastRequestKey = requestKey;

      // ponytail: a round's tokens are booked once even when it carries several
      // calls of the run (count grows per call) — tokens track ROUNDS, counts
      // track CALLS; a mixed A-extends/B-starts message books its tokens on the
      // new run — same approximation class as the count itself
      let billedBooked = false;

      for (const call of msg.toolCalls) {
        // ponytail: snapshot dedup by consecutive toolUseId only — real repeats
        // always carry fresh ids (verified on loop forensics); add a Set if
        // non-adjacent same-id lines ever show up
        if (call.id && call.id === state.lastToolUseId) continue;
        const key = bashStem(normalizeCallKey(call.name, call.input ?? {}));
        if (key === state.lastKey) {
          state.streak += 1;
          // book at the FIRST extending call so an incident fired by this very
          // round already carries its tokens
          if (!billedBooked) {
            billedBooked = true;
            if (!doubleBilled && billed > 0) state.streakTokens += billed;
          }
        } else {
          state.lastKey = key;
          state.streak = 1;
          // the founding round belongs to the run — same accounting as the
          // first stalled round in StallDetector
          state.streakTokens = doubleBilled ? 0 : billed;
          state.notifiedCount = 0;
        }
        state.lastToolUseId = call.id ?? '';
        if (
          !incident &&
          state.streak >= threshold &&
          (state.notifiedCount === 0 || state.streak >= state.notifiedCount * 2)
        ) {
          state.notifiedCount = state.streak;
          incident = {
            key,
            count: state.streak,
            tokens: state.streakTokens,
            toolUseId: call.id,
            cwd: state.cwd,
            batchIndex: i,
          };
        }
      }
    }
    return incident;
  }
}

interface FileStallState {
  lastContext: number;
  /** billedRequestKey of the last processed request — GLM-proxy fragment dedup */
  lastRequestKey?: string;
  streak: number;
  /** billed tokens of the current stall's rounds — survives batches, resets with the streak */
  streakTokens: number;
  lastToolUseId: string;
  /** streak length at last notification; 0 = not yet notified for this run */
  notifiedCount: number;
  cwd?: string;
}

const freshStallState = (): FileStallState => ({
  lastContext: 0,
  streak: 0,
  streakTokens: 0,
  lastToolUseId: '',
  notifiedCount: 0,
});

/**
 * StallDetector — live detection of context-stall loops: rounds that MAKE
 * tool calls while the context stops growing (echo-marker loops like
 * `echo w/v/u` — distinct args, so the key-based LoopDetector above sees no
 * streak). Criterion shared with the CLI/renderer: isStalledRound. GLM-proxy
 * fragments of one request are billed once (billedRequestKey dedup) — raw
 * appended lines are not merged at parse time. Same notification policy as
 * LoopDetector: first incident at `threshold`, re-notify on doubling.
 */
export class StallDetector {
  private perFile = new Map<string, FileStallState>();

  /** Drop state — file was truncated/rewritten, counters no longer describe it. */
  reset(filePath: string): void {
    this.perFile.delete(filePath);
  }

  /** Drop state for every file (full tracking cleanup). */
  resetAll(): void {
    this.perFile.clear();
  }

  /** Same contract as LoopDetector.feed. */
  feed(filePath: string, messages: ParsedMessage[], threshold: number): LoopIncident | null {
    const state = this.perFile.get(filePath) ?? freshStallState();
    this.perFile.set(filePath, state);

    let incident: LoopIncident | null = null;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      // a new user turn (or compaction) resets the stall baseline: the first
      // round of a turn can't be "stalled" relative to the previous turn
      if (isTurnBoundary(msg)) state.lastContext = 0;
      if (msg.type !== 'assistant' || msg.isSidechain || msg.model === '<synthetic>') continue;
      if (msg.cwd) state.cwd = msg.cwd;
      // one request streamed as several lines (each with the full usage) is
      // one round — skipping the later fragments keeps the streak honest
      const requestKey = billedRequestKey(msg);
      if (requestKey && requestKey === state.lastRequestKey) continue;
      if (requestKey) state.lastRequestKey = requestKey;

      const u = msg.usage;
      if (!u) continue;
      const context =
        (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0);
      const output = u.output_tokens ?? 0;
      const stalled = isStalledRound(state.lastContext, context, output, msg.toolCalls.length);
      // ghost rounds must not drag the baseline — same rule as buildLedger
      if (context > 0) state.lastContext = context;

      const toolUseId = msg.toolCalls[msg.toolCalls.length - 1]?.id ?? '';
      if (stalled) {
        state.streak += 1;
        state.streakTokens += billedTotalTokens(u);
        state.lastToolUseId = toolUseId;
        if (
          !incident &&
          state.streak >= threshold &&
          (state.notifiedCount === 0 || state.streak >= state.notifiedCount * 2)
        ) {
          state.notifiedCount = state.streak;
          incident = {
            key: 'context stall',
            count: state.streak,
            tokens: state.streakTokens,
            toolUseId,
            cwd: state.cwd,
            batchIndex: i,
          };
        }
      } else {
        state.streak = 0;
        state.streakTokens = 0;
        state.notifiedCount = 0;
      }
    }
    return incident;
  }
}

interface FileBudgetState {
  /** input-side spend per request key — keep-newest (last line of a request wins) */
  usageByRequest: Map<string, number>;
  /** assistant lines without any request id — each is its own request */
  keylessSpend: number;
  /** running turn total = Σ usageByRequest.values() + keylessSpend */
  total: number;
  /** this turn already fired its crossing notification */
  notified: boolean;
  lastToolUseId: string;
  cwd?: string;
}

const freshBudgetState = (): FileBudgetState => ({
  usageByRequest: new Map(),
  keylessSpend: 0,
  total: 0,
  notified: false,
  lastToolUseId: '',
});

export interface TurnBudgetIncident {
  /** turn's input-side spend at the crossing */
  spent: number;
  /** configured per-turn budget (the hook's currency) */
  budget: number;
  toolUseId: string;
  cwd?: string;
  batchIndex: number;
}

/**
 * TurnBudgetDetector — the bell's live mirror of the turn-budget hook.
 * Watches the current turn's input-side re-read with the SAME accounting
 * core (billedRequestKey + inputSideTokens, keep-newest), the SAME config
 * field the hook enforces, from the SAME transcript the hook reads — so
 * the notification number equals the hook's number by construction, not by
 * synchronization. Fires once per turn at the crossing (edge-triggered);
 * a new user turn resets the bucket.
 */
export class TurnBudgetDetector {
  private perFile = new Map<string, FileBudgetState>();

  /** Drop state — file was truncated/rewritten, counters no longer describe it. */
  reset(filePath: string): void {
    this.perFile.delete(filePath);
  }

  /** Drop state for every file (full tracking cleanup). */
  resetAll(): void {
    this.perFile.clear();
  }

  /** Same contract as LoopDetector.feed; budget = notifications.turnBudget.maxInputTokensPerTurn. */
  feed(filePath: string, messages: ParsedMessage[], budget: number): TurnBudgetIncident | null {
    let state = this.perFile.get(filePath) ?? freshBudgetState();
    this.perFile.set(filePath, state);

    let incident: TurnBudgetIncident | null = null;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      // a new user turn (or compaction) starts a fresh budget bucket
      if (isTurnBoundary(msg)) {
        state = freshBudgetState();
        this.perFile.set(filePath, state);
      }
      // main-chain assistant lines only — same accounting as the hook
      if (msg.type !== 'assistant' || msg.isSidechain || msg.model === '<synthetic>') continue;
      if (msg.cwd) state.cwd = msg.cwd;
      const u = msg.usage;
      if (!u) continue;
      const side = inputSideTokens(u);
      const key = billedRequestKey(msg);
      if (key) {
        // keep-newest replace: a streamed request's later lines carry the
        // final counts, so they REPLACE the earlier contribution
        const prev = state.usageByRequest.get(key);
        state.usageByRequest.set(key, side);
        state.total += side - (prev ?? 0);
      } else {
        // no request identity — each line is its own request
        state.keylessSpend += side;
        state.total += side;
      }
      state.lastToolUseId = msg.toolCalls[msg.toolCalls.length - 1]?.id ?? '';

      if (!state.notified && state.total >= budget) {
        state.notified = true;
        if (!incident) {
          incident = {
            spent: state.total,
            budget,
            toolUseId: state.lastToolUseId,
            cwd: state.cwd,
            batchIndex: i,
          };
        }
      }
    }
    return incident;
  }
}
