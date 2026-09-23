import { describe, expect, it } from 'vitest';

import { isPersistentHighlight } from '../../../src/renderer/hooks/useTabNavigationController';

describe('isPersistentHighlight', () => {
  it('error navigation is alarm state: highlight never auto-clears', () => {
    expect(isPersistentHighlight('error')).toBe(true);
  });

  it('search and non-target kinds keep the flash semantics', () => {
    expect(isPersistentHighlight('search')).toBe(false);
    expect(isPersistentHighlight('autoBottom')).toBe(false);
  });
});
