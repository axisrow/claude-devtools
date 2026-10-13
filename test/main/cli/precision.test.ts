/**
 * Precision CLI tests (#81) — Wilson CI on known values (incl. 0% / 100%
 * edges), seeded stratified sampling determinism, and the #79 mini fixtures
 * running the full sample → label → report pipeline. No corpus needed.
 */
import { copyFile, mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import { computeCorpus } from '../../../src/cli/corpus';
import {
  buildSampleDoc,
  mulberry32,
  precisionReport,
  stratifiedSample,
  wilsonInterval,
} from '../../../src/cli/precision';

import type { Finding, FindingType } from '../../../src/cli/analyzeSession';
import type { Label, SampleItem, TypePrecision } from '../../../src/cli/precision';

const FIXTURES_DIR = path.resolve(process.cwd(), 'test/fixtures/corpus');

describe('wilsonInterval (#81 acceptance: known values + edges)', () => {
  it('8/10 → [0.490, 0.943], contains the point estimate', () => {
    const ci = wilsonInterval(8, 10);
    expect(ci.lower).toBeCloseTo(0.490, 2);
    expect(ci.upper).toBeCloseTo(0.943, 2);
    expect(ci.lower).toBeLessThan(0.8);
    expect(ci.upper).toBeGreaterThan(0.8);
  });

  it('0/5 → lower bound 0, upper ≈ 0.434', () => {
    const ci = wilsonInterval(0, 5);
    expect(ci.lower).toBeCloseTo(0, 4); // exactly 0 algebraically; float dust allowed
    expect(ci.upper).toBeCloseTo(0.4345, 3);
  });

  it('50/50 (=100%) → lower ≈ 0.929, upper clamped to 1', () => {
    const ci = wilsonInterval(50, 50);
    expect(ci.lower).toBeCloseTo(0.929, 2);
    expect(ci.upper).toBe(1);
  });

  it('degenerate totals: 0/0 → the full [0,1] interval', () => {
    expect(wilsonInterval(0, 0)).toEqual({ lower: 0, upper: 1 });
  });

  it('is monotone: more successes never lower the interval', () => {
    let prevLower = -1;
    for (let x = 0; x <= 10; x += 1) {
      const ci = wilsonInterval(x, 10);
      expect(ci.lower).toBeGreaterThanOrEqual(prevLower);
      prevLower = ci.lower;
    }
  });
});

describe('mulberry32 (seeded PRNG)', () => {
  it('same seed → same sequence, different seed → different', () => {
    const a = mulberry32(79);
    const b = mulberry32(79);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual([mulberry32(80)(), mulberry32(80)(), mulberry32(80)()]);
    for (const v of seqA) expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe('stratifiedSample (#81 acceptance: same seed → same sample)', () => {
  const entries = (n: number): { type: FindingType; item: number }[] =>
    Array.from({ length: n }, (_, i) => ({
      type: (i % 2 === 0 ? 'duplicate_call' : 'failed_call') as FindingType,
      item: i,
    }));

  it('same seed → identical selection', () => {
    expect(stratifiedSample(entries(20), 3, 79)).toEqual(stratifiedSample(entries(20), 3, 79));
  });

  it('respects the per-type cap', () => {
    const picked = stratifiedSample(entries(20), 3, 79) as number[];
    expect(picked).toHaveLength(6); // 2 types × 3
    const dupTypes = picked.filter((i) => i % 2 === 0);
    const failTypes = picked.filter((i) => i % 2 === 1);
    expect(dupTypes).toHaveLength(3);
    expect(failTypes).toHaveLength(3);
  });

  it('returns everything when a type has fewer than perType', () => {
    expect(stratifiedSample(entries(7), 10, 79)).toHaveLength(7);
  });

  it('different seed → (with overwhelming probability) a different draw', () => {
    expect(stratifiedSample(entries(20), 3, 1)).not.toEqual(stratifiedSample(entries(20), 3, 2));
  });
});

const mkItem = (type: FindingType, label: Label | null): SampleItem => ({
  id: `h:${type}:-:0`,
  type,
  session: 'h',
  turn: null,
  severity: 'medium',
  tokensWasted: 1,
  summary: 's',
  context: [],
  label,
  comment: null,
});

describe('precisionReport (#81: unsure excluded, NOISY <70%)', () => {
  const doc = {
    seed: 1,
    perType: 10,
    items: [
      mkItem('duplicate_call', 'waste'),
      mkItem('duplicate_call', 'not_waste'),
      mkItem('duplicate_call', 'unsure'), // excluded from precision, counted apart
      mkItem('failed_call', 'not_waste'),
      mkItem('failed_call', null), // unlabeled
      mkItem('loop_streak', 'waste'),
      mkItem('loop_streak', 'waste'),
    ],
  };

  it('computes labeled-only precision with a Wilson CI per type', () => {
    const rows = precisionReport(doc);
    const dup = rows.find((r) => r.type === 'duplicate_call') as TypePrecision;
    expect(dup.labeled).toBe(2); // unsure kept out of the denominator
    expect(dup.waste).toBe(1);
    expect(dup.notWaste).toBe(1);
    expect(dup.unsure).toBe(1);
    expect(dup.precision).toBe(0.5);
    expect(dup.ci).not.toBeNull();
    expect(dup.ci!.lower).toBeLessThan(0.5);
    expect(dup.ci!.upper).toBeGreaterThan(0.5);
    expect(dup.noisy).toBe(true); // 50% < 70%
  });

  it('flags nothing when everything labeled is waste; upper bound reaches 1', () => {
    const loop = precisionReport(doc).find((r) => r.type === 'loop_streak') as TypePrecision;
    expect(loop.precision).toBe(1);
    expect(loop.ci!.upper).toBe(1);
    expect(loop.noisy).toBe(false);
  });

  it('counts unlabeled separately; zero precision is noisy', () => {
    const rows = precisionReport(doc);
    const failed = rows.find((r) => r.type === 'failed_call') as TypePrecision;
    expect(failed.unlabeled).toBe(1);
    expect(failed.labeled).toBe(1);
    expect(failed.precision).toBe(0);
    expect(failed.noisy).toBe(true);
  });

  it('empty doc → no rows, no crash', () => {
    expect(precisionReport({ seed: 1, perType: 10, items: [] })).toEqual([]);
  });
});

describe('buildSampleDoc skips observations (#84)', () => {
  const session = (findings: Finding[]) =>
    ({
      snapshot: { session: 'abcd1234abcd1234' },
      ledger: { rounds: [] },
      findings,
    }) as never;

  it('observation findings are not sampling candidates — they are not waste claims', () => {
    const doc = buildSampleDoc(
      [
        session([
          {
            type: 'context_spike',
            kind: 'observation',
            severity: 'high',
            tokensWasted: 0,
            basis: 'measured',
            summary: 'spike',
          },
        ]),
        session([
          {
            type: 'duplicate_call',
            kind: 'waste',
            severity: 'medium',
            tokensWasted: 10,
            basis: 'estimated',
            summary: 'dup',
          },
        ]),
      ],
      5,
      79
    );
    expect(doc.items.map((i) => i.type)).toEqual(['duplicate_call']);
  });
});

describe('sample on the #79 mini fixtures (CI stand-in for the real corpus)', () => {
  it('pipeline over the fixtures: stratified items, numeric context, deterministic doc', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'precision-fixtures-'));
    try {
      for (const f of ['loop-streak.jsonl', 'wait-loop-compaction.jsonl', 'basic-cache.jsonl']) {
        await copyFile(path.join(FIXTURES_DIR, f), path.join(dir, f));
      }
      const sessions = await computeCorpus(dir);
      const doc = buildSampleDoc(sessions, 5, 79);

      // the fixtures' known finding types all made it into the sample
      const types = new Set(doc.items.map((i) => i.type));
      expect(types).toContain('loop_streak');
      expect(types).toContain('failed_call');
      expect(types).toContain('wait_loop');

      for (const item of doc.items) {
        expect(item.label).toBeNull(); // labeling is human work, not sampling
        expect(item.summary.length).toBeGreaterThan(0);
        expect(item.id).toMatch(/^[0-9a-f]{16}:\w+:/);
        for (const c of item.context) {
          expect(Number.isFinite(c.round)).toBe(true);
          expect(Number.isFinite(c.input)).toBe(true);
          expect(Array.isArray(c.tools)).toBe(true);
        }
      }
      // at least one item carries the turn's round context (loop-streak fixture has rounds)
      expect(doc.items.some((i) => i.context.length > 0)).toBe(true);

      // acceptance: a rerun with the same seed yields the same sample
      const doc2 = buildSampleDoc(await computeCorpus(dir), 5, 79);
      expect(doc2.items).toEqual(doc.items);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
