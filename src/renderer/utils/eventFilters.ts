/**
 * Event filter logic for the chat view filter chips.
 *
 * Pure functions over SessionConversation: per-type counts for the chips and
 * item filtering. Filter semantics: empty selection = show everything;
 * non-empty = show only items of the selected types (multi-select union).
 *
 * Type mapping (display items inside AI groups):
 * - thinking → 'thinking', output → 'ai', tool → 'tools' (errored → also 'errors'),
 *   subagent/subagent_input → 'subagents', teammate_message → 'teammates',
 *   slash → 'system', compact_boundary → 'compact'
 */

import { enhanceAIGroup } from './aiGroupEnhancer';

import type { EventFilterType } from '@renderer/store/slices/tabUISlice';
import type { AIGroupDisplayItem, ChatItem, SessionConversation } from '@renderer/types/groups';

/** All chips in display order */
export const EVENT_FILTERS: readonly { type: EventFilterType; label: string }[] = [
  { type: 'user', label: 'User' },
  { type: 'ai', label: 'AI text' },
  { type: 'thinking', label: 'Thinking' },
  { type: 'tools', label: 'Tools' },
  { type: 'errors', label: 'Errors' },
  { type: 'subagents', label: 'Subagents' },
  { type: 'teammates', label: 'Teammates' },
  { type: 'system', label: 'System' },
  { type: 'compact', label: 'Compact' },
];

/** Which filter types a display item belongs to ('errors' is a subset of 'tools') */
export function displayItemFilterTypes(item: AIGroupDisplayItem): EventFilterType[] {
  switch (item.type) {
    case 'thinking':
      return ['thinking'];
    case 'output':
      return ['ai'];
    case 'tool':
      return item.tool.result?.isError ? ['tools', 'errors'] : ['tools'];
    case 'subagent':
    case 'subagent_input':
      return ['subagents'];
    case 'teammate_message':
      return ['teammates'];
    case 'slash':
      return ['system'];
    case 'compact_boundary':
      return ['compact'];
  }
}

/** Whether a display item matches the active filter selection */
export function matchesEventFilter(item: AIGroupDisplayItem, filters: EventFilterType[]): boolean {
  if (filters.length === 0) return true;
  const types = displayItemFilterTypes(item);
  return types.some((t) => filters.includes(t));
}

export interface EventFilterCounts {
  user: number;
  ai: number;
  thinking: number;
  tools: number;
  errors: number;
  subagents: number;
  teammates: number;
  system: number;
  compact: number;
}

function zeroCounts(): EventFilterCounts {
  return {
    user: 0,
    ai: 0,
    thinking: 0,
    tools: 0,
    errors: 0,
    subagents: 0,
    teammates: 0,
    system: 0,
    compact: 0,
  };
}

/** Stable zeroed counts for loading/empty states */
export const EMPTY_EVENT_FILTER_COUNTS: EventFilterCounts = zeroCounts();

export interface AppliedEventFilters {
  /** Filtered top-level items; AI groups kept only when they have visible content */
  items: ChatItem[];
  /** Per-type counts over the FULL conversation (stable regardless of selection) */
  counts: EventFilterCounts;
}

/**
 * Apply event filter chips to a conversation and compute chip counts in one pass.
 * ponytail: enhances every AI group (same work AIChatGroup does per render) —
 * memoize at the call site; cache enhanced groups if filter toggling lags.
 */
export function applyEventFilters(
  conversation: SessionConversation,
  filters: EventFilterType[]
): AppliedEventFilters {
  const counts = zeroCounts();
  const items: ChatItem[] = [];

  for (const item of conversation.items) {
    if (item.type === 'ai') {
      const enhanced = enhanceAIGroup(item.group);
      for (const displayItem of enhanced.displayItems) {
        for (const t of displayItemFilterTypes(displayItem)) counts[t]++;
      }
      // lastOutput is skipped by buildDisplayItems, so count it here — a plain
      // Q&A turn otherwise yields counts.ai = 0 and a disabled chip
      if (enhanced.lastOutput?.type === 'text' && enhanced.lastOutput.text) counts.ai++;
      if (filters.length === 0) {
        items.push(item);
        continue;
      }
      const hasVisibleItems = enhanced.displayItems.some((d) => matchesEventFilter(d, filters));
      // LastOutput is an 'ai' surface: visible under the AI-text chip when it is text
      const hasVisibleLastOutput =
        filters.includes('ai') &&
        enhanced.lastOutput?.type === 'text' &&
        !!enhanced.lastOutput.text;
      if (hasVisibleItems || hasVisibleLastOutput) {
        items.push(item);
      }
    } else if (item.type === 'user') {
      counts.user++;
      if (filters.length === 0 || filters.includes('user')) items.push(item);
    } else if (item.type === 'system') {
      counts.system++;
      if (filters.length === 0 || filters.includes('system')) items.push(item);
    } else {
      counts.compact++;
      if (filters.length === 0 || filters.includes('compact')) items.push(item);
    }
  }

  return { items, counts };
}
