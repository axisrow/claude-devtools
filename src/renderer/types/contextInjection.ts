/**
 * Type definitions for unified context injection tracking.
 * Extends CLAUDE.md tracking to include mentioned files (@mentions) and tool outputs.
 * This provides a comprehensive view of all context sources injected into the conversation.
 */

import type { ClaudeMdInjection } from './claudeMd';

// =============================================================================
// Constants
// =============================================================================

/**
 * Maximum tokens to estimate for a mentioned file.
 * Files larger than this are capped to prevent unrealistic token estimates.
 */
export const MAX_MENTIONED_FILE_TOKENS = 25000;

// =============================================================================
// Mentioned File Types
// =============================================================================

/**
 * Represents a file mentioned via @-mention that was injected into context.
 * Tracks the file path, token estimate, and where it first appeared in the session.
 */
export interface MentionedFileInjection {
  /** Unique identifier for this injection */
  id: string;
  /** Discriminator for type narrowing */
  category: 'mentioned-file';
  /** Absolute file path of the mentioned file */
  path: string;
  /** Relative path or filename for display purposes */
  displayName: string;
  /** Estimated token count for this file's content */
  estimatedTokens: number;
  /** Turn index where this file was first mentioned */
  firstSeenTurnIndex: number;
  /** AI group ID (e.g., "ai-0") where this file was first seen, for navigation */
  firstSeenInGroup: string;
  /** Whether the file exists on disk */
  exists: boolean;
}

/**
 * Information about a mentioned file returned from IPC.
 * Used to get file metadata before creating a MentionedFileInjection.
 */
export interface MentionedFileInfo {
  /** Absolute file path */
  path: string;
  /** Whether the file exists on disk */
  exists: boolean;
  /** Character count of file content */
  charCount: number;
  /** Estimated token count (typically charCount / 4) */
  estimatedTokens: number;
}

// =============================================================================
// Tool Output Types
// =============================================================================

/**
 * Breakdown of tokens contributed by a single tool in a turn.
 */
export interface ToolTokenBreakdown {
  /** Name of the tool (e.g., "Read", "Grep", "Bash") */
  toolName: string;
  /** Number of tokens in the tool's output */
  tokenCount: number;
  /** Whether the tool execution resulted in an error */
  isError: boolean;
  /** Tool use ID for deep-link navigation to specific tool in chat */
  toolUseId?: string;
}

/**
 * Represents aggregated tool output context for a single AI turn.
 * Multiple tools may execute in one turn; this aggregates their token contributions.
 */
export interface ToolOutputInjection {
  /** Unique identifier (e.g., "tool-output-ai-0") */
  id: string;
  /** Discriminator for type narrowing */
  category: 'tool-output';
  /** Turn index where these tool outputs occurred */
  turnIndex: number;
  /** AI group ID for navigation (e.g., "ai-0") */
  aiGroupId: string;
  /** Total estimated tokens from all tools in this turn */
  estimatedTokens: number;
  /** Number of tools that contributed output */
  toolCount: number;
  /** Detailed breakdown of tokens by individual tool */
  toolBreakdown: ToolTokenBreakdown[];
}

// =============================================================================
// Thinking/Text Output Types
// =============================================================================

/**
 * Breakdown of thinking vs text tokens within a turn.
 */
export interface ThinkingTextBreakdown {
  /** Type of content */
  type: 'thinking' | 'text';
  /** Estimated token count */
  tokenCount: number;
}

/**
 * Thinking and Text output token injection for a single turn.
 * Aggregates all thinking blocks and text outputs within one AI response turn.
 */
export interface ThinkingTextInjection {
  /** Unique identifier (e.g., "thinking-text-ai-0") */
  id: string;
  /** Discriminator for type narrowing */
  category: 'thinking-text';
  /** Turn index where this content occurred */
  turnIndex: number;
  /** AI group ID for navigation (e.g., "ai-0") */
  aiGroupId: string;
  /** Total estimated tokens from thinking + text in this turn */
  estimatedTokens: number;
  /** Detailed breakdown of thinking vs text tokens */
  breakdown: ThinkingTextBreakdown[];
}

// =============================================================================
// User Message Types
// =============================================================================

/**
 * Represents a user message injected into context for a single turn.
 * User prompts are a real part of the context window — tracking them
 * provides a more complete picture of what consumes tokens.
 */
export interface UserMessageInjection {
  /** Unique identifier (e.g., "user-msg-ai-0") */
  id: string;
  /** Discriminator for type narrowing */
  category: 'user-message';
  /** Turn index where this user message occurred */
  turnIndex: number;
  /** AI group ID for navigation (e.g., "ai-0") */
  aiGroupId: string;
  /** Estimated token count for the user message content */
  estimatedTokens: number;
  /** First ~80 characters of the message for preview */
  textPreview: string;
}

// =============================================================================
// Task Coordination Types
// =============================================================================

/**
 * Breakdown of tokens contributed by a single task coordination item.
 */
export interface TaskCoordinationBreakdown {
  /** Type of task coordination item */
  type: 'teammate-message' | 'send-message' | 'task-tool';
  /** Tool name (e.g., "TeamCreate", "TaskCreate", "SendMessage") */
  toolName?: string;
  /** Estimated token count */
  tokenCount: number;
  /** Display label (e.g., teammate name, "TaskCreate #3") */
  label: string;
}

/**
 * Represents aggregated task coordination context for a single AI turn.
 * Tracks SendMessage, TeamCreate, TaskCreate, and other task tools separately
 * from generic tool outputs.
 */
export interface TaskCoordinationInjection {
  /** Unique identifier (e.g., "task-coord-ai-0") */
  id: string;
  /** Discriminator for type narrowing */
  category: 'task-coordination';
  /** Turn index where these task coordination items occurred */
  turnIndex: number;
  /** AI group ID for navigation (e.g., "ai-0") */
  aiGroupId: string;
  /** Total estimated tokens from all task coordination items in this turn */
  estimatedTokens: number;
  /** Detailed breakdown of tokens by individual item */
  breakdown: TaskCoordinationBreakdown[];
}

// =============================================================================
// Loop Types
// =============================================================================

/**
 * Breakdown of tokens contributed by a single looping tool-call series.
 */
export interface LoopTokenBreakdown {
  /** Canonical call key (same identity the live loop detector uses) */
  key: string;
  /** How many bucketed repeat calls this series contributed (streak length beyond the threshold) */
  count: number;
  /** Estimated token count for this repeat call (call + result + skill) */
  tokenCount: number;
  /** Tool use ID for deep-link navigation to the specific repeat call */
  toolUseId?: string;
}

/**
 * Represents tokens burned by repeated back-to-back identical tool calls.
 * Calls from LOOP_MIN_STREAK (the live bell's default cycleThreshold) onward
 * land here; earlier calls of a streak stay in tool-output.
 */
export interface LoopInjection {
  /** Unique identifier (e.g., "loop-ai-0") */
  id: string;
  /** Discriminator for type narrowing */
  category: 'loop';
  /** Turn index where these repeats occurred */
  turnIndex: number;
  /** AI group ID for navigation (e.g., "ai-0") */
  aiGroupId: string;
  /** Total estimated tokens from repeat calls in this turn */
  estimatedTokens: number;
  /** Detailed breakdown of tokens by repeat series */
  breakdown: LoopTokenBreakdown[];
  /** Rounds carrying repeat calls, one row each (billed usage) */
  rounds: LoopRoundInfo[];
}

/** One assistant round (response) inside a turn, for round-level displays */
export interface LoopRoundInfo {
  /** Response message uuid (matches SemanticStep.sourceMessageId) */
  uuid: string;
  /** 1-based round number within the turn */
  index: number;
  /** Billed usage of the round (in + cache_read + cache_creation + output) */
  billed: number;
  /** Repeat call key(s) present in this round */
  keys: string[];
}

// =============================================================================
// Wait-Loop Types
// =============================================================================

/**
 * Represents tokens burned by quiet rounds in a turn: rounds that billed a
 * huge input-side context (>= WAIT_TICK_CONTEXT_TOKENS) while producing almost
 * nothing (<= WAIT_TICK_OUTPUT_TOKENS out). Same criterion and minimum round
 * gate (WAIT_LOOP_MIN_ROUNDS) as the CLI's wait_loop findings.
 */
export interface WaitLoopInjection {
  /** Unique identifier (e.g., "wait-loop-ai-0") */
  id: string;
  /** Discriminator for type narrowing */
  category: 'wait-loop';
  /** Turn index where these quiet rounds occurred */
  turnIndex: number;
  /** AI group ID for navigation (e.g., "ai-0") */
  aiGroupId: string;
  /** Total billed context re-read by quiet rounds in this turn */
  estimatedTokens: number;
  /** How many quiet rounds fired in this turn */
  roundCount: number;
  /** The quiet rounds themselves (for round-level expansion) */
  rounds: WaitRoundInfo[];
}

/** One quiet round: when it fired and what it billed */
export interface WaitRoundInfo {
  /** Response message uuid (matches SemanticStep.sourceMessageId) */
  uuid: string;
  /** 1-based round number within the turn */
  index: number;
  /** Output tokens of the round (always <= WAIT_TICK_OUTPUT_TOKENS) */
  outputTokens: number;
  /** Full billed usage of the round (in + cache_read + cache_creation + output) */
  billed: number;
}

// =============================================================================
// Union Types
// =============================================================================

/**
 * Extended ClaudeMdInjection with category discriminator for union compatibility.
 */
export type ClaudeMdContextInjection = ClaudeMdInjection & { category: 'claude-md' };

/**
 * Discriminated union of all context injection types.
 * Use the `category` field to narrow the type:
 * - 'claude-md': CLAUDE.md configuration injections
 * - 'mentioned-file': User @-mentioned file injections
 * - 'tool-output': Tool execution output injections
 * - 'thinking-text': Thinking and text output token injections
 * - 'task-coordination': Task coordination tool and message injections
 * - 'user-message': User message prompt injections
 */
export type ContextInjection =
  | ClaudeMdContextInjection
  | MentionedFileInjection
  | ToolOutputInjection
  | ThinkingTextInjection
  | TaskCoordinationInjection
  | UserMessageInjection
  | LoopInjection
  | WaitLoopInjection;

// =============================================================================
// Statistics Types
// =============================================================================

/**
 * Token counts broken down by context source category.
 */
export interface TokensByCategory {
  /** Tokens from CLAUDE.md injections */
  claudeMd: number;
  /** Tokens from mentioned files */
  mentionedFiles: number;
  /** Tokens from tool outputs */
  toolOutputs: number;
  /** Tokens from thinking blocks and text outputs */
  thinkingText: number;
  /** Tokens from task coordination (SendMessage, TeamCreate, TaskCreate, etc.) */
  taskCoordination: number;
  /** Tokens from user messages */
  userMessages: number;
  /** Tokens from repeated back-to-back identical tool calls (loop waste) */
  loop: number;
  /** Tokens re-read by quiet wait-loop rounds */
  waitLoop: number;
}

/**
 * Counts of new injections broken down by context source category.
 */
export interface NewCountsByCategory {
  /** Count of new CLAUDE.md injections */
  claudeMd: number;
  /** Count of new mentioned file injections */
  mentionedFiles: number;
  /** Count of new tool output injections */
  toolOutputs: number;
  /** Count of new thinking/text injections */
  thinkingText: number;
  /** Count of new task coordination injections */
  taskCoordination: number;
  /** Count of new user message injections */
  userMessages: number;
  /** Count of new repeat-call entries */
  loop: number;
  /** Count of quiet wait-loop rounds */
  waitLoop: number;
}

/**
 * Comprehensive statistics about context injections for an AI group.
 * Tracks both new injections in the current group and accumulated totals,
 * with breakdowns by category.
 */
export interface ContextStats {
  /** Injections that are new in THIS group */
  newInjections: ContextInjection[];
  /**
   * All injections accumulated up to and including this group.
   * Only populated for the last AI group in each context phase (to save memory).
   * Intermediate groups have an empty array here.
   */
  accumulatedInjections: ContextInjection[];
  /** Total estimated tokens from all accumulated injections */
  totalEstimatedTokens: number;
  /** Token counts broken down by category */
  tokensByCategory: TokensByCategory;
  /** Counts of new injections in this group, by category */
  newCounts: NewCountsByCategory;
  /** Running totals of accumulated injection counts by category (always populated) */
  accumulatedCounts: NewCountsByCategory;
  /** Which context phase this stats belongs to (1-based) */
  phaseNumber?: number;
  /** Per-round classification for the group's stream (keyed by response uuid) */
  roundFlags?: Map<string, RoundFlag>;
}

/** Stream-level flag of one assistant round inside a turn */
export interface RoundFlag {
  /** 1-based round number within the turn */
  index: number;
  /** Quiet round: billed a big context while producing almost nothing */
  quiet: boolean;
  /** Round carries repeat tool calls */
  repeat: boolean;
  /** Full billed usage of the round (in + cache_read + cache_creation + output) */
  billed: number;
}

// =============================================================================
// Context Phase Types
// =============================================================================

/** Token change at a compaction boundary */
export interface CompactionTokenDelta {
  preCompactionTokens: number;
  postCompactionTokens: number;
  delta: number; // negative = context freed
}

/** Metadata about a single context phase */
export interface ContextPhase {
  phaseNumber: number; // 1-based
  firstAIGroupId: string;
  lastAIGroupId: string;
  compactGroupId: string | null; // null for phase 1
  startTokens?: number;
  endTokens?: number;
}

/** Session-wide phase information */
export interface ContextPhaseInfo {
  phases: ContextPhase[];
  compactionCount: number;
  aiGroupPhaseMap: Map<string, number>; // aiGroupId → phaseNumber
  compactionTokenDeltas: Map<string, CompactionTokenDelta>; // compactGroupId → delta
}
