/**
 * control.ts — WebSocket namespace for session tree management.
 *
 * Responsibilities:
 *   - Serve the session hierarchy tree to users and admin in real-time.
 *   - Handle new_terminal: create the node AND start the persistent SSH session.
 *   - Handle close_node: terminate the SSH session and remove the node.
 *   - Handle admin_terminate: graceful or force-kill sessions per node or per user.
 *   - Handle disconnect (tree window close): signal all device tabs to close.
 *
 * The password is used only at session creation time and is never stored
 * in Redis. Once the SSH session is open, the password is no longer needed.
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
} from '../session/store';
import {
  startSession,
  terminateSession,
  terminateAllUserSessions,
  hasSession,
} from '../session/sshSessionManager';
import { AuthPayload } from '../middleware/auth';

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

// ── Namespace registration ────────────────────────────────────────────────────

export function registerControlNamespace(
  io: SocketIOServer,
  middleware: (socket: Socket, next: (err?: Error) => void) => void
): void {
  const ns: Namespace = io.of('/ws/control');
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
      // The password is used here and never stored anywhere
      try {
        await startSession(node.nodeId, auth.username, data.password);
      } catch (err) {
        // If SSH fails, remove the node and report the error
        await deleteNode(node.nodeId);
        socket.emit('error', {
          message: `SSH connection failed: ${(err as Error).message}`,
        });
        return;
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

      // Terminate the SSH session (and all children recursively via deleteNode)
      await _terminateNodeAndChildren(data.nodeId);
      await deleteNode(data.nodeId);
      await broadcastTree(ns, node.username);

      // Signal all tabs viewing this node to close
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
        // Terminate a specific node (and its children)
        const node = await getNode(data.nodeId);
        if (!node) return;

        await _terminateNodeAndChildren(data.nodeId, data.force);
        await deleteNode(data.nodeId);
        await broadcastTree(ns, targetUsername);
        ns.to(`node:${data.nodeId}`).emit('force_close_tabs', { nodeId: data.nodeId });
      } else {
        // Terminate ALL sessions for the user
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
      // Signal all session tabs on this device to close
      if (deviceId) {
        ns.to(`device:${deviceId}`).emit('force_close_tabs', { deviceId });
      }
      // SSH sessions remain alive — they are NOT terminated on tree close
    });
  });
}

// ── Helper: recursively terminate SSH sessions for a node and its children ───

async function _terminateNodeAndChildren(
  nodeId: string,
  force: boolean = false,
): Promise<void> {
  // Terminate children first (depth-first)
  const node = await getNode(nodeId);
  if (!node) return;

  const { getChildNodes } = await import('../session/store');
  const children = await getChildNodes(nodeId);
  for (const child of children) {
    await _terminateNodeAndChildren(child.nodeId, force);
  }

  // Terminate this node's SSH session if it is running
  if (hasSession(nodeId)) {
    await terminateSession(nodeId, force);
  }
}
