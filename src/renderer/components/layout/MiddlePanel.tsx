/**
 * MiddlePanel - Chat column: SearchBar, origin strip, ChatHistory.
 */

import React from 'react';

import { useStore } from '@renderer/store';
import {
  formatSessionOrigin,
  formatSessionOriginTooltip,
  resolveSessionOriginGroups,
} from '@renderer/utils/formatSessionOrigin';
import { useShallow } from 'zustand/react/shallow';

import { ChatHistory } from '../chat/ChatHistory';
import { SessionOriginStrip } from '../chat/SessionOriginStrip';
import { SearchBar } from '../search/SearchBar';

interface MiddlePanelProps {
  /** Tab ID for per-tab state isolation (scroll position, etc.) */
  tabId?: string;
}

export const MiddlePanel: React.FC<MiddlePanelProps> = ({ tabId }) => {
  const { session, repoName, worktreeName } = useStore(
    useShallow((s) => {
      const detail =
        (tabId ? s.tabSessionData[tabId]?.sessionDetail : undefined) ?? s.sessionDetail;
      const detailSession = detail?.session;
      // detail.session carries no worktreeName (only sidebar list rows are
      // tagged) — resolve repo/worktree from the same groups the sidebar uses
      const resolved = detailSession
        ? resolveSessionOriginGroups(s.repositoryGroups, detailSession.projectId)
        : {};
      return {
        session: detailSession,
        repoName: resolved.repoName,
        worktreeName: resolved.worktreeName,
      };
    })
  );

  const originInput = {
    projectPath: session?.projectPath,
    gitBranch: session?.gitBranch,
    worktreeName,
    repoName,
  };

  return (
    <div className="relative flex h-full flex-col">
      <SearchBar tabId={tabId} />
      <SessionOriginStrip
        origin={formatSessionOrigin(originInput)}
        title={formatSessionOriginTooltip(originInput)}
      />
      <ChatHistory tabId={tabId} />
    </div>
  );
};
