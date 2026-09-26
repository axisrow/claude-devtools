/**
 * Conversation slice unit tests — full-corpus in-session search (issue #36).
 */

import { describe, expect, it } from 'vitest';
import { create } from 'zustand';

import { createConversationSlice } from '../../../src/renderer/store/slices/conversationSlice';
import {
  makeAIGroup,
  makeConversation,
  makeSteps,
  makeSystemGroup,
  makeUserGroup,
} from '../../mocks/conversationFixtures';

import type { AppState } from '../../../src/renderer/store/types';

/** Minimal store exposing only the conversation slice */
function makeStore(): AppState {
  return create<AppState>()((...args) => ({
    ...createConversationSlice(...args),
  }));
}

/** ai-item SearchMatch factory */
function match(id: string, key: string) {
  return {
    itemId: id,
    itemType: 'ai' as const,
    matchIndexInItem: 0,
    globalIndex: 0,
    displayItemId: key,
  };
}

describe('conversationSlice performSearch (full corpus, issue #36)', () => {
  it('finds "hook error" in tool results (today: 0 matches)', () => {
    const store = makeStore();
    const conversation = makeConversation([
      makeAIGroup(
        makeSteps({
          thinking: 'internal plan',
          toolCallId: 'tu-1',
          toolResult: {
            content: 'PreToolUse:Bash hook error: Turn input budget exhausted',
            isError: true,
          },
          output: 'final answer text',
        }),
        'ai-g1'
      ),
    ]);

    store.getState().setSearchQuery('hook error', conversation);

    const s = store.getState();
    expect(s.searchResultCount).toBe(1);
    const match = s.searchMatches[0];
    // Addressed by owning group + display-item key (tool-<id>-<index>)
    expect(match.itemId).toBe('ai-g1');
    expect(match.displayItemId).toBe('tool-tu-1-1');
  });

  it('finds matches in thinking, user text, and system output', () => {
    const store = makeStore();
    const conversation = makeConversation([
      makeUserGroup('user-u1', 'please debug the budget'),
      makeAIGroup(makeSteps({ thinking: 'the turn budget is tight', output: 'done' }), 'ai-g1'),
      makeSystemGroup('system-s1', 'local command stdout: budget report'),
    ]);

    store.getState().setSearchQuery('budget', conversation);
    const s = store.getState();
    // 1 user + 1 thinking + 1 system
    expect(s.searchResultCount).toBe(3);
    const itemTypes = s.searchMatches.map((m) => m.itemType).sort();
    expect(itemTypes).toEqual(['system', 'user', 'ai'].sort());
    const thinkingMatch = s.searchMatches.find((m) => m.itemType === 'ai');
    expect(thinkingMatch?.displayItemId).toBe('thinking-0');
  });

  it('does not wipe store matches when rendered marks are a partial snapshot', () => {
    const store = makeStore();
    store.getState().setSearchQuery('hook error', null);
    store.setState({
      searchQuery: 'hook error',
      searchMatches: [match('ai-g1', 'tool-tu-1-1'), match('ai-g2', 'tool-tu-2-0')],
      searchResultCount: 2,
    });

    // Only 1 of 2 matches rendered as a <mark> — keep the store-level list
    store.getState().syncSearchMatchesWithRendered([{ itemId: 'ai-g1', matchIndexInItem: 0 }]);

    expect(store.getState().searchResultCount).toBe(2);
  });

  it('navigation to a display-item match auto-expands the owning AI group', () => {
    const store = makeStore();
    store.setState({
      searchQuery: 'hook error',
      searchMatches: [match('ai-g1', 'tool-tu-1-1')],
      searchResultCount: 1,
      currentSearchIndex: 0,
    });

    store.getState().nextSearchResult();

    const s = store.getState();
    expect(s.searchExpandedAIGroupIds.has('ai-g1')).toBe(true);
    expect(s.searchCurrentDisplayItemId).toBe('tool-tu-1-1');
  });
});
