/**
 * RereadSection - Section for per-turn re-read spend injections: the
 * input-side billed context of all requests in a turn — the same number the
 * turn-budget hook enforces and the chat's Re-read pill shows.
 */

import React from 'react';

import { CollapsibleSection } from './CollapsibleSection';

import type { RereadInjection } from '@renderer/types/contextInjection';

interface RereadSectionProps {
  injections: RereadInjection[];
  tokenCount: number;
  isExpanded: boolean;
  onToggle: () => void;
  onNavigateToTurn?: (groupId: string, opts?: { flashHeader?: boolean }) => void;
}

export const RereadSection = ({
  injections,
  tokenCount,
  isExpanded,
  onToggle,
  onNavigateToTurn,
}: Readonly<RereadSectionProps>): React.ReactElement | null => {
  if (injections.length === 0) return null;

  return (
    <CollapsibleSection
      title="Re-read"
      count={injections.length}
      tokenCount={tokenCount}
      isExpanded={isExpanded}
      onToggle={onToggle}
    >
      {injections.map((injection) => (
        <button
          key={injection.id}
          type="button"
          onClick={() => {
            if (onNavigateToTurn) {
              onNavigateToTurn(injection.aiGroupId, { flashHeader: true });
            }
          }}
          className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-white/5"
        >
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium"
            style={{ backgroundColor: 'rgba(239, 68, 68, 0.15)', color: '#f87171' }}
          >
            Re-read
          </span>
          <span className="min-w-0 flex-1 truncate text-xs" style={{ color: '#f87171' }}>
            Turn {injection.turnIndex + 1}
          </span>
          <span className="shrink-0 text-xs tabular-nums" style={{ color: '#a1a1aa' }}>
            {injection.requests} rq
          </span>
          <span className="shrink-0 text-xs font-medium tabular-nums" style={{ color: '#a1a1aa' }}>
            {injection.estimatedTokens.toLocaleString()} tok
          </span>
        </button>
      ))}
    </CollapsibleSection>
  );
};
