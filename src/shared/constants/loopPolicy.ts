/**
 * Wait-loop policy shared by the CLI analyzer (analyzeSession findings) and the
 * renderer's Visible Context wait-loop category (contextTracker).
 * A "quiet round" re-reads the whole window (>= CONTEXT tokens billed on the
 * input side) while producing almost nothing (<= OUTPUT tokens out).
 */

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
