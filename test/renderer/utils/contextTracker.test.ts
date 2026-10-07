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

import {
  processSessionContextWithPhases,
  classifyRounds,
  findLastTrackedAiGroupId,
  resolveContextTargetAiGroupId,
} from '@renderer/utils/contextTracker';

import type { AIGroup, UserGroup } from '@renderer/types/groups';
import type { ChatItem } from '@renderer/types/groups';
import type { ParsedMessage } from '@renderer/types/data';
import type { SemanticStep } from '@main/types/chunks';
import type { ContextPhaseInfo, ContextStats } from '@renderer/types/contextInjection';

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
  // same minimum-round gate as the CLI's wait_loop finding (WAIT_LOOP_MIN_TICKS)
  it('counts quiet rounds (>=50k context, <=300 out) once the 5-round gate is met', () => {
    const items = [
      userGroup(),
      aiGroup(
        'ai-0',
        0,
        [],
        [
          ...Array.from(
            { length: 5 },
            () => assistantMsg({ input: 10000, cacheRead: 50000, output: 200 }) // quiet: 60k + 200 out
          ),
          assistantMsg({ input: 10000, cacheRead: 50000, output: 5000 }), // active — not a tick
        ]
      ),
    ];

    const stats = lastStats(items).get('ai-0');
    expect(stats).toBeDefined();
    expect(stats!.tokensByCategory.waitLoop).toBe(5 * 60200);
    // accumulatedCounts.waitLoop counts quiet rounds (roundCount), not injections
    expect(stats!.accumulatedCounts.waitLoop).toBe(5);
    // total also carries the real global CLAUDE.md injections picked up on the
    // first group — assert the wait-loop burn is included, not the exact total
    expect(stats!.totalEstimatedTokens).toBeGreaterThanOrEqual(300000);
  });

  it('below the gate: 4 quiet rounds produce no wait-loop burn', () => {
    const items = [
      userGroup(),
      aiGroup(
        'ai-0',
        0,
        [],
        Array.from({ length: 4 }, () =>
          assistantMsg({ input: 10000, cacheRead: 50000, output: 200 })
        )
      ),
    ];

    const stats = lastStats(items).get('ai-0');
    expect(stats!.tokensByCategory.waitLoop).toBe(0);
    expect(stats!.accumulatedCounts.waitLoop).toBe(0);
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

describe('contextTracker turn re-read (hook parity)', () => {
  it('sums input-side context over ALL rounds; GLM fragments bill once', () => {
    const frag = (rid: string): ParsedMessage => {
      const m = assistantMsg({ input: 1000, cacheRead: 133_000, output: 100 });
      (m as unknown as { requestId?: string }).requestId = rid;
      return m;
    };
    const items = [
      userGroup(),
      aiGroup(
        'ai-0',
        0,
        [],
        [
          frag('req_a'),
          frag('req_a'), // stream fragment of the same request, full usage again
          assistantMsg({ input: 2000, cacheRead: 60_000, output: 2_000 }), // working round
        ]
      ),
    ];

    const stats = lastStats(items).get('ai-0');
    // fragment pair bills once (134k), working round adds 62k
    expect(stats!.turnRequests).toBe(2);
    expect(stats!.turnRereadTokens).toBe(196_000);
    // quiet subset untouched: 2 rounds < WAIT_LOOP_MIN_TICKS gate
    expect(stats!.tokensByCategory.waitLoop).toBe(0);
  });

  it('emits a reread injection for multi-request turns only, outside Visible totals', () => {
    const frag = (rid: string): ParsedMessage => {
      const m = assistantMsg({ input: 1000, cacheRead: 133_000, output: 100 });
      (m as unknown as { requestId?: string }).requestId = rid;
      return m;
    };
    const items = [
      userGroup(),
      aiGroup(
        'ai-0',
        0,
        [],
        [
          frag('req_a'),
          assistantMsg({ input: 2000, cacheRead: 60_000, output: 2_000 }), // working round
        ]
      ),
      // single-request turn: normal context send, no re-read flag
      aiGroup('ai-1', 1, [], [assistantMsg({ input: 1000, cacheRead: 5_000, output: 500 })]),
    ];

    const stats = lastStats(items);

    const turn0 = stats.get('ai-0')!;
    const rereadInj = turn0.newInjections.find((inj) => inj.category === 'reread');
    expect(rereadInj).toBeDefined();
    if (rereadInj?.category === 'reread') {
      expect(rereadInj.estimatedTokens).toBe(196_000);
      expect(rereadInj.requests).toBe(2);
      expect(rereadInj.aiGroupId).toBe('ai-0');
    }
    expect(turn0.tokensByCategory.reread).toBe(196_000);
    // spend, not content: Visible total stays free of the reread entry
    // (accumulatedInjections is only populated on the phase's last group)
    const last = stats.get('ai-1')!;
    const expectedVisible = last.accumulatedInjections
      .filter((inj) => inj.category !== 'reread')
      .reduce((sum, inj) => sum + inj.estimatedTokens, 0);
    expect(last.totalEstimatedTokens).toBe(expectedVisible);

    const turn1 = stats.get('ai-1')!;
    expect(turn1.newInjections.some((inj) => inj.category === 'reread')).toBe(false);
  });
});

describe('contextTracker compaction reset', () => {
  function compactItem(): ChatItem {
    return {
      type: 'compact',
      group: { id: 'compact-0' } as unknown as never,
    } as unknown as ChatItem;
  }

  it("loopState resets on compaction — repeat streaks don't leak across phases", () => {
    const items = [
      userGroup(),
      aiGroup(
        'ai-0',
        0,
        [...toolCall('t1', '/src/a.ts', 5000), ...toolCall('t2', '/src/a.ts', 5000)],
        [assistantMsg({ input: 10000, cacheRead: 50000, output: 200 }, ['t1', 't2'])]
      ),
      compactItem(),
      userGroup(),
      aiGroup(
        'ai-1',
        0,
        [...toolCall('t3', '/src/a.ts', 5000), ...toolCall('t4', '/src/a.ts', 5000)],
        [assistantMsg({ input: 10000, cacheRead: 50000, output: 200 }, ['t3', 't4'])]
      ),
    ];

    const stats = lastStats(items).get('ai-1');
    expect(stats).toBeDefined();
    // without the reset this would be the 3rd+4th occurrence of the same key
    // (loop = 2 entries); with the reset the streak restarts: only the 2nd
    // call of the new phase loops — 60.2k, not 120.4k
    expect(stats!.tokensByCategory.loop).toBe(60_200);
  });
});

describe('findLastTrackedAiGroupId', () => {
  it('returns the last AI group that has stats (not just the last AI group)', () => {
    const items = [userGroup(), aiGroup('a', 0, [], []), userGroup(), aiGroup('b', 1, [], [])];
    const stats = new Map([['a', { accumulatedInjections: [] } as unknown as ContextStats]]);
    expect(findLastTrackedAiGroupId(items, stats)).toBe('a');
  });

  it('returns undefined when stats are empty', () => {
    const items = [userGroup(), aiGroup('a', 0, [], [])];
    expect(findLastTrackedAiGroupId(items, new Map())).toBeUndefined();
  });

  it('returns the last AI group when all of them are tracked', () => {
    const items = [aiGroup('a', 0, [], []), aiGroup('b', 1, [], [])];
    const stats = new Map(['a', 'b'].map((id) => [id, {} as unknown as ContextStats]));
    expect(findLastTrackedAiGroupId(items, stats)).toBe('b');
  });

  it('skips non-AI items', () => {
    const items = [aiGroup('a', 0, [], []), userGroup(), userGroup()];
    const stats = new Map([['a', {} as unknown as ContextStats]]);
    expect(findLastTrackedAiGroupId(items, stats)).toBe('a');
  });
});

describe('resolveContextTargetAiGroupId', () => {
  const phaseInfo = {
    phases: [
      { phaseNumber: 1, firstAIGroupId: 'a', lastAIGroupId: 'a', compactGroupId: null },
      { phaseNumber: 2, firstAIGroupId: 'b', lastAIGroupId: 'b', compactGroupId: 'c1' },
    ],
    compactionCount: 1,
  } as unknown as ContextPhaseInfo;

  it('selected phase resolves within itself when tracked', () => {
    const items = [aiGroup('a', 0, [], []), aiGroup('b', 1, [], [])];
    const stats = new Map(['a', 'b'].map((id) => [id, {} as unknown as ContextStats]));
    expect(resolveContextTargetAiGroupId(items, stats, phaseInfo, 2)).toBe('b');
  });

  it('selected but untracked phase renders empty — never another phase', () => {
    const items = [aiGroup('a', 0, [], []), aiGroup('b', 1, [], [])];
    const stats = new Map([['a', {} as unknown as ContextStats]]);
    // 'a' is tracked, but it belongs to phase 1 — must not leak into phase 2
    expect(resolveContextTargetAiGroupId(items, stats, phaseInfo, 2)).toBeUndefined();
  });

  it('no selection: last tracked group wins', () => {
    const items = [aiGroup('a', 0, [], []), aiGroup('b', 1, [], [])];
    const stats = new Map([['a', {} as unknown as ContextStats]]);
    expect(resolveContextTargetAiGroupId(items, stats, null, null)).toBe('a');
  });
});

describe('contextTracker injection identity on group.id (issue #53)', () => {
  // post-#52 shape: a compact/system boundary tears one turn into two AI
  // groups sharing the same turnIndex
  it('two AI groups of one turn keep distinct injection ids and their own aiGroupId', () => {
    const items = [
      userGroup(),
      aiGroup('ai-xxx', 0, toolCall('t1', '/src/a.ts', 1000), [
        assistantMsg({ input: 1000, cacheRead: 5000, output: 100 }, ['t1']),
      ]),
      aiGroup('ai-yyy', 0, toolCall('t2', '/src/b.ts', 1000), [
        assistantMsg({ input: 1000, cacheRead: 5000, output: 100 }, ['t2']),
      ]),
    ];

    const stats = lastStats(items);
    const first = stats.get('ai-xxx')!;
    const second = stats.get('ai-yyy')!;

    // every injection carrying aiGroupId points at its OWN group, not "ai-<turnIndex>"
    for (const [groupId, entry] of [
      ['ai-xxx', first],
      ['ai-yyy', second],
    ] as const) {
      for (const inj of entry.newInjections) {
        if ('aiGroupId' in inj) expect(inj.aiGroupId).toBe(groupId);
      }
    }

    // no shared ids between the two groups of the same turn
    const firstIds = new Set(first.newInjections.map((inj) => inj.id));
    for (const inj of second.newInjections) {
      expect(firstIds.has(inj.id)).toBe(false);
    }

    // claude-md keeps its display metadata: real first-seen group + turn label
    const claudeMd = first.newInjections.find((inj) => inj.category === 'claude-md');
    expect(claudeMd).toBeDefined();
    if (claudeMd?.category === 'claude-md') {
      expect(claudeMd.firstSeenInGroup).toBe('ai-xxx');
      expect(claudeMd.firstSeenTurnIndex).toBe(0);
    }
  });
});
