import { describe, expect, it } from 'vitest';

import { buildBellStats, parseTurnbudgetLogLine } from '../../src/cli/bellStats';

// local noon — immune to DST/day-boundary flakiness in any timezone
const noon = (y: number, m: number, d: number): number => new Date(y, m - 1, d, 12).getTime();

const ENTRIES = [
  { timestamp: noon(2026, 10, 16), source: 'turn_budget' },
  { timestamp: noon(2026, 10, 17), source: 'loop' },
  { timestamp: noon(2026, 10, 17), source: 'turn_budget' },
  { timestamp: noon(2026, 10, 17), source: 'turn_budget_hook' },
  { timestamp: noon(2026, 10, 17), source: 'turn_budget_hook' },
];

describe('buildBellStats', () => {
  it('groups per local date x source, sorted, with totals', () => {
    const { rows, total } = buildBellStats(ENTRIES);
    expect(rows).toEqual([
      { date: '2026-10-16', source: 'turn_budget', count: 1 },
      { date: '2026-10-17', source: 'loop', count: 1 },
      { date: '2026-10-17', source: 'turn_budget', count: 1 },
      { date: '2026-10-17', source: 'turn_budget_hook', count: 2 },
    ]);
    expect(total).toBe(5);
  });

  it('filters by source type', () => {
    const { rows, total } = buildBellStats(ENTRIES, { type: 'turn_budget_hook' });
    expect(total).toBe(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ date: '2026-10-17', source: 'turn_budget_hook', count: 2 });
  });

  it('respects inclusive since/until bounds', () => {
    const since = new Date(2026, 9, 17);
    since.setHours(0, 0, 0, 0);
    const until = new Date(2026, 9, 17, 23, 59, 59, 999);
    const { rows, total } = buildBellStats(ENTRIES, { since, until });
    expect(total).toBe(4);
    expect(rows.every((r) => r.date === '2026-10-17')).toBe(true);
  });

  it('empty input gives empty stats', () => {
    expect(buildBellStats([])).toEqual({ rows: [], total: 0 });
  });
});

describe('parseTurnbudgetLogLine', () => {
  it('parses a deny row into a turn_budget_hook entry', () => {
    const e = parseTurnbudgetLogLine(
      '2026-10-17T07:29:41.220Z kind=deny session=f3bd8441 spent=15026601 budget=15000000 denied=true'
    );
    expect(e).toEqual({
      timestamp: Date.parse('2026-10-17T07:29:41.220Z'),
      source: 'turn_budget_hook',
    });
  });

  it('parses a crane row into its own turn_budget_crane source (#143)', () => {
    const e = parseTurnbudgetLogLine(
      '2026-10-18T02:09:00.000Z kind=crane session=f3bd8441 spent=15382567 budget=15000000 denied=true'
    );
    expect(e).toEqual({
      timestamp: Date.parse('2026-10-18T02:09:00.000Z'),
      source: 'turn_budget_crane',
    });
  });

  it('skips non-deny, malformed and empty lines', () => {
    expect(
      parseTurnbudgetLogLine(
        '2026-10-17T07:29:41.220Z kind=no-boundary session=x spent=1 budget=1 denied=false'
      )
    ).toBeNull();
    expect(parseTurnbudgetLogLine('garbage line')).toBeNull();
    expect(parseTurnbudgetLogLine('')).toBeNull();
  });
});
