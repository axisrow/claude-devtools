/**
 * DefaultToolViewer
 *
 * Default rendering for tools that don't have specialized viewers.
 */

import React from 'react';

import {
  createSearchContext,
  EMPTY_SEARCH_MATCHES,
} from '@renderer/components/chat/searchHighlightUtils';
import { useStore } from '@renderer/store';
import { useShallow } from 'zustand/react/shallow';

import { type ItemStatus } from '../BaseItem';

import { CollapsibleOutputSection } from './CollapsibleOutputSection';
import { renderInput, renderOutput } from './renderHelpers';

import type { LinkedToolItem } from '@renderer/types/groups';

interface DefaultToolViewerProps {
  linkedTool: LinkedToolItem;
  status: ItemStatus;
  /** Display-item key for in-session search (marks + auto-expand of the output section) */
  searchItemId?: string;
}

export const DefaultToolViewer: React.FC<DefaultToolViewerProps> = ({
  linkedTool,
  status,
  searchItemId,
}) => {
  // Only re-render when THIS tool item has search matches (same pattern as MarkdownViewer)
  const { searchQuery, searchMatches, currentSearchIndex } = useStore(
    useShallow((s) => {
      const hasMatch = searchItemId ? s.searchMatchItemIds.has(searchItemId) : false;
      return {
        searchQuery: hasMatch ? s.searchQuery : '',
        searchMatches: hasMatch ? s.searchMatches : EMPTY_SEARCH_MATCHES,
        currentSearchIndex: hasMatch ? s.currentSearchIndex : -1,
      };
    })
  );
  // Search context when this tool item contains matches — highlights the output
  // text and forces the (normally collapsed) output section open so marks are visible
  const searchCtx =
    searchQuery && searchItemId
      ? createSearchContext(searchQuery, searchItemId, searchMatches, currentSearchIndex)
      : null;

  return (
    <>
      {/* Input Section */}
      <div>
        <div className="mb-1 text-xs" style={{ color: 'var(--tool-item-muted)' }}>
          Input
        </div>
        <div
          className="max-h-96 overflow-auto rounded p-3 font-mono text-xs"
          style={{
            backgroundColor: 'var(--code-bg)',
            border: '1px solid var(--code-border)',
            color: 'var(--color-text-secondary)',
          }}
        >
          {renderInput(linkedTool.name, linkedTool.input)}
        </div>
      </div>

      {/* Output — collapsed by default, auto-opened when it holds search matches */}
      {!linkedTool.isOrphaned && linkedTool.result && (
        <CollapsibleOutputSection status={status} forceExpanded={!!searchCtx}>
          {renderOutput(linkedTool.result.content, searchCtx)}
        </CollapsibleOutputSection>
      )}
    </>
  );
};
