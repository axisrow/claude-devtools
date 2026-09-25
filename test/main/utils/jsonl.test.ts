import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  analyzeSessionFileMetadata,
  calculateMetrics,
  mergeAssistantFragments,
  parseJsonlFile,
  readSessionName,
} from '../../../src/main/utils/jsonl';
import { ChunkBuilder } from '../../../src/main/services/analysis/ChunkBuilder';
import { isAIChunk } from '../../../src/main/types';
import type { ParsedMessage } from '../../../src/main/types';

// Helper to create a minimal ParsedMessage
function createMessage(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    uuid: 'test-uuid',
    parentUuid: null,
    type: 'assistant',
    timestamp: new Date('2024-01-01T10:00:00Z'),
    content: '',
    isSidechain: false,
    isMeta: false,
    isCompactSummary: false,
    toolCalls: [],
    toolResults: [],
    ...overrides,
  };
}

describe('jsonl', () => {
  describe('calculateMetrics', () => {
    it('should return empty metrics for empty messages array', () => {
      const result = calculateMetrics([]);
      expect(result.durationMs).toBe(0);
      expect(result.totalTokens).toBe(0);
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(result.messageCount).toBe(0);
    });

    it('should calculate total tokens from usage', () => {
      const messages = [
        createMessage({
          usage: {
            input_tokens: 100,
            output_tokens: 50,
          },
        }),
      ];

      const result = calculateMetrics(messages);
      expect(result.inputTokens).toBe(100);
      expect(result.outputTokens).toBe(50);
      expect(result.totalTokens).toBe(150);
    });

    it('should sum tokens across multiple messages', () => {
      const messages = [
        createMessage({
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
        createMessage({
          usage: { input_tokens: 200, output_tokens: 100 },
        }),
      ];

      const result = calculateMetrics(messages);
      expect(result.inputTokens).toBe(300);
      expect(result.outputTokens).toBe(150);
      expect(result.totalTokens).toBe(450);
    });

    it('should handle cache tokens', () => {
      const messages = [
        createMessage({
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 25,
            cache_creation_input_tokens: 10,
          },
        }),
      ];

      const result = calculateMetrics(messages);
      expect(result.cacheReadTokens).toBe(25);
      expect(result.cacheCreationTokens).toBe(10);
      expect(result.totalTokens).toBe(185); // 100 + 50 + 25 + 10
    });

    it('should calculate duration from timestamps', () => {
      const messages = [
        createMessage({ timestamp: new Date('2024-01-01T10:00:00Z') }),
        createMessage({ timestamp: new Date('2024-01-01T10:01:00Z') }),
        createMessage({ timestamp: new Date('2024-01-01T10:02:00Z') }),
      ];

      const result = calculateMetrics(messages);
      expect(result.durationMs).toBe(120000); // 2 minutes in ms
    });

    it('should count messages', () => {
      const messages = [createMessage(), createMessage(), createMessage()];

      const result = calculateMetrics(messages);
      expect(result.messageCount).toBe(3);
    });

    it('should handle messages without usage', () => {
      const messages = [
        createMessage({ type: 'user', content: 'Hello' }),
        createMessage({ type: 'system' }),
      ];

      const result = calculateMetrics(messages);
      expect(result.totalTokens).toBe(0);
      expect(result.messageCount).toBe(2);
    });

    it('should handle single message duration', () => {
      const messages = [createMessage({ timestamp: new Date('2024-01-01T10:00:00Z') })];

      const result = calculateMetrics(messages);
      expect(result.durationMs).toBe(0); // min === max
    });

    it('should handle undefined token values', () => {
      const messages = [
        createMessage({
          usage: {
            input_tokens: undefined as unknown as number,
            output_tokens: 50,
          },
        }),
      ];

      const result = calculateMetrics(messages);
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(50);
    });
  });

  describe('streaming fragments (one request split across JSONL lines)', () => {
    const usageA = { input_tokens: 1000, output_tokens: 100 };

    it('mergeAssistantFragments joins lines sharing a message.id into one request', () => {
      const messages = [
        createMessage({
          uuid: 'a1',
          messageId: 'msg_1',
          usage: usageA,
          content: [{ type: 'text', text: 'hi' }],
        }),
        createMessage({
          uuid: 'a2',
          messageId: 'msg_1',
          usage: usageA,
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
          toolCalls: [{ id: 't1', name: 'Read', input: {}, isTask: false }],
        }),
      ];

      const merged = mergeAssistantFragments(messages);
      expect(merged).toHaveLength(1);
      expect(merged[0].uuid).toBe('a1'); // first fragment anchors the round
      expect(merged[0].usage).toEqual(usageA);
      expect(merged[0].content).toHaveLength(2); // text + tool_use
      expect(merged[0].toolCalls).toHaveLength(1);
    });

    it('mergeAssistantFragments joins string-content fragments without dropping text', () => {
      const messages = [
        createMessage({ uuid: 'a1', messageId: 'msg_1', usage: usageA, content: 'hel' }),
        createMessage({ uuid: 'a2', messageId: 'msg_1', usage: usageA, content: 'lo' }),
      ];

      const merged = mergeAssistantFragments(messages);
      expect(merged).toHaveLength(1);
      expect(merged[0].content).toBe('hello');
    });

    it('keeps requestId-bearing snapshot lines untouched (dedupe path handles them)', () => {
      const messages = [
        createMessage({
          uuid: 'a1',
          requestId: 'req_1',
          messageId: 'msg_1',
          content: [{ type: 'text', text: 'partial' }],
        }),
        createMessage({
          uuid: 'a2',
          requestId: 'req_1',
          messageId: 'msg_1',
          content: [{ type: 'text', text: 'full' }],
        }),
      ];

      expect(mergeAssistantFragments(messages)).toHaveLength(2);
    });

    it('calculateMetrics bills a fragmented request once', () => {
      const messages = [
        createMessage({
          uuid: 'a1',
          messageId: 'msg_1',
          usage: usageA,
          content: [{ type: 'text', text: 'x' }],
        }),
        createMessage({
          uuid: 'a2',
          messageId: 'msg_1',
          usage: usageA,
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
        }),
      ];

      // one request = one usage count (1100), not two (2200)
      expect(calculateMetrics(messages).totalTokens).toBe(1100);
    });

    it('parseJsonlFile merges fragment lines before any consumer sees them', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtools-frag-'));
      const file = path.join(dir, 'session.jsonl');
      const entry = (uuid: string, parentUuid: string | null, content: unknown[]) => ({
        type: 'assistant' as const,
        uuid,
        parentUuid,
        timestamp: '2024-01-01T10:00:00Z',
        isSidechain: false,
        isMeta: false,
        message: {
          role: 'assistant' as const,
          id: 'msg_1',
          model: 'glm-4.6',
          content,
          usage: { input_tokens: 1000, output_tokens: 100 },
        },
      });
      fs.writeFileSync(
        file,
        [
          JSON.stringify({
            type: 'user',
            uuid: 'u1',
            parentUuid: null,
            timestamp: '2024-01-01T10:00:00Z',
            isSidechain: false,
            isMeta: false,
            message: { role: 'user', content: 'go' },
          }),
          JSON.stringify(entry('a1', 'u1', [{ type: 'text', text: 'hi' }])),
          JSON.stringify(
            entry('a2', 'a1', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }])
          ),
          JSON.stringify({
            type: 'user',
            uuid: 'u2',
            parentUuid: 'a2',
            timestamp: '2024-01-01T10:00:03Z',
            isSidechain: false,
            isMeta: false,
            message: { role: 'user', content: 'ok' },
          }),
        ].join('\n')
      );

      const messages = await parseJsonlFile(file);
      // two fragment lines with the same message.id arrive as ONE message
      expect(messages.filter((m) => m.type === 'assistant')).toHaveLength(1);

      const chunks = new ChunkBuilder().buildChunks(messages);
      const ai = chunks.filter(isAIChunk);
      expect(ai).toHaveLength(1);
      expect(ai[0].responses).toHaveLength(1);
      expect(ai[0].responses[0].content).toHaveLength(2);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('session name (agent-name / ai-title)', () => {
    const USER = {
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'hello' },
      isMeta: false,
    };

    function writeSession(lines: unknown[]): { filePath: string; cleanup: () => void } {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-name-'));
      const filePath = path.join(tempDir, 'session.jsonl');
      fs.writeFileSync(filePath, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
      return {
        filePath,
        cleanup: () => {
          try {
            fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
          } catch {
            // best-effort
          }
        },
      };
    }

    it('extracts last agent-name, falling back to ai-title', async () => {
      const { filePath, cleanup } = writeSession([
        USER,
        { type: 'agent-name', agentName: 'first-name', sessionId: 's1' },
        { type: 'ai-title', aiTitle: 'auto title', sessionId: 's1' },
        { type: 'agent-name', agentName: 'renamed', sessionId: 's1' },
      ]);
      try {
        const meta = await analyzeSessionFileMetadata(filePath);
        expect(meta.name).toBe('renamed');
        await expect(readSessionName(filePath)).resolves.toBe('renamed');
      } finally {
        cleanup();
      }
    });

    it('falls back to ai-title when no agent-name, null when unnamed', async () => {
      const withTitle = writeSession([
        USER,
        { type: 'ai-title', aiTitle: 'auto title', sessionId: 's1' },
      ]);
      try {
        await expect(readSessionName(withTitle.filePath)).resolves.toBe('auto title');
        const meta = await analyzeSessionFileMetadata(withTitle.filePath);
        expect(meta.name).toBe('auto title');
      } finally {
        withTitle.cleanup();
      }

      const unnamed = writeSession([USER]);
      try {
        await expect(readSessionName(unnamed.filePath)).resolves.toBeNull();
        const meta = await analyzeSessionFileMetadata(unnamed.filePath);
        expect(meta.name).toBeNull();
      } finally {
        unnamed.cleanup();
      }
    });
  });

  describe('analyzeSessionFileMetadata', () => {
    it('should extract first message, count, ongoing state, and git branch in one pass', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-meta-'));
      try {
        const filePath = path.join(tempDir, 'session.jsonl');
        const lines = [
          JSON.stringify({
            type: 'user',
            uuid: 'u1',
            timestamp: '2026-01-01T00:00:00.000Z',
            gitBranch: 'feature/test',
            message: { role: 'user', content: 'hello world' },
            isMeta: false,
          }),
          JSON.stringify({
            type: 'assistant',
            uuid: 'a1',
            timestamp: '2026-01-01T00:00:01.000Z',
            message: {
              role: 'assistant',
              content: [{ type: 'thinking', thinking: 'thinking...' }],
            },
          }),
        ];
        fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');

        const result = await analyzeSessionFileMetadata(filePath);

        expect(result.firstUserMessage?.text).toBe('hello world');
        expect(result.firstUserMessage?.timestamp).toBe('2026-01-01T00:00:00.000Z');
        expect(result.messageCount).toBe(2);
        expect(result.isOngoing).toBe(true);
        expect(result.gitBranch).toBe('feature/test');
      } finally {
        try {
          fs.rmSync(tempDir, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 200,
          });
        } catch {
          // Best-effort cleanup; ignore ENOTEMPTY on Windows when dir is in use
        }
      }
    });

    it('sums total spend across all assistant usage in one pass', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-spend-'));
      try {
        const filePath = path.join(tempDir, 'session.jsonl');
        const lines = [
          JSON.stringify({
            type: 'user',
            uuid: 'u1',
            timestamp: '2026-01-01T00:00:00.000Z',
            message: { role: 'user', content: 'go' },
            isMeta: false,
          }),
          JSON.stringify({
            type: 'assistant',
            uuid: 'a1',
            timestamp: '2026-01-01T00:00:01.000Z',
            message: {
              role: 'assistant',
              model: 'claude-fable-5-1',
              content: [{ type: 'text', text: 'ok' }],
              usage: {
                input_tokens: 100,
                cache_read_input_tokens: 5000,
                cache_creation_input_tokens: 200,
                output_tokens: 50,
              },
            },
          }),
          JSON.stringify({
            type: 'assistant',
            uuid: 'a2',
            timestamp: '2026-01-01T00:00:02.000Z',
            message: {
              role: 'assistant',
              model: 'claude-fable-5-1',
              content: [{ type: 'text', text: 'done' }],
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          }),
          // sidechain counts too — this file's transcript cost
          JSON.stringify({
            type: 'assistant',
            uuid: 'a3',
            isSidechain: true,
            timestamp: '2026-01-01T00:00:03.000Z',
            message: {
              role: 'assistant',
              model: 'claude-fable-5-1',
              content: [],
              usage: { input_tokens: 7, output_tokens: 3 },
            },
          }),
          // synthetic / no-usage lines contribute nothing
          JSON.stringify({
            type: 'assistant',
            uuid: 'a4',
            timestamp: '2026-01-01T00:00:04.000Z',
            message: { role: 'assistant', model: '<synthetic>', content: [] },
          }),
        ];
        fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');

        const result = await analyzeSessionFileMetadata(filePath);

        // 100+5000+200+50 + 10+5 + 7+3 = 5375
        expect(result.totalTokens).toBe(5375);
      } finally {
        try {
          fs.rmSync(tempDir, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 200,
          });
        } catch {
          // Best-effort cleanup; ignore ENOTEMPTY on Windows when dir is in use
        }
      }
    });
    it('counts turns — AI response groups, same rule as the chunk pipeline', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-turns-'));
      try {
        const filePath = path.join(tempDir, 'session.jsonl');
        const user = (
          uuid: string,
          parentUuid: string | null,
          content: string,
          isSidechain = false
        ): string =>
          JSON.stringify({
            type: 'user',
            uuid,
            parentUuid: parentUuid ?? undefined,
            timestamp: '2026-01-01T00:00:00.000Z',
            isMeta: false,
            isSidechain,
            message: { role: 'user', content },
          });
        const assistant = (uuid: string, parentUuid: string, model: string): string =>
          JSON.stringify({
            type: 'assistant',
            uuid,
            parentUuid,
            timestamp: '2026-01-01T00:00:01.000Z',
            message: {
              role: 'assistant',
              model,
              content: [{ type: 'text', text: 'ok' }],
              usage: { input_tokens: 10, output_tokens: 2 },
            },
          });
        // root (parentUuid null) is hard noise everywhere; an assistant run
        // closes on user/system/compact and counts exactly one turn —
        // continuations, synthetic replies and sidechains never break a group
        const lines = [
          user('u1', null, 'go'),
          assistant('a1', 'u1', 'claude-fable-5-1'),
          assistant('a1b', 'a1', 'claude-fable-5-1'), // continuation — same group
          user('u2', 'a1b', 'again'),
          assistant('a2-synthetic', 'u2', '<synthetic>'), // hard noise — no break
          assistant('a2', 'a2-synthetic', 'claude-fable-5-1'),
          user('sys', 'a2', '<local-command-stdout>ok</local-command-stdout>'), // system break
          assistant('a3', 'sys', 'claude-fable-5-1'),
          user('side-u', 'a3', 'sidechat', true), // sidechain — skipped
          assistant('side-a', 'side-u', 'claude-fable-5-1'),
          user('u3', 'a3', 'more'),
          assistant('a4', 'u3', 'claude-fable-5-1'), // still open — closed at EOF
        ];
        fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');

        const result = await analyzeSessionFileMetadata(filePath);

        // groups: [a1,a1b] [a2] [a3] [a4] = 4
        expect(result.turnCount).toBe(4);
      } finally {
        try {
          fs.rmSync(tempDir, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 200,
          });
        } catch {
          // Best-effort cleanup; ignore ENOTEMPTY on Windows when dir is in use
        }
      }
    });

    it('parity — scan turnCount equals the chunk pipeline AIChunk count', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-parity-'));
      try {
        const msg = (over: Partial<ParsedMessage>): ParsedMessage => ({
          uuid: over.uuid ?? 'x',
          parentUuid: over.parentUuid ?? null,
          type: over.type ?? 'assistant',
          timestamp: new Date('2026-01-01T00:00:00.000Z'),
          content: over.content ?? '',
          isSidechain: over.isSidechain ?? false,
          isMeta: over.isMeta ?? false,
          isCompactSummary: over.isCompactSummary ?? false,
          toolCalls: [],
          toolResults: [],
        });
        const ai = (uuid: string, parentUuid: string): ParsedMessage =>
          msg({ uuid, parentUuid, content: [{ type: 'text', text: 'ok' }] });
        const messages: ParsedMessage[] = [
          msg({ uuid: 'u1', type: 'user', content: 'go' }), // root → hard noise
          ai('a1', 'u1'),
          ai('a2', 'a1'),
          msg({ uuid: 'u2', parentUuid: 'a2', type: 'user', content: 'again' }), // break
          msg({
            uuid: 's1',
            parentUuid: 'u2',
            content: [{ type: 'text', text: 'side' }],
            isSidechain: true,
          }),
          msg({
            uuid: 'sys',
            parentUuid: 'u2',
            type: 'user',
            content: '<local-command-stdout>x</local-command-stdout>',
          }), // break
          ai('a3', 'sys'),
          msg({ uuid: 'c1', parentUuid: 'a3', type: 'user', isCompactSummary: true }), // break
          ai('a4', 'c1'), // closed at EOF
        ];
        // Serialize the same objects to JSONL the way the scanner reads them
        const toEntry = (m: ParsedMessage): string =>
          JSON.stringify({
            uuid: m.uuid,
            parentUuid: m.parentUuid ?? undefined,
            type: m.type,
            timestamp: '2026-01-01T00:00:00.000Z',
            isMeta: m.isMeta || undefined,
            isSidechain: m.isSidechain || undefined,
            isCompactSummary: m.isCompactSummary || undefined,
            message:
              m.type === 'user'
                ? { role: 'user', content: m.content }
                : {
                    role: 'assistant',
                    model: 'claude-fable-5-1',
                    content: m.content,
                    usage: { input_tokens: 10, output_tokens: 2 },
                  },
          });
        const filePath = path.join(tempDir, 'session.jsonl');
        fs.writeFileSync(filePath, `${messages.map(toEntry).join('\n')}\n`, 'utf8');

        const scan = await analyzeSessionFileMetadata(filePath);
        const chunks = new ChunkBuilder().buildChunks(messages);
        const aiChunks = chunks.filter(isAIChunk).length;

        // groups: [a1,a2] [a3] [a4] = 3 on both paths
        expect(aiChunks).toBe(3);
        expect(scan.turnCount).toBe(aiChunks);
      } finally {
        try {
          fs.rmSync(tempDir, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 200,
          });
        } catch {
          // Best-effort cleanup; ignore ENOTEMPTY on Windows when dir is in use
        }
      }
    });
  });
});
