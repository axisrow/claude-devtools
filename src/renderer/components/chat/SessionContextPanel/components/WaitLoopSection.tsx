/**
 * WaitLoopSection - Section for displaying quiet-round wait-loop injections.
 * Each entry expands into its quiet rounds (time-less: round number, output,
 * billed usage).
 */

import React, { Fragment, useState } from 'react';

import { ChevronDown, ChevronRight } from 'lucide-react';

import { CollapsibleSection } from './CollapsibleSection';

import type { WaitLoopInjection } from '@renderer/types/contextInjection';

interface WaitLoopSectionProps {
  injections: WaitLoopInjection[];
  tokenCount: number;
  isExpanded: boolean;
  onToggle: () => void;
  onNavigateToTurn?: (turnIndex: number, opts?: { flashHeader?: boolean }) => void;
}

export const WaitLoopSection = ({
  injections,
  tokenCount,
  isExpanded,
  onToggle,
  onNavigateToTurn,
}: Readonly<WaitLoopSectionProps>): React.ReactElement | null => {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  if (injections.length === 0) return null;

  return (
    <CollapsibleSection
      title="Wait-loop"
      count={injections.length}
      tokenCount={tokenCount}
      isExpanded={isExpanded}
      onToggle={onToggle}
    >
      {injections.map((injection) => {
        const isOpen = expandedIds.has(injection.id);
        return (
          <Fragment key={injection.id}>
            <div className="flex w-full items-center gap-2 rounded px-2 py-1.5 transition-colors hover:bg-white/5">
              <button
                type="button"
                aria-label={isOpen ? 'Collapse rounds' : 'Expand rounds'}
                className="shrink-0 cursor-pointer"
                onClick={() => toggleExpanded(injection.id)}
              >
                {isOpen ? (
                  <ChevronDown className="size-3 text-text-muted" />
                ) : (
                  <ChevronRight className="size-3 text-text-muted" />
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (onNavigateToTurn) {
                    onNavigateToTurn(injection.turnIndex, { flashHeader: true });
                  }
                }}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
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
                <span
                  className="shrink-0 text-xs font-medium tabular-nums"
                  style={{ color: '#a1a1aa' }}
                >
                  {injection.estimatedTokens.toLocaleString()} tok
                </span>
              </button>
            </div>
            {isOpen &&
              injection.rounds.map((round) => (
                <div
                  key={`${injection.id}-${round.uuid}`}
                  className="flex items-center gap-2 py-0.5 pl-8 pr-2 text-[11px] tabular-nums"
                  style={{ color: '#a1a1aa' }}
                >
                  <span style={{ color: '#f87171' }}>R{round.index}</span>
                  <span className="flex-1">quiet</span>
                  <span>out {round.outputTokens.toLocaleString()}</span>
                  <span className="w-24 text-right">{round.billed.toLocaleString()} tok</span>
                </div>
              ))}
          </Fragment>
        );
      })}
    </CollapsibleSection>
  );
};
