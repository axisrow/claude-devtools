/**
 * Issue #54: refreshSessionInPlace must recompute Phase-2 context stats
 * (sessionContextStats / sessionPhaseInfo), not just swap the conversation.
 * Without it the Context pill stays frozen at fetch-time values for the
 * whole rest of a long session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installMockElectronAPI, type MockElectronAPI } from '../../mocks/electronAPI';

import { createTestStore, type TestStore } from './storeTestUtils';

import type { SessionDetail } from '@renderer/types/data';

// --- chunk fixtures -------------------------------------------------------
// Shapes follow EnhancedUserChunk / EnhancedAIChunk (src/main/types/chunks.ts).
// group.id === chunk.id (groupTransformer.createAIGroupFromChunk), and chunk ids
// are the keys of sessionContextStats / aiGroupPhaseMap.

function makeMetrics(messageCount: number) {
  return {
    durationMs: 60_000,
    totalTokens: 5_000,
    inputTokens: 3_000,
    outputTokens: 2_000,
    cacheReadTokens: 500,
    cacheCreationTokens: 100,
    messageCount,
    costUsd: 0.05,
  };
}

function userChunk(id: string, uuid: string) {
  return {
    id,
    chunkType: 'user' as const,
    startTime: new Date('2026-01-01T00:00:00Z'),
    endTime: new Date('2026-01-01T00:00:01Z'),
    durationMs: 1_000,
    metrics: makeMetrics(1),
    userMessage: {
      uuid,
      parentUuid: null,
      type: 'user' as const,
      timestamp: new Date('2026-01-01T00:00:00Z'),
      content: `message ${uuid}`,
      isMeta: false,
      isSidechain: false,
      toolCalls: [],
      toolResults: [],
    },
    rawMessages: [],
  };
}

function aiChunk(id: string) {
  return {
    id,
    chunkType: 'ai' as const,
    startTime: new Date('2026-01-01T00:00:01Z'),
    endTime: new Date('2026-01-01T00:00:05Z'),
    durationMs: 4_000,
    metrics: makeMetrics(2),
    responses: [
      {
        uuid: `resp-${id}`,
        parentUuid: null,
        type: 'assistant' as const,
        timestamp: new Date('2026-01-01T00:00:01Z'),
        content: [{ type: 'text', text: `answer ${id}` }],
        isMeta: false,
        isSidechain: false,
        toolCalls: [],
        toolResults: [],
        model: 'glm-5.3',
        usage: {
          input_tokens: 3_000,
          output_tokens: 2_000,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 100,
        },
      },
    ],
    processes: [],
    sidechainMessages: [],
    toolExecutions: [],
    semanticSteps: [],
    rawMessages: [],
  };
}

function detail(sessionId: string, chunks: unknown[]): SessionDetail {
  return {
    session: {
      id: sessionId,
      projectId: 'project-1',
      projectPath: '/tmp/proj-54',
      createdAt: 0,
      hasSubagents: false,
      messageCount: chunks.length,
      isOngoing: false,
      name: 'S',
      firstMessage: 'hi',
    },
    messages: [],
    chunks,
    processes: [],
    metrics: makeMetrics(chunks.length),
  } as unknown as SessionDetail;
}

const TURN1 = [userChunk('c-u1', 'u1'), aiChunk('c-ai-1')];
const TURN2 = [...TURN1, userChunk('c-u2', 'u2'), aiChunk('c-ai-2')];
const TURN3 = [...TURN2, userChunk('c-u3', 'u3'), aiChunk('c-ai-3')];

describe('sessionDetailSlice — Phase 2 on refresh (issue #54)', () => {
  let store: TestStore;
  let mockAPI: MockElectronAPI;

  beforeEach(() => {
    mockAPI = installMockElectronAPI();
    store = createTestStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** fetchSessionDetail's stillViewingSession guard requires selectedSessionId. */
  function seedAndFetch(sessionId: string, chunks: unknown[]) {
    store.setState({ selectedSessionId: sessionId });
    mockAPI.getSessionDetail.mockResolvedValueOnce(detail(sessionId, chunks));
    return store.getState().fetchSessionDetail('project-1', sessionId);
  }

  it('fetchSessionDetail computes context stats (Phase 2 baseline)', async () => {
    await seedAndFetch('s-base', TURN1);
    await vi.waitFor(() => {
      expect(store.getState().sessionContextStats?.has('c-ai-1')).toBe(true);
    });
  });

  it('refreshSessionInPlace recomputes stats for appended AI groups', async () => {
    await seedAndFetch('s-refresh', TURN1);
    await vi.waitFor(() => {
      expect(store.getState().sessionContextStats?.has('c-ai-1')).toBe(true);
    });

    // "user appended a turn to the JSONL" — next IPC returns the longer detail
    mockAPI.getSessionDetail.mockResolvedValue(detail('s-refresh', TURN2));
    await store.getState().refreshSessionInPlace('project-1', 's-refresh');

    await vi.waitFor(() => {
      // RED pre-fix: stats stay frozen at fetch-time values (only c-ai-1)
      expect(store.getState().sessionContextStats?.has('c-ai-2')).toBe(true);
      expect(store.getState().sessionPhaseInfo?.aiGroupPhaseMap.has('c-ai-2')).toBe(true);
    });
  });

  it('refreshSessionInPlace updates per-tab stats too', async () => {
    store.getState().openTab({
      type: 'session',
      sessionId: 's-tab',
      projectId: 'project-1',
      label: 'S',
    });
    const tabId = store.getState().activeTabId;
    expect(tabId).toBeTruthy();
    mockAPI.getSessionDetail.mockResolvedValueOnce(detail('s-tab', TURN1));
    await store.getState().fetchSessionDetail('project-1', 's-tab', tabId ?? undefined);
    await vi.waitFor(() => {
      expect(store.getState().tabSessionData[tabId ?? '']?.sessionContextStats?.has('c-ai-1')).toBe(
        true
      );
    });

    mockAPI.getSessionDetail.mockResolvedValue(detail('s-tab', TURN2));
    await store.getState().refreshSessionInPlace('project-1', 's-tab');

    await vi.waitFor(() => {
      // RED pre-fix: per-tab stats frozen as well
      expect(store.getState().tabSessionData[tabId ?? '']?.sessionContextStats?.has('c-ai-2')).toBe(
        true
      );
    });
  });

  it('a newer Phase-2 run wins over a still-in-flight older one', async () => {
    await seedAndFetch('s-race', TURN1);
    await vi.waitFor(() => {
      expect(store.getState().sessionContextStats?.has('c-ai-1')).toBe(true);
    });

    // Refresh A of s-race: its Phase-2 stalls in readClaudeMdFiles.
    let resolveClaudeMdA: (v: object) => void = () => {};
    mockAPI.getSessionDetail.mockResolvedValueOnce(detail('s-race', TURN2));
    mockAPI.readClaudeMdFiles.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveClaudeMdA = resolve;
        })
    );
    void store.getState().refreshSessionInPlace('project-1', 's-race');
    await vi.waitFor(() => {
      expect(
        store.getState().conversation?.items.some((i) => i.type === 'ai' && i.group.id === 'c-ai-2')
      ).toBe(true);
    });

    // A full fetch of ANOTHER session — its Phase-2 must invalidate A's
    // in-flight computation. Refresh generation alone cannot do that (A's
    // refresh generation never changed), the shared epoch can.
    store.setState({ selectedSessionId: 's-other' });
    mockAPI.getSessionDetail.mockResolvedValueOnce(detail('s-other', TURN1));
    await store.getState().fetchSessionDetail('project-1', 's-other');
    await vi.waitFor(() => {
      expect(store.getState().sessionContextStats?.has('c-ai-1')).toBe(true);
    });

    // A wakes after all that — it must drop its result: A computed over
    // s-race TURN2, so if A wrote, c-ai-2 would leak into the other
    // session's stats map.
    resolveClaudeMdA({});
    await new Promise((r) => setTimeout(r, 50));
    console.log(
      'final keys:',
      [...(store.getState().sessionContextStats?.keys() ?? [])],
      'conv:',
      store
        .getState()
        .conversation?.items.filter((i) => i.type === 'ai')
        .map((i) => i.group.id)
    );
    expect(store.getState().sessionContextStats?.has('c-ai-2')).toBe(false);
  });
});
