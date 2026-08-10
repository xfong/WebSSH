/**
 * sshSessionManager.ts
 *
 * Manages persistent SSH sessions that survive browser disconnection.
 * Each session is keyed by nodeId and lives independently of any WebSocket.
 *
 * Lifecycle:
 *   startSession()  → opens SSH, begins buffering output to Redis
 *   attachSocket()  → replays buffer + pipes live stream to a WebSocket
 *   detachSocket()  → removes socket listeners; SSH stays alive
 *   terminateSession() → closes SSH and cleans up Redis state
 *
 * The PTY output buffer is stored in Redis as a capped list so that
 * reconnecting users see recent terminal history.
 */

import { Socket } from 'socket.io';
import { openSSHSession, resizeSSHSession, closeSSHSession, SSHSession } from '../ssh/manager';
import { redis } from './store';

// ── Configuration ─────────────────────────────────────────────────────────────

/** Maximum number of output chunks to keep in the replay buffer per session. */
const BUFFER_MAX_CHUNKS = 500;

/** Redis key for the PTY output buffer list. */
const bufferKey = (nodeId: string) => `pty:buffer:${nodeId}`;

// ── In-memory session registry ────────────────────────────────────────────────

interface ManagedSession {
  nodeId: string;
  username: string;
  sshSession: SSHSession;
  /** Set of currently attached socket IDs. */
  attachedSockets: Set<string>;
  /** Per-socket cleanup callbacks (input/resize listeners). */
  socketCleanups: Map<string, () => void>;
}

/** Singleton in-memory map: nodeId → ManagedSession */
const sessions = new Map<string, ManagedSession>();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Opens a new SSH session for the given nodeId.
 * Throws if a session for this nodeId already exists.
 */
export async function startSession(
  nodeId: string,
  username: string,
  password: string,
  cols: number = 80,
  rows: number = 24,
  env?: Record<string, string>,
): Promise<void> {
  if (sessions.has(nodeId)) {
    throw new Error(`Session ${nodeId} already exists`);
  }

  const sshSession = await openSSHSession(username, password, cols, rows, env);

  const managed: ManagedSession = {
    nodeId,
    username,
    sshSession,
    attachedSockets: new Set(),
    socketCleanups: new Map(),
  };

  sessions.set(nodeId, managed);
  console.log(`[SSH] Session started: ${nodeId} (user: ${username})`);

  // If a DISPLAY value was provided, send it as the first shell command.
  // This is the most reliable way to set DISPLAY in the user's shell regardless
  // of whether sshd is configured with AcceptEnv DISPLAY.
  // The command is sent before any socket attaches, so it runs silently in the
  // background buffer and is replayed to the user when they first connect.
  if (env?.DISPLAY) {
    // Set DISPLAY and XAUTHORITY so X11 apps can find the Xpra display and
    // its MIT-MAGIC-COOKIE. XAUTHORITY defaults to ~/.Xauthority which is
    // where Xpra stores the cookie when it starts.
    sshSession.stream.write(
      `export DISPLAY=${env.DISPLAY}; export XAUTHORITY="$HOME/.Xauthority"\n`,
    );
  }

  // Stream SSH output → Redis buffer + all attached sockets
  sshSession.stream.on('data', (data: Buffer) => {
    const chunk = data.toString('utf8');
    _bufferChunk(nodeId, chunk);
    _broadcastToSockets(managed, chunk);
  });

  sshSession.stream.stderr?.on('data', (data: Buffer) => {
    const chunk = data.toString('utf8');
    _bufferChunk(nodeId, chunk);
    _broadcastToSockets(managed, chunk);
  });

  // When the SSH stream closes (e.g. user typed 'exit'), clean up
  sshSession.stream.on('close', () => {
    console.log(`[SSH] Stream closed naturally: ${nodeId}`);
    const msg = '\r\n[Session closed]\r\n';
    _bufferChunk(nodeId, msg);
    _broadcastToSockets(managed, msg);
    // Detach all sockets gracefully before removing the session
    for (const socketId of [...managed.attachedSockets]) {
      const cleanup = managed.socketCleanups.get(socketId);
      if (cleanup) cleanup();
    }
    sessions.delete(nodeId);
    _clearBuffer(nodeId);
  });
}

/**
 * Returns true if a live session exists for the given nodeId.
 */
export function hasSession(nodeId: string): boolean {
  return sessions.has(nodeId);
}

/**
 * Attaches a WebSocket to an existing session.
 * Replays the recent output buffer to the socket, then pipes live output.
 */
export async function attachSocket(nodeId: string, socket: Socket): Promise<void> {
  const managed = sessions.get(nodeId);
  if (!managed) {
    socket.emit('error', { message: 'Session not found or not yet started' });
    socket.disconnect();
    return;
  }

  console.log(`[SSH] Socket attached: ${socket.id} → session ${nodeId}`);

  // Replay buffered output so the user sees recent history
  const buffer = await redis.lrange(bufferKey(nodeId), 0, -1);
  if (buffer.length > 0) {
    socket.emit('terminal_output', buffer.join(''));
  }

  // Register this socket
  managed.attachedSockets.add(socket.id);

  // Browser input → SSH
  const onInput = (data: string) => {
    managed.sshSession.stream.write(data);
  };

  // PTY resize
  const onResize = (data: { cols: number; rows: number }) => {
    resizeSSHSession(managed.sshSession.stream, data.cols, data.rows);
  };

  socket.on('terminal_input', onInput);
  socket.on('terminal_resize', onResize);

  // Store cleanup so detachSocket can remove listeners
  managed.socketCleanups.set(socket.id, () => {
    socket.off('terminal_input', onInput);
    socket.off('terminal_resize', onResize);
    managed.attachedSockets.delete(socket.id);
    managed.socketCleanups.delete(socket.id);
  });
}

/**
 * Detaches a WebSocket from a session without closing the SSH connection.
 * The SSH session remains alive and buffering continues.
 */
export function detachSocket(nodeId: string, socketId: string): void {
  const managed = sessions.get(nodeId);
  if (!managed) return;
  const cleanup = managed.socketCleanups.get(socketId);
  if (cleanup) {
    cleanup();
    console.log(`[SSH] Socket detached: ${socketId} from session ${nodeId}`);
  }
}

/**
 * Gracefully or forcibly terminates a session and cleans up all state.
 * @param force  If true, destroys the SSH client immediately.
 *               If false, sends EOF to the shell stream (graceful exit).
 */
export async function terminateSession(nodeId: string, force: boolean = false): Promise<void> {
  const managed = sessions.get(nodeId);
  if (!managed) return;

  // Detach all sockets
  for (const socketId of [...managed.attachedSockets]) {
    const cleanup = managed.socketCleanups.get(socketId);
    if (cleanup) cleanup();
  }

  if (force) {
    try { managed.sshSession.client.destroy(); } catch { /* ignore */ }
  } else {
    try { closeSSHSession(managed.sshSession); } catch { /* ignore */ }
  }

  sessions.delete(nodeId);
  await _clearBuffer(nodeId);
  console.log(`[SSH] Session terminated: ${nodeId} (force=${force})`);
}

/**
 * Terminates all live sessions belonging to a user.
 */
export async function terminateAllUserSessions(
  username: string,
  force: boolean = false,
): Promise<void> {
  const toTerminate = [...sessions.values()]
    .filter((s) => s.username === username)
    .map((s) => s.nodeId);

  for (const nodeId of toTerminate) {
    await terminateSession(nodeId, force);
  }
}

/**
 * Returns the raw ManagedSession for a nodeId, or undefined.
 * Used internally and by control.ts for admin operations.
 */
export function getSession(nodeId: string): ManagedSession | undefined {
  return sessions.get(nodeId);
}

// ── Private helpers ───────────────────────────────────────────────────────────

/** Appends a chunk to the Redis buffer and trims to BUFFER_MAX_CHUNKS. */
function _bufferChunk(nodeId: string, chunk: string): void {
  const key = bufferKey(nodeId);
  // Fire-and-forget — we don't await to avoid blocking the data handler
  redis.rpush(key, chunk)
    .then(() => redis.ltrim(key, -BUFFER_MAX_CHUNKS, -1))
    .catch(() => { /* ignore Redis errors in the data path */ });
}

/** Broadcasts a chunk to all attached sockets. */
function _broadcastToSockets(managed: ManagedSession, chunk: string): void {
  for (const socketId of managed.attachedSockets) {
    // We don't have direct socket references here; they are looked up via
    // the cleanup map. Instead we store socket references alongside cleanups.
    // See _getSocket() below.
    const sock = _socketRefs.get(socketId);
    if (sock) {
      sock.emit('terminal_output', chunk);
    }
  }
}

/** Secondary map: socketId → Socket reference for broadcasting. */
const _socketRefs = new Map<string, Socket>();

/** Clears the Redis buffer for a session. */
async function _clearBuffer(nodeId: string): Promise<void> {
  await redis.del(bufferKey(nodeId)).catch(() => { /* ignore */ });
}

/**
 * Registers a socket reference so _broadcastToSockets can reach it.
 * Called by attachSocket; cleaned up by detachSocket.
 */
export function registerSocketRef(socket: Socket): void {
  _socketRefs.set(socket.id, socket);
}

export function unregisterSocketRef(socketId: string): void {
  _socketRefs.delete(socketId);
}
