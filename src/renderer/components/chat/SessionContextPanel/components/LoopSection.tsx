/**
 * LoopSection - Section for displaying repeat-call (loop) injections.
 */

import React from 'react';

import { CollapsibleSection } from './CollapsibleSection';

import type { LoopInjection } from '@renderer/types/contextInjection';

interface LoopSectionProps {
  injections: LoopInjection[];
  tokenCount: number;
  isExpanded: boolean;
  onToggle: () => void;
  onNavigateToTool?: (turnIndex: number, toolUseId: string) => void;
  onNavigateToTurn?: (turnIndex: number, opts?: { flashHeader?: boolean }) => void;
}

export const LoopSection = ({
  injections,
  tokenCount,
  isExpanded,
  onToggle,
  onNavigateToTool,
  onNavigateToTurn,
}: Readonly<LoopSectionProps>): React.ReactElement | null => {
  if (injections.length === 0) return null;

  return (
    <CollapsibleSection
      title="Loop"
      count={injections.length}
      tokenCount={tokenCount}
      isExpanded={isExpanded}
      onToggle={onToggle}
    >
      {injections.map((injection) =>
        injection.breakdown.map((item) => (
          <button
            key={`${injection.id}-${item.key}`}
            type="button"
            onClick={() => {
              if (item.toolUseId && onNavigateToTool) {
                onNavigateToTool(injection.turnIndex, item.toolUseId);
              } else if (onNavigateToTurn) {
                onNavigateToTurn(injection.turnIndex, { flashHeader: true });
              }
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-white/5"
          >
            <span
              className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium"
              style={{ backgroundColor: 'rgba(239, 68, 68, 0.15)', color: '#f87171' }}
            >
              Loop
            </span>
            <span className="min-w-0 flex-1 truncate text-xs" style={{ color: '#f87171' }}>
              {item.key} ×{item.count}
            </span>
            <span
              className="shrink-0 text-xs font-medium tabular-nums"
              style={{ color: '#a1a1aa' }}
            >
              {item.tokenCount.toLocaleString()} tok
            </span>
          </button>
        ))
      )}
    </CollapsibleSection>
  );
};
