import { describe, expect, it } from 'vitest';

import { formatSessionOrigin, formatSessionOriginTag } from '@renderer/utils/formatSessionOrigin';

describe('formatSessionOrigin', () => {
  it('renders repo · worktree · branch · shortened path for a main-worktree session', () => {
    expect(formatSessionOrigin({ projectPath: '/Users/test/project', gitBranch: 'main' })).toBe(
      'project · main · main · ~/project'
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
    expect(out.startsWith('x · main · ~/w/…')).toBe(true);
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
