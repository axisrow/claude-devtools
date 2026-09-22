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
import { bashStem, normalizeCallKey } from '@main/utils/callKey';

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
