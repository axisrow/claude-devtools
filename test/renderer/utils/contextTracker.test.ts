/**
 * Tests for the Loop and Wait-loop categories in contextTracker.
 *
 * Loop: repeat calls (2..N of a back-to-back identical series, keyed via
 * bashStem(normalizeCallKey)) are bucketed into the loop category; the first
 * call stays in tool-output. The streak threads across AI groups.
 *
 * Wait-loop: quiet rounds (contextSize >= 50k, output <= 300) contribute their
 * full billed usage (input + cache + output) — same criterion as the CLI's
 * wait_loop findings.
 *
 * Loop: tokens are the billed usage of rounds carrying repeat calls (each
 * round once), not content estimates — rounds without usage contribute 0.
 */

import { describe, expect, it } from 'vitest';

import { processSessionContextWithPhases, classifyRounds } from '@renderer/utils/contextTracker';

import type { AIGroup, UserGroup } from '@renderer/types/groups';
import type { ChatItem } from '@renderer/types/groups';
import type { ParsedMessage } from '@renderer/types/data';
import type { SemanticStep } from '@main/types/chunks';
import type { ContextStats } from '@renderer/types/contextInjection';

// Minimal assistant message with usage for wait-loop accounting
function assistantMsg(
  usage: {
    input?: number;
    cacheRead?: number;
    output?: number;
  },
  toolUseIds: string[] = []
): ParsedMessage {
  return {
    type: 'assistant',
    usage: {
      input_tokens: usage.input ?? 0,
      cache_read_input_tokens: usage.cacheRead ?? 0,
      cache_creation_input_tokens: 0,
      output_tokens: usage.output ?? 0,
    },
    content: toolUseIds.map((id) => ({ type: 'tool_use', id, name: 'Read', input: {} })),
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
        // one round carrying both calls bills the loop exactly once
        [assistantMsg({ input: 10000, cacheRead: 50000, output: 200 }, ['t1', 't2'])]
      ),
    ];

    const stats = lastStats(items).get('ai-0');
    expect(stats).toBeDefined();
    expect(stats!.tokensByCategory.loop).toBe(60200);

    const loopInj = stats!.newInjections.find((inj) => inj.category === 'loop');
    expect(loopInj).toBeDefined();
    if (loopInj?.category === 'loop') {
      expect(loopInj.breakdown).toHaveLength(1);
      expect(loopInj.breakdown[0].key).toBe('Read|/src/a.ts');
      expect(loopInj.breakdown[0].count).toBe(1);
      expect(loopInj.breakdown[0].toolUseId).toBe('t2');
      expect(loopInj.breakdown[0].tokenCount).toBe(60200);
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
        [assistantMsg({ input: 10000, cacheRead: 50000, output: 200 }, ['t4'])]
      ),
    ];

    const stats = lastStats(items).get('ai-0');
    expect(stats).toBeDefined();
    // only t4 is a repeat (t1->t2->t3 breaks the series)
    expect(stats!.accumulatedCounts.loop).toBe(1);
    expect(stats!.tokensByCategory.loop).toBe(60200);
  });

  it('threads the streak across AI groups', () => {
    const items = [
      userGroup(),
      aiGroup('ai-0', 0, [...toolCall('t1', '/src/a.ts', 1000)], []),
      aiGroup(
        'ai-1',
        1,
        [...toolCall('t2', '/src/a.ts', 1000)],
        [assistantMsg({ input: 10000, cacheRead: 50000, output: 200 }, ['t2'])]
      ),
    ];

    const statsMap = lastStats(items);
    const first = statsMap.get('ai-0');
    const second = statsMap.get('ai-1');
    expect(first!.tokensByCategory.loop).toBe(0);
    expect(second!.tokensByCategory.loop).toBeGreaterThan(0);
  });
});

describe('classifyRounds', () => {
  it('marks quiet, repeat and normal rounds with 4-component billing', () => {
    const responses = [
      // quiet idle tick: big context, nothing produced, NO tool call
      assistantMsg({ input: 10000, cacheRead: 50000, output: 200 }),
      // working round (carries a repeat call) — same usage, but NOT quiet
      assistantMsg({ input: 10000, cacheRead: 50000, output: 200 }, ['t1']),
      // active round — big output, not quiet
      assistantMsg({ input: 10000, cacheRead: 50000, output: 5000 }),
      // normal small round
      assistantMsg({ input: 500, cacheRead: 500, output: 100 }),
    ];
    const keyByToolId = new Map([['t1', 'Read|/src/a.ts']]);

    const rounds = classifyRounds(responses, keyByToolId);

    expect(rounds).toHaveLength(4);
    expect(rounds[0]).toMatchObject({
      uuid: 'round-1',
      index: 1,
      quiet: true,
      repeat: false,
      billed: 60200,
    });
    // a round with a tool call is work, never a quiet tick — even with tiny output
    expect(rounds[1]).toMatchObject({ index: 2, quiet: false, repeat: true, billed: 60200 });
    expect(rounds[1].keys).toEqual(['Read|/src/a.ts']);
    expect(rounds[2].quiet).toBe(false);
    expect(rounds[3]).toMatchObject({ index: 4, quiet: false, repeat: false, billed: 1100 });
  });

  it('marks echo-marker rounds (tool call, no context growth) as stalled', () => {
    const responses = [
      // baseline work round: context jumps to ~134k, loud output — not stalled
      assistantMsg({ input: 200, cacheRead: 134_000, output: 2_000 }, ['t0']),
      // the live 0779a2bc shape: tool call each round, context grows by the
      // tiny tool result only (+24), output ~19 tok — `echo w/v/u` markers
      assistantMsg({ input: 100, cacheRead: 134_124, output: 19 }, ['t1']),
      assistantMsg({ input: 101, cacheRead: 134_148, output: 20 }, ['t2']),
      assistantMsg({ input: 102, cacheRead: 134_172, output: 21 }, ['t3']),
    ];

    const rounds = classifyRounds(responses);

    expect(rounds[0].stalled).toBe(false); // loud output — real work
    expect(rounds[1].stalled).toBe(true);
    expect(rounds[2].stalled).toBe(true);
    expect(rounds[3].stalled).toBe(true);
  });

  it('a shrinking window (compaction) is not stalled; the first round never is', () => {
    const responses = [
      assistantMsg({ input: 100, cacheRead: 134_000, output: 100 }, ['t1']),
      // context collapse — compaction, progress of a kind, not a stall
      assistantMsg({ input: 100, cacheRead: 50_000, output: 100 }, ['t2']),
    ];

    const rounds = classifyRounds(responses);

    expect(rounds[0].stalled).toBe(false); // first round: no baseline yet
    expect(rounds[1].stalled).toBe(false); // negative delta
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
          assistantMsg({ input: 10000, cacheRead: 50000, output: 200 }), // quiet: 60k + 200 out
          assistantMsg({ input: 10000, cacheRead: 50000, output: 5000 }), // active
        ]
      ),
    ];

    const stats = lastStats(items).get('ai-0');
    expect(stats).toBeDefined();
    expect(stats!.tokensByCategory.waitLoop).toBe(60200);
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
