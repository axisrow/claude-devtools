/**
 * SearchTextExtractor - Lightweight text extraction for search.
 * Mirrors ChunkBuilder's classification loop but only extracts searchable
 * text + metadata, skipping tool execution, semantic steps, subagent linking,
 * timeline gaps and metrics.
 */

import { classifyMessages } from '@main/services/parsing/MessageClassifier';
import { sanitizeDisplayContent } from '@shared/utils/contentSanitizer';

import type { ContentBlock, ParsedMessage } from '@main/types';

/**
 * A lightweight entry containing only the data needed for search matching.
 */
export interface SearchableEntry {
  text: string;
  groupId: string;
  messageType: 'user' | 'assistant';
  itemType: 'user' | 'ai';
  timestamp: number;
  messageUuid: string;
}

/**
 * Result of extracting searchable text from a session's messages.
 */
export interface SearchTextResult {
  entries: SearchableEntry[];
  sessionTitle: string | undefined;
}

/**
 * Extract searchable text entries from parsed messages.
 *
 * Algorithm mirrors ChunkBuilder.buildChunks() lines 78-151:
 * - Filter to main thread (!m.isSidechain), classifyMessages(), walk with an
 *   aiBuffer: hardNoise → skip; compact/system/user → flush AI buffer, then
 *   handle; ai → push to buffer; flush the remaining buffer at end.
 * AI buffers additionally yield entries for tool_use inputs and tool_result
 * texts (issue #36); system command output is searchable too.
 */
export function extractSearchableEntries(messages: ParsedMessage[]): SearchTextResult {
  const entries: SearchableEntry[] = [];
  let sessionTitle: string | undefined;

  // Filter to main thread messages (non-sidechain) — same as ChunkBuilder line 82
  const mainMessages = messages.filter((m) => !m.isSidechain);
  const classified = classifyMessages(mainMessages);

  let aiBuffer: ParsedMessage[] = [];

  const flushAIBuffer = (): void => {
    if (aiBuffer.length === 0) return;
    const aiEntry = extractAIEntry(aiBuffer);
    if (aiEntry) entries.push(aiEntry);
    entries.push(...extractAIToolEntries(aiBuffer));
    aiBuffer = [];
  };

  for (const { message, category } of classified) {
    switch (category) {
      case 'hardNoise':
        // Skip — filtered out
        break;

      case 'compact':
      case 'system':
        // Flush AI buffer, then index the command/system output text
        flushAIBuffer();
        if (category === 'system') {
          const text = extractUserText(message);
          if (text) {
            entries.push({
              text,
              groupId: `system-${message.uuid}`,
              messageType: 'assistant',
              itemType: 'ai',
              timestamp: message.timestamp.getTime(),
              messageUuid: message.uuid,
            });
          }
        }
        break;

      case 'user': {
        // Flush AI buffer
        flushAIBuffer();
        // Extract user text
        const userText = extractUserText(message);
        if (userText) {
          if (!sessionTitle) {
            sessionTitle = userText.slice(0, 100);
          }
          entries.push({
            text: userText,
            groupId: `user-${message.uuid}`,
            messageType: 'user',
            itemType: 'user',
            timestamp: message.timestamp.getTime(),
            messageUuid: message.uuid,
          });
        }
        break;
      }

      case 'ai':
        aiBuffer.push(message);
        break;
    }
  }

  // Flush remaining AI buffer
  flushAIBuffer();

  return { entries, sessionTitle };
}

/**
 * Extract the last text output from an AI message buffer.
 * Scans backward for the last assistant message with a text content block.
 */
function extractAIEntry(buffer: ParsedMessage[]): SearchableEntry | null {
  // Scan backward for last assistant message with text content
  for (let i = buffer.length - 1; i >= 0; i--) {
    const msg = buffer[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    // Find the last text block in this message
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j];
      if (block.type === 'text' && block.text) {
        return {
          text: block.text,
          groupId: `ai-${buffer[0].uuid}`,
          messageType: 'assistant',
          itemType: 'ai',
          timestamp: msg.timestamp.getTime(),
          messageUuid: msg.uuid,
        };
      }
    }
  }
  return null;
}

/**
 * Extract tool_use input and tool_result text entries from an AI buffer (issue #36).
 * Both are addressed by the same ai-{uuid} group id as the buffer's text entry.
 */
function extractAIToolEntries(buffer: ParsedMessage[]): SearchableEntry[] {
  const entries: SearchableEntry[] = [];
  const groupId = `ai-${buffer[0].uuid}`;

  for (const msg of buffer) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      const toolText =
        block.type === 'tool_use'
          ? `${block.name} ${JSON.stringify(block.input)}`
          : block.type === 'tool_result'
            ? toolResultText(block.content)
            : '';
      if (!toolText) continue;
      entries.push({
        text: toolText,
        groupId,
        messageType: 'assistant',
        itemType: 'ai',
        timestamp: msg.timestamp.getTime(),
        messageUuid: msg.uuid,
      });
    }
  }
  return entries;
}

/** Plain text of a tool_result content (string or content-block array) */
function toolResultText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return sanitizeDisplayContent(content);
  if (Array.isArray(content)) {
    return sanitizeDisplayContent(
      content
        .map((block) => (block.type === 'text' ? block.text : JSON.stringify(block)))
        .join('\n')
    );
  }
  return '';
}

/**
 * Extract searchable text from a user message.
 * Shared logic previously in SessionSearcher.extractUserSearchableText().
 */
export function extractUserText(message: ParsedMessage): string {
  let rawText = '';
  if (typeof message.content === 'string') {
    rawText = message.content;
  } else if (Array.isArray(message.content)) {
    rawText = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
  }
  return sanitizeDisplayContent(rawText);
}
