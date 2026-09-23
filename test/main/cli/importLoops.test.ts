import { describe, expect, it } from 'vitest';

import { buildImportEntries, mergeImport } from '../../../src/cli/importLoops';

const fixture = {
  sessionId: 's1',
  projectId: '-p1',
  filePath: '/x/s1.jsonl',
  cycles: [
    { key: 'Read|/a', count: 25, startTs: '2026-09-01T10:00:00Z', toolUseId: 'c25' },
    { key: 'Bash|true', count: 19, startTs: '2026-09-02T10:00:20Z', toolUseId: 'c19' },
  ],
};

describe('importLoops pure core', () => {
  it('filters cycles below the threshold and keeps deep links', () => {
    const out = buildImportEntries([fixture], 20);
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe('s1');
    expect(out[0].toolUseId).toBe('c25');
    expect(out[0].triggerId).toBe('historical-loop');
  });

  it('replaces previous imports and caps the bell', () => {
    const existing: { id: string; timestamp: number; triggerId: string }[] = [
      { id: 'live-1', timestamp: 500, triggerId: 'trigger' },
      { id: 'old-import', timestamp: 900, triggerId: 'historical-loop' },
    ];
    const incoming = buildImportEntries([fixture], 20);
    const merged = mergeImport(existing, incoming, 5);
    expect(merged.map((n) => n.id)).toEqual([
      'historical-loop-s1-25x-2026-09-01T10:00:00Z',
      'live-1',
    ]);
  });
});
