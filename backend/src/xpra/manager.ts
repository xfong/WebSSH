/**
 * xpra/manager.ts
 *
 * Manages per-user Xpra sessions running on the SSH host.
 *
 * Architecture:
 *   - When a terminal session starts, an Xpra server is launched on the SSH
 *     host as the user via SSH: `xpra start :DISPLAY --bind-tcp=0.0.0.0:PORT`
 *   - The Xpra server's built-in HTML5 HTTP/WebSocket server listens on PORT.
 *   - The backend nginx proxy forwards browser WebSocket connections to that port.
 *   - A background poller detects new X11 windows and creates child nodes in
 *     the session tree, broadcasting real-time tree updates to all clients.
 *   - When a terminal session is closed, the Xpra server is stopped via SSH.
 */

import { Client as SSHClient } from 'ssh2';
import { redis } from '../session/store';

// ── Configuration ─────────────────────────────────────────────────────────────

const SSH_HOST = process.env.SSH_HOST || 'host.docker.internal';
const SSH_PORT = parseInt(process.env.SSH_PORT || '22', 10);
const XPRA_PORT_START = parseInt(process.env.XPRA_PORT_START || '10000', 10);
const XPRA_PORT_END = parseInt(process.env.XPRA_PORT_END || '11000', 10);

/** Redis key for the set of in-use Xpra ports. */
const PORT_POOL_KEY = 'xpra:ports:used';

/** Redis key for a user's Xpra session metadata. */
const sessionKey = (username: string) => `xpra:session:${username}`;

/** Redis key for the known window list of a user's Xpra session. */
const windowsKey = (username: string) => `xpra:windows:${username}`;

// ── In-memory registry ────────────────────────────────────────────────────────

export interface XpraSession {
  username: string;
  display: number;   // X display number (e.g. 10 → :10)
  port: number;      // TCP port for Xpra HTML5 server
  nodeId: string;    // parent terminal nodeId
}

/** In-memory map: username → XpraSession */
const sessions = new Map<string, XpraSession>();

// ── Port allocation ───────────────────────────────────────────────────────────

export async function allocateXpraPort(): Promise<number> {
  for (let port = XPRA_PORT_START; port <= XPRA_PORT_END; port++) {
    const added = await redis.sadd(PORT_POOL_KEY, port);
    if (added === 1) return port;
  }
  throw new Error('No available Xpra ports');
}

export async function releaseXpraPort(port: number): Promise<void> {
  await redis.srem(PORT_POOL_KEY, port);
}

// ── Session lifecycle ─────────────────────────────────────────────────────────

/**
 * Starts an Xpra server on the SSH host as the given user.
 * The display number is derived from the port offset.
 * Returns the XpraSession metadata.
 */
export async function startXpraSession(
  username: string,
  password: string,
  terminalNodeId: string,
): Promise<XpraSession> {
  if (sessions.has(username)) {
    return sessions.get(username)!;
  }

  const port = await allocateXpraPort();
  const display = port - XPRA_PORT_START + 10; // :10, :11, ...

  // Start Xpra on the SSH host as the user
  await _sshExec(username, password, [
    'xpra', 'start', `:${display}`,
    `--bind-tcp=0.0.0.0:${port}`,
    '--html=on',
    '--daemon=yes',
    '--exit-with-children=no',
    '--start-via-proxy=no',
    '--mdns=no',
    '--notifications=no',
    '--bell=no',
    '--pulseaudio=no',
    '--speaker=off',
    '--microphone=off',
  ].join(' '));

  const session: XpraSession = { username, display, port, nodeId: terminalNodeId };
  sessions.set(username, session);

  // Persist to Redis so the port survives backend restarts
  await redis.set(sessionKey(username), JSON.stringify(session));

  console.log(`[Xpra] Started session for ${username}: display :${display}, port ${port}`);
  return session;
}

/**
 * Stops the Xpra server for a user and releases the port.
 */
export async function stopXpraSession(username: string, password: string): Promise<void> {
  const session = sessions.get(username);
  if (!session) return;

  try {
    await _sshExec(username, password, `xpra stop :${session.display}`);
  } catch {
    // Ignore — session may already be gone
  }

  sessions.delete(username);
  await redis.del(sessionKey(username));
  await redis.del(windowsKey(username));
  await releaseXpraPort(session.port);
  console.log(`[Xpra] Stopped session for ${username}`);
}

/**
 * Returns the XpraSession for a user, or null if none exists.
 */
export function getXpraSession(username: string): XpraSession | null {
  return sessions.get(username) ?? null;
}

/**
 * Returns the WebSocket URL for the Xpra HTML5 server for a given port.
 * The backend proxies this to the browser via nginx.
 */
export function getXpraWsUrl(port: number): string {
  return `ws://${SSH_HOST}:${port}`;
}

// ── Window detection ──────────────────────────────────────────────────────────

export interface XpraWindow {
  wid: number;
  title: string;
}

/**
 * Lists the current windows in a user's Xpra session via SSH.
 * Returns an empty array if the session is not running or the command fails.
 */
export async function listXpraWindows(
  username: string,
  password: string,
): Promise<XpraWindow[]> {
  const session = sessions.get(username);
  if (!session) return [];

  try {
    const output = await _sshExec(
      username, password,
      `xpra info :${session.display} 2>/dev/null | grep -E "^windows\\.[0-9]+\\.title=" || true`,
    );
    // Parse lines like: windows.4194314.title=xclock
    const windows: XpraWindow[] = [];
    for (const line of output.split('\n')) {
      const m = line.match(/^windows\.(\d+)\.title=(.+)$/);
      if (m) {
        windows.push({ wid: parseInt(m[1], 10), title: m[2].trim() });
      }
    }
    return windows;
  } catch {
    return [];
  }
}

/**
 * Compares the current window list against the previously known list stored
 * in Redis. Returns arrays of new and closed windows.
 */
export async function diffXpraWindows(
  username: string,
  password: string,
): Promise<{ added: XpraWindow[]; removed: XpraWindow[] }> {
  const current = await listXpraWindows(username, password);
  const currentMap = new Map(current.map((w) => [w.wid, w]));

  const rawPrev = await redis.get(windowsKey(username));
  const prev: XpraWindow[] = rawPrev ? JSON.parse(rawPrev) : [];
  const prevMap = new Map(prev.map((w) => [w.wid, w]));

  const added = current.filter((w) => !prevMap.has(w.wid));
  const removed = prev.filter((w) => !currentMap.has(w.wid));

  // Persist the updated window list
  await redis.set(windowsKey(username), JSON.stringify(current));

  return { added, removed };
}

// ── Restore sessions on restart ───────────────────────────────────────────────

/**
 * Restores in-memory session state from Redis after a backend restart.
 * Called once at startup from index.ts.
 */
export async function restoreXpraSessions(): Promise<void> {
  const keys = await redis.keys('xpra:session:*');
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    try {
      const session = JSON.parse(raw) as XpraSession;
      sessions.set(session.username, session);
      console.log(`[Xpra] Restored session for ${session.username} (port ${session.port})`);
    } catch {
      await redis.del(key);
    }
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Executes a shell command on the SSH host as the given user.
 * Returns stdout as a string.
 */
function _sshExec(username: string, password: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new SSHClient();
    let stdout = '';
    let stderr = '';

    client.on('ready', () => {
      client.exec(command, (err, stream) => {
        if (err) {
          client.end();
          return reject(err);
        }
        stream.on('data', (d: Buffer) => { stdout += d.toString(); });
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        stream.on('close', (code: number) => {
          client.end();
          if (code !== 0 && stderr) {
            reject(new Error(`SSH command failed (exit ${code}): ${stderr.trim()}`));
          } else {
            resolve(stdout);
          }
        });
      });
    });

    client.on('error', reject);

    client.connect({
      host: SSH_HOST,
      port: SSH_PORT,
      username,
      password,
      readyTimeout: 10000,
    });
  });
}
