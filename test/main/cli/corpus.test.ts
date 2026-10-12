/**
 * corpus CLI tests (#79) — mini fixtures run the full pipeline, snapshots stay
 * numeric-only (privacy), invariants fire on tampered ledgers, env resolution.
 * The real corpus lives outside the repo (CORPUS_DIR); these fixtures stand in
 * for CI.
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildLedger, computeFindings } from '../../../src/cli/analyzeSession';
import {
  buildSnapshot,
  checkInvariants,
  diffSnapshots,
  hashSessionId,
  listSessionFiles,
  resolveCorpusDir,
  SNAPSHOT_DIR_NAME,
} from '../../../src/cli/corpus';
import { parseJsonlFile } from '../../../src/main/utils/jsonl';

import type { SessionSnapshot } from '../../../src/cli/corpus';
import type { Finding, SessionLedger } from '../../../src/cli/analyzeSession';

// vitest hands modules a non-file: import.meta.url — paths anchor on cwd (the
// package root, same for pnpm scripts)
const FIXTURES_DIR = path.resolve(process.cwd(), 'test/fixtures/corpus');
const REPO_ROOT = process.cwd();

// nothing that identifies a session may appear in a snapshot
const PRIVACY_FORBIDDEN = [
  /\/Users\//, // absolute paths
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, // raw session ids
];

const assertNumericOnly = (snapshot: SessionSnapshot): void => {
  const json = JSON.stringify(snapshot);
  for (const re of PRIVACY_FORBIDDEN) expect(json).not.toMatch(re);
  expect(snapshot.session).toMatch(/^[0-9a-f]{16}$/);
};

describe('corpus mini fixtures (CI stand-in for the real corpus)', () => {
  const fixtures = fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();

  it('has 3–5 anonymized fixtures', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(3);
    expect(fixtures.length).toBeLessThanOrEqual(5);
  });

  for (const file of fixtures) {
    it(`${file}: pipeline runs, invariants hold`, async () => {
      const messages = await parseJsonlFile(path.join(FIXTURES_DIR, file));
      const ledger = buildLedger(messages);
      const findings = computeFindings(messages, ledger);
      expect(ledger.rounds.length).toBeGreaterThan(0);
      expect(checkInvariants(ledger, findings)).toEqual([]);
      assertNumericOnly(buildSnapshot(file.replace(/\.jsonl$/, ''), ledger, findings));
    });
  }

  it('router-retry fixture flags a retry copy', async () => {
    const messages = await parseJsonlFile(path.join(FIXTURES_DIR, 'router-retry.jsonl'));
    const ledger = buildLedger(messages);
    expect(ledger.totals.retryCopies).toBe(1);
    expect(ledger.billing).toBe('router-style');
  });

  it('loop-streak fixture produces loop_streak + failed_call findings', async () => {
    const messages = await parseJsonlFile(path.join(FIXTURES_DIR, 'loop-streak.jsonl'));
    const ledger = buildLedger(messages);
    const findings = computeFindings(messages, ledger);
    const types = findings.map((f) => f.type);
    expect(types).toContain('loop_streak');
    expect(types).toContain('failed_call');
  });

  it('wait-loop fixture produces a wait_loop finding after compaction', async () => {
    const messages = await parseJsonlFile(path.join(FIXTURES_DIR, 'wait-loop-compaction.jsonl'));
    const ledger = buildLedger(messages);
    const findings = computeFindings(messages, ledger);
    const wait = findings.find((f) => f.type === 'wait_loop');
    expect(wait).toBeDefined();
    expect(wait?.turnIndex).toBe(2); // after the isCompactSummary boundary
  });

  it('basic-cache fixture is clean; write+read rounds detect as mixed', async () => {
    const messages = await parseJsonlFile(path.join(FIXTURES_DIR, 'basic-cache.jsonl'));
    const ledger = buildLedger(messages);
    // round 1/3 carry cache writes, round 2 a cache read — detectBillingScheme
    // calls that pattern mixed (both signatures present)
    expect(ledger.billing).toBe('mixed');
    expect(computeFindings(messages, ledger)).toEqual([]);
  });
});

describe('snapshot privacy (#79 acceptance: no texts, paths, open ids)', () => {
  it('a sensitive session yields a numeric-only snapshot', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'corpus-privacy-'));
    try {
      const sessionId = '12345678-9abc-4def-8901-234567890abc';
      const lines = [
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-10-05T09:00:00Z',
          isMeta: false,
          message: {
            role: 'user',
            content: 'TOPSECRET-prompt-text about /Users/alice/secret-project',
          },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-10-05T09:00:05Z',
          requestId: 'req-1',
          message: {
            id: 'm1',
            model: 'claude-sonnet-5-5',
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 1000,
              output_tokens: 20,
            },
            content: [
              {
                type: 'tool_use',
                id: 't1',
                name: 'Read',
                input: { file_path: '/Users/alice/secret-project/keys.env' },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'u2',
          timestamp: '2026-10-05T09:00:10Z',
          isMeta: true,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: 'SECRET-FILE-CONTENT api_key=...',
              },
            ],
          },
        },
      ];
      const file = path.join(dir, `${sessionId}.jsonl`);
      await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n'));
      const messages = await parseJsonlFile(file);
      const ledger = buildLedger(messages);
      const findings = computeFindings(messages, ledger);
      const snapshot = buildSnapshot(sessionId, ledger, findings);
      assertNumericOnly(snapshot);
      const json = JSON.stringify(snapshot);
      expect(json).not.toContain('TOPSECRET');
      expect(json).not.toContain('secret-project');
      expect(json).not.toContain('SECRET-FILE-CONTENT');
      expect(json).not.toContain(sessionId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('committed corpus-snapshots/ (when present) pass the same scan', () => {
    const dir = path.join(REPO_ROOT, SNAPSHOT_DIR_NAME);
    if (!fs.existsSync(dir)) return; // nothing committed yet — CI runs on fixtures only
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const json = fs.readFileSync(path.join(dir, name), 'utf8');
      for (const re of PRIVACY_FORBIDDEN) expect(`${name}: ${json}`).not.toMatch(re);
    }
  });
});

describe('diffSnapshots', () => {
  it('recompute is diff-clean; a token shift is visible', async () => {
    const messages = await parseJsonlFile(path.join(FIXTURES_DIR, 'basic-cache.jsonl'));
    const ledger = buildLedger(messages);
    const findings = computeFindings(messages, ledger);
    const snap = buildSnapshot('s1', ledger, findings);
    expect(diffSnapshots(snap, structuredClone(snap))).toEqual({
      session: snap.session,
      totalsChanges: [],
      structuralChanges: [],
      added: [],
      removed: [],
    });

    const shifted = structuredClone(snap);
    shifted.totals.outputTokens += 500;
    const d = diffSnapshots(snap, shifted);
    expect(d.totalsChanges).toEqual([
      {
        field: 'outputTokens',
        before: snap.totals.outputTokens,
        after: snap.totals.outputTokens + 500,
      },
    ]);

    const withNewFinding = structuredClone(snap);
    withNewFinding.findings.push({
      type: 'failed_call',
      turnIndex: 1,
      severity: 'medium',
      tokensWasted: 42,
    });
    const d2 = diffSnapshots(snap, withNewFinding);
    expect(d2.added).toHaveLength(1);
    expect(d2.removed).toHaveLength(0);
  });
});

describe('checkInvariants (#79 acceptance: checked per session)', () => {
  const ledgerWithTotals = (
    totals: Partial<SessionLedger['totals']>,
    roundTokens = 100
  ): SessionLedger => {
    const ledger = buildLedger([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: new Date('2026-10-05T09:00:00Z'),
        isMeta: false,
        content: 'hi',
      } as never,
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: new Date('2026-10-05T09:00:05Z'),
        requestId: 'r1',
        message: {
          id: 'm1',
          model: 'claude-sonnet-5-5',
          usage: {
            input_tokens: roundTokens,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: roundTokens,
          },
          content: [],
        },
      } as never,
    ]);
    return { ...ledger, totals: { ...ledger.totals, ...totals } };
  };

  it('a clean ledger passes', () => {
    const ledger = ledgerWithTotals({});
    expect(checkInvariants(ledger, [])).toEqual([]);
  });

  it('round sum != total is caught', () => {
    const ledger = ledgerWithTotals({ inputTokens: 999 });
    const violations = checkInvariants(ledger, []);
    expect(violations.map((v) => v.invariant)).toContain('rounds-sum-equals-total');
  });

  it('negative tokensWasted is caught', () => {
    const ledger = ledgerWithTotals({});
    const finding: Finding = {
      type: 'duplicate_call',
      severity: 'medium',
      tokensWasted: -5,
      summary: 'x',
    };
    expect(checkInvariants(ledger, [finding]).map((v) => v.invariant)).toContain(
      'tokensWasted-non-negative'
    );
  });

  it('wasted sum > billed is caught', () => {
    const ledger = ledgerWithTotals({});
    const finding: Finding = {
      type: 'cache_dead',
      severity: 'high',
      tokensWasted: ledger.totals.billedTokens + 1,
      summary: 'x',
    };
    expect(checkInvariants(ledger, [finding]).map((v) => v.invariant)).toContain(
      'wasted-le-billed'
    );
  });
});

describe('resolveCorpusDir', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it('env wins over .env', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'corpus-env-'));
    await writeFile(path.join(dir, '.env'), 'CORPUS_DIR=/from-dot-env\n');
    expect(resolveCorpusDir({ CORPUS_DIR: '/from-env-var' }, dir)).toBe('/from-env-var');
  });

  it('falls back to .env (quotes stripped)', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'corpus-env-'));
    await writeFile(path.join(dir, '.env'), 'OTHER=1\nCORPUS_DIR="/from dot env"\n');
    expect(resolveCorpusDir({}, dir)).toBe('/from dot env');
  });

  it('null when neither is set (empty value counts as unset)', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'corpus-env-'));
    await writeFile(path.join(dir, '.env'), 'CORPUS_DIR=\n');
    expect(resolveCorpusDir({}, dir)).toBeNull();
    expect(resolveCorpusDir({ CORPUS_DIR: '  ' }, dir)).toBeNull();
  });
});

describe('listSessionFiles', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it('walks recursively, skips agent-* sidechains and non-jsonl, sorted', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'corpus-list-'));
    await mkdir(path.join(dir, 'proj-a'), { recursive: true });
    await writeFile(path.join(dir, 'b.jsonl'), '');
    await writeFile(path.join(dir, 'proj-a', 'a.jsonl'), '');
    await writeFile(path.join(dir, 'proj-a', 'agent-x.jsonl'), '');
    await writeFile(path.join(dir, 'proj-a', 'notes.txt'), '');
    expect(listSessionFiles(dir)).toEqual([
      path.join(dir, 'b.jsonl'),
      path.join(dir, 'proj-a', 'a.jsonl'),
    ]);
  });
});

describe('hashSessionId', () => {
  it('stable, 16 hex chars, differs per id', () => {
    expect(hashSessionId('abc')).toMatch(/^[0-9a-f]{16}$/);
    expect(hashSessionId('abc')).toBe(hashSessionId('abc'));
    expect(hashSessionId('abc')).not.toBe(hashSessionId('abd'));
  });
});

describe('snapshot file round-trip (what corpus:snapshot writes)', () => {
  it('JSON on disk equals the in-memory snapshot and diffs clean', async () => {
    const messages = await parseJsonlFile(path.join(FIXTURES_DIR, 'basic-cache.jsonl'));
    const ledger = buildLedger(messages);
    const findings = computeFindings(messages, ledger);
    const snap = buildSnapshot('roundtrip-session', ledger, findings);
    const dir = await mkdtemp(path.join(tmpdir(), 'corpus-snap-'));
    try {
      const file = path.join(dir, `${snap.session}.json`);
      await writeFile(file, JSON.stringify(snap, null, 2) + '\n');
      const back = JSON.parse(await readFile(file, 'utf8')) as SessionSnapshot;
      expect(back).toEqual(snap);
      expect(diffSnapshots(back, snap).totalsChanges).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
