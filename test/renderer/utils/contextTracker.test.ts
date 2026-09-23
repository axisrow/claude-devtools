/**
 * Tests for the Loop and Wait-loop categories in contextTracker.
 *
 * Loop: repeat calls (2..N of a back-to-back identical series, keyed via
 * bashStem(normalizeCallKey)) are bucketed into the loop category; the first
 * call stays in tool-output. The streak threads across AI groups.
 *
 * Wait-loop: quiet rounds (contextSize >= 50k, output <= 300) contribute their
 * billed input-side context — same criterion as the CLI's wait_loop findings.
 */

import { describe, expect, it } from 'vitest';

import { processSessionContextWithPhases } from '@renderer/utils/contextTracker';

import type { AIGroup, UserGroup } from '@renderer/types/groups';
import type { ChatItem } from '@renderer/types/groups';
import type { ParsedMessage } from '@renderer/types/data';
import type { SemanticStep } from '@main/types/chunks';
import type { ContextStats } from '@renderer/types/contextInjection';

// Minimal assistant message with usage for wait-loop accounting
function assistantMsg(usage: {
  input?: number;
  cacheRead?: number;
  output?: number;
}): ParsedMessage {
  return {
    type: 'assistant',
    usage: {
      input_tokens: usage.input ?? 0,
      cache_read_input_tokens: usage.cacheRead ?? 0,
      cache_creation_input_tokens: 0,
      output_tokens: usage.output ?? 0,
    },
  } as unknown as ParsedMessage;
}

// tool_call + tool_result step pair with the given result token count
function toolCall(id: string, filePath: string, resultTokens: number): SemanticStep[] {
  const call: SemanticStep = {
    id,
    type: 'tool_call',
    startTime: new Date('2026-09-23T10:00:00Z'),
    durationMs: 10,
    content: { toolName: 'Read', toolInput: { file_path: filePath } },
    context: 'main',
  };
  const result: SemanticStep = {
    id,
    type: 'tool_result',
    startTime: new Date('2026-09-23T10:00:01Z'),
    durationMs: 5,
    content: { toolName: 'Read', tokenCount: resultTokens },
    context: 'main',
  };
  return [call, result];
}

// Minimal AI group carrying the given steps and response messages
function aiGroup(
  id: string,
  turnIndex: number,
  steps: SemanticStep[],
  responses: ParsedMessage[]
): ChatItem {
  return {
    type: 'ai',
    group: {
      id,
      turnIndex,
      startTime: new Date(),
      endTime: new Date(),
      durationMs: 100,
      steps,
      responses,
      processes: [],
    } as unknown as AIGroup,
  };
}

function userGroup(): ChatItem {
  return { type: 'user', group: { content: { text: '' } } as unknown as UserGroup };
}

function lastStats(items: ChatItem[]): Map<string, ContextStats> {
  const { statsMap } = processSessionContextWithPhases(items, '/proj');
  return statsMap;
}

describe('contextTracker loop category', () => {
  it('buckets the 2nd identical call into loop, first stays in tool-output', () => {
    const items = [
      userGroup(),
      aiGroup(
        'ai-0',
        0,
        [...toolCall('t1', '/src/a.ts', 5000), ...toolCall('t2', '/src/a.ts', 5000)],
        []
      ),
    ];

    const stats = lastStats(items).get('ai-0');
    expect(stats).toBeDefined();
    expect(stats!.tokensByCategory.loop).toBeGreaterThan(0);
    expect(stats!.tokensByCategory.loop).toBe(stats!.tokensByCategory.toolOutputs);

    const loopInj = stats!.newInjections.find((inj) => inj.category === 'loop');
    expect(loopInj).toBeDefined();
    if (loopInj?.category === 'loop') {
      expect(loopInj.breakdown).toHaveLength(1);
      expect(loopInj.breakdown[0].key).toBe('Read|/src/a.ts');
      expect(loopInj.breakdown[0].count).toBe(1);
      expect(loopInj.breakdown[0].toolUseId).toBe('t2');
    }
  });

  it('resets the streak when the key changes', () => {
    const items = [
      userGroup(),
      aiGroup(
        'ai-0',
        0,
        [
          ...toolCall('t1', '/src/a.ts', 1000),
          ...toolCall('t2', '/src/b.ts', 1000),
          ...toolCall('t3', '/src/a.ts', 1000),
          ...toolCall('t4', '/src/a.ts', 1000),
        ],
        []
      ),
    ];

    const stats = lastStats(items).get('ai-0');
    expect(stats).toBeDefined();
    // only t4 is a repeat (t1->t2->t3 breaks the series)
    expect(stats!.accumulatedCounts.loop).toBe(1);
    expect(stats!.tokensByCategory.toolOutputs).toBe(stats!.tokensByCategory.loop * 3);
  });

  it('threads the streak across AI groups', () => {
    const items = [
      userGroup(),
      aiGroup('ai-0', 0, [...toolCall('t1', '/src/a.ts', 1000)], []),
      aiGroup('ai-1', 1, [...toolCall('t2', '/src/a.ts', 1000)], []),
    ];

    const statsMap = lastStats(items);
    const first = statsMap.get('ai-0');
    const second = statsMap.get('ai-1');
    expect(first!.tokensByCategory.loop).toBe(0);
    expect(second!.tokensByCategory.loop).toBeGreaterThan(0);
  });
});

describe('contextTracker wait-loop category', () => {
  it('counts quiet rounds (>=50k context, <=300 out) and skips active rounds', () => {
    const items = [
      userGroup(),
      aiGroup(
        'ai-0',
        0,
        [],
        [
          assistantMsg({ input: 10000, cacheRead: 50000, output: 200 }), // quiet: 60k
          assistantMsg({ input: 10000, cacheRead: 50000, output: 5000 }), // active
        ]
      ),
    ];

    const stats = lastStats(items).get('ai-0');
    expect(stats).toBeDefined();
    expect(stats!.tokensByCategory.waitLoop).toBe(60000);
    expect(stats!.accumulatedCounts.waitLoop).toBe(1);
    // total also carries the real global CLAUDE.md injections picked up on the
    // first group — assert the wait-loop burn is included, not the exact total
    expect(stats!.totalEstimatedTokens).toBeGreaterThanOrEqual(60000);
  });

  it('ignores rounds below the context threshold', () => {
    const items = [
      userGroup(),
      aiGroup(
        'ai-0',
        0,
        [],
        [
          assistantMsg({ input: 5000, cacheRead: 5000, output: 100 }), // 10k < 50k
        ]
      ),
    ];

    const stats = lastStats(items).get('ai-0');
    expect(stats!.tokensByCategory.waitLoop).toBe(0);
  });
});
