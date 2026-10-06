/**
 * Builds compact "where does this session live" labels from data already on
 * the Session object (projectPath / gitBranch / worktreeName) plus the
 * repository name when the sidebar runs in grouped view.
 *
 * Full values stay available for tooltips; these helpers only format.
 */

import { shortenDisplayPath } from './pathDisplay';

export interface SessionOriginInput {
  /** Full project directory (~/.claude encoded id decoded) */
  projectPath?: string;
  /** Git branch of the session's project directory */
  gitBranch?: string;
  /** Worktree display name — absent for the main worktree */
  worktreeName?: string;
  /** Repository display name (grouped sidebar view) */
  repoName?: string;
}

/** Last non-empty path segment, e.g. `/Users/x/proj` → `proj`. */
function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

const SEPARATOR = ' · ';

/**
 * One-line origin for the strip above the chat:
 * `repo · worktree · branch · ~/short/path`. Worktree defaults to `main`.
 * Returns '' when nothing is known — callers should render nothing.
 */
export function formatSessionOrigin(o: SessionOriginInput): string {
  if (!o.projectPath && !o.repoName) return '';

  const repo = o.repoName ?? basename(o.projectPath ?? '');
  const parts = [
    repo,
    o.worktreeName ?? 'main',
    o.gitBranch,
    o.projectPath ? shortenDisplayPath(o.projectPath) : undefined,
  ].filter(Boolean);
  return parts.join(SEPARATOR);
}

/**
 * Compact tag for sidebar session rows: `worktree · branch`.
 * Main-worktree sessions show just the branch. Returns null when neither
 * worktree nor branch is known — callers should render nothing.
 */
export function formatSessionOriginTag(o: SessionOriginInput): string | null {
  const tag = [o.worktreeName, o.gitBranch].filter(Boolean).join(SEPARATOR);
  return tag.length > 0 ? tag : null;
}
