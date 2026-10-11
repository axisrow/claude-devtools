import { describe, expect, it } from 'vitest';

import { ChunkBuilder } from '@main/services/analysis';
import { parseJsonlLine } from '@main/utils/jsonl';
import { enhanceAIGroup } from '@renderer/utils/aiGroupEnhancer';
import { transformChunksToConversation } from '@renderer/utils/groupTransformer';

/**
 * Issue #104: after #70 a completed background task's <task-notification>
 * user line (promptSource: "system") no longer opens a user turn — correct —
 * but the card it used to render disappeared, because it now lands inside an
 * AI group that has no display element for it.
 *
 * Pipeline under test mirrors the real render path:
 * jsonl → ChunkBuilder → transformChunksToConversation → enhanceAIGroup.
 */

let seq = 0;
let clock = Date.parse('2026-10-01T07:00:00Z');
const at = (gapMs = 20_000) => new Date((clock += gapMs)).toISOString();

function userLine(content: unknown): string {
  seq += 1;
  return JSON.stringify({
    uuid: `u${seq}`,
    parentUuid: null,
    sessionId: 's',
    cwd: '/p',
    isSidechain: false,
    type: 'user',
    timestamp: at(),
    message: { role: 'user', content },
  });
}

function assistantLine(block: object, requestId: string): string {
  seq += 1;
  return JSON.stringify({
    uuid: `a${seq}`,
    parentUuid: null,
    sessionId: 's',
    cwd: '/p',
    isSidechain: false,
    type: 'assistant',
    timestamp: at(),
    requestId,
    message: {
      id: `m${seq}`,
      role: 'assistant',
      model: 'claude-x',
      content: [block],
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 0,
        output_tokens: 50,
      },
    },
  });
}

function toolResultLine(toolUseId: string): string {
  seq += 1;
  return JSON.stringify({
    uuid: `r${seq}`,
    parentUuid: null,
    sessionId: 's',
    cwd: '/p',
    isSidechain: false,
    type: 'user',
    timestamp: at(),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
    },
  });
}

const NOTE =
  '<task-notification>\n<task-id>bppnd267i</task-id>\n<status>completed</status>\n<summary>Background command "Fresh tarball download" completed (exit code 0)</summary>\n</task-notification>';

function buildSession(): ReturnType<typeof transformChunksToConversation> {
  const lines = [
    userLine('Запусти сборку'),
    assistantLine(
      { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'curl …', run_in_background: true } },
      'q1'
    ),
    toolResultLine('b1'),
    assistantLine({ type: 'text', text: 'Запустил в фоне' }, 'q2'),
    userLine(NOTE),
    assistantLine({ type: 'text', text: 'Сборка завершилась' }, 'q3'),
  ];
  const messages = lines.map((l) => parseJsonlLine(l)).filter((m) => m !== null);
  const chunks = new ChunkBuilder().buildChunks(messages, []);
  return transformChunksToConversation(chunks, [], false);
}

describe('task-notification display (issue #104)', () => {
  it('opens no extra user turn', () => {
    const { items } = buildSession();
    const userItems = items.filter((i) => i.type === 'user');
    expect(userItems).toHaveLength(1); // only "Запусти сборку"
  });

  it('shows one display element with status and exit code inside the AI group', () => {
    const { items } = buildSession();
    const aiItem = items.find((i) => i.type === 'ai');
    expect(aiItem).toBeDefined();
    const { displayItems } = enhanceAIGroup(
      (aiItem as { group: Parameters<typeof enhanceAIGroup>[0] }).group
    );

    const notifications = displayItems.filter((d) => d.type === 'task_notification');
    expect(notifications).toHaveLength(1);
    const notif = notifications[0];
    if (notif.type !== 'task_notification') throw new Error('Expected task_notification');
    expect(notif.notification.status).toBe('completed');
    expect(notif.notification.summary).toContain('(exit code 0)');
  });
});
