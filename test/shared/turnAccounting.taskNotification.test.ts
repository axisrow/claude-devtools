import { describe, expect, it } from 'vitest';

// canonical accounting core (same file the hook imports through its wrapper)
import {
  isTurnBoundary,
  isTurnNumberLine,
  isUserChunkLine,
} from '../../scripts/turn-accounting.mjs';

// verbatim shape from session 8b65639f (ccstatusline): a background Bash task
// completion arrives as a NON-meta user line with string content
const taskNotification = [
  '<task-notification>',
  '<task-id>bppnd267i</task-id>',
  '<tool-use-id>call_dcb8930609034ba7adde0619</tool-use-id>',
  '<status>completed</status>',
  '<summary>Background command "Fresh tarball download with stall abort and retries" completed (exit code 0)</summary>',
  '</task-notification>',
].join('\n');

// raw JSONL shape: content wrapped in .message; isMeta absent (not false)
const rawLine = (content: unknown): Record<string, unknown> => ({
  type: 'user',
  message: { role: 'user', content },
});
// flattened ParsedMessage shape (app parser): content directly on the object
const flatLine = (content: unknown): Record<string, unknown> => ({
  type: 'user',
  content,
});

describe('task-notification lines are not user turns', () => {
  it('a bare <task-notification> user line opens no turn', () => {
    expect(isUserChunkLine(rawLine(taskNotification))).toBe(false);
    expect(isUserChunkLine(flatLine(taskNotification))).toBe(false);
    // turn numbering and budget bucket must agree with the chunk predicate
    expect(isTurnNumberLine(rawLine(taskNotification))).toBe(false);
    expect(isTurnBoundary(rawLine(taskNotification))).toBe(false);
  });

  it('a real user message quoting a notification is still a turn', () => {
    const quoted = `Что значит это?\n${taskNotification}`;
    expect(isUserChunkLine(rawLine(quoted))).toBe(true);
    expect(isTurnNumberLine(rawLine(quoted))).toBe(true);
  });

  it('array form: a notification-only text block opens no turn either', () => {
    expect(isUserChunkLine(rawLine([{ type: 'text', text: taskNotification }]))).toBe(false);
  });
});
