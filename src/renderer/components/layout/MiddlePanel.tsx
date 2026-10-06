/**
 * MiddlePanel - Chat column: SearchBar, origin strip, ChatHistory.
 */

import React from 'react';

import { useStore } from '@renderer/store';
import { formatSessionOrigin } from '@renderer/utils/formatSessionOrigin';
import { useShallow } from 'zustand/react/shallow';

import { ChatHistory } from '../chat/ChatHistory';
import { SessionOriginStrip } from '../chat/SessionOriginStrip';
import { SearchBar } from '../search/SearchBar';

interface MiddlePanelProps {
  /** Tab ID for per-tab state isolation (scroll position, etc.) */
  tabId?: string;
}

export const MiddlePanel: React.FC<MiddlePanelProps> = ({ tabId }) => {
  const { session, repoName } = useStore(
    useShallow((s) => {
      const detail =
        (tabId ? s.tabSessionData[tabId]?.sessionDetail : undefined) ?? s.sessionDetail;
      const detailSession = detail?.session;
      const detailRepoName = detailSession
        ? s.repositoryGroups.find((g) => g.worktrees.some((w) => w.id === detailSession.projectId))
            ?.name
        : undefined;
      return { session: detailSession, repoName: detailRepoName };
    })
  );

  const origin = formatSessionOrigin({
    projectPath: session?.projectPath,
    gitBranch: session?.gitBranch,
    worktreeName: session?.worktreeName,
    repoName,
  });

  return (
    <div className="relative flex h-full flex-col">
      <SearchBar tabId={tabId} />
      <SessionOriginStrip
        origin={origin}
        title={[session?.worktreeName, session?.gitBranch, session?.projectPath]
          .filter(Boolean)
          .join(' · ')}
      />
      <ChatHistory tabId={tabId} />
    </div>
  );
};
