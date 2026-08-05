import { Server as SocketIOServer, Namespace, Socket } from 'socket.io';
import { getNode } from '../session/store';
import { openSSHSession, resizeSSHSession, closeSSHSession } from '../ssh/manager';
import { AuthPayload } from '../middleware/auth';
import { redis } from '../session/store';

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

    // Retrieve the temporarily stored password
    const password = await redis.get(`session:password:${nodeId}`);
    if (!password && auth.role !== 'admin') {
      socket.emit('error', { message: 'Session credentials expired. Please create a new terminal.' });
      socket.disconnect();
      return;
    }

    // Join the node room so force_close_tabs can reach this socket
    socket.join(`node:${nodeId}`);

    // Open SSH session
    let sshSession: Awaited<ReturnType<typeof openSSHSession>> | null = null;

    try {
      sshSession = await openSSHSession(node.username, password!, 80, 24);
    } catch (err) {
      socket.emit('error', { message: `SSH connection failed: ${(err as Error).message}` });
      socket.disconnect();
      return;
    }

    const { stream } = sshSession;

    // Stream SSH output → browser
    stream.on('data', (data: Buffer) => {
      socket.emit('terminal_output', data.toString('utf8'));
    });

    stream.stderr?.on('data', (data: Buffer) => {
      socket.emit('terminal_output', data.toString('utf8'));
    });

    stream.on('close', () => {
      socket.emit('terminal_output', '\r\n[Session closed]\r\n');
      socket.disconnect();
    });

    // Browser input → SSH
    socket.on('terminal_input', (data: string) => {
      stream.write(data);
    });

    // PTY resize
    socket.on('terminal_resize', (data: { cols: number; rows: number }) => {
      resizeSSHSession(stream, data.cols, data.rows);
    });

    // Cleanup on disconnect
    socket.on('disconnect', () => {
      if (sshSession) {
        closeSSHSession(sshSession);
        sshSession = null;
      }
    });
  });
}
