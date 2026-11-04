import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  collectSubagentRuns,
  parseSubagentScanArgs,
  scanSubagentFile,
} from '../../src/cli/subagentScan';

const TS1 = '2026-11-04T10:00:00.000Z';
const TS2 = '2026-11-04T10:26:00.000Z';

/** Subagent transcript line builder. */
const line = (o: {
  type?: string;
  ts: string;
  sessionId?: string;
  id?: string;
  requestId?: string;
  input?: number;
  output?: number;
}): string =>
  JSON.stringify({
    type: o.type ?? 'assistant',
    timestamp: o.ts,
    ...(o.sessionId ? { sessionId: o.sessionId } : {}),
    ...(o.requestId ? { requestId: o.requestId } : {}),
    message: {
      ...(o.id ? { id: o.id } : {}),
      ...(o.input
        ? {
            usage: {
              input_tokens: o.input,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
              output_tokens: o.output ?? 0,
            },
          }
        : {}),
    },
  });

describe('scanSubagentFile', () => {
  it('bills fragments once: N lines of one request = one round, last counts win', async () => {
    const home = mkdtempSync(join(tmpdir(), 'subagent-scan-'));
    try {
      const file = join(home, 'agent-t1.jsonl');
      writeFileSync(
        file,
        [
          line({ ts: TS1, sessionId: 'sess-1' }),
          line({ ts: TS2, id: 'm1', input: 1000, output: 500 }),
          line({ ts: TS2, id: 'm1', input: 1200, output: 700 }),
          line({ ts: TS2, id: 'm1', input: 1200, output: 700 }),
        ].join('\n') + '\n'
      );
      const s = await scanSubagentFile(file, { nowMs: Date.parse(TS2) + 60_000 });
      expect(s.rounds).toBe(1);
      expect(s.inputSide).toBe(1200);
      expect(s.output).toBe(700);
      expect(s.parentSessionId).toBe('sess-1');
      expect(s.ongoing).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('bills a mixed-shape request (bare fragments + requestId head) once via the canon ledger', async () => {
    const home = mkdtempSync(join(tmpdir(), 'subagent-scan-'));
    try {
      const file = join(home, 'agent-t2.jsonl');
      writeFileSync(
        file,
        [
          line({ ts: TS1, sessionId: 's' }),
          line({ ts: TS2, id: 'm1', input: 800 }),
          line({ ts: TS2, id: 'm1', requestId: 'req-1', input: 1000 }),
        ].join('\n') + '\n'
      );
      const s = await scanSubagentFile(file, { nowMs: Date.parse(TS2) + 60_000 });
      expect(s.rounds).toBe(1);
      expect(s.inputSide).toBe(1000); // head re-points and replaces the bare-id line
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('ongoing flag: touched within the active window = NOW, older = done', async () => {
    const home = mkdtempSync(join(tmpdir(), 'subagent-scan-'));
    try {
      const file = join(home, 'agent-t3.jsonl');
      writeFileSync(
        file,
        [line({ ts: TS1, sessionId: 's' }), line({ ts: TS2, id: 'm1', input: 100 })].join('\n') +
          '\n'
      );
      const within = await scanSubagentFile(file, {
        nowMs: Date.parse(TS2) + 5 * 60_000,
        activeMs: 10 * 60_000,
      });
      expect(within.ongoing).toBe(true);
      const past = await scanSubagentFile(file, {
        nowMs: Date.parse(TS2) + 11 * 60_000,
        activeMs: 10 * 60_000,
      });
      expect(past.ongoing).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('corpus walk: nested layout counted, parent from path fallback', async () => {
    const home = mkdtempSync(join(tmpdir(), 'subagent-scan-'));
    try {
      const proj = join(home, '-Users-x-proj');
      const sub = join(proj, 'sess-9', 'subagents');
      mkdirSync(sub, { recursive: true });
      writeFileSync(
        join(sub, 'agent-w1.jsonl'),
        [line({ ts: TS1, sessionId: 'sess-9' }), line({ ts: TS2, id: 'm1', input: 400 })].join(
          '\n'
        ) + '\n'
      );
      // old flat layout at project root — excluded by listSessionFiles (dup of parent sidechain)
      writeFileSync(join(proj, 'agent-flat.jsonl'), line({ ts: TS1, sessionId: 'sess-9' }) + '\n');

      const { rows, scannedFiles } = await collectSubagentRuns(home, {
        nowMs: Date.parse(TS2) + 30_000,
      });
      expect(scannedFiles).toBe(1); // flat agent file excluded
      expect(rows).toHaveLength(1);
      expect(rows[0].parent).toBe('sess-9');
      expect(rows[0].project).toBe('-Users-x-proj');
      expect(rows[0].agent).toBe('agent-w1');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('parseSubagentScanArgs', () => {
  it('defaults, numeric flags, unknown-flag error', () => {
    expect(parseSubagentScanArgs([])).toEqual({ top: 20, activeMinutes: 10, json: false });
    expect(parseSubagentScanArgs(['--top', '5']).top).toBe(5);
    expect(parseSubagentScanArgs(['--active-minutes', '3']).activeMinutes).toBe(3);
    expect(parseSubagentScanArgs(['--json']).json).toBe(true);
    expect(parseSubagentScanArgs(['--nope']).error).toContain('unknown flag');
    expect(parseSubagentScanArgs(['--active-minutes', '0']).error).toContain('active-minutes');
  });
});
