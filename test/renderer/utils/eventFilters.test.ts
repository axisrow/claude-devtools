/**
 * Event filter logic + hook-denial detection tests (issue #36).
 */

import { describe, expect, it } from 'vitest';

import { applyEventFilters } from '../../../src/renderer/utils/eventFilters';
import { isHookErrorTool } from '../../../src/renderer/utils/toolRendering/toolContentChecks';
import {
  makeAIGroup,
  makeConversation,
  makeSteps,
  makeSystemGroup,
  makeUserGroup,
} from '../../mocks/conversationFixtures';

import type { LinkedToolItem } from '../../../src/renderer/types/groups';

const DENIAL = {
  content: 'PreToolUse:Bash hook error: Turn input budget exhausted',
  isError: true,
};

describe('applyEventFilters', () => {
  const conversation = makeConversation([
    makeUserGroup('user-u1', 'run the deployment'),
    makeAIGroup(
      makeSteps({
        thinking: 'deployment plan',
        toolCallId: 'tu-ok',
        toolResult: { content: 'deploy ok', isError: false },
        output: 'deployment finished',
      }),
      'ai-ok'
    ),
    makeAIGroup(
      makeSteps({ toolCallId: 'tu-err', toolResult: DENIAL, output: 'hit the budget' }),
      'ai-err'
    ),
    makeSystemGroup('system-s1', 'local command stdout'),
  ]);

  it('empty selection is an identity filter (session renders exactly as before)', () => {
    const { items, counts } = applyEventFilters(conversation, []);
    expect(items.map((i) => i.group.id)).toEqual(['user-u1', 'ai-ok', 'ai-err', 'system-s1']);
    expect(counts.user).toBe(1);
    expect(counts.thinking).toBe(1);
    expect(counts.tools).toBe(2);
    expect(counts.errors).toBe(1);
    expect(counts.system).toBe(1);
    // lastOutput is not a display item — count it per AI group with text output
    expect(counts.ai).toBe(2);
  });

  it("'errors' keeps only groups with errored tools and non-zero counts", () => {
    const { items } = applyEventFilters(conversation, ['errors']);
    expect(items.map((i) => i.group.id)).toEqual(['ai-err']);
  });

  it('multi-chip selection is a union of types', () => {
    const { items } = applyEventFilters(conversation, ['user', 'system']);
    expect(items.map((i) => i.group.id)).toEqual(['user-u1', 'system-s1']);
  });
});

describe('isHookErrorTool', () => {
  /** Minimal LinkedToolItem fixture */
  function makeTool(result: LinkedToolItem['result']): LinkedToolItem {
    return {
      id: 'tu-1',
      name: 'Bash',
      input: {},
      inputPreview: '',
      startTime: new Date('2026-01-01T00:00:00Z'),
      isOrphaned: false,
      result,
    } as LinkedToolItem;
  }

  it('detects hook denial in an errored result', () => {
    expect(isHookErrorTool(makeTool(DENIAL))).toBe(true);
  });

  it('ignores non-hook errors and success results', () => {
    expect(isHookErrorTool(makeTool({ content: 'command failed: exit 1', isError: true }))).toBe(
      false
    );
    expect(isHookErrorTool(makeTool({ content: 'hook error: never mind', isError: false }))).toBe(
      false
    );
  });
});
