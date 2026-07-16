import { redis } from '../session/store';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const XPRA_PORT_START = parseInt(process.env.XPRA_PORT_START || '10000', 10);
const XPRA_PORT_END = parseInt(process.env.XPRA_PORT_END || '11000', 10);
const XPRA_HOST = process.env.XPRA_HOST || 'xpra';

const PORT_POOL_KEY = 'xpra:ports:used';

/**
 * Allocate a free port from the Xpra port range.
 */
export async function allocateXpraPort(): Promise<number> {
  for (let port = XPRA_PORT_START; port <= XPRA_PORT_END; port++) {
    const added = await redis.sadd(PORT_POOL_KEY, port);
    if (added === 1) return port;
  }
  throw new Error('No available Xpra ports');
}

/**
 * Release a previously allocated Xpra port.
 */
export async function releaseXpraPort(port: number): Promise<void> {
  await redis.srem(PORT_POOL_KEY, port);
}

/**
 * Start an Xpra session for a user on the given display/port.
 * The Xpra daemon runs inside the xpra container and is accessible
 * by the backend over the internal Docker network.
 */
export async function startXpraSession(username: string, port: number): Promise<void> {
  // The xpra container runs as root for session management; individual
  // Xpra sessions are started as the target user via SSH into the host.
  // Here we record the session metadata; actual Xpra start is triggered
  // via SSH by the terminal session when a GUI app is launched.
  await redis.set(`xpra:session:${username}:${port}`, JSON.stringify({
    username,
    port,
    host: XPRA_HOST,
    startedAt: Date.now(),
  }));
}

/**
 * Stop an Xpra session and release its port.
 */
export async function stopXpraSession(username: string, port: number): Promise<void> {
  await redis.del(`xpra:session:${username}:${port}`);
  await releaseXpraPort(port);

  // Send stop command to Xpra via SSH (best-effort)
  try {
    await execAsync(`ssh -o StrictHostKeyChecking=no ${username}@${process.env.SSH_HOST} xpra stop :${port - XPRA_PORT_START + 10}`);
  } catch {
    // Ignore errors — session may already be gone
  }
}

export function getXpraProxyUrl(port: number): string {
  return `ws://${XPRA_HOST}:${port}`;
}
