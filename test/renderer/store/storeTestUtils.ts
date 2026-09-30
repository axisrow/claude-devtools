/**
 * Store test utilities for creating isolated test store instances.
 */

import { create } from 'zustand';

import { installMockElectronAPI } from '../../mocks/electronAPI';

import { createConfigSlice } from '../../../src/renderer/store/slices/configSlice';
import { createConversationSlice } from '../../../src/renderer/store/slices/conversationSlice';
import { createMemorySlice } from '../../../src/renderer/store/slices/memorySlice';
import { createNotificationSlice } from '../../../src/renderer/store/slices/notificationSlice';
import { createPaneSlice } from '../../../src/renderer/store/slices/paneSlice';
import { createProjectSlice } from '../../../src/renderer/store/slices/projectSlice';
import { createRepositorySlice } from '../../../src/renderer/store/slices/repositorySlice';
import { createSessionDetailSlice } from '../../../src/renderer/store/slices/sessionDetailSlice';
import { createSessionSlice } from '../../../src/renderer/store/slices/sessionSlice';
import { createSubagentSlice } from '../../../src/renderer/store/slices/subagentSlice';
import { createTabSlice } from '../../../src/renderer/store/slices/tabSlice';
import { createTabUISlice } from '../../../src/renderer/store/slices/tabUISlice';
import { createUISlice } from '../../../src/renderer/store/slices/uiSlice';

import type { AppState } from '../../../src/renderer/store/types';

/**
 * Create an isolated store instance for testing.
 * Each test gets a fresh store with no shared state.
 */
export function createTestStore() {
  // Opening a session tab triggers a real detail fetch through `api`, which
  // falls back to the HTTP client when no bridge is installed — and crashes
  // on EventSource in happy-dom. Tests that assert on IPC calls install their
  // own mock first; only fill the gap when nobody did.
  if (!window.electronAPI) {
    installMockElectronAPI();
  }

  const store = create<AppState>()((...args) => ({
    ...createProjectSlice(...args),
    ...createRepositorySlice(...args),
    ...createSessionSlice(...args),
    ...createSessionDetailSlice(...args),
    ...createSubagentSlice(...args),
    ...createConversationSlice(...args),
    ...createTabSlice(...args),
    ...createTabUISlice(...args),
    ...createPaneSlice(...args),
    ...createUISlice(...args),
    ...createNotificationSlice(...args),
    ...createConfigSlice(...args),
    ...createMemorySlice(...args),
  }));

  return store;
}

export type TestStore = ReturnType<typeof createTestStore>;
