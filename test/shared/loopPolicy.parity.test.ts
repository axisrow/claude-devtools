/**
 * Loop-threshold parity test (epic #94, issue #96) — one transcript fixture,
 * four surfaces, ONE gate:
 *  - panel (renderer Visible Context loop category, contextTracker)
 *  - analyze:session loop_streak finding (cli/analyzeSession)
 *  - analyze:sessions cycles (cli/sessionInventory)
 *  - bell (live LoopDetector at the default cycleThreshold)
 *
 * k identical back-to-back Reads (k = 2..4): no surface flags below
 * LOOP_MIN_STREAK, every surface flags at it. Early calls of a series are
 * legitimate iteration (#26); #27 regressed the panel to 2 and the CLI sat
 * at 3 while the bell defaulted to 4.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildLedger, computeFindings } from '../../src/cli/analyzeSession';
import { scanSessionFile } from '../../src/cli/sessionInventory';
import { ChunkBuilder } from '../../src/main/services/analysis/ChunkBuilder';
import { LoopDetector } from '../../src/main/utils/loopDetection';
import { parseJsonlFile } from '../../src/main/utils/jsonl';
import { LOOP_MIN_STREAK } from '../../src/shared/constants/loopPolicy';
import { processSessionContextWithPhases } from '../../src/renderer/utils/contextTracker';
import { transformChunksToConversation } from '../../src/renderer/utils/groupTransformer';

// --- transcript fixture: k identical Read rounds, then a closing text round ---

let seq = 0;
const at = (): string => new Date(Date.parse('2026-10-01T07:00:00Z') + (seq += 20_000)).toISOString();
const base = (): Record<string, unknown> => ({
  uuid: `u${String(++seq)}`,
  parentUuid: null,
  sessionId: 's',
  cwd: '/p',
  isSidechain: false,
});
const toolResult = (id: string): Record<string, unknown> => ({
  ...base(),
  type: 'user',
  timestamp: at(),
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
  },
});

function fixtureLines(k: number): object[] {
  seq = 0;
  const lines: object[] = [
    {
      ...base(),
      type: 'user',
      timestamp: at(),
      message: { role: 'user', content: 'go' },
    },
  ];
  for (let i = 0; i < k; i++) {
    lines.push({
      ...base(),
      type: 'assistant',
      timestamp: at(),
      requestId: `q${String(i)}`,
      message: {
        id: `m${String(i)}`,
        role: 'assistant',
        model: 'claude-x',
        content: [{ type: 'tool_use', id: `r${String(i)}`, name: 'Read', input: { file_path: '/x/f.ts' } }],
        usage: {
          input_tokens: 0,
          cache_read_input_tokens: 600_000,
          cache_creation_input_tokens: 0,
          output_tokens: 40,
        },
      },
    });
    lines.push(toolResult(`r${String(i)}`));
  }
  lines.push({
    ...base(),
    type: 'assistant',
    timestamp: at(),
    requestId: 'qe',
    message: {
      id: 'me',
      role: 'assistant',
      model: 'claude-x',
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 0, cache_read_input_tokens: 600_000, cache_creation_input_tokens: 0, output_tokens: 40 },
    },
  });
  return lines;
}

async function writeFixture(k: number): Promise<string> {
  const f = join(mkdtempSync(join(tmpdir(), 'loop-parity-')), 's.jsonl');
  writeFileSync(f, fixtureLines(k).map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

// the four surfaces, real code paths end to end
async function surfaceFlags(k: number): Promise<{
  panel: boolean;
  cli: boolean;
  inventory: boolean;
  bell: boolean;
}> {
  const f = await writeFixture(k);
  const msgs = await parseJsonlFile(f);

  // 1. panel: chunks → conversation → context phases → loop injection
  const conv = transformChunksToConversation(new ChunkBuilder().buildChunks(msgs, []), [], false);
  let panel = false;
  for (const stats of processSessionContextWithPhases(conv.items, '/p', {}, new Map(), new Map()).statsMap.values()) {
    if (stats.newInjections.some((i) => i.category === 'loop')) panel = true;
  }

  // 2. analyze:session loop_streak
  const cli = computeFindings(msgs, buildLedger(msgs)).some((x) => x.type === 'loop_streak');

  // 3. analyze:sessions cycles
  const entry = await scanSessionFile(f);
  const inventory = (entry?.cycles.length ?? 0) > 0;

  // 4. bell at the shared default threshold
  const bell = new LoopDetector().feed('f', msgs, LOOP_MIN_STREAK) !== null;

  return { panel, cli, inventory, bell };
}

describe('loop threshold parity across surfaces (issue #96)', () => {
  for (const k of [2, 3, 4]) {
    it(`k=${String(k)} identical calls: all four surfaces agree`, async () => {
      const flags = await surfaceFlags(k);
      expect(Object.values(flags)).toEqual([k >= LOOP_MIN_STREAK, k >= LOOP_MIN_STREAK, k >= LOOP_MIN_STREAK, k >= LOOP_MIN_STREAK]);
    });
  }
});
