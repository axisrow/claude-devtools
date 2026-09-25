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
import { bashStem, normalizeCallKey } from '@shared/utils/callKey';

export interface LoopIncident {
  /** normalized key of the looping call */
  key: string;
  /** current run length */
  count: number;
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
  lastToolUseId: string;
  /** streak length at last notification; 0 = not yet notified for this run */
  notifiedCount: number;
  cwd?: string;
}

const freshState = (): FileLoopState => ({
  lastKey: '',
  streak: 0,
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

      for (const call of msg.toolCalls) {
        // ponytail: snapshot dedup by consecutive toolUseId only — real repeats
        // always carry fresh ids (verified on loop forensics); add a Set if
        // non-adjacent same-id lines ever show up
        if (call.id && call.id === state.lastToolUseId) continue;
        const key = bashStem(normalizeCallKey(call.name, call.input ?? {}));
        if (key === state.lastKey) {
          state.streak += 1;
        } else {
          state.lastKey = key;
          state.streak = 1;
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
  lastToolUseId: string;
  /** streak length at last notification; 0 = not yet notified for this run */
  notifiedCount: number;
  cwd?: string;
}

const freshStallState = (): FileStallState => ({
  lastContext: 0,
  streak: 0,
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
            toolUseId,
            cwd: state.cwd,
            batchIndex: i,
          };
        }
      } else {
        state.streak = 0;
        state.notifiedCount = 0;
      }
    }
    return incident;
  }
}
