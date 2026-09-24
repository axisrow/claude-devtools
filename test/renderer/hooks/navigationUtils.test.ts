/**
 * Tests for navigation/utils.ts — specifically findAIGroupBySubagentId.
 */

import { describe, expect, it } from 'vitest';

import { findAIGroupBySubagentId, isGroupHeaderAlarm } from '@renderer/hooks/navigation/utils';

import type { ChatItem } from '@renderer/types/groups';
import type { TriggerColor } from '@shared/constants/triggerColors';
import type { Process } from '@main/types';

/** Minimal AI chat item factory for testing. */
function makeAIChatItem(groupId: string, processes: Partial<Process>[] = []): ChatItem {
  return {
    type: 'ai',
    group: {
      id: groupId,
      startTime: new Date(0),
      endTime: new Date(1000),
      processes: processes.map((p) => ({
        id: p.id ?? 'unknown',
        filePath: p.filePath ?? '',
        messages: [],
        startTime: new Date(0),
        endTime: new Date(1000),
        ...p,
      })) as Process[],
    },
  } as ChatItem;
}

describe('findAIGroupBySubagentId', () => {
  it('returns null for empty items', () => {
    expect(findAIGroupBySubagentId([], 'agent-123')).toBeNull();
  });

  it('returns null when no AI group contains the subagent', () => {
    const items: ChatItem[] = [
      makeAIChatItem('ai-1', [{ id: 'agent-aaa' }]),
      makeAIChatItem('ai-2', [{ id: 'agent-bbb' }]),
    ];
    expect(findAIGroupBySubagentId(items, 'agent-ccc')).toBeNull();
  });

  it('finds the AI group containing the subagent', () => {
    const items: ChatItem[] = [
      makeAIChatItem('ai-1', [{ id: 'agent-aaa' }]),
      makeAIChatItem('ai-2', [{ id: 'agent-bbb' }, { id: 'agent-ccc' }]),
    ];
    expect(findAIGroupBySubagentId(items, 'agent-ccc')).toBe('ai-2');
  });

  it('returns first match when subagent appears in multiple groups', () => {
    const items: ChatItem[] = [
      makeAIChatItem('ai-1', [{ id: 'agent-same' }]),
      makeAIChatItem('ai-2', [{ id: 'agent-same' }]),
    ];
    expect(findAIGroupBySubagentId(items, 'agent-same')).toBe('ai-1');
  });

  it('skips non-AI items', () => {
    const items: ChatItem[] = [
      { type: 'user', group: { id: 'user-1' } } as ChatItem,
      makeAIChatItem('ai-1', [{ id: 'agent-target' }]),
    ];
    expect(findAIGroupBySubagentId(items, 'agent-target')).toBe('ai-1');
  });
});

describe('isGroupHeaderAlarm', () => {
  const base = {
    highlightedGroupId: 'ai-1' as string | null,
    highlightColor: 'red' as TriggerColor | null,
    highlightToolUseId: null as string | null,
  };

  it('red group-level error navigation lights the turn header — loop deep-links', () => {
    expect(isGroupHeaderAlarm('ai-1', base)).toBe(true);
  });

  it('a tool-targeted navigation keeps the alarm on the tool card, not the header', () => {
    expect(isGroupHeaderAlarm('ai-1', { ...base, highlightToolUseId: 'toolu-9' })).toBe(false);
  });

  it('non-red highlights are not header alarms', () => {
    expect(isGroupHeaderAlarm('ai-1', { ...base, highlightColor: 'blue' })).toBe(false);
  });

  it('other groups and cleared navigation are not header alarms', () => {
    expect(isGroupHeaderAlarm('ai-2', base)).toBe(false);
    expect(isGroupHeaderAlarm('ai-1', { ...base, highlightedGroupId: null })).toBe(false);
  });
});
