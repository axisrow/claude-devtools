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
