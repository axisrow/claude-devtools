import { describe, expect, it } from 'vitest';

import { feedLine, percentile } from '../../src/cli/turnSpendStats';

function userLine(content: unknown, isMeta?: boolean): string {
  return JSON.stringify({
    type: 'user',
    isMeta: isMeta ?? false,
    message: { role: 'user', content },
  });
}

function assistantLine(input: number, cacheRead: number, output: number): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [],
      model: 'claude',
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: 0,
        output_tokens: output,
      },
    },
  });
}

function mkState() {
  return {
    current: null as null | { inputSide: number; rounds: number; file: string; turnIndex: number },
    spends: [] as { inputSide: number; rounds: number; file: string; turnIndex: number }[],
    file: 'f.jsonl',
  };
}

describe('turnSpendStats', () => {
  it('bounds turns by real user messages and sums assistant input side', () => {
    const s = mkState();
    for (const line of [
      userLine('first prompt'),
      assistantLine(1000, 50_000, 200),
      assistantLine(1000, 50_000, 10_000),
      userLine('second prompt'),
      assistantLine(2000, 60_000, 500),
    ]) {
      feedLine(line, s);
    }
    expect(s.spends).toHaveLength(1);
    expect(s.spends[0].inputSide).toBe(102_000);
    expect(s.spends[0].rounds).toBe(2);
  });

  it('ignores tool results and internal isMeta lines as boundaries', () => {
    const s = mkState();
    for (const line of [
      userLine('prompt'),
      assistantLine(500, 10_000, 100),
      userLine([{ type: 'tool_result', content: 'x' }], true),
      assistantLine(500, 10_000, 100),
      userLine('next'),
    ]) {
      feedLine(line, s);
    }
    expect(s.spends).toHaveLength(1);
    expect(s.spends[0].inputSide).toBe(21_000);
    expect(s.spends[0].rounds).toBe(2);
  });

  it('bounds turns at compaction markers too — the hook boundary, not just user messages', () => {
    const s = mkState();
    for (const line of [
      userLine('before compact'),
      assistantLine(1000, 50_000, 200),
      JSON.stringify({
        type: 'user',
        isMeta: true,
        isCompactSummary: true,
        message: { role: 'user', content: 'compact summary' },
      }),
      assistantLine(2000, 60_000, 500),
    ]) {
      feedLine(line, s);
    }
    // post-compact activity is its own turn — pre-compact spend must not fold in
    expect(s.spends).toHaveLength(1);
    expect(s.spends[0].inputSide).toBe(51_000);
    expect(s.spends[0].rounds).toBe(1);
    expect(s.current?.inputSide).toBe(62_000);
  });

  it('computes nearest-rank percentile', () => {
    const sorted = [10, 20, 30, 40, 100];
    expect(percentile(sorted, 50)).toBe(30);
    expect(percentile(sorted, 99)).toBe(100);
    expect(percentile([], 99)).toBe(0);
  });
});
