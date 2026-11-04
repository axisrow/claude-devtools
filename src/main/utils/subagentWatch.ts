import { type ParsedMessage } from '@main/types';
import { createRequestLedger, inputSideTokens } from '@shared/turnAccounting';

/**
 * SubagentRunwayDetector — the one live detector fed by SUBAGENT transcripts.
 *
 * Every other live detector (loop/stall/turn-budget) is gated to main-chain
 * sessions (FileWatcher liveGate): their state machines reason about turns
 * and tool-call rounds of the main chain, and the parent "mirrors" the
 * subagent's content. None of that watches the subagent's own RUNAWAY — a
 * background agent spinning for 1–2 hours burning hundreds of millions of
 * tokens invisibly (corpus 2026-11-04: champion 14h49m / 4292 rounds /
 * 1.02B input tokens).
 *
 * Per subagent file state: request-identity ledgers (canon core — GLM
 * mixed-shape heads+fragments bill once) + first→last timestamp span.
 * Thresholds: span >= minutes OR billed (in+out) >= tokens — the first one
 * crossed rings. Edge-latched: ONE notification per subagent file per app
 * run. ponytail: no reset-on-quiet — a resumed runaway is the same runaway;
 * the settings toggle or an app restart is the off-switch.
 */

export interface SubagentWatchConfig {
  enabled: boolean;
  /** transcript span (first→last line) that trips the bell, minutes */
  minutes: number;
  /** request-deduped billed total (inputSide + output) that trips, tokens */
  tokens: number;
}

export interface SubagentRunwayIncident {
  filePath: string;
  /** first→last line timestamp span, ms */
  spanMs: number;
  minutes: number;
  /** request-deduped input-side tokens (the re-read currency) */
  inputSide: number;
  output: number;
  /** distinct billed requests */
  rounds: number;
  /** which threshold tripped first */
  triggeredBy: 'minutes' | 'tokens';
}

interface SubagentFileState {
  side: ReturnType<typeof createRequestLedger>;
  out: ReturnType<typeof createRequestLedger>;
  firstTsMs: number;
  lastTsMs: number;
  notified: boolean;
}

const lineTsMs = (m: ParsedMessage): number => {
  const t = m.timestamp;
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'string') {
    const p = Date.parse(t);
    return Number.isFinite(p) ? p : NaN;
  }
  return NaN;
};

export class SubagentRunwayDetector {
  private states = new Map<string, SubagentFileState>();

  reset(filePath: string): void {
    this.states.delete(filePath);
  }

  /** Feed one append batch for a subagent transcript; returns the incident
   * once — on the feed where a threshold is first crossed. */
  feed(
    filePath: string,
    messages: ParsedMessage[],
    cfg: SubagentWatchConfig
  ): SubagentRunwayIncident | null {
    let st = this.states.get(filePath);
    if (!st) {
      st = {
        side: createRequestLedger(),
        out: createRequestLedger(),
        firstTsMs: Infinity,
        lastTsMs: -Infinity,
        notified: false,
      };
      this.states.set(filePath, st);
    }
    for (const m of messages) {
      const ts = lineTsMs(m);
      if (Number.isFinite(ts)) {
        if (ts < st.firstTsMs) st.firstTsMs = ts;
        if (ts > st.lastTsMs) st.lastTsMs = ts;
      }
      const usage = m.usage;
      if (m.type === 'assistant' && usage) {
        // forward feed: replace semantics — the last fragment carries the
        // final counts for its request
        st.side.bill(m, inputSideTokens(usage), true);
        st.out.bill(m, usage.output_tokens ?? 0, true);
      }
    }
    if (st.notified || !Number.isFinite(st.firstTsMs)) return null;

    const spanMs = st.lastTsMs - st.firstTsMs;
    const minutes = spanMs / 60000;
    const billed = st.side.spent + st.out.spent;
    if (minutes < cfg.minutes && billed < cfg.tokens) return null;
    st.notified = true;
    return {
      filePath,
      spanMs,
      minutes: Math.round(minutes),
      inputSide: st.side.spent,
      output: st.out.spent,
      rounds: st.side.keys,
      triggeredBy: minutes >= cfg.minutes ? 'minutes' : 'tokens',
    };
  }
}
