/**
 * Wait-loop policy shared by the CLI analyzer (analyzeSession findings) and the
 * renderer's Visible Context wait-loop category (contextTracker).
 * A "quiet round" re-reads the whole window (>= CONTEXT tokens billed on the
 * input side) while producing almost nothing (<= OUTPUT tokens out).
 */

/**
 * Minimum back-to-back identical calls (bashStem(normalizeCallKey) key) before
 * a run counts as a Loop — the one gate for the renderer's Visible Context
 * loop category (contextTracker), the CLI's loop_streak finding, the
 * inventory's cycles, and the default cycleThreshold of the live bell
 * (LoopDetector), so all four surfaces flag the same runs (#96).
 *
 * Value 4, not 2 or 3: the early calls of a series are legitimate iteration
 * (Read → fix → Read) — #26's original rationale; the bell has always
 * defaulted to 4, so 4 keeps the bell unchanged while un-breaking the panel
 * (#27 regressed it to 2) and aligning the CLI (was 3).
 */
export const LOOP_MIN_STREAK = 4;

/** Minimum input-side tokens (input + cache_read + cache_creation) for a quiet round to count */
export const WAIT_TICK_CONTEXT_TOKENS = 50_000;

/** Maximum output tokens for a round to qualify as quiet */
export const WAIT_TICK_OUTPUT_TOKENS = 300;

/**
 * Minimum quiet ticks in one turn before the run is flagged a wait-loop —
 * the one gate for both the CLI findings and the renderer's Visible Context
 * category, so the panel never shows burn the CLI would not flag.
 */
export const WAIT_LOOP_MIN_TICKS = 5;

/**
 * The one quiet-tick criterion, shared verbatim by both consumers so it
 * cannot drift: a quiet round produces almost nothing out while re-reading
 * a large context AND makes no tool call at all — with a large baseline
 * context, ordinary working rounds (short tool calls) would otherwise
 * satisfy the token thresholds too.
 */
export function isQuietTick(
  billedContextTokens: number,
  outputTokens: number,
  toolCallCount: number
): boolean {
  return (
    toolCallCount === 0 &&
    billedContextTokens >= WAIT_TICK_CONTEXT_TOKENS &&
    outputTokens <= WAIT_TICK_OUTPUT_TOKENS
  );
}

/** Maximum round-to-round context growth for a round to qualify as stalled */
export const STALL_CONTEXT_DELTA_TOKENS = 300;

/**
 * The one stall criterion, shared verbatim by all consumers (CLI findings,
 * renderer round flags, main-process bell): a stalled round MAKES a tool
 * call but the context stops growing (marker loops like `echo w/v/u` —
 * distinct args, so the repeat-key walk sees no streak) and the output is
 * tiny. Quiet ticks (isQuietTick) are the no-tool-call counterpart.
 */
export function isStalledRound(
  prevContextTokens: number,
  contextTokens: number,
  outputTokens: number,
  toolCallCount: number
): boolean {
  const delta = contextTokens - prevContextTokens;
  return (
    toolCallCount > 0 &&
    prevContextTokens > 0 && // first round / ghost baseline — nothing to compare
    delta >= 0 && // a shrinking window (compaction) is not a stall
    delta <= STALL_CONTEXT_DELTA_TOKENS &&
    outputTokens <= WAIT_TICK_OUTPUT_TOKENS
  );
}
