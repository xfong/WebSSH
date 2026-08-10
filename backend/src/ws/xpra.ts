/**
 * ws/xpra.ts
 *
 * Proxies raw WebSocket traffic between the browser's Xpra HTML5 client
 * and the Xpra server running on the SSH host.
 *
 * The Xpra HTML5 client speaks the Xpra binary protocol over WebSocket.
 * This handler acts as a transparent TCP-level proxy: every binary frame
 * received from the browser is forwarded to the Xpra server, and vice versa.
 *
 * Connection flow:
 *   Browser → nginx (wss://.../ws/xpra/?nodeId=...) → this handler
 *   This handler → ws://SSH_HOST:XPRA_PORT (Xpra HTML5 server)
 */

import { Server as SocketIOServer, Namespace, Socket } from 'socket.io';
import WebSocket from 'ws';
import { getNode } from '../session/store';
import { getXpraWsUrl } from '../xpra/manager';
import { AuthPayload } from '../middleware/auth';

export function registerXpraNamespace(
  io: SocketIOServer,
  middleware: (socket: Socket, next: (err?: Error) => void) => void,
): void {
  const ns: Namespace = io.of('/ws/xpra');
  ns.use(middleware);

  ns.on('connection', async (socket: Socket) => {
    const auth = socket.data.auth as AuthPayload;
    // nodeId may arrive in query (Socket.IO query option) or auth (Socket.IO auth option)
    const nodeId = (socket.handshake.query.nodeId ||
                    socket.handshake.auth?.nodeId) as string | undefined;

    console.log(`[Xpra] Connection attempt: nodeId=${nodeId}, query=${JSON.stringify(socket.handshake.query)}, auth keys=${Object.keys(socket.handshake.auth || {})}`);

    if (!nodeId) {
      socket.emit('error', { message: 'nodeId is required' });
      socket.disconnect();
      return;
    }

    // Validate the node exists and is an xpra type
    const node = await getNode(nodeId);
    if (!node || node.type !== 'xpra') {
      socket.emit('error', { message: 'Xpra session not found' });
      socket.disconnect();
      return;
    }

    // Authorisation: owner or admin
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

    // Open upstream WebSocket to the Xpra HTML5 server
    const xpraUrl = getXpraWsUrl(node.xpraPort);
    console.log(`[Xpra] Connecting upstream: ${xpraUrl} for node ${nodeId}`);

    const upstream = new WebSocket(xpraUrl, ['binary'], {
      rejectUnauthorized: false,
    });

    upstream.on('open', () => {
      console.log(`[Xpra] Upstream connected for node ${nodeId}`);
      socket.emit('xpra_ready');
    });

    // Relay Xpra server → browser (binary frames)
    upstream.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (socket.connected) {
        const buf = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
        socket.emit('xpra_data', buf, isBinary);
      }
    });

    upstream.on('close', (code, reason) => {
      console.log(`[Xpra] Upstream closed for node ${nodeId}: ${code} ${reason}`);
      if (socket.connected) {
        socket.emit('xpra_closed');
        socket.disconnect();
      }
    });

    upstream.on('error', (err) => {
      console.error(`[Xpra] Upstream error for node ${nodeId}: ${err.message}`);
      if (socket.connected) {
        socket.emit('error', { message: `Xpra upstream error: ${err.message}` });
        socket.disconnect();
      }
    });

    // Relay browser → Xpra server (binary frames)
    socket.on('xpra_data', (data: Buffer | ArrayBuffer | string) => {
      if (upstream.readyState === WebSocket.OPEN) {
        const buf = data instanceof Buffer
          ? data
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : Buffer.from(data as string, 'binary');
        upstream.send(buf, { binary: true });
      }
    });

    socket.on('disconnect', (reason) => {
      console.log(`[Xpra] Browser disconnected for node ${nodeId}: ${reason}`);
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
      }
    });
  });
}
