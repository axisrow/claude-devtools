/**
 * App-side delivery into a Claude Code session's inbox socket.
 *
 * The messaging env (CLAUDE_CODE_MESSAGING_SOCKET/TOKEN) is exported by CC to
 * that session's HOOKS only — the app never has it. The turn-budget hook
 * (installed per-session) persists a snapshot {socket, token} per session id
 * to ~/.claude/claude-devtools-messaging/<session>.json (0600); this module
 * reads that map and posts the same two-line frame the auto-continue sf-child
 * uses (auth + user message; the session wakes with the text as a new turn).
 *
 * Verified by the Фаза-3 spike (2026-11-05): own-session delivery lands as a
 * peer message; cross-session posts with a foreign token are silently
 * rejected — hence the per-session snapshot map.
 */
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '@shared/utils/logger';

const logger = createLogger('Utils:MessagingDelivery');

const SESSION_RE = /^[\w-]+$/;
const SOCKET_ACK_MS = 5000; // the inbox never acks; this only bounds the wait

export interface MessagingSnap {
  socket: string;
  token: string;
}

/** Session → {socket, token} snapshot written by the turn-budget hook. */
/** Session → {socket, token} snapshot written by the turn-budget hook.
 * homeOverride: tests pass a temp home (os.homedir() ignores $HOME on macOS). */
export function readMessagingSnap(sessionId: string, homeOverride?: string): MessagingSnap | null {
  if (!SESSION_RE.test(sessionId)) return null;
  try {
    const raw = JSON.parse(
      readFileSync(
        join(
          homeOverride ?? homedir(),
          '.claude',
          'claude-devtools-messaging',
          `${sessionId}.json`
        ),
        'utf8'
      )
    ) as Partial<MessagingSnap>;
    if (typeof raw.socket !== 'string' || typeof raw.token !== 'string') return null;
    return { socket: raw.socket, token: raw.token };
  } catch {
    return null;
  }
}

/** Post one user message into a session inbox; true when the frame was written. */
export function postToSocket(snap: MessagingSnap, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(ok);
    };
    const s = connect(snap.socket, () => {
      try {
        const lines = [
          JSON.stringify({ type: 'auth', token: snap.token }),
          JSON.stringify({ type: 'user', message: { role: 'user', content: text } }),
        ];
        s.write(lines.join('\n') + '\n');
        s.end();
      } catch {
        finish(false);
      }
    });
    s.on('error', () => finish(false));
    s.on('close', () => finish(true));
    setTimeout(() => finish(false), SOCKET_ACK_MS);
  });
}

/** Read the session's snapshot and deliver text; false when unknown session or dead socket. */
export async function deliverToSession(
  sessionId: string,
  text: string,
  homeOverride?: string
): Promise<boolean> {
  const snap = readMessagingSnap(sessionId, homeOverride);
  if (!snap) {
    logger.debug(`messaging: no snapshot for session ${sessionId.slice(0, 8)} — not steered`);
    return false;
  }
  const ok = await postToSocket(snap, text);
  logger.debug(`messaging: deliver to ${sessionId.slice(0, 8)} → ${ok ? 'sent' : 'failed'}`);
  return ok;
}
