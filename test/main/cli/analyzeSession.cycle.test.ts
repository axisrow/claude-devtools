/**
 * Cycle diagnostics — «цикл или длинный ход» verdict for a turn:
 * detectCycleFindings (cycle_motif / probe_no_progress) + turnVerdict.
 */
import { describe, expect, it } from 'vitest';

import { buildLedger, computeFindings, turnVerdict } from '../../../src/cli/analyzeSession';
import type { ParsedMessage } from '../../../src/main/types';

let seq = 0;
const base = {
  parentUuid: null,
  timestamp: new Date('2026-09-20T10:00:00Z'),
  content: '' as never,
  toolCalls: [] as never,
  toolResults: [] as never,
  isSidechain: false,
  isMeta: false,
};
const msg = (o: object): ParsedMessage => ({ uuid: `u${++seq}`, ...base, ...o }) as ParsedMessage;
const usage = (ctx: number) => ({
  input_tokens: ctx,
  output_tokens: 50,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});
/** one round = assistant msg with a single Bash call; result lands in a meta user msg */
const round = (i: number, cmd: string, result?: string): ParsedMessage[] => {
  const t = Date.parse('2026-09-20T10:00:00Z') + i * 60_000;
  const out: ParsedMessage[] = [
    msg({
      type: 'assistant',
      timestamp: new Date(t),
      model: 'm1',
      usage: usage(1000 + 100 * i),
      toolCalls: [{ id: `c${i}`, name: 'Bash', input: { command: cmd }, isTask: false }],
    }),
  ];
  if (result !== undefined) {
    out.push(
      msg({
        type: 'user',
        isMeta: true,
        timestamp: new Date(t + 30_000),
        content: [{ type: 'tool_result', tool_use_id: `c${i}`, content: result } as never],
        toolResults: [{ toolUseId: `c${i}`, content: result, isError: false }],
      })
    );
  }
  return out;
};
const turn = (specs: { cmd: string; result?: string }[]): ParsedMessage[] => [
  msg({ type: 'user', content: 'fix it' }),
  ...specs.flatMap((s, i) => round(i, s.cmd, s.result)),
];

describe('detectCycleFindings', () => {
  it('flags a repeating sequence of distinct calls as cycle_motif', () => {
    const specs = ['edit', 'lint', 'battle'];
    const messages = turn([...specs, ...specs, ...specs]);
    const findings = computeFindings(messages, buildLedger(messages));
    const motif = findings.find((f) => f.type === 'cycle_motif');
    expect(motif).toBeDefined();
    expect(motif?.severity).toBe('medium'); // x3 — not yet high
    // wasted = context of repeated windows (rounds 3..8): Σ(1000+100i), i=3..8
    expect(motif?.tokensWasted).toBe(9300);
  });

  it('short alternating sequences stay silent', () => {
    const messages = turn([{ cmd: 'a' }, { cmd: 'b' }, { cmd: 'a' }, { cmd: 'b' }]);
    const findings = computeFindings(messages, buildLedger(messages));
    expect(findings.some((f) => f.type === 'cycle_motif')).toBe(false);
    expect(findings.some((f) => f.type === 'probe_no_progress')).toBe(false);
  });

  it('flags a probe re-run with the same result as probe_no_progress', () => {
    const messages = turn([
      { cmd: 'probe', result: 'same line' },
      { cmd: 'fix one' },
      { cmd: 'probe', result: 'same line' },
      { cmd: 'fix two' },
      { cmd: 'probe', result: 'same line' },
    ]);
    const findings = computeFindings(messages, buildLedger(messages));
    const probe = findings.find((f) => f.type === 'probe_no_progress');
    expect(probe).toBeDefined();
    expect(probe?.summary).toContain('same result x3');
    expect(probe?.tokensWasted).toBeGreaterThan(0);
  });

  it('linear distinct work stays silent', () => {
    const messages = turn(
      Array.from({ length: 10 }, (_, i) => ({ cmd: `step ${i}`, result: `done ${i}` }))
    );
    const findings = computeFindings(messages, buildLedger(messages));
    expect(findings.some((f) => f.type === 'cycle_motif')).toBe(false);
    expect(findings.some((f) => f.type === 'probe_no_progress')).toBe(false);
  });
});

describe('turnVerdict', () => {
  const F = (type: string): never =>
    ({
      type,
      severity: 'medium',
      tokensWasted: 0,
      summary: '',
    }) as never;

  it('probe_no_progress dominates — cycle with churning', () => {
    expect(turnVerdict([F('cycle_motif'), F('probe_no_progress')], 40, 50)).toBe('cycle-churning');
  });

  it('motif without probe repeats — cycle with progress', () => {
    expect(turnVerdict([F('cycle_motif')], 40, 50)).toBe('cycle-progressing');
  });

  it('no cycles but heavy — long turn', () => {
    expect(turnVerdict([], 40, 50)).toBe('long-turn');
    expect(turnVerdict([], 35, 2)).toBe('long-turn');
  });

  it('light and linear — normal', () => {
    expect(turnVerdict([], 5, 2)).toBe('normal');
  });
});

describe('buildLedger turn numbering parity', () => {
  it('a compaction summary opens no turn (app numbering parity)', () => {
    const messages = [
      msg({ type: 'user', content: 'one' }),
      msg({ type: 'assistant', model: 'm1', usage: usage(100) }),
      msg({
        type: 'user',
        isMeta: false,
        isCompactSummary: true,
        content: 'This session is being continued…',
      }),
      msg({ type: 'user', content: 'two' }),
    ];
    expect(buildLedger(messages).turns).toHaveLength(2);
  });
});
