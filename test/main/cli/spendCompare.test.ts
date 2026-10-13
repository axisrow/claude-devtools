/**
 * spend:compare tests (#86) — synthetic distributions with a known median
 * shift (CI covers it, excludes 0), no shift (CI covers 0), bootstrap seed
 * reproducibility, Mann–Whitney edges, turn metric computation and set
 * assignment on synthetic ledgers. No corpus needed.
 */
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import { hashSessionId } from '../../../src/cli/corpus';
import { mulberry32 } from '../../../src/cli/precision';
import {
  assignSets,
  bootstrapMedianDiff,
  compareTurnSets,
  mannWhitneyP,
  median,
  parseCompareArgs,
  parsePeriodSpec,
  readHashList,
  renderReport,
  turnSamples,
} from '../../../src/cli/spendCompare';

import type {
  Finding,
  FindingType,
  RoundRow,
  SessionLedger,
} from '../../../src/cli/analyzeSession';
import type { ComputedSession } from '../../../src/cli/corpus';
import type { SampleSet, SetSpec, TurnSample } from '../../../src/cli/spendCompare';

// =============================================================================
// Synthetic builders
// =============================================================================

let nextIndex = 0;
const makeRound = (
  turnIndex: number,
  model: string,
  opts: Partial<
    Pick<
      RoundRow,
      'inputTokens' | 'cacheReadTokens' | 'cacheCreationTokens' | 'outputTokens' | 'timestamp'
    >
  > = {}
): RoundRow => {
  const i = nextIndex;
  nextIndex += 1;
  return {
    index: i,
    turnIndex,
    model,
    timestamp: new Date(2026, 8, 1, 12, 0, i),
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    contextSize: 0,
    contextDelta: 0,
    thinkingTokens: 0,
    tools: [],
    resultTokens: 0,
    injectedTextTokens: 0,
    ...opts,
  };
};

const makeLedger = (rounds: RoundRow[]): SessionLedger =>
  ({
    turns: [...new Set(rounds.map((r) => r.turnIndex))].map((index) => ({
      index,
      start: rounds[0].timestamp,
      activeMinutes: 1,
    })),
    rounds,
    totals: {},
    models: [...new Set(rounds.map((r) => r.model))],
    durationMs: 0,
    activeMinutes: 1,
    billing: 'mixed',
  }) as unknown as SessionLedger;

const makeFinding = (
  type: FindingType,
  turnIndex: number | undefined,
  tokensWasted: number,
  wastedUsd?: number
): Finding => ({
  type,
  kind: 'waste',
  severity: 'low',
  tokensWasted,
  ...(wastedUsd !== undefined ? { wastedUsd } : {}),
  basis: 'measured',
  ...(turnIndex === undefined ? {} : { turnIndex }),
  summary: '',
});

const makeTurn = (cost: number, model = 'claude-sonnet-5'): TurnSample => ({
  turnIndex: 0,
  model,
  mixedModels: false,
  costUsd: cost,
  inputSide: cost * 1e6,
  wasteUsd: 0,
  typeTokens: new Map(),
  typeTurns: new Set(),
});

const sampleSetFrom = (turns: TurnSample[], source = 'synthetic'): SampleSet => ({
  source,
  sessions: 1,
  turns,
  unattributedFindings: 0,
});

// =============================================================================
// Period / list parsing
// =============================================================================

describe('parsePeriodSpec', () => {
  it('single date → the full local day', () => {
    const spec = parsePeriodSpec('2026-09-01');
    expect(spec?.kind).toBe('period');
    if (spec?.kind === 'period') {
      expect(spec.since).toEqual(new Date(2026, 8, 1, 0, 0, 0, 0));
      expect(spec.until).toEqual(new Date(2026, 8, 1, 23, 59, 59, 999));
    }
  });

  it('START..END → start of the first day to end of the second', () => {
    const spec = parsePeriodSpec('2026-09-01..2026-09-14');
    if (spec?.kind === 'period') {
      expect(spec.since).toEqual(new Date(2026, 8, 1));
      expect(spec.until).toEqual(new Date(2026, 8, 14, 23, 59, 59, 999));
    } else {
      expect.unreachable('expected a period spec');
    }
  });

  it('malformed input → null', () => {
    expect(parsePeriodSpec('garbage')).toBeNull();
    expect(parsePeriodSpec('2026-09-01..nope')).toBeNull();
    expect(parsePeriodSpec('2026-13-40')).toBeNull();
  });
});

describe('readHashList', () => {
  it('parses hashes, skips comments and blanks, rejects non-hex lines', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spend-compare-'));
    const file = path.join(dir, 'list.txt');
    await writeFile(file, `# comment\n${'a'.repeat(16)}\n\n  ${'b'.repeat(16)}  \n`);
    expect(readHashList(file)).toEqual(['a'.repeat(16), 'b'.repeat(16)]);
    await writeFile(file, 'nothex\n');
    expect(() => readHashList(file)).toThrow('not a 16-hex');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('parseCompareArgs', () => {
  it('reads flags with values and boolean --json', () => {
    const opts = parseCompareArgs([
      '--before',
      '2026-09-01',
      '--after',
      '2026-09-15',
      '--seed',
      '7',
      '--rounds',
      '100',
      '--json',
    ]);
    expect(opts.before).toBe('2026-09-01');
    expect(opts.after).toBe('2026-09-15');
    expect(opts.seed).toBe(7);
    expect(opts.rounds).toBe(100);
    expect(opts.json).toBe(true);
    expect(opts.error).toBeUndefined();
  });

  it('rejects bad numeric flags', () => {
    expect(parseCompareArgs(['--rounds', 'x']).error).toMatch(/--rounds/);
    expect(parseCompareArgs(['--seed', '']).error).toMatch(/--seed/);
  });
});

// =============================================================================
// Turn samples
// =============================================================================

describe('turnSamples', () => {
  it('sums cost, inputSide and waste per turn; dominant model by billed tokens', () => {
    const rounds = [
      makeRound(1, 'claude-sonnet-5', { inputTokens: 100, outputTokens: 10 }),
      makeRound(1, 'claude-sonnet-5', { inputTokens: 200, outputTokens: 5 }),
      makeRound(2, 'claude-sonnet-5', { inputTokens: 50, outputTokens: 3 }),
      makeRound(2, 'glm-5.3-flash', { inputTokens: 500, outputTokens: 1 }),
    ];
    const findings = [
      makeFinding('duplicate_call', 1, 50, 0.002),
      makeFinding('failed_call', 2, 10),
    ];
    const { turns, unattributedFindings } = turnSamples(makeLedger(rounds), findings);

    expect(turns).toHaveLength(2);
    expect(unattributedFindings).toBe(0);
    const t1 = turns[0];
    expect(t1.turnIndex).toBe(1);
    expect(t1.inputSide).toBe(300);
    expect(t1.costUsd).not.toBeNull();
    expect(t1.wasteUsd).toBeCloseTo(0.002, 9);
    expect(t1.typeTurns.has('duplicate_call')).toBe(true);
    expect(t1.typeTokens.get('duplicate_call')).toBe(50);
    expect(t1.model).toBe('claude-sonnet-5');
    expect(t1.mixedModels).toBe(false);

    const t2 = turns[1];
    expect(t2.turnIndex).toBe(2);
    expect(t2.model).toBe('glm-5.3-flash'); // 500 billed beats 53
    expect(t2.mixedModels).toBe(true);
    expect(t2.typeTurns.has('failed_call')).toBe(true);
  });

  it('a turn with any unpriced round has null cost', () => {
    const rounds = [
      makeRound(1, 'claude-sonnet-5', { inputTokens: 100 }),
      makeRound(1, 'mystery-model-v9', { inputTokens: 10 }),
    ];
    const { turns } = turnSamples(makeLedger(rounds), []);
    expect(turns[0].costUsd).toBeNull();
    expect(turns[0].inputSide).toBe(110);
  });

  it('findings without a turn are counted as unattributed', () => {
    const { unattributedFindings } = turnSamples(
      makeLedger([makeRound(1, 'claude-sonnet-5', { inputTokens: 10 })]),
      [makeFinding('cache_dead', undefined, 5)]
    );
    expect(unattributedFindings).toBe(1);
  });
});

// =============================================================================
// Statistics (#86 acceptance)
// =============================================================================

describe('median', () => {
  it('odd, even, empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('bootstrapMedianDiff (#86 acceptance: known shift covered, reproducible)', () => {
  // deterministic synthetic distributions with a known median shift; the base
  // spread (±100) stays well under the shift (300) so the CI must separate
  const shifted = (): { a: number[]; b: number[] } => {
    const gen = (seed: number, shift: number): number[] => {
      const rnd = mulberry32(seed);
      return Array.from({ length: 120 }, () => 1000 + rnd() * 200 + shift);
    };
    return { a: gen(1, 0), b: gen(2, 300) };
  };

  it('known shift: CI covers the shift and excludes 0', () => {
    const { a, b } = shifted();
    const ci = bootstrapMedianDiff(a, b);
    expect(ci).not.toBeNull();
    expect(ci.lower).toBeGreaterThan(0);
    expect(ci.lower).toBeLessThanOrEqual(300);
    expect(ci.upper).toBeGreaterThanOrEqual(300);
  });

  it('no shift: CI covers 0', () => {
    const gen = (seed: number): number[] => {
      const rnd = mulberry32(seed);
      return Array.from({ length: 200 }, () => rnd() * 1000);
    };
    const ci = bootstrapMedianDiff(gen(3), gen(4));
    expect(ci).not.toBeNull();
    expect(ci.lower).toBeLessThanOrEqual(0);
    expect(ci.upper).toBeGreaterThanOrEqual(0);
  });

  it('same seed → identical CI to the last digit; different seed → different resamples', () => {
    const { a, b } = shifted();
    expect(bootstrapMedianDiff(a, b, 7)).toEqual(bootstrapMedianDiff(a, b, 7));
    expect(bootstrapMedianDiff(a, b, 7)).not.toEqual(bootstrapMedianDiff(a, b, 8));
  });

  it('empty side → null', () => {
    expect(bootstrapMedianDiff([], [1])).toBeNull();
    expect(bootstrapMedianDiff([1], [])).toBeNull();
  });
});

describe('mannWhitneyP', () => {
  it('known shift → significant; tied samples → no evidence; empty side → null', () => {
    const a = Array.from({ length: 60 }, (_, i) => i);
    const b = Array.from({ length: 60 }, (_, i) => i + 15);
    expect(mannWhitneyP(a, b)).not.toBeNull();
    expect(mannWhitneyP(a, b)).toBeLessThan(0.05);
    expect(mannWhitneyP(a, [...a])).toBeGreaterThan(0.99); // all values tied → no evidence
    expect(mannWhitneyP([], a)).toBeNull();
  });

  it('same distribution → p > 0.05', () => {
    const gen = (seed: number): number[] => {
      const rnd = mulberry32(seed);
      return Array.from({ length: 100 }, () => rnd() * 1000);
    };
    expect(mannWhitneyP(gen(5), gen(6))).toBeGreaterThan(0.05);
  });
});

// =============================================================================
// Set assignment
// =============================================================================

describe('assignSets', () => {
  const corpusDir = '/tmp/fake-corpus';
  // assignSets hashes the corpus-relative path (the snapshots' hash input),
  // so the fixture must hash `<name>.jsonl`, not the bare name
  const session = (name: string, lastTs: Date): ComputedSession =>
    ({
      file: `${corpusDir}/${name}.jsonl`,
      ledger: makeLedger([makeRound(1, 'claude-sonnet-5', { timestamp: lastTs })]),
      findings: [],
      snapshot: {
        session: hashSessionId(`${name}.jsonl`),
        turns: 1,
        rounds: 1,
        totals: {} as never,
        findings: [],
      },
    }) as unknown as ComputedSession;

  it('assigns by last round timestamp; out-of-range sessions unused', () => {
    const before = parsePeriodSpec('2026-09-01..2026-09-10');
    const after = parsePeriodSpec('2026-09-20..2026-09-30');
    if (before?.kind !== 'period' || after?.kind !== 'period') throw new Error('bad spec');
    const r = assignSets(
      [
        session('a', new Date(2026, 8, 5)),
        session('b', new Date(2026, 8, 25)),
        session('c', new Date(2026, 8, 15)),
      ],
      corpusDir,
      before,
      after
    );
    expect(r.before).toHaveLength(1);
    expect(r.after).toHaveLength(1);
    expect(r.unused).toBe(1);
    expect(r.ambiguous).toBe(0);
  });

  it('overlapping periods: a session matching both is excluded from both', () => {
    const before = parsePeriodSpec('2026-09-01..2026-09-20');
    const after = parsePeriodSpec('2026-09-15..2026-09-30');
    if (before?.kind !== 'period' || after?.kind !== 'period') throw new Error('bad spec');
    const r = assignSets([session('a', new Date(2026, 8, 16))], corpusDir, before, after);
    expect(r.ambiguous).toBe(1);
    expect(r.before).toHaveLength(0);
    expect(r.after).toHaveLength(0);
  });

  it('list assignment by hash; a listed hash inside the other window is ambiguous', () => {
    const before = parsePeriodSpec('2026-09-01..2026-09-30');
    if (before?.kind !== 'period') throw new Error('bad spec');
    const after: SetSpec = {
      kind: 'list',
      hashes: new Set([hashSessionId('b.jsonl')]),
      source: 'list',
    };
    const r = assignSets(
      [session('a', new Date(2026, 8, 2)), session('b', new Date(2026, 8, 3))],
      corpusDir,
      before,
      after
    );
    expect(r.before.map((s) => s.snapshot.session)).toEqual([hashSessionId('a.jsonl')]);
    expect(r.ambiguous).toBe(1);
  });
});

// =============================================================================
// compareTurnSets — the #86 acceptance on synthetic effect sizes
// =============================================================================

describe('compareTurnSets', () => {
  it('spend drop: delta < 0, CI excludes 0, p significant', () => {
    const rnd = mulberry32(11);
    const before = sampleSetFrom(Array.from({ length: 60 }, () => makeTurn(0.4 + rnd() * 0.2)));
    const after = sampleSetFrom(Array.from({ length: 60 }, () => makeTurn(0.2 + rnd() * 0.2)));
    const report = compareTurnSets(before, after, { seed: 86, bootstrapRounds: 1000 });
    const m = report.metrics.turnCostUsd;
    expect(m.medianBefore).not.toBeNull();
    expect(m.delta).toBeLessThan(0);
    expect(m.ci.upper).toBeLessThan(0);
    expect(m.p).not.toBeNull();
    expect(m.p).toBeLessThan(0.05);
  });

  it('no change: CI covers 0, p > 0.05', () => {
    const rnd = mulberry32(12);
    const vals = (): TurnSample[] => Array.from({ length: 60 }, () => makeTurn(0.3 + rnd() * 0.2));
    const report = compareTurnSets(sampleSetFrom(vals()), sampleSetFrom(vals()), {
      seed: 86,
      bootstrapRounds: 1000,
    });
    const m = report.metrics.turnCostUsd;
    expect(m.ci.lower).toBeLessThanOrEqual(0);
    expect(m.ci.upper).toBeGreaterThanOrEqual(0);
    expect(m.p).toBeGreaterThan(0.05);
  });

  it('wasteShare per turn = wasteUsd / costUsd', () => {
    const t = { ...makeTurn(2), wasteUsd: 0.5 };
    const report = compareTurnSets(sampleSetFrom([t]), sampleSetFrom([{ ...t }]), {
      seed: 1,
      bootstrapRounds: 100,
    });
    expect(report.metrics.turnWasteShare.medianBefore).toBe(0.25);
  });

  it('unpriced turns drop out of cost/wasteShare but stay in inputSide', () => {
    const unpriced = { ...makeTurn(0), costUsd: null };
    const before = sampleSetFrom([...Array.from({ length: 35 }, () => makeTurn(0.3)), unpriced]);
    const after = sampleSetFrom(Array.from({ length: 35 }, () => makeTurn(0.3)));
    const report = compareTurnSets(before, after, { seed: 1, bootstrapRounds: 200 });
    expect(report.before.unpricedTurns).toBe(1);
    expect(report.metrics.turnCostUsd.nBefore).toBe(35);
    expect(report.metrics.turnWasteShare.nBefore).toBe(35);
    expect(report.metrics.turnInputSide.nBefore).toBe(36);
  });

  it('small samples and model-mix mismatches are flagged', () => {
    const before = sampleSetFrom(
      Array.from({ length: 10 }, () => makeTurn(0.4, 'claude-sonnet-5'))
    );
    const after = sampleSetFrom(Array.from({ length: 10 }, () => makeTurn(0.4, 'glm-5.3-flash')));
    const report = compareTurnSets(before, after, { seed: 86, bootstrapRounds: 200 });
    const joined = report.warnings.join('\n');
    expect(joined).toMatch(/small sample/);
    expect(joined).toMatch(/model mix differs/);
    expect(Object.keys(report.byModel).sort()).toEqual(['claude-sonnet-5', 'glm-5.3-flash']);
  });

  it('finding type: frequency and tokens/turn track a known change', () => {
    const withType = (present: boolean): TurnSample => ({
      ...makeTurn(0.3),
      typeTurns: present ? new Set<FindingType>(['duplicate_call']) : new Set(),
      typeTokens: present
        ? (new Map([['duplicate_call', 100]]) as Map<FindingType, number>)
        : new Map(),
    });
    const before = sampleSetFrom(Array.from({ length: 40 }, (_, i) => withType(i % 2 === 0)));
    const after = sampleSetFrom(Array.from({ length: 40 }, () => withType(false)));
    const report = compareTurnSets(before, after, { seed: 86, bootstrapRounds: 500 });
    const st = report.findingTypes.duplicate_call;
    expect(st.freqBefore).toBeCloseTo(0.5, 6);
    expect(st.freqAfter).toBe(0);
    expect(st.freqP).not.toBeNull();
    expect(st.freqP).toBeLessThan(0.05);
    expect(st.tokensPerTurn.medianBefore).toBe(50); // even split of 0s and 100s
    expect(st.tokensPerTurn.medianAfter).toBe(0);
    expect(st.tokensPerTurn.ci.upper).toBeLessThanOrEqual(0);
  });

  it('types absent from both sets produce no rows', () => {
    const report = compareTurnSets(sampleSetFrom([makeTurn(0.3)]), sampleSetFrom([makeTurn(0.3)]), {
      seed: 1,
      bootstrapRounds: 100,
    });
    expect(report.findingTypes).toEqual({});
  });
});

// =============================================================================
// Rendering
// =============================================================================

describe('renderReport', () => {
  it('text contains the key columns and warnings', () => {
    const before = sampleSetFrom(Array.from({ length: 31 }, (_, i) => makeTurn(0.4 + i * 0.001)));
    const after = sampleSetFrom(Array.from({ length: 31 }, (_, i) => makeTurn(0.2 + i * 0.001)));
    const report = compareTurnSets(before, after, { seed: 86, bootstrapRounds: 200 });
    const text = renderReport(report);
    expect(text).toContain('turn cost USD');
    expect(text).toContain('turn inputSide tok');
    expect(text).toContain('turn wasteShare');
    expect(text).toContain('seed=86');
    expect(text).toContain('by dominant model');
    expect(text).toContain('note: costs use');
    expect(text).not.toMatch(/WARNING/); // 31/31 turns — no small-sample warning
  });
});
