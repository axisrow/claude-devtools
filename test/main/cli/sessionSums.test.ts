/**
 * session:sums tests — rollup checksums, hook parity, cycle attribution.
 * Fixtures go through a temp .jsonl so raw and parsed shapes stay in sync.
 */
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildLedger, computeFindings } from '../../../src/cli/analyzeSession';
import { buildSums, hookSpentByTurn } from '../../../src/cli/sessionSums';
import { parseJsonlFile } from '../../../src/main/utils/jsonl';

let dir: string | null = null;
afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = null;
  }
});

const T = '2026-09-20T10:00:00Z';
const user = (n: number, text: string): Record<string, unknown> => ({
  type: 'user',
  uuid: `u${n}`,
  timestamp: T,
  isMeta: false,
  message: { content: text },
});
const meta = (n: number, id: string, result: string): Record<string, unknown> => ({
  type: 'user',
  uuid: `u${n}`,
  timestamp: T,
  isMeta: true,
  message: {
    content: [{ type: 'tool_result', tool_use_id: id, content: result }],
  },
});
const ai = (
  n: number,
  id: string,
  input: number,
  output: number,
  calls: { id: string; command: string }[] = []
): Record<string, unknown> => ({
  type: 'assistant',
  uuid: `a${n}`,
  timestamp: T,
  message: {
    id,
    model: 'm1',
    usage: {
      input_tokens: input,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: output,
    },
    content: calls.map((c) => ({
      type: 'tool_use',
      id: c.id,
      name: 'Bash',
      input: { command: c.command },
    })),
  },
});

async function writeSession(lines: Record<string, unknown>[]): Promise<string> {
  dir = await mkdtemp(path.join(tmpdir(), 'devtools-sums-'));
  const file = path.join(dir, 's.jsonl');
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

async function sumsFor(lines: Record<string, unknown>[]) {
  const file = await writeSession(lines);
  const messages = await parseJsonlFile(file);
  const ledger = buildLedger(messages);
  const findings = computeFindings(messages, ledger);
  const raw = (await readFile(file, 'utf8')).split('\n');
  return buildSums(ledger, findings, hookSpentByTurn(raw));
}

describe('session:sums', () => {
  it('checksums hold: rounds = turns = session; hook parity matches', async () => {
    const sums = await sumsFor([
      user(1, 'fix it'),
      ai(2, 'msg1', 100, 10),
      ai(3, 'msg2', 200, 20),
      user(4, 'go on'),
      ai(5, 'msg3', 300, 30),
    ]);
    expect(sums.turns).toHaveLength(2);
    expect(sums.session).toMatchObject({ inputSide: 600, billedTotal: 660 });
    const t1 = (sums.turns as { index: number; inputSide: number; rounds: number }[])[0];
    expect(t1).toMatchObject({ index: 1, rounds: 2, inputSide: 300 });
    expect(sums.checksums).toEqual({
      roundsSumEqualsTurnsSum: true,
      turnsSumEqualsSession: true,
      hookParity: { match: true, mismatches: [] },
    });
    expect(sums.tragedy).toMatchObject({ cycleTokensWasted: 0, cycleTurns: 0 });
  });

  it('a same-result probe turn is attributed as churning with its input-side', async () => {
    const sums = await sumsFor([
      user(1, 'run probe'),
      ai(2, 'msg1', 1000, 10, [{ id: 'c1', command: 'probe' }]),
      meta(3, 'c1', 'same line'),
      ai(4, 'msg2', 1100, 10),
      ai(5, 'msg3', 1200, 10, [{ id: 'c2', command: 'probe' }]),
      meta(6, 'c2', 'same line'),
      ai(7, 'msg4', 1300, 10),
      ai(8, 'msg5', 1400, 10, [{ id: 'c3', command: 'probe' }]),
      meta(9, 'c3', 'same line'),
    ]);
    const turns = sums.turns as {
      cycles: { verdict: string; tokensWasted: number };
      inputSide: number;
    }[];
    expect(turns[0].cycles.verdict).toBe('cycle-churning');
    expect(sums.tragedy).toMatchObject({
      cycleTurns: 1,
      cycleTokensWasted: turns[0].inputSide,
    });
    expect(sums.checksums).toMatchObject({
      roundsSumEqualsTurnsSum: true,
      turnsSumEqualsSession: true,
    });
  });

  // Issue #88: Claude Code 2.1.296 writes ONE content block per JSONL line —
  // a requestId's lines partition the response (same usage everywhere), they
  // are not stream snapshots. keep-last dropped every block but the last.
  it('ledger keeps all tool calls and thinking of a requestId split response', async () => {
    const part = (n: number, rid: string, content: Record<string, unknown>[]): Record<string, unknown> => ({
      type: 'assistant',
      uuid: `a${n}`,
      timestamp: T,
      requestId: rid,
      message: {
        id: 'msg1',
        model: 'm1',
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 10,
        },
        content,
      },
    });
    const file = await writeSession([
      user(1, 'go'),
      part(2, 'req_1', [{ type: 'thinking', thinking: 'four' }]),
      part(3, 'req_1', [{ type: 'text', text: 'running checks' }]),
      part(4, 'req_1', [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'lint' } }]),
      part(5, 'req_1', [{ type: 'tool_use', id: 'c2', name: 'Bash', input: { command: 'test' } }]),
      part(6, 'req_1', [{ type: 'tool_use', id: 'c3', name: 'Bash', input: { command: 'build' } }]),
    ]);
    const ledger = buildLedger(await parseJsonlFile(file));

    expect(ledger.rounds).toHaveLength(1);
    expect(ledger.rounds[0].tools).toEqual(['Bash', 'Bash', 'Bash']);
    expect(ledger.rounds[0].thinkingTokens).toBeGreaterThan(0);
  });
});
