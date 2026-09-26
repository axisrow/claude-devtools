/**
 * EventFilterBar - filter chips for the chat view (issue #36).
 * One chip per event type with its count; toggles per-tab (tabUISlice).
 * Empty selection = no filtering.
 */

import { COLOR_TEXT_MUTED, COLOR_TEXT_SECONDARY } from '@renderer/constants/cssVariables';
import { useTabUI } from '@renderer/hooks/useTabUI';
import { EVENT_FILTERS } from '@renderer/utils/eventFilters';
import { X } from 'lucide-react';

import type { EventFilterCounts } from '@renderer/utils/eventFilters';

interface EventFilterBarProps {
  counts: EventFilterCounts;
}

export const EventFilterBar = ({ counts }: EventFilterBarProps): React.JSX.Element => {
  const { eventFilters, toggleEventFilter } = useTabUI();

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 px-4 py-1.5"
      style={{
        backgroundColor: 'var(--color-surface)',
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      <span
        className="mr-1 text-[10px] uppercase tracking-wide"
        style={{ color: COLOR_TEXT_MUTED }}
      >
        Filter
      </span>
      {EVENT_FILTERS.map(({ type, label }) => {
        const count = counts[type];
        const isActive = eventFilters.includes(type);
        return (
          <button
            key={type}
            type="button"
            disabled={count === 0 && !isActive}
            onClick={() => toggleEventFilter(type)}
            title={`${label} (${count})`}
            className="rounded-full px-2 py-0.5 text-[11px] transition-colors disabled:cursor-default disabled:opacity-35"
            style={{
              // Invert tag tokens for the active chip — no -active variables exist
              backgroundColor: isActive ? 'var(--tag-text)' : 'var(--tag-bg)',
              color: isActive ? 'var(--tag-bg)' : COLOR_TEXT_SECONDARY,
              border: `1px solid ${isActive ? 'var(--tag-text)' : 'var(--tag-border)'}`,
            }}
          >
            {label}
            <span className="ml-1 tabular-nums" style={{ color: COLOR_TEXT_MUTED }}>
              {count}
            </span>
            {isActive && <X className="ml-0.5 inline size-2.5" />}
          </button>
        );
      })}
    </div>
  );
};
