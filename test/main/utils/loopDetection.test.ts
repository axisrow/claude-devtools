import { describe, expect, it } from 'vitest';

import type { ParsedMessage } from '../../../src/main/types';
import { LoopDetector, StallDetector } from '../../../src/main/utils/loopDetection';

/** Minimal ParsedMessage fixture: one assistant line carrying tool calls. */
const assistant = (
  uuid: string,
  calls: { id: string; name: string; input?: Record<string, unknown> }[],
  opts: { sidechain?: boolean; model?: string } = {}
): ParsedMessage =>
  ({
    uuid,
    parentUuid: null,
    type: 'assistant',
    timestamp: new Date(),
    content: [],
    model: opts.model ?? 'claude-sonnet-5',
    isSidechain: opts.sidechain ?? false,
    isMeta: false,
    toolCalls: calls.map((c) => ({ id: c.id, name: c.name, input: c.input ?? {}, isTask: false })),
    toolResults: [],
  }) as unknown as ParsedMessage;

const read = (
  id: string,
  file: string
): { id: string; name: string; input: Record<string, unknown> } => ({
  id,
  name: 'Read',
  input: { file_path: file },
});

describe('LoopDetector', () => {
  it('fires once at threshold, stays quiet until doubling', () => {
    const det = new LoopDetector();
    const msgs = [1, 2, 3, 4, 5, 6].map((n) => assistant(`m${n}`, [read(`t${n}`, '/x/f')]));
    const first = det.feed('s1', msgs.slice(0, 3), 3);
    expect(first).toEqual({
      key: 'Read|/x/f',
      count: 3,
      toolUseId: 't3',
      cwd: undefined,
      batchIndex: 2,
    });
    // counts 4 and 5 are below the 2x doubling bar -> quiet
    expect(det.feed('s1', msgs.slice(3, 5), 3)).toBeNull();
    // 6th call doubles the notified length 3 -> re-notify
    const second = det.feed('s1', [msgs[5]], 3);
    expect(second?.count).toBe(6);
    expect(second?.toolUseId).toBe('t6');
  });

  it('keeps counting after an incident to the end of the batch', () => {
    const det = new LoopDetector();
    const msgs = [1, 2, 3, 4, 5, 6].map((n) => assistant(`m${n}`, [read(`t${n}`, '/x/f')]));
    // first incident at 3; the rest of the batch still counts (no second incident)
    expect(det.feed('s', msgs, 3)?.count).toBe(3);
    // streak reached 6 in-batch, so the doubling bar (2×3) is crossed at 7,
    // and the streaming snapshot dup of t6 is skipped (true last call id)
    const next = det.feed(
      's',
      [assistant('d', [read('t6', '/x/f')]), assistant('m7', [read('t7', '/x/f')])],
      3
    );
    expect(next?.count).toBe(7);
    expect(next?.toolUseId).toBe('t7');
  });

  it('dedupes streaming snapshots by consecutive toolUseId', () => {
    const det = new LoopDetector();
    const msgs = [
      assistant('m1', [read('t1', '/x/f')]),
      assistant('m2', [read('t1', '/x/f')]),
      assistant('m3', [read('t2', '/x/f')]),
    ];
    expect(det.feed('s', msgs, 2)).toEqual({
      key: 'Read|/x/f',
      count: 2,
      toolUseId: 't2',
      cwd: undefined,
      batchIndex: 2,
    });
  });

  it('resets the run when the key changes; a fresh run notifies again', () => {
    const det = new LoopDetector();
    const msgs = [
      ...[1, 2].map((n) => assistant(`a${n}`, [read(`t${n}`, '/x/f')])), // 2x Read
      assistant('b1', [read('t3', '/x/other')]), // key change -> run resets
      ...[4, 5, 6].map((n) => assistant(`a${n}`, [read(`t${n}`, '/x/f')])), // fresh run
    ];
    det.feed('s', msgs.slice(0, 3), 3); // 2x Read + break
    const incident = det.feed('s', msgs.slice(3), 3); // 3x Read -> fire
    expect(incident?.count).toBe(3);
  });

  it('files are independent', () => {
    const det = new LoopDetector();
    const a = [1, 2].map((n) => assistant(`p${n}`, [read(`p${n}`, '/x/f')]));
    const b = [1, 2, 3].map((n) => assistant(`q${n}`, [read(`q${n}`, '/x/f')]));
    det.feed('s1', a, 3);
    det.feed('s2', b, 3);
    const s1Incident = det.feed('s1', [assistant('p3', [read('p3', '/x/f')])], 3);
    expect(s1Incident?.count).toBe(3);
  });

  it('ignores sidechain and synthetic messages', () => {
    const det = new LoopDetector();
    const msgs = [
      assistant('n1', [read('t1', '/x/f')]),
      assistant('n2', [read('t2', '/x/f')], { sidechain: true }),
      assistant('n3', [read('t3', '/x/f')], { model: '<synthetic>' }),
      assistant('n4', [read('t4', '/x/f')]),
    ];
    // only 2 counted, below threshold
    expect(det.feed('s', msgs, 3)).toBeNull();
    expect(det.feed('s', [assistant('n5', [read('t5', '/x/f')])], 3)?.count).toBe(3);
  });

  it('reset() drops state: after reset the run restarts from scratch', () => {
    const det = new LoopDetector();
    const msgs = [1, 2, 3].map((n) => assistant(`m${n}`, [read(`t${n}`, '/x/f')]));
    expect(det.feed('s', msgs, 3)?.count).toBe(3);
    det.reset('s');
    expect(det.feed('s', [], 3)).toBeNull();
    expect(det.feed('s', msgs, 3)?.count).toBe(3);
  });
});

let seq = 0;

// Minimal main-chain assistant round with usage and optional Bash tool calls
function assistantMsg(overrides: {
  input?: number;
  cacheRead?: number;
  output?: number;
  commands?: string[];
  messageId?: string;
}): ParsedMessage {
  seq += 1;
  const { input = 0, cacheRead = 0, output = 0, commands = [], messageId } = overrides;
  return {
    uuid: `a${seq}`,
    parentUuid: null,
    type: 'assistant',
    timestamp: new Date('2026-09-25T11:00:00Z'),
    content: commands.map((command, i) => ({
      type: 'tool_use',
      id: `t${seq}-${i}`,
      name: 'Bash',
      input: { command },
    })),
    toolCalls: commands.map((command, i) => ({
      id: `t${seq}-${i}`,
      name: 'Bash',
      input: { command },
      isTask: false,
    })),
    toolResults: [],
    isSidechain: false,
    isMeta: false,
    isCompactSummary: false,
    model: 'glm-5.3-flash',
    usage: {
      input_tokens: input,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: 0,
      output_tokens: output,
    },
    messageId,
  } as unknown as ParsedMessage;
}

// Live 0779a2bc shape: one echo-marker round re-reading ~134k, +24 delta
const echoRound = (n: number, messageId?: string) =>
  assistantMsg({
    input: 100 + n,
    cacheRead: 134_100 + 23 * n, // context = 134_200 + 24n — grows by the tool result only
    output: 19 + n,
    commands: [`echo ${String.fromCharCode(119 + n)}`],
    messageId,
  });

describe('StallDetector', () => {
  const threshold = 4; // notifications.loopDetection.cycleThreshold default

  it('notifies once the echo-marker streak reaches the threshold', () => {
    const detector = new StallDetector();
    const batch = [
      // baseline work round: loud output, context jumps
      assistantMsg({ input: 200, cacheRead: 134_000, output: 2_000, commands: ['cat plan.md'] }),
      echoRound(1),
      echoRound(2),
      echoRound(3),
    ];
    expect(detector.feed('/s.jsonl', batch, threshold)).toBeNull(); // streak 3

    const incident = detector.feed('/s.jsonl', [echoRound(4)], threshold);
    expect(incident).not.toBeNull();
    expect(incident?.count).toBe(4);
    expect(incident?.toolUseId).toBe('t5-0');
  });

  it('counts GLM-proxy fragments of one request once (messageId dedup)', () => {
    const detector = new StallDetector();
    // request A streamed as two JSONL lines, EACH carrying the full usage —
    // counting both would inflate the streak (the 66c45cf lesson)
    const fragA = echoRound(1, 'msg_a');
    const fragA2 = {
      ...assistantMsg({ input: 101, cacheRead: 134_123, output: 20 }),
      messageId: 'msg_a',
      toolCalls: [],
      content: [{ type: 'text', text: 'text block of the same request' }],
    } as unknown as ParsedMessage;
    const batch = [
      assistantMsg({ input: 200, cacheRead: 134_000, output: 2_000, commands: ['cat plan.md'] }),
      fragA,
      fragA2,
      echoRound(2, 'msg_b'),
      echoRound(3, 'msg_c'),
    ];
    // fragments bill once → streak 3 < threshold → silent
    expect(detector.feed('/s.jsonl', batch, threshold)).toBeNull();

    const incident = detector.feed('/s.jsonl', [echoRound(4, 'msg_d')], threshold);
    expect(incident?.count).toBe(4);
  });

  it('a real work round resets the streak', () => {
    const detector = new StallDetector();
    const batch = [
      echoRound(1),
      echoRound(2),
      // work round: context jumps +2k — progress
      assistantMsg({ input: 500, cacheRead: 134_300, output: 2_000, commands: ['edit file.ts'] }),
      echoRound(3),
      echoRound(4),
      echoRound(5),
    ];
    // without the reset the streak would be 5 → incident; it must stay 3
    expect(detector.feed('/s.jsonl', batch, threshold)).toBeNull();
  });
});
