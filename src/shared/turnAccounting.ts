/**
 * Single import surface for the canonical token-accounting core
 * (scripts/turn-accounting.mjs — pure, zero imports; the turn-budget hook
 * re-exports the same functions). App-side consumers import the accounting
 * primitives from here, never from the script directly. This module is safe
 * to bundle into the renderer: the core pulls no node builtins.
 *
 * Naming contract (see the core's header):
 *  - inputSideTokens — input + cache_read + cache_creation: what a turn
 *    re-reads; the currency of the turn-budget hook and its calibration.
 *  - billedTotalTokens — inputSide + output: a round's full billed cost.
 */
export {
  analyzeTurn,
  billedRequestKey,
  billedTotalTokens,
  firstAssistantTotalTokens,
  inputSideTokens,
  isRealUserLine,
  isTeammateRelayLine,
  isTranscriptTurnLine,
  isTurnBoundary,
  isTurnNumberLine,
  isUserChunkLine,
  lastAssistantTotalTokens,
  SYSTEM_OUTPUT_TAGS,
  TEAMMATE_BLOCK_RE,
} from '../../scripts/turn-accounting.mjs';
