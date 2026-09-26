/**
 * Shared conversation fixtures for search/filter tests (issue #36).
 */

import type { SessionConversation } from '../../../src/renderer/types/groups';

type ChatItem = SessionConversation['items'][number];

export const NOW = new Date('2026-01-01T00:00:00Z');

/** Conversation fixture builder */
export function makeConversation(items: ChatItem[]): SessionConversation {
  return {
    sessionId: 's1',
    items,
    totalUserGroups: 0,
    totalSystemGroups: 0,
    totalAIGroups: 0,
    totalCompactGroups: 0,
  };
}

/** AI group fixture: a turn with the given semantic steps */
export function makeAIGroup(steps: unknown[], id = 'ai-g1', responses: unknown[] = []): ChatItem {
  return {
    type: 'ai',
    group: {
      id,
      turnIndex: 0,
      startTime: NOW,
      endTime: NOW,
      durationMs: 0,
      steps: steps as never,
      tokens: { input: 0, output: 0, cached: 0 },
      summary: {} as never,
      status: 'complete',
      processes: [],
      chunkId: 'c1',
      metrics: {},
      responses,
    },
  } as ChatItem;
}

/** thinking → tool_call → tool_result → output steps for one turn */
export function makeSteps(opts: {
  thinking?: string;
  toolCallId?: string;
  toolResult?: { content: string; isError: boolean };
  output?: string;
}): unknown[] {
  const steps: unknown[] = [];
  if (opts.thinking) {
    steps.push({
      id: 's-think',
      type: 'thinking',
      startTime: NOW,
      durationMs: 0,
      content: { thinkingText: opts.thinking },
      context: 'main',
    });
  }
  if (opts.toolCallId) {
    steps.push({
      id: opts.toolCallId,
      type: 'tool_call',
      startTime: NOW,
      durationMs: 0,
      content: { toolName: 'Bash', toolInput: { command: 'run check' } },
      context: 'main',
    });
    if (opts.toolResult) {
      steps.push({
        id: opts.toolCallId,
        type: 'tool_result',
        startTime: NOW,
        durationMs: 0,
        content: {
          toolName: 'Bash',
          toolResultContent: opts.toolResult.content,
          isError: opts.toolResult.isError,
        },
        context: 'main',
      });
    }
  }
  if (opts.output) {
    steps.push({
      id: 's-out',
      type: 'output',
      startTime: NOW,
      durationMs: 0,
      content: { outputText: opts.output },
      context: 'main',
    });
  }
  return steps;
}

/** user ChatItem fixture */
export function makeUserGroup(
  id: string,
  rawText: string,
  messageContent?: string,
  timestamp?: Date
): ChatItem {
  return {
    type: 'user',
    group: {
      id,
      message: {
        uuid: id,
        content: messageContent ?? rawText,
        timestamp: timestamp ?? NOW,
      } as never,
      timestamp: timestamp ?? NOW,
      index: 0,
      content: { rawText, commands: [], images: [], fileReferences: [] },
    },
  } as ChatItem;
}

/** system ChatItem fixture */
export function makeSystemGroup(id: string, output: string): ChatItem {
  return {
    type: 'system',
    group: { id, message: { uuid: id } as never, timestamp: NOW, commandOutput: output },
  } as ChatItem;
}
