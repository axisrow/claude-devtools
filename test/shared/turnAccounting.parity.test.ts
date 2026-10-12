/**
 * Golden parity test — the whole point of the single-source-of-truth
 * redesign: one transcript fixture, three consumers, ONE set of numbers.
 *
 * Consumers under parity:
 *  - hook analyzeTurn (scripts/turn-accounting.mjs) — scans newest-first
 *  - calibration feedLine (src/cli/turnSpendStats.ts) — walks forward
 *  - renderer sumTurnReread (src/renderer/utils/contextTracker.ts)
 *
 * The fixture pins: GLM stream fragments (same requestId, full usage each),
 * GLM fragments WITHOUT requestId sharing one message.id (issue #95 — billed
 * once via billedRequestKey), a keyless assistant line (own request), a
 * sidechain round (excluded — main-chain only accounting everywhere) with
 * its inline subagent prompt (an isSidechain user line — opens no turn
 * boundary anywhere, #98), a ghost line WITHOUT usage (skipped), junk
 * usage fields (ignored), and all the non-boundary user-line shapes
 * (teammate, interrupt, isMeta tool_result) plus the current boundary canon
 * (<local-command-stdout> IS a boundary).
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { analyzeTurn } from '../../scripts/turn-budget-hook.mjs';
import { isTurnNumberLine, isTranscriptTurnLine } from '../../scripts/turn-accounting.mjs';
import { TurnBudgetDetector } from '../../src/main/utils/loopDetection';
import { feedLine } from '../../src/cli/turnSpendStats';
import {
  sumTurnReread,
  processSessionContextWithPhases,
} from '../../src/renderer/utils/contextTracker';
import { transformChunksToConversation } from '../../src/renderer/utils/groupTransformer';
import { ChunkBuilder } from '../../src/main/services/analysis/ChunkBuilder';
import { parseJsonlFile } from '../../src/main/utils/jsonl';
import { buildLedger, computeFindings } from '../../src/cli/analyzeSession';
import { scanSessionFile } from '../../src/cli/sessionInventory';

interface Spend {
  inputSide: number;
  rounds: number;
  file: string;
  turnIndex: number;
}

function mkState() {
  return {
    current: null as Spend | null,
    spends: [] as Spend[],
    file: 'fixture',
  };
}

// vitest runs from the repo root — import.meta.url is not file:// here
const fixturePath = resolve(process.cwd(), 'test/fixtures/turn-accounting/session.jsonl');
const lines = readFileSync(fixturePath, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '');

function flatten(
  m: Record<string, unknown> & {
    message?: { usage?: Record<string, number> };
    usage?: Record<string, number>;
  }
): Record<string, unknown> {
  // ParsedMessage shape: usage/model/toolCalls flattened to the top level
  return {
    ...m,
    usage: m.usage ?? m.message?.usage,
    model: (m.message as { model?: string } | undefined)?.model,
    toolCalls: [],
  };
}

// buildLedger consumes ParsedMessage — minimal raw→Parsed mapping (the
// fixture lines carry no uuid, so parseJsonlFile would skip them)
function toParsed(l: string, i: number) {
  const m = JSON.parse(l);
  const inner = m.message ?? {};
  return {
    uuid: `line${i}`,
    parentUuid: null,
    timestamp: new Date(m.timestamp ?? 0),
    type: m.type,
    content: inner.content ?? '',
    toolCalls: [],
    toolResults: [],
    isSidechain: m.isSidechain ?? false,
    isMeta: m.isMeta ?? false,
    isCompactSummary: m.isCompactSummary === true,
    usage: inner.usage,
    model: inner.model,
    requestId: m.requestId,
    messageId: inner.id,
  } as never;
}

describe('turn accounting — golden parity across consumers', () => {
  it('feedLine (forward) and analyzeTurn (newest-first) agree per turn', () => {
    const state = mkState();
    for (const line of lines) feedLine(line, state);
    const spends = state.spends as { inputSide: number; rounds: number }[];

    // the walk leaves the LAST turn in state.current (no EOF flush) —
    // analyzeTurn scanning newest-first must agree with exactly that turn;
    // turn 5 = GLM fragments WITHOUT requestId, one message.id (issue #95):
    // billed once (6.6k), not twice
    expect(analyzeTurn([...lines].reverse())).toEqual({ spent: 6_600, boundaryFound: true });
    expect(state.current as { inputSide: number } | null).toMatchObject({ inputSide: 6_600 });
    expect(spends[spends.length - 1].inputSide).toBe(110_000);
  });

  it('pins the fixture numbers: 4 turns — stdout no longer splits turns', () => {
    const state = mkState();
    for (const line of lines) feedLine(line, state);
    const spends = state.spends as { inputSide: number; rounds: number }[];

    // canonical boundary: <local-command-stdout> is system output, NOT a turn
    // boundary — turn 1 now spans fixture lines 2..10 (306.3k main + 4.4k;
    // the sidechain round's 5.5k is excluded, main-chain only) and contains
    // an inline subagent prompt that must not split it (#98)
    // turn 5 (issue #95): GLM fragments WITHOUT requestId, one message.id —
    // one round, billed once. It stays unflushed in state.current (no EOF
    // flush), so spends ends with turn 4 (110k), NOT turn 5.
    expect(spends).toHaveLength(4);
    expect(spends.map((s) => s.inputSide)).toEqual([310_700, 10_798, 102_320, 110_000]);
    expect(spends.map((s) => s.rounds)).toEqual([4, 2, 2, 1]);
  });

  it('sumTurnReread (renderer) matches the hook on the same requests', () => {
    // turn 1 = fixture lines 2..8: GLM fragments, snapshots, keyless, sidechain
    const turn1Responses = lines
      .slice(1, 8)
      .map((l) => flatten(JSON.parse(l)))
      .filter((m) => m.type === 'assistant');
    const reread = sumTurnReread(turn1Responses as never[]);
    expect(reread.tokens).toBe(306_300);
    expect(reread.requests).toBe(3);
  });

  it('an inline subagent prompt does not split the turn — hook, bell, panel agree (#98)', () => {
    // fixture lines 1..11: the isSidechain user prompt sits mid-turn. The
    // panel (ChunkBuilder drops sidechain lines) bills the whole turn —
    // hook and bell must produce the SAME single reread, not restart on
    // the subagent prompt
    const turn1 = lines.slice(0, 11);
    const hookSpent = analyzeTurn([...turn1].reverse()).spent;
    const det = new TurnBudgetDetector();
    det.feed('f', turn1.map((l) => flatten(JSON.parse(l))) as never[], Number.MAX_SAFE_INTEGER);
    const responses = turn1
      .map((l) => flatten(JSON.parse(l)))
      .filter((m) => m.type === 'assistant');
    expect(hookSpent).toBe(310_700);
    expect(det.currentTurnTotal('f')).toBe(310_700);
    expect(sumTurnReread(responses as never[])).toMatchObject({
      tokens: 310_700,
      requests: 4,
    });
  });

  it('ledger and hookSpentByTurn number turns without the sidechain prompt (#109 review)', async () => {
    // the un-split slice must keep its turn NUMBER: hookSpentByTurn numbers
    // slices by isTurnNumberLine, buildLedger opens turns on real user
    // messages — a sidechain prompt inflating either would pair ledger turn
    // N with hook turn N+1 (sessionSums buildSums) on exactly the sessions
    // this PR fixes
    const { hookSpentByTurn } = await import('../../src/cli/sessionSums');
    const { buildLedger } = await import('../../src/cli/analyzeSession');
    // turn 5 = issue #95 fragments (no requestId, one message.id — billed once)
    // (#99) the relay (line 12) consumes a turn number: slice numbers follow
    // app canon — slice 1 spans the relay+interrupt, so it flushes as number
    // 2; the ledger opens turn 2 on the relay (no rounds → context 0)
    expect([...hookSpentByTurn(lines).entries()]).toEqual([
      [2, 310_700],
      [3, 10_798],
      [4, 102_320],
      [5, 110_000],
      [6, 6_600],
    ]);
    const ledger = buildLedger(lines.map(toParsed));
    expect(ledger.turns).toHaveLength(6);
    const contextByTurn = (no: number) =>
      ledger.rounds.filter((r) => r.turnIndex === no).reduce((sum, r) => sum + r.contextSize, 0);
    expect([1, 2, 3, 4, 5, 6].map(contextByTurn)).toEqual([
      310_700, 0, 10_798, 102_320, 110_000, 6_600,
    ]);
  });

  it('a teammate relay is a turn in the CLI too — one numbering with the app (#99)', async () => {
    // app canon (jsonl.ts:558 turnCount, loopDetection.ts:337 bell): transcript
    // turns minus sidechain/compact — the fixture has 6 (5 user prompts + the
    // relay at line 12). The CLI must number the SAME set; the sidechain
    // prompt (line 7) opens no turn anywhere (#98/#109).
    const { buildLedger } = await import('../../src/cli/analyzeSession');
    const transcriptTurns = lines.filter((l) => {
      const m = JSON.parse(l);
      return isTranscriptTurnLine(m) && m.isSidechain !== true && m.isCompactSummary !== true;
    });
    expect(transcriptTurns).toHaveLength(6);
    expect(isTurnNumberLine(JSON.parse(lines[11]))).toBe(true); // the relay
    expect(isTurnNumberLine(JSON.parse(lines[6]))).toBe(false); // sidechain prompt
    expect(buildLedger(lines.map(toParsed)).turns).toHaveLength(6);
    // a response after a relay bills to the relay's turn — `--turn 2` opens
    // what the chip «Turn 2» shows (issue repro: team session with a relay)
    const teamLedger = buildLedger(
      [
        '{"type":"user","timestamp":"2026-10-08T03:00:00.000Z","message":{"role":"user","content":"lead task"}}',
        '{"type":"assistant","requestId":"q1","message":{"id":"m1","content":[],"usage":{"input_tokens":10,"cache_read_input_tokens":100,"cache_creation_input_tokens":0,"output_tokens":1}}}',
        '{"type":"user","timestamp":"2026-10-08T03:00:01.000Z","isMeta":false,"message":{"role":"user","content":"<teammate-message teammate_id=\\"lead\\">status?</teammate-message>"}}',
        '{"type":"assistant","requestId":"q2","message":{"id":"m2","content":[],"usage":{"input_tokens":20,"cache_read_input_tokens":200,"cache_creation_input_tokens":0,"output_tokens":2}}}',
      ].map(toParsed)
    );
    expect(teamLedger.turns).toHaveLength(2);
    expect(teamLedger.rounds.map((r) => (r as { turnIndex: number }).turnIndex)).toEqual([1, 2]);
  });

  it('TurnBudgetDetector.feed agrees with analyzeTurn at every batch boundary', () => {
    // live FileWatcher feeds new messages in arbitrary batches — the running
    // total must equal the offline accounting after every prefix, batches of
    // 1..5 exercise both single lines and multi-fragment requests
    const msgs = lines.map((l) => flatten(JSON.parse(l))) as never[];
    for (let end = 1; end <= msgs.length; end++) {
      for (const batch of [1, 3, 5]) {
        const det = new TurnBudgetDetector();
        for (let i = 0; i < end; i += batch) {
          det.feed('f', msgs.slice(i, Math.min(i + batch, end)), Number.MAX_SAFE_INTEGER);
        }
        const expected = analyzeTurn(lines.slice(0, end).reverse()).spent;
        expect(det.currentTurnTotal('f')).toBe(expected);
      }
    }
  });

  it('the detector labels its incident with the turn number and start time', () => {
    const msgs = lines.map((l) => flatten(JSON.parse(l))) as never[];
    const det = new TurnBudgetDetector();
    // budget small enough to cross on the first turn's first request
    const incident = det.feed('f', msgs, 1);
    expect(incident).not.toBeNull();
    expect(incident?.turnNumber).toBe(1);
    expect(incident?.turnStartTs).toBe(msgs[0].timestamp);
  });
});

describe('a mid-turn compact does not cut the turn (#97)', () => {
  // One transcript shape, three consumers: analyze:session (ledger findings),
  // the inventory scan and the panel (ChunkBuilder → groups → contextTracker).
  // Since #69 analyze:session keeps ONE turn across a compact summary — the
  // inventory turn clock and the panel's wait-loop gate must agree, or the
  // same session is flagged in one surface and clean in another.
  const dirs: string[] = [];
  const writeFixture = async (name: string, objs: object[]): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), `parity97-${name}-`));
    dirs.push(dir);
    const file = join(dir, 's.jsonl');
    await writeFile(file, objs.map((o) => JSON.stringify(o)).join('\n') + '\n');
    return file;
  };
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  let clock = 0;
  const at = (ms: number): string => {
    clock += ms;
    return new Date(clock).toISOString();
  };
  const base = (uuid: string, x: Record<string, unknown> = {}): Record<string, unknown> => ({
    uuid,
    parentUuid: null,
    sessionId: 's',
    cwd: '/p',
    isSidechain: false,
    ...x,
  });
  const userLine = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) =>
    base(uuid, {
      timestamp: at(20_000),
      type: 'user',
      message: { role: 'user', content },
      ...extra,
    });
  // a quiet tick: text-only round re-reading 80k with 20 out (isQuietTick:
  // no tools, context ≥ 50k, output ≤ 300)
  const quietRound = (uuid: string, rid: string, mid: string) =>
    base(uuid, {
      requestId: rid,
      timestamp: at(20_000),
      type: 'assistant',
      message: {
        id: mid,
        role: 'assistant',
        model: 'claude-x',
        content: [{ type: 'text', text: 'still waiting' }],
        usage: {
          input_tokens: 0,
          cache_read_input_tokens: 80_000,
          cache_creation_input_tokens: 0,
          output_tokens: 20,
        },
      },
    });
  const compactLine = (uuid: string) =>
    userLine(uuid, 'This session is being continued from a previous conversation...', {
      isCompactSummary: true,
    });

  it('wait-loop verdict agrees between analyze:session and the panel (3 quiet + compact + 3 quiet)', async () => {
    clock = Date.parse('2026-10-01T07:00:00Z');
    const objs: object[] = [userLine('u0', 'watch the deploy')];
    for (let i = 0; i < 3; i++) objs.push(quietRound(`a${i}`, `ra${i}`, `ma${i}`));
    objs.push(compactLine('c0'));
    for (let i = 0; i < 3; i++) objs.push(quietRound(`b${i}`, `rb${i}`, `mb${i}`));
    const file = await writeFixture('wait', objs);

    const msgs = await parseJsonlFile(file);
    const cliWait = computeFindings(msgs, buildLedger(msgs)).some((f) => f.type === 'wait_loop');
    const conv = transformChunksToConversation(new ChunkBuilder().buildChunks(msgs, []), [], false);
    const { statsMap } = processSessionContextWithPhases(
      conv.items,
      '/p',
      {},
      new Map(),
      new Map()
    );
    const panelWait = [...statsMap.values()].some((s) =>
      s.newInjections.some((i) => i.category === 'wait-loop')
    );

    // the ledger counts 6 quiet ticks in one turn (the compact opens no turn
    // since #69) — the panel splits them across two AI groups of the SAME
    // turn and must gate on the turn total, not the group
    expect(cliWait).toBe(true);
    expect(panelWait).toBe(cliWait);
  });

  it('longest-turn minutes agree between analyze:session and the inventory (3×4min + compact + 3×4min)', async () => {
    clock = Date.parse('2026-10-01T07:00:00Z');
    const objs: object[] = [userLine('u0', 'long task')];
    for (let i = 0; i < 6; i++) {
      if (i === 3) {
        clock += 40_000; // compact lands 60s after the previous result
        objs.push(compactLine('c0'));
      }
      objs.push(
        base(`r${i}`, {
          requestId: `rc${i}`,
          timestamp: at(240_000),
          type: 'assistant',
          message: {
            id: `mc${i}`,
            role: 'assistant',
            model: 'claude-x',
            content: [
              { type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `step ${i}` } },
            ],
            usage: {
              input_tokens: 0,
              cache_read_input_tokens: 100_000,
              cache_creation_input_tokens: 0,
              output_tokens: 50,
            },
          },
        })
      );
      objs.push(
        base(`res${i}`, {
          timestamp: at(1_000),
          type: 'user',
          isMeta: true,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }],
          },
        })
      );
    }
    const file = await writeFixture('turn', objs);

    const ledger = buildLedger(await parseJsonlFile(file));
    const entry = await scanSessionFile(file);
    const cliMinutes = ledger.totals.longestTurn?.activeMinutes;
    // one turn across the compact: 4 working gaps of 241s + 301s across the
    // boundary = 21.1 min — the inventory must measure the same clock, not
    // reset it on the compact summary (it reported 8 min before the fix).
    // #121 keeps fractional minutes; both consumers see the same gap set
    expect(cliMinutes).toBeCloseTo(21.083, 2);
    expect((entry?.longestTurnMs ?? 0) / 60_000).toBeCloseTo(cliMinutes ?? -1, 2);
  });
});

/**
 * Issue #101 — the bell and the panel must speak ONE matching key. The bell
 * reports the phase number and the segment start (first request after the
 * last boundary); the panel's Re-read row shows ph{phaseNumber} and the AI
 * group's start time. Acceptance: exactly ONE row matches the incident on
 * number + time — the row whose segment crossed the budget.
 */
describe('turn budget bell ↔ panel Re-read row matching (#101)', () => {
  const BUDGET = 10_000_000;
  const hhmm = (d: string | Date) => new Date(d).toISOString().slice(11, 16);

  let n = 0;
  const user = (content: unknown, x: Record<string, unknown> = {}) => ({
    uuid: `u${++n}`,
    parentUuid: null,
    sessionId: 's',
    cwd: '/p',
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content },
    ...x,
  });
  const ai = (i: number) => ({
    uuid: `u${++n}`,
    parentUuid: null,
    sessionId: 's',
    cwd: '/p',
    isSidechain: false,
    type: 'assistant',
    requestId: `q${i}`,
    message: {
      id: `m${i}`,
      role: 'assistant',
      model: 'claude-x',
      content: [{ type: 'text', text: `r${i}` }],
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: 4_000_000,
        cache_creation_input_tokens: 0,
        output_tokens: 10,
      },
    },
  });
  const COMPACT = () => user('This session is being continued...', { isCompactSummary: true });
  const RELAY = () =>
    user('<teammate-message teammate_id="b">status?</teammate-message>', { isMeta: false });

  const scenario = async (steps: [kind: 'user' | 'ai' | 'compact' | 'relay', hm: string][]) => {
    const linesOut = steps.map(([kind, hm], i) => {
      const m =
        kind === 'ai'
          ? ai(i)
          : kind === 'compact'
            ? COMPACT()
            : kind === 'relay'
              ? RELAY()
              : user('go');
      return `${JSON.stringify({ ...m, timestamp: `2026-10-01T${hm}:00Z` })}`;
    });
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { parseJsonlFile } = await import('../../src/main/utils/jsonl');
    const { ChunkBuilder } = await import('../../src/main/services/analysis/ChunkBuilder');
    const { transformChunksToConversation } =
      await import('../../src/renderer/utils/groupTransformer');
    const { processSessionContextWithPhases } =
      await import('../../src/renderer/utils/contextTracker');

    const f = join(mkdtempSync(join(tmpdir(), 'bell-panel-')), 's.jsonl');
    writeFileSync(f, linesOut.join('\n') + '\n');
    const msgs = await parseJsonlFile(f);

    const det = new TurnBudgetDetector();
    let incident: ReturnType<TurnBudgetDetector['feed']> = null;
    for (const m of msgs) {
      const hit = det.feed('f', [m], BUDGET);
      if (!incident) incident = hit;
    }
    expect(incident).not.toBeNull();

    const conv = transformChunksToConversation(new ChunkBuilder().buildChunks(msgs, []), [], false);
    const { rereadAll } = processSessionContextWithPhases(
      conv.items,
      '/p',
      {},
      new Map(),
      new Map()
    ).phaseInfo;
    return { incident: incident!, rows: rereadAll };
  };

  it('compact inside a turn — the crossing segment matches exactly one row', async () => {
    const { incident, rows } = await scenario([
      ['user', '07:00'],
      ['ai', '07:01'],
      ['ai', '07:02'],
      ['compact', '07:30'],
      ['ai', '07:31'],
      ['ai', '07:32'],
      ['ai', '07:33'],
    ]);
    const matched = rows.filter(
      (r: { phaseNumber?: number; turnStartTs?: string }) =>
        r.phaseNumber === incident.phaseNumber &&
        hhmm(r.turnStartTs!) === hhmm(incident.segmentStartTs)
    );
    expect(matched).toHaveLength(1);
    // the matched row is the crossing one: the post-compact segment (12M)
    expect(matched[0].estimatedTokens).toBe(12_000_000);
  });

  it('relay after the crossing — the segment matches exactly one row', async () => {
    const { incident, rows } = await scenario([
      ['user', '08:00'],
      ['ai', '08:01'],
      ['ai', '08:02'],
      ['ai', '08:03'],
      ['relay', '08:10'],
      ['ai', '08:11'],
    ]);
    const matched = rows.filter(
      (r: { phaseNumber?: number; turnStartTs?: string }) =>
        r.phaseNumber === incident.phaseNumber &&
        hhmm(r.turnStartTs!) === hhmm(incident.segmentStartTs)
    );
    expect(matched).toHaveLength(1);
    // the merged group (turn-1 crossing + post-relay round) holds the crossing
    expect(matched[0].estimatedTokens).toBe(16_000_000);
  });
});
