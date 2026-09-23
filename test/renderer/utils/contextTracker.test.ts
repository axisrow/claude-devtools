/**
 * Tests for the Loop and Wait-loop categories in contextTracker.
 *
 * Loop: repeat calls (from the 4th of a back-to-back identical series —
 * LOOP_MIN_STREAK, the live bell's default cycleThreshold — keyed via
 * bashStem(normalizeCallKey)) are bucketed into the loop category; earlier
 * calls of a streak stay in tool-output. The streak threads across AI groups.
 *
 * Wait-loop: quiet rounds (contextSize >= 50k, output <= 300) contribute their
 * billed input-side context once a turn has >= 5 of them (WAIT_LOOP_MIN_ROUNDS,
 * same criterion and gate as the CLI's wait_loop findings).
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
  it('keeps calls below the streak threshold in tool-output', () => {
    const items = [
      userGroup(),
      aiGroup(
        'ai-0',
        0,
        [
          ...toolCall('t1', '/src/a.ts', 5000),
          ...toolCall('t2', '/src/a.ts', 5000),
          ...toolCall('t3', '/src/a.ts', 5000),
        ],
        []
      ),
    ];

    const stats = lastStats(items).get('ai-0');
    expect(stats).toBeDefined();
    // streak reaches 3 < LOOP_MIN_STREAK — normal double Read, no waste bucket
    expect(stats!.tokensByCategory.loop).toBe(0);
    expect(stats!.accumulatedCounts.loop).toBe(0);
    expect(stats!.tokensByCategory.toolOutputs).toBeGreaterThan(0);
  });

  it('buckets calls from the 4th identical call into loop, earlier ones stay in tool-output', () => {
    const items = [
      userGroup(),
      aiGroup(
        'ai-0',
        0,
        [
          ...toolCall('t1', '/src/a.ts', 5000),
          ...toolCall('t2', '/src/a.ts', 5000),
          ...toolCall('t3', '/src/a.ts', 5000),
          ...toolCall('t4', '/src/a.ts', 5000),
        ],
        []
      ),
    ];

    const stats = lastStats(items).get('ai-0');
    expect(stats).toBeDefined();
    // only t4 (streak 4) is bucketed; t1..t3 stay legitimate
    expect(stats!.tokensByCategory.loop).toBeGreaterThan(0);
    expect(stats!.tokensByCategory.toolOutputs).toBe(stats!.tokensByCategory.loop * 3);

    const loopInj = stats!.newInjections.find((inj) => inj.category === 'loop');
    expect(loopInj).toBeDefined();
    if (loopInj?.category === 'loop') {
      expect(loopInj.breakdown).toHaveLength(1);
      expect(loopInj.breakdown[0].key).toBe('Read|/src/a.ts');
      expect(loopInj.breakdown[0].count).toBe(1);
      expect(loopInj.breakdown[0].toolUseId).toBe('t4');
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
          ...toolCall('t5', '/src/a.ts', 1000),
          ...toolCall('t6', '/src/a.ts', 1000),
        ],
        []
      ),
    ];

    const stats = lastStats(items).get('ai-0');
    expect(stats).toBeDefined();
    // only t6 is a bucketed repeat (t1→t2 breaks the series; a-streak restarts
    // at t3, so t6 is the 4th consecutive a-call, not the 6th)
    expect(stats!.accumulatedCounts.loop).toBe(1);
    expect(stats!.tokensByCategory.toolOutputs).toBe(stats!.tokensByCategory.loop * 5);
  });

  it('threads the streak across AI groups', () => {
    const items = [
      userGroup(),
      aiGroup('ai-0', 0, [...toolCall('t1', '/src/a.ts', 1000)], []),
      aiGroup(
        'ai-1',
        1,
        [
          ...toolCall('t2', '/src/a.ts', 1000),
          ...toolCall('t3', '/src/a.ts', 1000),
          ...toolCall('t4', '/src/a.ts', 1000),
        ],
        []
      ),
    ];

    const statsMap = lastStats(items);
    const first = statsMap.get('ai-0');
    const second = statsMap.get('ai-1');
    expect(first!.tokensByCategory.loop).toBe(0);
    // streak continues into the second group and reaches 4 on t4
    expect(second!.tokensByCategory.loop).toBeGreaterThan(0);
    expect(second!.accumulatedCounts.loop).toBe(1);
  });
});

describe('contextTracker wait-loop category', () => {
  it('counts quiet rounds (>=50k context, <=300 out) from the 5th on and skips active rounds', () => {
    const quiet = (): ParsedMessage =>
      assistantMsg({ input: 10000, cacheRead: 50000, output: 200 }); // quiet: 60k
    const items = [
      userGroup(),
      aiGroup(
        'ai-0',
        0,
        [],
        [
          quiet(),
          quiet(),
          assistantMsg({ input: 10000, cacheRead: 50000, output: 5000 }), // active
          quiet(),
          quiet(),
          quiet(),
        ]
      ),
    ];

    const stats = lastStats(items).get('ai-0');
    expect(stats).toBeDefined();
    expect(stats!.tokensByCategory.waitLoop).toBe(5 * 60000);
    expect(stats!.accumulatedCounts.waitLoop).toBe(5);
    // total also carries the real global CLAUDE.md injections picked up on the
    // first group — assert the wait-loop burn is included, not the exact total
    expect(stats!.totalEstimatedTokens).toBeGreaterThanOrEqual(5 * 60000);
  });

  it('ignores turns with fewer than 5 quiet rounds', () => {
    const items = [
      userGroup(),
      aiGroup(
        'ai-0',
        0,
        [],
        [
          assistantMsg({ input: 10000, cacheRead: 50000, output: 200 }), // quiet
          assistantMsg({ input: 10000, cacheRead: 50000, output: 200 }), // quiet
          assistantMsg({ input: 10000, cacheRead: 50000, output: 200 }), // quiet
          assistantMsg({ input: 10000, cacheRead: 50000, output: 200 }), // quiet
        ]
      ),
    ];

    const stats = lastStats(items).get('ai-0');
    expect(stats).toBeDefined();
    // 4 quiet rounds < WAIT_LOOP_MIN_ROUNDS — a normal short turn, not waste
    expect(stats!.tokensByCategory.waitLoop).toBe(0);
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
