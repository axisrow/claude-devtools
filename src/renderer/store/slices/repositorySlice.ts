/**
 * Repository slice - manages repository grouping state (worktree support).
 */

import { api } from '@renderer/api';
import { createLogger } from '@shared/utils/logger';

import { getSessionResetState } from '../utils/stateResetHelpers';

import type { AppState } from '../types';
import type { RepositoryGroup } from '@renderer/types/data';
import type { StateCreator } from 'zustand';

const logger = createLogger('Store:repository');

// =============================================================================
// Slice Interface
// =============================================================================

export interface RepositorySlice {
  // State
  repositoryGroups: RepositoryGroup[];
  selectedRepositoryId: string | null;
  selectedWorktreeId: string | null;
  repositoryGroupsLoading: boolean;
  repositoryGroupsError: string | null;
  /** Repo-id -> total spend summed over all worktrees' sessions (best-effort) */
  repositorySpend: Record<string, number>;
  /** Repo-id -> total turns summed over all worktrees' sessions (best-effort) */
  repositoryTurns: Record<string, number>;
  /** Repo-id -> /name of the most recently updated named session (best-effort) */
  repositoryLastName: Record<string, string | undefined>;
  viewMode: 'flat' | 'grouped';

  // Actions
  fetchRepositoryGroups: () => Promise<void>;
  /** Background per-repo spend + turns aggregation (memoized main-side) */
  fetchRepositoryStats: () => void;
  selectRepository: (repositoryId: string) => void;
  selectWorktree: (worktreeId: string) => void;
  setViewMode: (mode: 'flat' | 'grouped') => void;
}

// =============================================================================
// Slice Creator
// =============================================================================

export const createRepositorySlice: StateCreator<AppState, [], [], RepositorySlice> = (
  set,
  get
) => ({
  // Initial state
  repositoryGroups: [],
  selectedRepositoryId: null,
  selectedWorktreeId: null,
  repositoryGroupsLoading: false,
  repositoryGroupsError: null,
  repositorySpend: {},
  repositoryTurns: {},
  repositoryLastName: {},
  viewMode: 'grouped', // Default to grouped view

  // Fetch all repository groups (projects grouped by git repo)
  fetchRepositoryGroups: async () => {
    set({ repositoryGroupsLoading: true, repositoryGroupsError: null });
    try {
      const groups = await api.getRepositoryGroups();
      // Already sorted by most recent session in the scanner
      set({ repositoryGroups: groups, repositoryGroupsLoading: false });
      // best-effort background aggregation — card totals appear as they land
      get().fetchRepositoryStats();
    } catch (error) {
      set({
        repositoryGroupsError:
          error instanceof Error ? error.message : 'Failed to fetch repository groups',
        repositoryGroupsLoading: false,
      });
    }
  },

  // Repo totals: sum session spend and turns over all worktrees. getSessions is
  // memoized main-side (mtime-keyed), so repeated opens are cheap.
  fetchRepositoryStats: () => {
    for (const repo of get().repositoryGroups) {
      void (async () => {
        try {
          const perWorktree = await Promise.all(
            repo.worktrees.map((worktree) => api.getSessions(worktree.id))
          );
          const sessions = perWorktree.flat();
          const total = sessions.reduce((sum, s) => sum + (s.totalTokens ?? 0), 0);
          const turns = sessions.reduce((sum, s) => sum + (s.turnCount ?? 0), 0);
          const lastNamed = sessions
            .filter((s) => s.name)
            .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
          set((state) => ({
            repositorySpend: { ...state.repositorySpend, [repo.id]: total },
            repositoryTurns: { ...state.repositoryTurns, [repo.id]: turns },
            repositoryLastName: {
              ...state.repositoryLastName,
              [repo.id]: lastNamed?.name,
            },
          }));
        } catch {
          // leave this repo's total absent — the card just omits it
        }
      })();
    }
  },

  // Select a repository group and auto-select a worktree
  selectRepository: (repositoryId: string) => {
    const { repositoryGroups } = get();
    const repo = repositoryGroups.find((r) => r.id === repositoryId);

    if (!repo) {
      logger.warn('Repository not found:', repositoryId);
      return;
    }

    // Auto-select worktree:
    // 1. Prefer the "Default" worktree (isMainWorktree = true)
    // 2. Otherwise, select the first worktree (already sorted by most recent)
    const defaultWorktree = repo.worktrees.find((w) => w.isMainWorktree);
    const worktreeToSelect = defaultWorktree ?? repo.worktrees[0];

    if (worktreeToSelect) {
      set({
        selectedRepositoryId: repositoryId,
        selectedWorktreeId: worktreeToSelect.id,
        selectedProjectId: worktreeToSelect.id,
        activeProjectId: worktreeToSelect.id,
        sidebarCollapsed: false, // Ensure session list is visible when a project is selected
        ...getSessionResetState(),
      });
      // Show ALL worktrees' sessions — the card advertised them
      void get().fetchSessionsForRepository(repo);
    } else {
      // No worktrees available (shouldn't happen normally)
      set({
        selectedRepositoryId: repositoryId,
        selectedWorktreeId: null,
        ...getSessionResetState(),
      });
    }
  },

  // Select a worktree within a repository group
  selectWorktree: (worktreeId: string) => {
    set({
      selectedWorktreeId: worktreeId,
      selectedProjectId: worktreeId,
      activeProjectId: worktreeId,
      ...getSessionResetState(),
    });

    // Fetch sessions for this worktree
    void get().fetchSessionsInitial(worktreeId);
  },

  // Toggle between flat and grouped view modes
  setViewMode: (mode: 'flat' | 'grouped') => {
    set({
      viewMode: mode,
      selectedRepositoryId: null,
      selectedWorktreeId: null,
      selectedProjectId: null,
      ...getSessionResetState(),
    });

    // Fetch the appropriate data for the new mode
    if (mode === 'grouped') {
      void get().fetchRepositoryGroups();
    } else {
      void get().fetchProjects();
    }
  },
});
