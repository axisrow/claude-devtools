import { describe, expect, it } from 'vitest';

import {
  incrementalUpdateConversation,
  transformChunksToConversation,
} from '@renderer/utils/groupTransformer';

// =============================================================================
// Test Fixtures (chunk shapes per src/main/types/chunks.ts type guards)
// =============================================================================

function makeMetrics(overrides = {}) {
  return {
    durationMs: 60000,
    totalTokens: 5000,
    inputTokens: 3000,
    outputTokens: 2000,
    cacheReadTokens: 500,
    cacheCreationTokens: 100,
    messageCount: 10,
    costUsd: 0.05,
    ...overrides,
  };
}

let seq = 0;

function makeUserChunk(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `chunk-user-${seq}`,
    chunkType: 'user' as const,
    startTime: new Date('2025-01-15T10:00:00Z'),
    endTime: new Date('2025-01-15T10:00:01Z'),
    durationMs: 1000,
    metrics: makeMetrics({ messageCount: 1 }),
    userMessage: {
      uuid: `user-${seq}`,
      parentUuid: null,
      type: 'user' as const,
      timestamp: new Date('2025-01-15T10:00:00Z'),
      content: `user message ${seq}`,
      isMeta: false,
      isSidechain: false,
    },
    rawMessages: [],
    ...overrides,
  };
}

function makeAIChunk(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `chunk-ai-${seq}`,
    chunkType: 'ai' as const,
    startTime: new Date('2025-01-15T10:00:01Z'),
    endTime: new Date('2025-01-15T10:00:05Z'),
    durationMs: 4000,
    metrics: makeMetrics({ messageCount: 2 }),
    responses: [
      {
        uuid: `assistant-${seq}`,
        parentUuid: null,
        type: 'assistant' as const,
        timestamp: new Date('2025-01-15T10:00:01Z'),
        content: [{ type: 'text', text: 'answer' }],
        isMeta: false,
        isSidechain: false,
      },
    ],
    processes: [],
    sidechainMessages: [],
    toolExecutions: [],
    semanticSteps: [],
    rawMessages: [],
    ...overrides,
  };
}

function makeSystemChunk(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `chunk-system-${seq}`,
    chunkType: 'system' as const,
    startTime: new Date('2025-01-15T10:00:06Z'),
    endTime: new Date('2025-01-15T10:00:07Z'),
    durationMs: 1000,
    metrics: makeMetrics({ messageCount: 1 }),
    message: {
      uuid: `system-${seq}`,
      type: 'user' as const,
      timestamp: new Date('2025-01-15T10:00:06Z'),
      content: 'command output',
      isMeta: true,
      isSidechain: false,
    },
    commandOutput: 'Set model to sonnet',
    rawMessages: [],
    ...overrides,
  };
}

function makeCompactChunk(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `chunk-compact-${seq}`,
    chunkType: 'compact' as const,
    startTime: new Date('2025-01-15T10:01:00Z'),
    endTime: new Date('2025-01-15T10:01:00Z'),
    durationMs: 0,
    metrics: makeMetrics({ messageCount: 0 }),
    message: {
      uuid: `compact-${seq}`,
      type: 'summary' as const,
      timestamp: new Date('2025-01-15T10:01:00Z'),
      content: 'Summary',
      isMeta: false,
      isSidechain: false,
    },
    rawMessages: [],
    ...overrides,
  };
}

/** AI group turnIndexes in item order. */
function aiTurnIndexes(chunks: Parameters<typeof transformChunksToConversation>[0]) {
  const conv = transformChunksToConversation(chunks, [], false);
  return conv.items
    .filter((item) => item.type === 'ai')
    .map((item) => (item.group as { turnIndex: number }).turnIndex);
}

// =============================================================================
// Turn numbering — must match transcript user-message ordinals 1:1
// =============================================================================

describe('groupTransformer turn numbering', () => {
  it('numbers AI groups by the user message they answer (empty turns consume a number)', () => {
    // [U1, A1, U2 (no response), U3, A3] → Turn 1, Turn 3
    expect(
      aiTurnIndexes([
        makeUserChunk(),
        makeAIChunk(),
        makeUserChunk(),
        makeUserChunk(),
        makeAIChunk(),
      ])
    ).toEqual([0, 2]);
  });

  it('numbers an AI group by its own user message even when the previous turn was empty', () => {
    // [U1, A1, U2 (no response), A2] → A2 answers U2 → Turn 2
    expect(aiTurnIndexes([makeUserChunk(), makeAIChunk(), makeUserChunk(), makeAIChunk()])).toEqual(
      [0, 1]
    );
  });

  it('does not consume a turn number for compact boundaries', () => {
    const chunks = [makeUserChunk(), makeAIChunk(), makeCompactChunk(), makeAIChunk()];
    expect(aiTurnIndexes(chunks)).toEqual([0, 0]);
  });

  it('does not consume a turn number for system chunks', () => {
    const chunks = [makeUserChunk(), makeAIChunk(), makeSystemChunk(), makeAIChunk()];
    expect(aiTurnIndexes(chunks)).toEqual([0, 0]);
  });

  it('falls back to AI-sequence numbering before the first user chunk', () => {
    const chunks = [makeAIChunk(), makeAIChunk(), makeUserChunk(), makeAIChunk()];
    expect(aiTurnIndexes(chunks)).toEqual([0, 1, 0]);
  });

  it('incremental path agrees with the full transform', () => {
    const base = [makeUserChunk(), makeAIChunk()];
    const prev = transformChunksToConversation(base, [], false);
    const grown = incrementalUpdateConversation(
      prev,
      [...base, makeUserChunk(), makeAIChunk()],
      [],
      false
    );
    const aiItems = grown.items.filter((item) => item.type === 'ai');
    expect(aiItems.map((item) => (item.group as { turnIndex: number }).turnIndex)).toEqual([0, 1]);
  });

  it('incremental path accounts for empty turns added in bulk', () => {
    const base = [makeUserChunk(), makeAIChunk(), makeUserChunk(), makeUserChunk()];
    const prev = transformChunksToConversation(base, [], false);
    const grown = incrementalUpdateConversation(prev, [...base, makeAIChunk()], [], false);
    const aiItems = grown.items.filter((item) => item.type === 'ai');
    expect(aiItems.map((item) => (item.group as { turnIndex: number }).turnIndex)).toEqual([0, 2]);
  });
});
