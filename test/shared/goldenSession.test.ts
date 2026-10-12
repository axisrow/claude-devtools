/**
 * Golden validation against a REAL (anonymized) session (#74).
 *
 * The parity test (turnAccounting.parity.test.ts) proves consumers agree with
 * each other on a hand-written fixture; this test proves they agree with an
 * INDEPENDENT reference on real data — a wrong formula or price shared by all
 * consumers passes parity but fails here.
 *
 * Fixture: test/fixtures/golden/session.jsonl — a real multi-model session
 * (streaming fragments, compaction, sidechain, 1h cache writes, an unpriced
 * router model, a <synthetic> line), anonymized by a drop-everything-not-
 * whitelisted pass; provenance in test/fixtures/golden/README.md.
 *
 * Reference: test/fixtures/golden/reference.mjs — a zero-import script that
 * re-implements the billing spec (one billed request per requestId/message.id,
 * last line's usage wins; main chain only for cost/hook; prices hand-copied
 * from the published price pages) and prints the expected totals. Its frozen
 * output is test/fixtures/golden/expected.json.
 *
 * Acceptance (#74):
 *  1. the fixture exhibits the required real-session phenomena,
 *  2. the fixture carries no personal data (paths, prompts, ids),
 *  3. reference output === frozen expected.json,
 *  4. calculateMetrics (app), buildLedger (CLI analyzeSession) and the hook's
 *     analyzeTurn reproduce the reference tokens/cost on the same fixture.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { analyzeTurn, isTurnBoundary } from '../../scripts/turn-accounting.mjs';
import { parseJsonlFile, calculateMetrics } from '../../src/main/utils/jsonl';
import { buildLedger } from '../../src/cli/analyzeSession';

const GOLDEN_DIR = resolve(process.cwd(), 'test/fixtures/golden');
const fixturePath = resolve(GOLDEN_DIR, 'session.jsonl');
const referencePath = resolve(GOLDEN_DIR, 'reference.mjs');
const expectedPath = resolve(GOLDEN_DIR, 'expected.json');

interface Expected {
  fixture: {
    lines: number;
    models: string[];
    fragmentGroups: number;
    compactLines: number;
    sidechainLines: number;
    cacheWrite1hRounds: number;
    syntheticLines: number;
  };
  hook: { turns: number; perTurnInputSide: number[]; inputSideTotal: number };
  ledger: {
    turns: number;
    inputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    outputTokens: number;
    billedTokens: number;
  };
  app: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  cost: { usd: number; partial: boolean };
}

const expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as Expected;
const rawLines = readFileSync(fixturePath, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '');

// privacy — a leak of paths, ids, api keys or original (Russian) prompts fails
const PRIVACY_FORBIDDEN: [string, RegExp][] = [
  ['absolute path', /\/Users\//],
  ['raw UUID', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
  ['api key', /sk-(ant|proj|-|or)/],
  ['username', /axisrow/i],
  ['original prompt text', /[Ѐ-ӿ]/],
];

describe('golden real-session fixture (#74)', () => {
  it('carries no personal data', () => {
    const json = readFileSync(fixturePath, 'utf8');
    for (const [, re] of PRIVACY_FORBIDDEN) expect(json).not.toMatch(re);
  });

  it('exhibits the required real-session phenomena, pinned in expected.json', () => {
    const models = new Set<string>();
    const requestLines = new Map<string, number>();
    let compactLines = 0;
    let sidechainLines = 0;
    let cacheWrite1hRounds = 0;
    let syntheticLines = 0;
    for (const line of rawLines) {
      const m = JSON.parse(line) as {
        type?: string;
        isCompactSummary?: boolean;
        isSidechain?: boolean;
        requestId?: string;
        message?: {
          id?: string;
          model?: string;
          usage?: {
            cache_creation_input_tokens?: number;
            cache_creation?: { ephemeral_1h_input_tokens?: number };
          };
        };
      };
      if (m.isCompactSummary === true) compactLines++;
      if (m.isSidechain === true) sidechainLines++;
      if (m.type !== 'assistant') continue;
      const key = m.requestId ?? m.message?.id;
      if (key) requestLines.set(key, (requestLines.get(key) ?? 0) + 1);
      if (m.message?.model) models.add(m.message.model);
      if (m.message?.model === '<synthetic>') syntheticLines++;
      if ((m.message?.usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0)
        cacheWrite1hRounds++;
    }
    expect({
      lines: rawLines.length,
      models: [...models].sort(),
      fragmentGroups: [...requestLines.values()].filter((n) => n > 1).length,
      compactLines,
      sidechainLines,
      cacheWrite1hRounds,
      syntheticLines,
    }).toEqual(expected.fixture);
    // the issue's minimum bars, asserted explicitly so a re-derived
    // expected.json cannot silently drop a phenomenon
    expect(models.size).toBeGreaterThanOrEqual(2);
    expect(expected.fixture.fragmentGroups).toBeGreaterThan(0);
    expect(expected.fixture.compactLines).toBeGreaterThan(0);
    expect(expected.fixture.sidechainLines).toBeGreaterThan(0);
    expect(expected.fixture.cacheWrite1hRounds).toBeGreaterThan(0);
    expect(expected.fixture.syntheticLines).toBeGreaterThan(0);
  });

  it('the independent reference reproduces the frozen expected numbers', () => {
    const out = execFileSync(process.execPath, [referencePath], { encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual({
      fixture: expected.fixture,
      hook: expected.hook,
      ledger: expected.ledger,
      app: expected.app,
      cost: expected.cost,
    });
  });

  it('calculateMetrics (app) matches the reference tokens and cost', async () => {
    const msgs = await parseJsonlFile(fixturePath);
    const metrics = calculateMetrics(msgs);
    expect(metrics.inputTokens).toBe(expected.app.inputTokens);
    expect(metrics.cacheReadTokens).toBe(expected.app.cacheReadTokens);
    expect(metrics.cacheCreationTokens).toBe(expected.app.cacheCreationTokens);
    expect(metrics.outputTokens).toBe(expected.app.outputTokens);
    expect(metrics.totalTokens).toBe(expected.app.totalTokens);
    expect(metrics.costPartial).toBe(expected.cost.partial);
    expect(metrics.costUsd).toBeCloseTo(expected.cost.usd, 9);
  });

  it('buildLedger (CLI analyzeSession) matches the reference main-chain tokens and cost', async () => {
    const msgs = await parseJsonlFile(fixturePath);
    const ledger = buildLedger(msgs);
    expect(ledger.totals.inputTokens).toBe(expected.ledger.inputTokens);
    expect(ledger.totals.cacheReadTokens).toBe(expected.ledger.cacheReadTokens);
    expect(ledger.totals.cacheCreationTokens).toBe(expected.ledger.cacheCreationTokens);
    expect(ledger.totals.outputTokens).toBe(expected.ledger.outputTokens);
    expect(ledger.totals.billedTokens).toBe(expected.ledger.billedTokens);
    expect(ledger.turns).toHaveLength(expected.ledger.turns);
    expect(ledger.totals.costPartial).toBe(expected.cost.partial);
    expect(ledger.totals.costUsd).toBeCloseTo(expected.cost.usd, 9);
  });

  it('hook analyzeTurn per turn sums to the reference input-side total', () => {
    // slice the transcript at canonical boundaries (orchestration only — the
    // NUMBERS come from the independent reference), then run the hook's own
    // accounting per segment, newest-first
    const segments: string[][] = [];
    for (const line of rawLines) {
      if (segments.length === 0 || isTurnBoundary(JSON.parse(line))) segments.push([]);
      segments[segments.length - 1].push(line);
    }
    const perTurn = segments.map((seg) => analyzeTurn([...seg].reverse()).spent);
    expect(segments).toHaveLength(expected.hook.turns);
    expect(perTurn).toEqual(expected.hook.perTurnInputSide);
    expect(perTurn.reduce((a, b) => a + b, 0)).toBe(expected.hook.inputSideTotal);
  });
});
