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
import { openSSHSession, closeSSHSession } from '../ssh/manager';
import { AuthPayload } from '../middleware/auth';
import { redis } from '../session/store';

// In-memory map: nodeId -> SSH session (for graceful/force kill)
const sshSessions = new Map<string, ReturnType<typeof openSSHSession> extends Promise<infer T> ? T : never>();

/**
 * Broadcast updated tree to all relevant clients.
 * For a regular user: broadcast to that user's room.
 * For admin: broadcast to the admin room.
 */
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

export function registerControlNamespace(io: SocketIOServer): void {
  const ns: Namespace = io.of('/ws/control');

  ns.on('connection', async (socket: Socket) => {
    const auth = socket.data.auth as AuthPayload;

    if (auth.role === 'admin') {
      socket.join('admin');
      // Send full tree to admin on connect
      await broadcastFullAdminTree(ns);
    } else {
      socket.join(`user:${auth.username}`);
      // Send user's own tree on connect
      const tree = await buildUserTree(auth.username);
      socket.emit('tree_update', { username: auth.username, tree });
    }

    // ── request_tree ──────────────────────────────────────────────────────────
    socket.on('request_tree', async () => {
      if (auth.role === 'admin') {
        await broadcastFullAdminTree(ns);
      } else {
        const tree = await buildUserTree(auth.username);
        socket.emit('tree_update', { username: auth.username, tree });
      }
    });

    // ── new_terminal ──────────────────────────────────────────────────────────
    socket.on('new_terminal', async (data: { password?: string }) => {
      if (auth.role === 'admin') return; // admin cannot create terminals

      // Count existing terminals to generate a unique name
      const existing = await getUserNodes(auth.username);
      const terminalCount = existing.filter((n) => n.type === 'terminal').length;
      const name = `Terminal ${terminalCount + 1}`;

      const node = await createNode(auth.username, 'terminal', null, name);

      // Store password temporarily in Redis for the terminal WS handler to pick up
      if (data.password) {
        await redis.setex(`session:password:${node.nodeId}`, 300, data.password);
      }

      await broadcastTree(ns, auth.username);
      socket.emit('terminal_created', { nodeId: node.nodeId, name: node.name });
    });

    // ── rename_node ───────────────────────────────────────────────────────────
    socket.on('rename_node', async (data: { nodeId: string; newName: string }) => {
      const node = await getNode(data.nodeId);
      if (!node) return;
      if (auth.role !== 'admin' && node.username !== auth.username) return;

      await renameNode(data.nodeId, data.newName);
      await broadcastTree(ns, node.username);
    });

    // ── close_node ────────────────────────────────────────────────────────────
    socket.on('close_node', async (data: { nodeId: string }) => {
      const node = await getNode(data.nodeId);
      if (!node) return;
      if (auth.role !== 'admin' && node.username !== auth.username) return;

      await deleteNode(data.nodeId);
      await broadcastTree(ns, node.username);

      // Signal all tabs viewing this node to close
      ns.to(`node:${data.nodeId}`).emit('force_close_tabs', { nodeId: data.nodeId });
    });

    // ── admin_terminate ───────────────────────────────────────────────────────
    socket.on('admin_terminate', async (data: { userId: string; nodeId?: string; force: boolean }) => {
      if (auth.role !== 'admin') return;

      const targetUsername = data.userId;

      if (data.nodeId) {
        // Terminate a specific node
        const node = await getNode(data.nodeId);
        if (!node) return;

        if (!data.force) {
          // Graceful: send SIGHUP via SSH (best-effort)
          const session = sshSessions.get(data.nodeId);
          if (session) {
            try { closeSSHSession(session); } catch { /* ignore */ }
          }
        }

        await deleteNode(data.nodeId);
        await broadcastTree(ns, targetUsername);
        ns.to(`node:${data.nodeId}`).emit('force_close_tabs', { nodeId: data.nodeId });
      } else {
        // Terminate ALL sessions for the user
        const nodes = await getUserNodes(targetUsername);
        for (const n of nodes) {
          const session = sshSessions.get(n.nodeId);
          if (session) {
            try { closeSSHSession(session); } catch { /* ignore */ }
          }
          await deleteNode(n.nodeId);
          ns.to(`node:${n.nodeId}`).emit('force_close_tabs', { nodeId: n.nodeId });
        }
        await broadcastFullAdminTree(ns);
      }

      // Notify the affected user
      ns.to(`user:${targetUsername}`).emit('admin_notification', {
        message: 'Your session has been terminated by an administrator.',
      });
    });

    // ── disconnect: close tree window ─────────────────────────────────────────
    socket.on('disconnect', async () => {
      if (auth.role === 'admin') return;

      const deviceId = socket.handshake.auth?.deviceId as string | undefined;
      if (deviceId) {
        // Signal all session tabs on this device to close
        ns.to(`device:${deviceId}`).emit('force_close_tabs', { deviceId });
      }
    });

    // Join device room for targeted close signals
    const deviceId = socket.handshake.auth?.deviceId as string | undefined;
    if (deviceId) {
      socket.join(`device:${deviceId}`);
    }
  });
}
