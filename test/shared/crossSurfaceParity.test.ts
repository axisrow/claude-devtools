/**
 * Cross-surface parity (#103) — ONE edge-case transcript
 * (test/fixtures/cross-surface/session.jsonl) through EVERY consumer,
 * asserting the same numbers everywhere. Complements
 * turnAccounting.parity.test.ts, whose minimal fixture carries no compact,
 * relays, pre-input run or task-notification.
 *
 * The fixture (chronological; every number below was derived by hand from the
 * usage lines, then confirmed on each consumer):
 *  a0            assistant round BEFORE any user input — the #100 implicit
 *                pre-input turn (keyless: no requestId, no message.id)
 *  u1..a2        turn 2: parallel tool_use in ONE round (Bash+Read, #88), a
 *                sidechain subagent prompt+round mid-turn (#98), and two GLM
 *                proxy fragments WITHOUT requestId sharing one message.id
 *                (f1/f2, #95 — billed once)
 *  u2..w6        turn 3: 3 quiet ticks, a COMPACT MID-TURN (c0), 3 more quiet
 *                ticks of the SAME turn (#97) — 6 ticks ≥ WAIT_LOOP_MIN_TICKS
 *  u3..a3        turn 4: the same Bash call ×4 (#96) — exactly
 *                LOOP_MIN_STREAK, so the loop fires on every surface
 *  u4, tn1,      turn 5 prompt, then a <task-notification> (opens NO turn,
 *  rel1, a4      #104), then a teammate relay (opens turn 6, #99) answered by
 *                a4
 *
 * Scenario × surface table (issue #103 — a NEW surface showing the same
 * numbers is added here as its own `it`; acceptance says so):
 *
 * | scenario                            | surfaces compared                                        |
 * |-------------------------------------|----------------------------------------------------------|
 * | start without user message (#100)   | sidebar turnCount ↔ chips ↔ ledger ↔ hookSpentByTurn; bell → MISMATCH, see the TODO block below |
 * | parallel tool_use (#88)             | raw JSONL call count ↔ ledger rounds' tools ↔ panel tool-output breakdown |
 * | proxy fragments, one message.id (#95)| hook analyzeTurn ↔ feedLine ↔ ledger ↔ panel reread ↔ sidebar ↔ details ↔ inventory |
 * | same call ×4 (#96)                  | bell LoopDetector ↔ CLI loop_streak ↔ inventory cycles ↔ panel loop injection (count parity; token currencies differ by definition) |
 * | compact mid-turn (#97)              | turn number everywhere ↔ wait-loop verdict CLI ↔ panel; longest turn ledger ↔ inventory |
 * | sidechain prompt (#98)              | turn predicates, ledger rounds, chunk responses, hook spend |
 * | teammate relay (#99)                | chips ↔ ledger turn 6 ↔ hookSpentByTurn[6] ↔ sidebar ↔ bell numbering |
 * | <task-notification> (#104)          | turn predicates ↔ chips ↔ panel display item |
 * | cost (#73)                          | calculateMetrics ↔ ledger totals |
 * | rollup checksums (#102)             | buildSums rounds==turns==session, hookParity |
 *
 * Known mismatch (NOT fixed here — out of scope per #103): the live bell
 * (TurnBudgetDetector) numbers turns by counting isTranscriptTurnLine lines
 * only, so the #100 implicit pre-input turn is missing from its counter — it
 * reports 0 during the pre-input run and stays one behind the app canon for
 * the rest of the session. Pinned as-is in the TODO block at the bottom.
 */
import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { analyzeTurn, isTurnBoundary, isTurnNumberLine } from '../../scripts/turn-accounting.mjs';
import { LoopDetector, TurnBudgetDetector } from '../../src/main/utils/loopDetection';
import { ChunkBuilder } from '../../src/main/services/analysis/ChunkBuilder';
import {
  analyzeSessionFileMetadata,
  calculateMetrics,
  parseJsonlFile,
} from '../../src/main/utils/jsonl';
import { buildLedger, computeFindings, type Finding } from '../../src/cli/analyzeSession';
import { scanSessionFile } from '../../src/cli/sessionInventory';
import { buildSums, hookSpentByTurn } from '../../src/cli/sessionSums';
import { feedLine, type TurnSpend } from '../../src/cli/turnSpendStats';
import {
  processSessionContextWithPhases,
  sumTurnReread,
} from '../../src/renderer/utils/contextTracker';
import { buildDisplayItems } from '../../src/renderer/utils/displayItemBuilder';
import { findLastOutput } from '../../src/renderer/utils/lastOutputDetector';
import { transformChunksToConversation } from '../../src/renderer/utils/groupTransformer';

// vitest runs from the repo root
const fixturePath = `${process.cwd()}/test/fixtures/cross-surface/session.jsonl`;

const lines = readFileSync(fixturePath, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '');

// Hand-derived canon (input side = input + cache_read + cache_creation):
// turn:      1     2      3       4       5  6
const TURN_INPUT_SIDE = [5100, 24900, 474000, 301000, 0, 61100];
// the six AI groups the panel builds, in order: g1(T1) g2(T2) g3(T3 pre)
// g4(T3 post) g5(T4) g6(T5+T6). Reread rows exist only for MULTI-request
// groups (sumTurnReread.requests > 1 — the panel's own display filter), so
// g1 and g6 (a single round each) show none:
const GROUP_REREAD_ROWS = [24900, 240000, 234000, 301000];
const GROUP_TURN_INDEX = [0, 1, 2, 2, 3, 5]; // 0-based, chip numbering
const GROUP_ROW_PHASE = [1, 1, 2, 2]; // row phases; c0 advances the phase
// billed totals: sidebar/details price the WHOLE transcript (sidechain
// included — the cost of the transcript); the CLI ledger and the inventory
// bill main-chain only. Delta = the sidechain round s2 (6500 + 50 out).
const TOTAL_BILLED_APP = 873_240;
const TOTAL_BILLED_CLI = 866_690;

interface Shared {
  msgs: Awaited<ReturnType<typeof parseJsonlFile>>;
  ledger: ReturnType<typeof buildLedger>;
  findings: Finding[];
  items: ReturnType<typeof transformChunksToConversation>['items'];
  rereadAll: ReturnType<typeof processSessionContextWithPhases>['rereadAll'];
  statsMap: ReturnType<typeof processSessionContextWithPhases>['statsMap'];
}

let shared: Shared;
beforeAll(async () => {
  const msgs = await parseJsonlFile(fixturePath);
  const ledger = buildLedger(msgs);
  const findings = computeFindings(msgs, ledger);
  const conv = transformChunksToConversation(new ChunkBuilder().buildChunks(msgs, []), [], false);
  const { statsMap, rereadAll } = processSessionContextWithPhases(
    conv.items,
    '/p',
    {},
    new Map(),
    new Map()
  );
  shared = { msgs, ledger, findings, items: conv.items, statsMap, rereadAll };
});

const aiGroups = () =>
  shared.items.filter(
    (i): i is Extract<(typeof shared.items)[number], { type: 'ai' }> => i.type === 'ai'
  );

const injectionsOf = (category: string) =>
  [...shared.statsMap.values()]
    .flatMap((s) => s.newInjections)
    .filter((i) => i.category === category);

describe('cross-surface parity — one edge-case transcript through every consumer (#103)', () => {
  it('turn numbering: sidebar == chat chips == ledger == hookSpentByTurn (#99/#100/#104)', async () => {
    // the scanner (#100) counts the pre-input run, every real user message and
    // the relay — but NOT the task-notification or the compact:
    const meta = await analyzeSessionFileMetadata(fixturePath);
    expect(meta.turnCount).toBe(6);

    // chat chips: 6 AI groups, numbered 1..6 with turn 3 owning TWO groups
    // (the compact splits the chunk, not the number) and turn 5 having none
    // (the relay consumed the number before a4 answered it)
    const chips = aiGroups().map((g) => g.group.turnIndex);
    expect(chips).toEqual(GROUP_TURN_INDEX);

    // ledger: implicit turn 1 opens on a0 (buildLedger's first billed round),
    // then u1..u4 and rel1 — 6 turns, 0 rounds in the relay-prompted turn 5
    expect(shared.ledger.turns).toHaveLength(6);
    expect(shared.ledger.rounds.map((r) => r.turnIndex)).toEqual([
      1, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 6,
    ]);

    // hook numbering (session:sums): the same canon — implicit turn 1, one
    // number per transcript turn line, none for tn1/c0; turn 5 stayed empty
    expect([...hookSpentByTurn(lines).entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [1, 5100],
      [2, 24900],
      [3, 474000],
      [4, 301000],
      [6, 61100],
    ]);

    // the canonical predicates underneath: tn1 and c0 are NOT number lines,
    // rel1 IS one, s1 (sidechain) is neither boundary nor number
    const byUuid = (uuid: string) => JSON.parse(lines.find((l) => JSON.parse(l).uuid === uuid)!);
    expect(isTurnNumberLine(byUuid('tn1'))).toBe(false);
    expect(isTurnNumberLine(byUuid('c0'))).toBe(false);
    expect(isTurnNumberLine(byUuid('rel1'))).toBe(true);
    expect(isTurnBoundary(byUuid('tn1'))).toBe(false);
    expect(isTurnBoundary(byUuid('c0'))).toBe(true);
    expect(isTurnBoundary(byUuid('rel1'))).toBe(false);
    expect(isTurnBoundary(byUuid('s1'))).toBe(false);
    expect(isTurnNumberLine(byUuid('s1'))).toBe(false);
  });

  it('per-turn spend — the parity table: hook == ledger == panel reread, turn by turn', () => {
    // ledger: Σ contextSize of the turn's rounds
    const contextByTurn = (no: number) =>
      shared.ledger.rounds.filter((r) => r.turnIndex === no).reduce((s, r) => s + r.contextSize, 0);
    // panel: Σ the turn's reread rows — the rows exist only for multi-request
    // turns (the panel's display filter), and only THOSE turns can be compared
    const hookByTurn = hookSpentByTurn(lines);
    const panelByTurn = (no: number) =>
      shared.rereadAll
        .filter((r) => r.turnIndex === no - 1)
        .reduce((s, g) => s + g.estimatedTokens, 0);
    // turns 2..4: multi-request — the full parity triple holds
    for (let t = 2; t <= 4; t++) {
      expect(panelByTurn(t)).toBe(TURN_INPUT_SIDE[t - 1]);
      expect(contextByTurn(t)).toBe(TURN_INPUT_SIDE[t - 1]);
      expect(hookByTurn.get(t) ?? 0).toBe(TURN_INPUT_SIDE[t - 1]);
    }
    // turns 1 and 6 are single-round: no reread row (by design — a lone
    // request is a normal context send), but hook == ledger still holds
    expect(shared.rereadAll.some((r) => r.turnIndex === 0 || r.turnIndex === 5)).toBe(false);
    expect(contextByTurn(1)).toBe(5100);
    expect(hookByTurn.get(1)).toBe(5100);
    expect(contextByTurn(6)).toBe(61_100);
    expect(hookByTurn.get(6)).toBe(61_100);
    // the newest-first hook scan on the trailing slice agrees with the walk
    expect(analyzeTurn([...lines].reverse())).toEqual({ spent: 61_100, boundaryFound: true });
  });

  it('group-level reread rows — only multi-request groups, phase split at the compact', () => {
    expect(shared.rereadAll).toHaveLength(4);
    expect(shared.rereadAll.map((r) => r.estimatedTokens)).toEqual(GROUP_REREAD_ROWS);
    expect(shared.rereadAll.map((r) => r.phaseNumber)).toEqual(GROUP_ROW_PHASE);
    // independent recomputation with the canonical counter itself
    aiGroups().forEach((g) => {
      const { tokens, requests } = sumTurnReread(g.group.responses as never);
      const row = shared.rereadAll.find((r) => r.aiGroupId === g.group.id);
      if (requests > 1) expect(row?.estimatedTokens).toBe(tokens);
      else expect(row).toBeUndefined();
    });
  });

  it('token totals: sidebar == session details; analyze:session == analyze:sessions (#95)', async () => {
    const meta = await analyzeSessionFileMetadata(fixturePath);
    const details = calculateMetrics(shared.msgs);
    const entry = await scanSessionFile(fixturePath);
    const cli = shared.ledger.totals;

    // app counts the whole transcript (sidechain s2 included, fragments deduped)
    expect(meta.totalTokens).toBe(TOTAL_BILLED_APP);
    expect(details.totalTokens).toBe(TOTAL_BILLED_APP);
    // CLI surfaces bill main-chain only — the delta is exactly s2's billed total
    expect(TOTAL_BILLED_APP - TOTAL_BILLED_CLI).toBe(6550);
    expect(cli.inputTokens + cli.cacheReadTokens + cli.cacheCreationTokens + cli.outputTokens).toBe(
      TOTAL_BILLED_CLI
    );
    expect(entry?.totalTokens).toBe(TOTAL_BILLED_CLI);
  });

  it('#95 GLM proxy fragments without requestId, one message.id — billed once everywhere', () => {
    // f1/f2 share message.id "mfrag" and carry identical full usage — one
    // round of 8300 input-side, not two. Turn 2 = 24900 on every surface:
    // hook (keep-newest), feedLine, ledger (deduplicateByRequestId), panel.
    const state = { current: null as TurnSpend | null, spends: [] as TurnSpend[], file: 'f' };
    for (const l of lines) feedLine(l, state);
    expect(state.spends[0]).toMatchObject({ inputSide: 24_900, rounds: 3 });
    // if the fragment pair were double-billed, turn 2 would read 33200 and
    // every total below would drift by exactly one 8330 copy
    expect(shared.ledger.rounds.filter((r) => r.turnIndex === 2)).toHaveLength(3);
    // the FIRST reread row is g2's — 24900, not 33200 (double-billed fragment)
    expect(shared.rereadAll[0].estimatedTokens).toBe(24_900);
    expect(hookSpentByTurn(lines).get(2)).toBe(24_900);
  });

  it('#88 parallel tool_use — one round, two calls, equal counts: raw == ledger == panel', () => {
    // raw JSONL: turn 2's assistant lines carry exactly 2 tool_use blocks
    const rawCalls = lines
      .map((l) => JSON.parse(l) as { uuid?: string; message?: { content?: unknown[] } })
      .filter((m) => ['a1', 'f1', 'f2', 'a2'].includes(m.uuid ?? ''))
      .flatMap((m) =>
        (m.message?.content ?? []).filter((b) => (b as { type: string }).type === 'tool_use')
      );
    expect(rawCalls).toHaveLength(2);
    // ledger: the same 2 calls across turn 2's rounds
    expect(
      shared.ledger.rounds.filter((r) => r.turnIndex === 2).reduce((s, r) => s + r.tools.length, 0)
    ).toBe(2);
    // panel: the group's tool-output breakdown names both calls
    const g2 = aiGroups()[1].group;
    const toolOutput = injectionsOf('tool-output').find((i) => i.aiGroupId === g2.id);
    expect(toolOutput?.toolBreakdown.map((t) => t.toolName).sort()).toEqual(['Bash', 'Read']);
  });

  it('#96 the same call ×4 — one gate everywhere: bell, CLI streak, inventory cycle, panel', async () => {
    // bell (live LoopDetector) fires exactly at the 4th identical call
    const loop = new LoopDetector();
    const incident = loop.feed('f', shared.msgs, 4);
    expect(incident).not.toBeNull();
    expect(incident?.count).toBe(4);
    expect(incident?.toolUseId).toBe('L4');
    expect(incident?.tokens).toBe(240_900); // billed totals of l1..l4

    // CLI loop_streak: one finding on turn 4, the summary names x4
    const streaks = shared.findings.filter((f) => f.type === 'loop_streak');
    expect(streaks).toHaveLength(1);
    expect(streaks[0].turnIndex).toBe(4);
    expect(streaks[0].summary).toMatch(/x4 back-to-back/);

    // analyze:sessions inventory: one maximal run, count 4 — same key family
    const entry = await scanSessionFile(fixturePath);
    expect(entry?.cycles).toHaveLength(1);
    expect(entry?.cycles[0]?.count).toBe(4);

    // panel: the loop injection exists on the turn-4 group. Token currencies
    // are DIFFERENT BY DEFINITION (panel bills only the rounds carrying
    // post-gate calls = l4's round; the bell books the whole streak) — the
    // shared number is the COUNT, not the tokens.
    const g5 = aiGroups()[4].group;
    const loopInj = injectionsOf('loop').find((i) => i.aiGroupId === g5.id);
    expect(loopInj).toBeDefined();
    expect(loopInj?.rounds).toHaveLength(1);
    expect(loopInj?.estimatedTokens).toBe(60_300);
  });

  it('#97 compact mid-turn — one turn everywhere, wait-loop verdict agrees, longest turn agrees', async () => {
    // numbering: c0 consumed no turn number — turn 3 owns both quiet phases
    // (asserted via chips/contextByTurn above); here: the budget bucket too
    expect(hookSpentByTurn(lines).get(3)).toBe(474_000); // 240k pre + 234k post
    expect(contextByTurnOf(shared.ledger, 3)).toBe(474_000);

    // wait-loop: CLI finding (6 quiet ticks, one turn) ...
    const wait = shared.findings.filter((f) => f.type === 'wait_loop');
    expect(wait).toHaveLength(1);
    expect(wait[0].turnIndex).toBe(3);
    expect(wait[0].summary).toMatch(/6 quiet rounds/);
    // ... == panel injection, accumulated ACROSS the compact's two groups
    const waitInj = injectionsOf('wait-loop');
    expect(waitInj).toHaveLength(1);
    expect(waitInj[0].turnIndex).toBe(2);
    expect(waitInj[0].roundCount).toBe(6);
    // currency note: the panel's estimate is billed (474120 = 474000 input
    // side + 6×20 out); the CLI's tokensWasted books the input side after
    // waste allocation — the shared, asserted number is the tick count.
    expect(waitInj[0].estimatedTokens).toBe(474_120);

    // longest turn: ledger minutes == inventory ms (one turn across c0)
    const entry = await scanSessionFile(fixturePath);
    const cliMinutes = shared.ledger.totals.longestTurn?.activeMinutes;
    expect(cliMinutes).toBeCloseTo(4.5, 2); // 30+30+90+60+60s of round gaps
    expect((entry?.longestTurnMs ?? 0) / 60_000).toBeCloseTo(cliMinutes ?? -1, 2);
  });

  it('#98 the sidechain subagent prompt opens no turn and bills nothing, anywhere', () => {
    // s1 (isSidechain user prompt) + s2 (isSidechain round, billed 6500):
    // no ledger round, no chunk response, no hook spend, no turn number
    expect(shared.ledger.rounds.some((r) => r.turnIndex === 2 && r.contextSize === 6500)).toBe(
      false
    );
    for (const g of aiGroups()) {
      expect(g.group.responses.some((m) => m.uuid === 's1' || m.uuid === 's2')).toBe(false);
    }
    // hook turn 2 excludes the sidechain round (24900, not 31400)
    expect(hookSpentByTurn(lines).get(2)).toBe(24_900);
  });

  it('#104 a <task-notification> opens no turn but renders in the panel', () => {
    const byUuid = (uuid: string) => JSON.parse(lines.find((l) => JSON.parse(l).uuid === uuid)!);
    expect(isTurnNumberLine(byUuid('tn1'))).toBe(false);
    // chat: still 6 groups — tn1 glued into the last AI group
    expect(aiGroups()).toHaveLength(6);
    // panel display items: the notification renders as a task_notification
    // card (parsed from the same non-meta user line) and the relay next to it
    // as a teammate card
    const g6 = aiGroups()[5].group;
    const items = buildDisplayItems(
      g6.steps,
      findLastOutput(g6.steps, false),
      g6.processes ?? [],
      g6.responses
    );
    const tn = items.find((i) => i.type === 'task_notification');
    expect(tn?.notification.taskId).toBe('bppnd267i');
    expect(tn?.notification.summary).toContain('run-job.sh');
    expect(
      items.some((i) => i.type === 'teammate_message' && i.teammateMessage.teammateId === 'alice')
    ).toBe(true);
  });

  it('cost parity: session details == analyze:session, priced and not partial (#73)', () => {
    // sonnet 5 (2/10/0.2 per MTok) on 15 main-chain rounds + glm 5.3 flash
    // (0.075/0.25/0.015) on the fragment — hand-priced: 179_284 / 1e6
    const app = calculateMetrics(shared.msgs);
    const cli = shared.ledger.totals;
    expect(app.costUsd).toBeCloseTo(0.179284, 10);
    expect(cli.costUsd).toBeCloseTo(app.costUsd ?? -1, 10);
    expect(app.costPartial).toBe(false);
    expect(cli.costPartial).toBe(false);
  });

  it('buildSums checksums all hold on this transcript (#102)', () => {
    const sums = buildSums(shared.ledger, shared.findings, hookSpentByTurn(lines), lines) as {
      checksums: {
        roundsSumEqualsTurnsSum: boolean;
        turnsSumEqualsSession: boolean;
        hookParity: { match: boolean; mismatches: unknown[] };
      };
    };
    expect(sums.checksums.roundsSumEqualsTurnsSum).toBe(true);
    expect(sums.checksums.turnsSumEqualsSession).toBe(true);
    expect(sums.checksums.hookParity.match).toBe(true);
    expect(sums.checksums.hookParity.mismatches).toEqual([]);
  });

  it('calibration feedLine walk — pinned slice attribution (sampler quirks, by design)', () => {
    // turn-spend:stats measures HOOK budget buckets, not app turns: a0's
    // pre-input spend is before the first boundary (dropped — the sampler
    // starts at the first user message), the compact SPLITS turn 3 into two
    // buckets (240k + 234k — that is what the hook enforces), and the relay
    // does not close a bucket, so a4 bills into u4's slice (unflushed tail).
    const state = { current: null as TurnSpend | null, spends: [] as TurnSpend[], file: 'f' };
    for (const l of lines) feedLine(l, state);
    expect(state.spends.map((s) => s.inputSide)).toEqual([24_900, 240_000, 234_000, 301_000]);
    expect(state.spends.map((s) => s.rounds)).toEqual([3, 3, 3, 5]);
    expect(state.current).toMatchObject({ inputSide: 61_100, rounds: 1 });
  });

  it('bell ↔ panel: the crossing budget incident matches exactly one Re-read row (#101)', () => {
    // budget 20000: turn 2 crosses at a2 (8200 + 8300 + 8400). The bell names
    // phase 1 + segment start = a1's timestamp = the g2 row's group start.
    const det = new TurnBudgetDetector();
    const incident = det.feed('f', shared.msgs, 20_000);
    expect(incident).not.toBeNull();
    expect(incident?.spent).toBe(24_900);
    expect(incident?.phaseNumber).toBe(1);
    const ts = (v: unknown) => new Date(v as string).getTime();
    const matched = shared.rereadAll.filter(
      (r) =>
        r.phaseNumber === incident!.phaseNumber &&
        ts(r.turnStartTs) === ts(incident!.segmentStartTs)
    );
    expect(matched).toHaveLength(1);
    expect(matched[0].estimatedTokens).toBe(24_900);
  });
});

describe('TODO(#100): the bell numbers turns without the implicit pre-input turn', () => {
  // KNOWN MISMATCH, deliberately NOT fixed (out of scope for #103): the app
  // canon (jsonl turnCount, chips, buildLedger, hookSpentByTurn) opens turn 1
  // on the pre-input assistant run and numbers the first user turn 2 — the
  // bell's counter only counts isTranscriptTurnLine lines, so it says 0 during
  // the pre-input run ("file opened mid-turn") and lags one behind for the
  // whole session. Any fix belongs with #100's canon; until then these
  // assertions PIN the divergent numbers so the gap stays visible.
  it('bell reports 0 during the pre-input run and one less than the chat afterwards', () => {
    const early = new TurnBudgetDetector();
    const earlyHit = early.feed('f', shared.msgs.slice(0, 1), 4_000);
    expect(earlyHit?.turnNumber).toBe(0); // chat numbers this run Turn 1

    const det = new TurnBudgetDetector();
    const hit = det.feed('f', shared.msgs, 20_000); // crosses in chat-turn 2
    expect(hit?.turnNumber).toBe(1); // chat chip says Turn 2 — one behind
    // the SPEND parity holds regardless (the bucket, not the number):
    expect(hit?.spent).toBe(24_900);
    expect(det.currentTurnTotal('f')).toBe(61_100);
  });
});

function contextByTurnOf(ledger: ReturnType<typeof buildLedger>, no: number): number {
  return ledger.rounds.filter((r) => r.turnIndex === no).reduce((s, r) => s + r.contextSize, 0);
}
