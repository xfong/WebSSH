import { Server as SocketIOServer, Namespace, Socket } from 'socket.io';
import WebSocket from 'ws';
import { getNode } from '../session/store';
import { getXpraProxyUrl } from '../xpra/manager';
import { AuthPayload } from '../middleware/auth';

/**
 * Proxies the Xpra HTML5 WebSocket protocol between the browser client
 * and the Xpra daemon running in the xpra container.
 */
export function registerXpraNamespace(
  io: SocketIOServer,
  middleware: (socket: Socket, next: (err?: Error) => void) => void
): void {
  const ns: Namespace = io.of('/ws/xpra');
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
    if (!node || node.type !== 'xpra') {
      socket.emit('error', { message: 'Xpra session not found' });
      socket.disconnect();
      return;
    }

    if (auth.role !== 'admin' && node.username !== auth.username) {
      socket.emit('error', { message: 'Forbidden' });
      socket.disconnect();
      return;
    }

    if (!node.xpraPort) {
      socket.emit('error', { message: 'No Xpra port assigned to this session' });
      socket.disconnect();
      return;
    }

    socket.join(`node:${nodeId}`);

    const xpraUrl = getXpraProxyUrl(node.xpraPort);
    const upstream = new WebSocket(xpraUrl, { rejectUnauthorized: false });

    upstream.on('open', () => {
      socket.emit('xpra_ready');
    });

    // Relay Xpra → browser
    upstream.on('message', (data: WebSocket.RawData) => {
      socket.emit('xpra_data', data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer));
    });

    upstream.on('close', () => {
      socket.emit('xpra_closed');
      socket.disconnect();
    });

    upstream.on('error', (err) => {
      socket.emit('error', { message: `Xpra upstream error: ${err.message}` });
      socket.disconnect();
    });

    // Relay browser → Xpra
    socket.on('xpra_data', (data: Buffer | string) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data);
      }
    });

    socket.on('disconnect', () => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.close();
      }
    });
  });
}
