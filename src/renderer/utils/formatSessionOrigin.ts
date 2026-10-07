/**
 * Builds compact "where does this session live" labels from data already on
 * the Session object (projectPath / gitBranch / worktreeName) plus the
 * repository name when the sidebar runs in grouped view.
 *
 * Full values stay available for tooltips; these helpers only format.
 */

import { shortenDisplayPath } from './pathDisplay';
import { getBaseName } from './pathUtils';

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

const SEPARATOR = ' · ';

/**
 * One-line origin for the strip above the chat:
 * `repo · worktree · branch · ~/short/path`. The worktree segment renders
 * only when explicitly known — a synthetic "main" would assert the main
 * worktree for sessions whose origin cannot be resolved (flat sidebar mode)
 * and duplicate the branch for main-worktree sessions on branch "main".
 * Returns '' when nothing is known — callers should render nothing.
 */
export function formatSessionOrigin(o: SessionOriginInput): string {
  if (!o.projectPath && !o.repoName) return '';

  const repo = o.repoName ?? getBaseName(o.projectPath ?? '');
  const parts = [
    repo,
    o.worktreeName,
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

/**
 * Full origin parts for tooltips — same parts the tags show, unshortened.
 * Empty/unknown parts are skipped, so callers can pass everything they have.
 */
export function formatSessionOriginTooltip(o: SessionOriginInput): string | undefined {
  const tooltip = [o.worktreeName, o.gitBranch, o.projectPath]
    .filter((part): part is string => Boolean(part))
    .join(SEPARATOR);
  return tooltip.length > 0 ? tooltip : undefined;
}

/** Worktree row of the grouped sidebar view, narrowed to what origin needs. */
export interface WorktreeGroupRef {
  name: string;
  worktrees: { id: string; name: string; isMainWorktree?: boolean }[];
}

/**
 * Derives repoName and worktreeName from the repository groups by the
 * session's projectId. SessionDetail.session carries no worktreeName (it is
 * only tagged onto sidebar list rows), so the strip must resolve it from the
 * same groups the sidebar uses — main worktree stays unnamed, like the tags.
 */
export function resolveSessionOriginGroups(
  groups: WorktreeGroupRef[],
  projectId: string
): { repoName?: string; worktreeName?: string } {
  for (const group of groups) {
    const worktree = group.worktrees.find((w) => w.id === projectId);
    if (worktree) {
      return {
        repoName: group.name,
        worktreeName: worktree.isMainWorktree ? undefined : worktree.name,
      };
    }
  }
  return {};
}
