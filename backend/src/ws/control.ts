/**
 * control.ts — WebSocket namespace for session tree management.
 *
 * Responsibilities:
 *   - Serve the session hierarchy tree to users and admin in real-time.
 *   - Handle new_terminal: create the node, start the persistent SSH session,
 *     and start the Xpra server for the user.
 *   - Handle close_node: terminate the SSH session, stop Xpra, remove the node.
 *   - Handle admin_terminate: graceful or force-kill sessions per node or per user.
 *   - Handle disconnect (tree window close): signal all device tabs to close.
 *   - Poll Xpra for new/closed GUI windows and update the session tree in real-time.
 *
 * The password is used only at session creation time and is never stored
 * in Redis. Once the SSH session is open, the password is no longer needed.
 * The Xpra manager also needs the password to run SSH commands; it is kept
 * in a per-user in-memory map (cleared on session termination).
 */

import { Server as SocketIOServer, Namespace, Socket } from 'socket.io';
import {
  buildUserTree,
  createNode,
  deleteNode,
  renameNode,
  getAllActiveUsers,
  getUserNodes,
  getNode,
  getChildNodes,
} from '../session/store';
import {
  startSession,
  terminateSession,
  terminateAllUserSessions,
  hasSession,
} from '../session/sshSessionManager';
import {
  startXpraSession,
  stopXpraSession,
  getXpraSession,
  diffXpraWindows,
  XpraWindow,
} from '../xpra/manager';
import { AuthPayload } from '../middleware/auth';

// ── Per-user password cache (in-memory only, never persisted) ─────────────────
// Needed so the Xpra window poller can run SSH commands without re-prompting.
const _passwordCache = new Map<string, string>();

// ── Xpra window poller ────────────────────────────────────────────────────────
// Maps username → xpraWindow nodeId (keyed by wid)
const _xpraWindowNodes = new Map<string, Map<number, string>>(); // username → (wid → nodeId)

// ── Tree broadcast helpers ────────────────────────────────────────────────────

async function broadcastTree(ns: Namespace, username: string): Promise<void> {
  const tree = await buildUserTree(username);
  ns.to(`user:${username}`).emit('tree_update', { username, tree });
  ns.to('admin').emit('tree_update', { username, tree });
}

async function broadcastFullAdminTree(ns: Namespace): Promise<void> {
  const users = await getAllActiveUsers();
  const fullTree: Record<string, unknown> = {};
  for (const u of users) {
    fullTree[u] = await buildUserTree(u);
  }
  ns.to('admin').emit('admin_tree_update', { tree: fullTree });
}

// ── Xpra window polling ───────────────────────────────────────────────────────

/**
 * Polls Xpra for new/closed windows for a user and updates the session tree.
 * Called on a 3-second interval while the user has an active Xpra session.
 */
async function _pollXpraWindows(
  ns: Namespace,
  username: string,
  terminalNodeId: string,
): Promise<void> {
  const password = _passwordCache.get(username);
  if (!password) return;

  const xpraSession = getXpraSession(username);
  if (!xpraSession) return;

  try {
    const { added, removed } = await diffXpraWindows(username, password);

    let changed = false;

    // Create nodes for newly appeared windows
    for (const win of added) {
      const name = _uniqueWindowName(username, win.title);
      const node = await createNode(
        username, 'xpra', terminalNodeId, name, xpraSession.port,
      );
      if (!_xpraWindowNodes.has(username)) {
        _xpraWindowNodes.set(username, new Map());
      }
      _xpraWindowNodes.get(username)!.set(win.wid, node.nodeId);
      console.log(`[Xpra] New window for ${username}: "${win.title}" → node ${node.nodeId}`);
      changed = true;
    }

    // Remove nodes for windows that have closed
    for (const win of removed) {
      const widMap = _xpraWindowNodes.get(username);
      if (!widMap) continue;
      const nodeId = widMap.get(win.wid);
      if (nodeId) {
        await deleteNode(nodeId);
        widMap.delete(win.wid);
        console.log(`[Xpra] Window closed for ${username}: wid ${win.wid} → node ${nodeId}`);
        changed = true;
      }
    }

    if (changed) {
      await broadcastTree(ns, username);
    }
  } catch (err) {
    // Polling errors are non-fatal — log and continue
    console.warn(`[Xpra] Poll error for ${username}: ${(err as Error).message}`);
  }
}

/** Generates a unique display name for an Xpra window, appending (N) if needed. */
function _uniqueWindowName(username: string, title: string): string {
  const widMap = _xpraWindowNodes.get(username);
  if (!widMap) return title;
  // Count existing windows with the same base title
  const count = [...widMap.values()].length; // approximate — good enough for naming
  return count === 0 ? title : `${title} (${count + 1})`;
}

// ── Per-user Xpra poll intervals ──────────────────────────────────────────────
const _pollIntervals = new Map<string, ReturnType<typeof setInterval>>();

function _startPolling(ns: Namespace, username: string, terminalNodeId: string): void {
  if (_pollIntervals.has(username)) return; // already polling
  const interval = setInterval(
    () => _pollXpraWindows(ns, username, terminalNodeId),
    3000,
  );
  _pollIntervals.set(username, interval);
  console.log(`[Xpra] Started window polling for ${username}`);
}

function _stopPolling(username: string): void {
  const interval = _pollIntervals.get(username);
  if (interval) {
    clearInterval(interval);
    _pollIntervals.delete(username);
    console.log(`[Xpra] Stopped window polling for ${username}`);
  }
}

// ── Namespace registration ────────────────────────────────────────────────────

export function registerControlNamespace(
  io: SocketIOServer,
  middleware: (socket: Socket, next: (err?: Error) => void) => void,
): void {
  const ns: Namespace = io.of('/ws/control');
  const terminalNs: Namespace = io.of('/ws/terminal');
  const xpraNs: Namespace = io.of('/ws/xpra');
  ns.use(middleware);

  ns.on('connection', async (socket: Socket) => {
    const auth = socket.data.auth as AuthPayload;

    if (auth.role === 'admin') {
      socket.join('admin');
      await broadcastFullAdminTree(ns);
    } else {
      socket.join(`user:${auth.username}`);
      const tree = await buildUserTree(auth.username);
      socket.emit('tree_update', { username: auth.username, tree });
    }

    // Join device room for targeted close signals
    const deviceId = socket.handshake.auth?.deviceId as string | undefined;
    if (deviceId) {
      socket.join(`device:${deviceId}`);
    }

    // ── request_tree ────────────────────────────────────────────────────────
    socket.on('request_tree', async () => {
      if (auth.role === 'admin') {
        await broadcastFullAdminTree(ns);
      } else {
        const tree = await buildUserTree(auth.username);
        socket.emit('tree_update', { username: auth.username, tree });
      }
    });

    // ── new_terminal ────────────────────────────────────────────────────────
    socket.on('new_terminal', async (data: { password?: string }) => {
      if (auth.role === 'admin') return; // admin cannot create terminals

      if (!data.password) {
        socket.emit('error', { message: 'Password is required to start a terminal session.' });
        return;
      }

      // Generate a unique terminal name
      const existing = await getUserNodes(auth.username);
      const terminalCount = existing.filter((n) => n.type === 'terminal').length;
      const name = `Terminal ${terminalCount + 1}`;

      // Create the node in the session store
      const node = await createNode(auth.username, 'terminal', null, name);

      // Start the persistent SSH session immediately
      // The password is used here and never stored anywhere except the in-memory cache
      try {
        await startSession(node.nodeId, auth.username, data.password);
      } catch (err) {
        await deleteNode(node.nodeId);
        socket.emit('error', {
          message: `SSH connection failed: ${(err as Error).message}`,
        });
        return;
      }

      // Cache the password for Xpra SSH commands (in-memory only)
      _passwordCache.set(auth.username, data.password);

      // Start Xpra server for this user (if not already running)
      try {
        await startXpraSession(auth.username, data.password, node.nodeId);
        _startPolling(ns, auth.username, node.nodeId);
      } catch (err) {
        // Xpra failure is non-fatal — terminal still works
        console.warn(`[Xpra] Failed to start session for ${auth.username}: ${(err as Error).message}`);
      }

      await broadcastTree(ns, auth.username);
      socket.emit('terminal_created', { nodeId: node.nodeId, name: node.name });
    });

    // ── rename_node ─────────────────────────────────────────────────────────
    socket.on('rename_node', async (data: { nodeId: string; newName: string }) => {
      const node = await getNode(data.nodeId);
      if (!node) return;
      if (auth.role !== 'admin' && node.username !== auth.username) return;

      await renameNode(data.nodeId, data.newName);
      await broadcastTree(ns, node.username);
    });

    // ── close_node ──────────────────────────────────────────────────────────
    socket.on('close_node', async (data: { nodeId: string }) => {
      const node = await getNode(data.nodeId);
      if (!node) return;
      if (auth.role !== 'admin' && node.username !== auth.username) return;

      await _terminateNodeAndChildren(data.nodeId);
      await deleteNode(data.nodeId);

      // If this was a terminal node, stop Xpra and polling
      if (node.type === 'terminal' && node.parentId === null) {
        const password = _passwordCache.get(node.username);
        if (password) {
          _stopPolling(node.username);
          await stopXpraSession(node.username, password).catch(() => {});
          _xpraWindowNodes.delete(node.username);
          // Only clear password cache if user has no more terminal sessions
          const remaining = await getUserNodes(node.username);
          const hasMoreTerminals = remaining.some((n) => n.type === 'terminal');
          if (!hasMoreTerminals) {
            _passwordCache.delete(node.username);
          }
        }
      }

      await broadcastTree(ns, node.username);
      ns.to(`node:${data.nodeId}`).emit('force_close_tabs', { nodeId: data.nodeId });
    });

    // ── admin_terminate ─────────────────────────────────────────────────────
    socket.on('admin_terminate', async (data: {
      userId: string;
      nodeId?: string;
      force: boolean;
    }) => {
      if (auth.role !== 'admin') return;

      const targetUsername = data.userId;

      if (data.nodeId) {
        const node = await getNode(data.nodeId);
        if (!node) return;

        await _terminateNodeAndChildren(data.nodeId, data.force);
        await deleteNode(data.nodeId);
        await broadcastTree(ns, targetUsername);
        ns.to(`node:${data.nodeId}`).emit('force_close_tabs', { nodeId: data.nodeId });
      } else {
        // Terminate ALL sessions for the user
        _stopPolling(targetUsername);
        const password = _passwordCache.get(targetUsername);
        if (password) {
          await stopXpraSession(targetUsername, password).catch(() => {});
        }
        _passwordCache.delete(targetUsername);
        _xpraWindowNodes.delete(targetUsername);

        await terminateAllUserSessions(targetUsername, data.force);
        const nodes = await getUserNodes(targetUsername);
        for (const n of nodes) {
          ns.to(`node:${n.nodeId}`).emit('force_close_tabs', { nodeId: n.nodeId });
          await deleteNode(n.nodeId);
        }
        await broadcastFullAdminTree(ns);
      }

      // Notify the affected user (requires acknowledgement on the frontend)
      ns.to(`user:${targetUsername}`).emit('admin_notification', {
        message: 'Your session has been terminated by an administrator.',
      });
    });

    // ── disconnect: tree window closed ──────────────────────────────────────
    socket.on('disconnect', async () => {
      if (auth.role === 'admin') return;
      if (!deviceId) return;
      // Broadcast force_close_tabs to this device across ALL namespaces.
      const payload = { deviceId };
      ns.to(`device:${deviceId}`).emit('force_close_tabs', payload);
      terminalNs.to(`device:${deviceId}`).emit('force_close_tabs', payload);
      xpraNs.to(`device:${deviceId}`).emit('force_close_tabs', payload);
      // SSH sessions remain alive — they are NOT terminated on tree close
    });
  });
}

// ── Helper: recursively terminate SSH sessions for a node and its children ───

async function _terminateNodeAndChildren(
  nodeId: string,
  force: boolean = false,
): Promise<void> {
  const node = await getNode(nodeId);
  if (!node) return;

  const children = await getChildNodes(nodeId);
  for (const child of children) {
    await _terminateNodeAndChildren(child.nodeId, force);
  }

  if (hasSession(nodeId)) {
    await terminateSession(nodeId, force);
  }
}
