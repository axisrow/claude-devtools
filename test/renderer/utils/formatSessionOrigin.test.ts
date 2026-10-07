import { describe, expect, it } from 'vitest';

import {
  formatSessionOrigin,
  formatSessionOriginTag,
  formatSessionOriginTooltip,
  resolveSessionOriginGroups,
} from '@renderer/utils/formatSessionOrigin';

describe('formatSessionOrigin', () => {
  it('renders repo · branch · shortened path for a main-worktree session', () => {
    expect(formatSessionOrigin({ projectPath: '/Users/test/project', gitBranch: 'main' })).toBe(
      'project · main · ~/project'
    );
  });

  it('uses repoName when provided and keeps the full-length path as-is when short enough', () => {
    expect(
      formatSessionOrigin({
        repoName: 'agent-orchestrator',
        projectPath: '/Users/axisrow/.conductor/workspaces/agent-orchestrator-76',
        worktreeName: 'agent-orchestrator-76',
        gitBranch: 'feature/x',
      })
    ).toBe(
      'agent-orchestrator · agent-orchestrator-76 · feature/x · ~/.conductor/workspaces/agent-orchestrator-76'
    );
  });

  it('middle-truncates long paths', () => {
    const out = formatSessionOrigin({
      projectPath: '/Users/test/w/very-long-repo/deep/nested/directory/x',
    });
    expect(out).toContain('…');
    expect(out.startsWith('x · ~/w/…')).toBe(true);
  });

  it('returns an empty string when nothing is known', () => {
    expect(formatSessionOrigin({})).toBe('');
    expect(formatSessionOrigin({ gitBranch: 'main' })).toBe('');
  });
});

describe('formatSessionOriginTag', () => {
  it('joins worktree and branch', () => {
    expect(formatSessionOriginTag({ worktreeName: 'wt-a', gitBranch: 'feat' })).toBe('wt-a · feat');
  });

  it('falls back to whichever part exists', () => {
    expect(formatSessionOriginTag({ gitBranch: 'main' })).toBe('main');
    expect(formatSessionOriginTag({ worktreeName: 'wt-a' })).toBe('wt-a');
  });

  it('returns null when there is nothing to show', () => {
    expect(formatSessionOriginTag({})).toBeNull();
  });
});

describe('formatSessionOriginTooltip', () => {
  it('joins all known parts unshortened', () => {
    expect(
      formatSessionOriginTooltip({
        worktreeName: 'wt-a',
        gitBranch: 'feat',
        projectPath: '/Users/x/repo',
      })
    ).toBe('wt-a · feat · /Users/x/repo');
  });

  it('skips unknown parts and returns undefined when empty', () => {
    expect(formatSessionOriginTooltip({ gitBranch: 'main' })).toBe('main');
    expect(formatSessionOriginTooltip({})).toBeUndefined();
  });
});

describe('resolveSessionOriginGroups', () => {
  const groups = [
    {
      name: 'agent-orchestrator',
      worktrees: [
        { id: 'wt-main', name: 'main', isMainWorktree: true },
        { id: 'wt-76', name: 'agent-orchestrator-76' },
      ],
    },
    { name: 'other-repo', worktrees: [{ id: 'wt-other', name: 'main', isMainWorktree: true }] },
  ];

  it('leaves the main worktree unnamed — same rule as the sidebar tags', () => {
    expect(resolveSessionOriginGroups(groups, 'wt-main')).toEqual({
      repoName: 'agent-orchestrator',
      worktreeName: undefined,
    });
  });

  it('resolves a non-main worktree name for the detail path', () => {
    expect(resolveSessionOriginGroups(groups, 'wt-76')).toEqual({
      repoName: 'agent-orchestrator',
      worktreeName: 'agent-orchestrator-76',
    });
  });

  it('returns empty for an unknown project', () => {
    expect(resolveSessionOriginGroups(groups, 'nope')).toEqual({});
  });
});
