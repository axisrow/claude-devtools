/**
 * Loop policy shared by the CLI analyzer (analyzeSession findings), the live
 * LoopDetector's defaults and the renderer's Visible Context burn categories
 * (contextTracker).
 */

/**
 * A "quiet round" re-reads the whole window (>= CONTEXT tokens billed on the
 * input side) while producing almost nothing (<= OUTPUT tokens out).
 */

/** Minimum input-side tokens (input + cache_read + cache_creation) for a quiet round to count */
export const WAIT_TICK_CONTEXT_TOKENS = 50_000;

/** Maximum output tokens for a round to qualify as quiet */
export const WAIT_TICK_OUTPUT_TOKENS = 300;

/** Quiet rounds required before a turn counts as wait-loop — same gate as the CLI's `waitLoopTicks` */
export const WAIT_LOOP_MIN_ROUNDS = 5;

/**
 * Streak length from which back-to-back identical calls count as loop waste —
 * aligned with the live bell's default `cycleThreshold` (ConfigManager), so a
 * normal Edit → fix → Edit or double Read never lands in the red category.
 */
export const LOOP_MIN_STREAK = 4;
