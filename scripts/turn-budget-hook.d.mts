/**
 * Types for the standalone turn-budget hook — the fork's single-source-of-truth
 * accounting core. The app imports it only through src/shared/turnAccounting.ts
 * (whose typecheck fails if an exported name disappears here); the calibration
 * CLI imports the predicates directly.
 */

export interface UsageLike {
  input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  output_tokens?: number | null;
}

/** A raw hook line (usage under `.message`) or a flattened ParsedMessage. */
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

/** Turn boundary: real user message or compaction marker. */
export declare function isTurnBoundary(m: AccountableMessage): boolean;

/** Main-chain assistant line — billed to the turn's re-read. */
export declare function isMainChainAssistantLine(m: AccountableMessage): boolean;

/** Sum input-side spend of the current turn, scanning lines newest-first. */
export declare function analyzeTurn(linesNewestFirst: Iterable<string>): {
  spent: number;
  boundaryFound: boolean;
};

/** Parse the notifications.turnBudget config section with defaults. */
export declare function readConfig(raw?: string): { enabled: boolean; budget: number };
