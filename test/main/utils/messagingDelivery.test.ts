import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deliverToSession,
  postToSocket,
  readMessagingSnap,
} from '../../../src/main/utils/messagingDelivery';

describe('messagingDelivery (Фаза 3)', () => {
  let home: string;
  let server: Server | null = null;
  const HOME_BACKUP = process.env.HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'msg-deliv-'));
    process.env.HOME = home; // os.homedir() respects $HOME on POSIX
  });

  afterEach(() => {
    process.env.HOME = HOME_BACKUP;
    server?.close();
    server = null;
  });

  // Windows has no unix-socket filesystem paths — an inbox path must be a
  // named pipe there; POSIX keeps a path in the temp home.
  let inboxSeq = 0;
  const inboxPath = (): string =>
    process.platform === 'win32'
      ? `\\\\.\\pipe\\msg-deliv-${process.pid}-${++inboxSeq}`
      : join(home, `inbox-${++inboxSeq}.sock`);

  it('readMessagingSnap validates the hook snapshot map', () => {
    const dir = join(home, '.claude', 'claude-devtools-messaging');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 's1.json'), JSON.stringify({ socket: '/tmp/x.sock', token: 't' }));
    expect(readMessagingSnap('s1', home)).toEqual({ socket: '/tmp/x.sock', token: 't' });
    writeFileSync(join(dir, 'bad.json'), 'not json');
    expect(readMessagingSnap('bad', home)).toBeNull();
    expect(readMessagingSnap('../evil', home)).toBeNull();
    expect(readMessagingSnap('missing', home)).toBeNull();
  });

  it('postToSocket delivers the auth+message frame to a fake inbox', async () => {
    const sockPath = inboxPath();
    try {
      const received = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('<timeout>'), 3000);
        server = createServer((c) => {
          c.on('data', (d) => {
            clearTimeout(timer);
            resolve(d.toString());
          });
        });
        // an unhandled 'error' here kills the vitest worker — resolve instead
        server.on('error', (e) => {
          clearTimeout(timer);
          resolve(`<listen-error ${String(e)}>`);
        });
        server.listen(sockPath, () => {
          void postToSocket({ socket: sockPath, token: 'tok-9' }, 'Stop the runaway subagent');
        });
      });
      expect(received).toContain('"type":"auth"');
      expect(received).toContain('"token":"tok-9"');
      expect(received).toContain('Stop the runaway subagent');
    } finally {
      rmSync(sockPath, { force: true });
    }
  });

  it('deliverToSession reads the hook snapshot and delivers; unknown session → false', async () => {
    const dir = join(home, '.claude', 'claude-devtools-messaging');
    mkdirSync(dir, { recursive: true });
    const sockPath = inboxPath();
    writeFileSync(join(dir, 's7.json'), JSON.stringify({ socket: sockPath, token: 'tok-7' }));
    try {
      const received = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('<timeout>'), 3000);
        server = createServer((c) => {
          c.on('data', (d) => {
            clearTimeout(timer);
            resolve(d.toString());
          });
        });
        server.on('error', (e) => {
          clearTimeout(timer);
          resolve(`<listen-error ${String(e)}>`);
        });
        server.listen(sockPath, () => {
          void deliverToSession('s7', 'wrap up the runaway', home);
        });
      });
      expect(received).toContain('"token":"tok-7"');
      expect(received).toContain('wrap up the runaway');
    } finally {
      rmSync(sockPath, { force: true });
    }
    expect(await deliverToSession('no-such-session', 'x', home)).toBe(false);
  });
});
