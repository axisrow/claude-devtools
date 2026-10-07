/**
 * Types for the canonical token-accounting core — pure functions, zero
 * imports (see turn-accounting.mjs). The turn-budget hook re-exports these
 * plus its own I/O entry points (declared in turn-budget-hook.d.mts).
 */

export interface UsageLike {
  input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  output_tokens?: number | null;
}

/** A raw hook line (usage/id under `.message`) or a flattened ParsedMessage. */
export interface AccountableMessage {
  type?: string;
  requestId?: string;
  messageId?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  content?: unknown;
  usage?: UsageLike;
  message?: { id?: string; usage?: UsageLike; content?: unknown };
}

/** requestId ?? messageId ?? message.id — one billed request per key. */
export declare function billedRequestKey(m: AccountableMessage): string | undefined;

/** input + cache_read + cache_creation — what a round re-reads. */
export declare function inputSideTokens(u?: UsageLike): number;

/** inputSide + output — a round's full billed cost. */
export declare function billedTotalTokens(u?: UsageLike): number;

/** Billed total of the first assistant round carrying usage. */
export declare function firstAssistantTotalTokens(
  responses?: AccountableMessage[]
): number;

/** Billed total of the last assistant round carrying usage. */
export declare function lastAssistantTotalTokens(responses?: AccountableMessage[]): number;

/** Real user message (raw or flattened shape) — not meta/system/teammate. */
export declare function isRealUserLine(m: AccountableMessage): boolean;

/** System-output wrapper tags (canonical list; messageTags.ts re-exports). */
export declare const SYSTEM_OUTPUT_TAGS: string[];

/** Canonical user-turn predicate: port of isParsedUserChunkMessage. */
export declare function isUserChunkLine(m: AccountableMessage): boolean;

/** Teammate relay: non-meta user line carrying a <teammate-message> wrapper
 * — transcript turn input but NOT a hook-turn boundary (issue #55). */
export declare function isTeammateRelayLine(m: AccountableMessage): boolean;

/** Transcript turn input: a real user message or a teammate relay. */
export declare function isTranscriptTurnLine(m: AccountableMessage): boolean;

/** Turn boundary: user-initiated message or compaction marker. */
export declare function isTurnBoundary(m: AccountableMessage): boolean;

/** Sum input-side spend of the current turn, scanning lines newest-first. */
export declare function analyzeTurn(linesNewestFirst: Iterable<string>): {
  spent: number;
  boundaryFound: boolean;
};
