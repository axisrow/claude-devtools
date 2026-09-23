/**
 * WaitLoopSection - Section for displaying quiet-round wait-loop injections.
 */

import React from 'react';

import { CollapsibleSection } from './CollapsibleSection';

import type { WaitLoopInjection } from '@renderer/types/contextInjection';

interface WaitLoopSectionProps {
  injections: WaitLoopInjection[];
  tokenCount: number;
  isExpanded: boolean;
  onToggle: () => void;
  onNavigateToTurn?: (turnIndex: number) => void;
}

export const WaitLoopSection = ({
  injections,
  tokenCount,
  isExpanded,
  onToggle,
  onNavigateToTurn,
}: Readonly<WaitLoopSectionProps>): React.ReactElement | null => {
  if (injections.length === 0) return null;

  return (
    <CollapsibleSection
      title="Wait-loop"
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
              onNavigateToTurn(injection.turnIndex);
            }
          }}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-white/5"
        >
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium"
            style={{ backgroundColor: 'rgba(239, 68, 68, 0.15)', color: '#f87171' }}
          >
            Wait
          </span>
          <span className="min-w-0 flex-1 truncate text-xs" style={{ color: '#f87171' }}>
            Turn {injection.turnIndex + 1} · {injection.roundCount} quiet rounds
          </span>
          <span className="shrink-0 text-xs font-medium tabular-nums" style={{ color: '#a1a1aa' }}>
            {injection.estimatedTokens.toLocaleString()} tok
          </span>
        </button>
      ))}
    </CollapsibleSection>
  );
};
