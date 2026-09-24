/**
 * Burn-category navigation from the Visible Context panel must target the
 * turn header — where the aggregate burn pills ("Wait 4.3M · 58 rd") live —
 * not an individual item in the middle of a long turn.
 */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { LoopSection } from '../../../src/renderer/components/chat/SessionContextPanel/components/LoopSection';
import { WaitLoopSection } from '../../../src/renderer/components/chat/SessionContextPanel/components/WaitLoopSection';

import type { LoopInjection, WaitLoopInjection } from '@renderer/types/contextInjection';

const waitInjection = {
  id: 'wait-loop-ai-0',
  category: 'wait-loop',
  turnIndex: 0,
  aiGroupId: 'ai-0',
  estimatedTokens: 4_284_616,
  roundCount: 58,
} as WaitLoopInjection;

const loopInjection = {
  id: 'loop-ai-0',
  category: 'loop',
  turnIndex: 0,
  aiGroupId: 'ai-0',
  estimatedTokens: 2300,
  breakdown: [{ key: 'Edit|/Users/x/prompt_test.go', count: 3, tokenCount: 938 }],
} as LoopInjection;

const loopInjectionWithTool: LoopInjection = {
  ...loopInjection,
  breakdown: [
    { key: 'Edit|/Users/x/prompt_test.go', count: 3, tokenCount: 938, toolUseId: 'toolu-1' },
  ],
};

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

function clickEntryByTitle(host: HTMLElement, title: string): void {
  const button = Array.from(host.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(title)
  );
  if (!button) throw new Error(`entry button not found: ${title}`);
  act(() => {
    button.click();
  });
}

describe('burn navigation targets the aggregate', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('Wait-loop entry requests turn navigation with header flash', async () => {
    const onNavigateToTurn = vi.fn();
    const { host, unmount } = await mount(
      React.createElement(WaitLoopSection, {
        injections: [waitInjection],
        tokenCount: 4_284_616,
        isExpanded: true,
        onToggle: () => undefined,
        onNavigateToTurn,
      })
    );

    clickEntryByTitle(host, 'Turn 1');

    expect(onNavigateToTurn).toHaveBeenCalledWith(0, { flashHeader: true });
    unmount();
  });

  it('Loop entry without toolUseId requests turn navigation with header flash', async () => {
    const onNavigateToTurn = vi.fn();
    const onNavigateToTool = vi.fn();
    const { host, unmount } = await mount(
      React.createElement(LoopSection, {
        injections: [loopInjection],
        tokenCount: 2300,
        isExpanded: true,
        onToggle: () => undefined,
        onNavigateToTool,
        onNavigateToTurn,
      })
    );

    clickEntryByTitle(host, 'Edit|/Users/x/prompt_test.go');

    expect(onNavigateToTurn).toHaveBeenCalledWith(0, { flashHeader: true });
    expect(onNavigateToTool).not.toHaveBeenCalled();
    unmount();
  });

  it('Loop entry with toolUseId still deep-links the specific call', async () => {
    const onNavigateToTurn = vi.fn();
    const onNavigateToTool = vi.fn();
    const { host, unmount } = await mount(
      React.createElement(LoopSection, {
        injections: [loopInjectionWithTool],
        tokenCount: 2300,
        isExpanded: true,
        onToggle: () => undefined,
        onNavigateToTool,
        onNavigateToTurn,
      })
    );

    clickEntryByTitle(host, 'Edit|/Users/x/prompt_test.go');

    expect(onNavigateToTool).toHaveBeenCalledWith(0, 'toolu-1');
    expect(onNavigateToTurn).not.toHaveBeenCalled();
    unmount();
  });
});
