/**
 * Path parsing utilities for SessionContextPanel.
 */

/**
 * Format a turn index (0-based) into a human-readable label.
 * 0 -> "Turn 1"; negative (unknown) -> ''.
 */
export function formatFirstSeen(turnIndex: number): string {
  if (turnIndex < 0) return '';
  return `Turn ${turnIndex + 1}`;
}
