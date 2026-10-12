/**
 * Skill completeness (#92) — every FindingType and every documented CLI flag
 * must be mentioned in the plugin's SKILL.md files, so the skills cannot lag
 * behind the CLI again. The Record guard fails `pnpm typecheck` when a new
 * FindingType is added without a key here.
 */
import { readFileSync } from 'fs';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import type { FindingType } from '../../../src/cli/analyzeSession';

// vitest runs with cwd at the package root (same convention as corpus.test.ts)
const REPO_ROOT = process.cwd();
const AUDIT_SKILL = path.resolve(REPO_ROOT, 'skills/audit-session/SKILL.md');
const INVENTORY_SKILL = path.resolve(REPO_ROOT, 'skills/sessions-inventory/SKILL.md');

// exhaustiveness guard: a FindingType member missing from this record breaks the build
const ALL_FINDING_TYPES: Record<FindingType, true> = {
  duplicate_call: true,
  failed_call: true,
  oversized_output: true,
  context_spike: true,
  cache_dead: true,
  thinking_heavy: true,
  long_turn: true,
  loop_streak: true,
  stall_streak: true,
  wait_loop: true,
  cycle_motif: true,
  probe_no_progress: true,
};

describe('skill docs stay in sync with the CLI (#92)', () => {
  const auditSkill = readFileSync(AUDIT_SKILL, 'utf8');
  const inventorySkill = readFileSync(INVENTORY_SKILL, 'utf8');

  it('mentions every FindingType in audit-session/SKILL.md', () => {
    for (const type of Object.keys(ALL_FINDING_TYPES)) {
      expect(auditSkill, `audit-session/SKILL.md is missing finding type "${type}"`).toContain(
        type
      );
    }
  });

  it('documents the --turn deep-dive flag', () => {
    expect(auditSkill).toContain('--turn');
  });

  it('documents the inventory turn/streak filters', () => {
    expect(inventorySkill).toContain('--min-turn-minutes');
    expect(inventorySkill).toContain('--min-streak');
  });
});
