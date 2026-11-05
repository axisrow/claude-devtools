import { describe, expect, it } from 'vitest';

import { SubagentRunwayDetector } from '../../../src/main/utils/subagentWatch';
import type { ParsedMessage } from '@main/types';

/** Minimal ParsedMessage fixture for detector feeds. */
const msg = (o: {
  type?: string;
  ts?: string;
  id?: string;
  requestId?: string;
  input?: number;
  output?: number;
}): ParsedMessage =>
  ({
    type: o.type ?? 'assistant',
    timestamp: new Date(o.ts ?? '2026-11-04T10:00:00.000Z'),
    ...(o.id ? { messageId: o.id } : {}),
    ...(o.requestId ? { requestId: o.requestId } : {}),
    usage: o.input
      ? {
          input_tokens: o.input,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: o.output ?? 0,
        }
      : undefined,
  }) as unknown as ParsedMessage;

describe('SubagentRunwayDetector', () => {
  it('rings on span >= minutes (triggeredBy minutes)', () => {
    const d = new SubagentRunwayDetector();
    const inc = d.feed(
      '/f/agent-a.jsonl',
      [
        msg({ type: 'user', ts: '2026-11-04T10:00:00Z' }),
        msg({ id: 'm1', input: 100, ts: '2026-11-04T11:30:00Z' }),
      ],
      { enabled: true, minutes: 60, tokens: 10_000_000 }
    );
    expect(inc?.triggeredBy).toBe('minutes');
    expect(inc?.minutes).toBe(90);
    expect(inc?.rounds).toBe(1);
    expect(inc?.inputSide).toBe(100);
  });

  it('rings on tokens first when only burn crossed (span tiny)', () => {
    const d = new SubagentRunwayDetector();
    const inc = d.feed(
      '/f/agent-b.jsonl',
      [msg({ id: 'm1', input: 10_000_001, ts: '2026-11-04T10:00:00Z' })],
      { enabled: true, minutes: 60, tokens: 10_000_000 }
    );
    expect(inc?.triggeredBy).toBe('tokens');
    expect(inc?.inputSide).toBe(10_000_001);
  });

  it('stays silent under both thresholds; lineless feed never rings', () => {
    const d = new SubagentRunwayDetector();
    const under = d.feed(
      '/f/agent-c.jsonl',
      [msg({ id: 'm1', input: 100, ts: '2026-11-04T10:00:00Z' })],
      { enabled: true, minutes: 60, tokens: 10_000_000 }
    );
    expect(under).toBeNull();
    const lineless = d.feed(
      '/f/agent-d.jsonl',
      [msg({ type: 'user', ts: '2026-11-04T10:00:00Z' })],
      {
        enabled: true,
        minutes: 1,
        tokens: 1,
      }
    );
    expect(lineless).toBeNull();
  });

  it('edge-latches: one incident per file; reset re-arms', () => {
    const d = new SubagentRunwayDetector();
    const batch = [msg({ id: 'm1', input: 10_000_001, ts: '2026-11-04T10:00:00Z' })];
    expect(
      d.feed('/f/agent-e.jsonl', batch, { enabled: true, minutes: 60, tokens: 10_000_000 })
    ).not.toBeNull();
    expect(
      d.feed('/f/agent-e.jsonl', [], { enabled: true, minutes: 60, tokens: 10_000_000 })
    ).toBeNull();
    d.reset('/f/agent-e.jsonl');
    expect(
      d.feed('/f/agent-e.jsonl', batch, { enabled: true, minutes: 60, tokens: 10_000_000 })
    ).not.toBeNull();
  });

  it('bills across batches with request dedup: fragments replace, rounds stay 1', () => {
    const d = new SubagentRunwayDetector();
    d.feed('/f/agent-f.jsonl', [msg({ id: 'm1', input: 1000, ts: '2026-11-04T10:00:00Z' })], {
      enabled: true,
      minutes: 60,
      tokens: 10_000_000,
    });
    const inc = d.feed(
      '/f/agent-f.jsonl',
      [msg({ id: 'm1', input: 1200, ts: '2026-11-04T10:05:00Z' })],
      { enabled: true, minutes: 60, tokens: 10_000_000 }
    );
    expect(inc).toBeNull(); // under thresholds still
    const crossing = d.feed(
      '/f/agent-f.jsonl',
      [msg({ id: 'm2', input: 10_000_001, ts: '2026-11-04T10:06:00Z' })],
      { enabled: true, minutes: 60, tokens: 10_000_000 }
    );
    expect(crossing).not.toBeNull();
    expect(crossing?.inputSide).toBe(1200 + 10_000_001);
    expect(crossing?.rounds).toBe(2);
  });
});
