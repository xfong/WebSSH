/**
 * terminal.ts — WebSocket namespace for terminal session attachment.
 *
 * This handler no longer owns SSH connections. Instead it:
 *   1. Verifies the nodeId and user ownership.
 *   2. Calls attachSocket() to pipe the persistent SSH session to this socket.
 *   3. On disconnect, calls detachSocket() — the SSH session stays alive.
 *
 * The SSH session must already exist (started by control.ts when the user
 * clicked "+"). If the session is not yet running (e.g. the backend restarted),
 * the client is informed and must re-create the terminal.
 */

import { Server as SocketIOServer, Namespace, Socket } from 'socket.io';
import { getNode } from '../session/store';
import {
  hasSession,
  attachSocket,
  detachSocket,
  registerSocketRef,
  unregisterSocketRef,
} from '../session/sshSessionManager';
import { AuthPayload } from '../middleware/auth';

export function registerTerminalNamespace(
  io: SocketIOServer,
  middleware: (socket: Socket, next: (err?: Error) => void) => void
): void {
  const ns: Namespace = io.of('/ws/terminal');
  ns.use(middleware);

  ns.on('connection', async (socket: Socket) => {
    const auth = socket.data.auth as AuthPayload;
    const nodeId = socket.handshake.query.nodeId as string;

    if (!nodeId) {
      socket.emit('error', { message: 'nodeId is required' });
      socket.disconnect();
      return;
    }

    // Verify the node exists in the session store
    const node = await getNode(nodeId);
    if (!node) {
      socket.emit('error', { message: 'Session not found' });
      socket.disconnect();
      return;
    }

    // Verify ownership (admin can observe any session)
    if (auth.role !== 'admin' && node.username !== auth.username) {
      socket.emit('error', { message: 'Forbidden' });
      socket.disconnect();
      return;
    }

    // Check that the persistent SSH session is running
    if (!hasSession(nodeId)) {
      socket.emit('error', {
        message:
          'SSH session is not running. The server may have restarted. ' +
          'Please close this terminal and create a new one.',
      });
      socket.disconnect();
      return;
    }

    // Join the node room so force_close_tabs can reach this socket
    socket.join(`node:${nodeId}`);

    // Join the device room so tree-window-close force_close_tabs reaches this tab
    const deviceId = socket.handshake.auth?.deviceId as string | undefined;
    if (deviceId) {
      socket.join(`device:${deviceId}`);
    }

    // Register socket reference for broadcasting
    registerSocketRef(socket);

    // Attach this socket to the persistent SSH session
    // (replays buffer, registers input/resize handlers)
    await attachSocket(nodeId, socket);

    // On disconnect: detach from the SSH session (SSH stays alive)
    socket.on('disconnect', () => {
      detachSocket(nodeId, socket.id);
      unregisterSocketRef(socket.id);
    });
  });
}
