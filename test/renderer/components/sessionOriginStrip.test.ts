/**
 * SessionOriginStrip renders the session origin line above the chat and
 * hides itself entirely when the origin is unknown.
 */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { SessionOriginStrip } from '../../../src/renderer/components/chat/SessionOriginStrip';

async function mount(ui: React.ReactElement): Promise<{ host: HTMLElement; unmount: () => void }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(ui);
    await Promise.resolve();
  });
  return {
    host,
    unmount: () => {
      act(() => {
        root.unmount();
      });
    },
  };
}

describe('SessionOriginStrip', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders nothing for an empty origin', async () => {
    const { host, unmount } = await mount(React.createElement(SessionOriginStrip, { origin: '' }));
    expect(host.textContent).toBe('');
    unmount();
  });

  it('renders the origin text with a tooltip', async () => {
    const { host, unmount } = await mount(
      React.createElement(SessionOriginStrip, {
        origin: 'repo · wt · main · ~/p',
        title: '/full/path',
      })
    );
    const el = host.querySelector('div');
    expect(el?.textContent).toBe('repo · wt · main · ~/p');
    expect(el?.getAttribute('title')).toBe('/full/path');
    unmount();
  });
});
