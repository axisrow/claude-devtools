/**
 * LoopSection - Section for displaying repeat-call (loop) injections.
 * Each key row expands into the rounds that carried the repeats.
 */

import React, { Fragment, useState } from 'react';

import { ChevronDown, ChevronRight } from 'lucide-react';

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
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  const toggleKey = (key: string): void => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

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
        injection.breakdown.map((item) => {
          const expandKey = `${injection.id}-${item.key}`;
          const isOpen = expandedKeys.has(expandKey);
          const keyRounds = injection.rounds.filter((round) => round.keys.includes(item.key));
          return (
            <Fragment key={`${injection.id}-${item.key}`}>
              <div className="flex w-full items-center gap-2 rounded px-2 py-1.5 transition-colors hover:bg-white/5">
                <button
                  type="button"
                  aria-label={isOpen ? 'Collapse rounds' : 'Expand rounds'}
                  className="shrink-0 cursor-pointer"
                  onClick={() => toggleKey(expandKey)}
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
                    if (item.toolUseId && onNavigateToTool) {
                      onNavigateToTool(injection.turnIndex, item.toolUseId);
                    } else if (onNavigateToTurn) {
                      onNavigateToTurn(injection.turnIndex, { flashHeader: true });
                    }
                  }}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
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
              </div>
              {isOpen &&
                keyRounds.map((round) => (
                  <div
                    key={`${expandKey}-${round.uuid}`}
                    className="flex items-center gap-2 py-0.5 pl-8 pr-2 text-[11px] tabular-nums"
                    style={{ color: '#a1a1aa' }}
                  >
                    <span style={{ color: '#f87171' }}>R{round.index}</span>
                    <span className="flex-1">repeat</span>
                    <span className="w-24 text-right">{round.billed.toLocaleString()} tok</span>
                  </div>
                ))}
            </Fragment>
          );
        })
      )}
    </CollapsibleSection>
  );
};
