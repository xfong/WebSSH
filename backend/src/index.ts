import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { registerAuthRoutes } from './auth/routes';
import { registerConfigRoutes } from './utils/configRoutes';
import { registerControlNamespace } from './ws/control';
import { registerTerminalNamespace } from './ws/terminal';
import { registerXpraNamespace } from './ws/xpra';
import { authMiddleware } from './middleware/auth';

const PORT = parseInt(process.env.PORT || '3000', 10);

const app = express();
app.use(express.json());

// ── REST routes ───────────────────────────────────────────────────────────────
registerAuthRoutes(app);
registerConfigRoutes(app);

// ── HTTP server + Socket.IO ───────────────────────────────────────────────────
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*' },
  // Allow both websocket and polling transports.
  // Socket.IO always starts with a polling handshake to exchange the session ID
  // before upgrading to WebSocket, even when the client requests websocket-only.
  // Restricting to ['websocket'] here causes the auth middleware to run on the
  // root namespace (which has no namespace middleware support in Socket.IO v4)
  // and prevents socket.data from being populated before namespace handlers fire.
  transports: ['websocket', 'polling'],
});

// ── WebSocket namespaces ──────────────────────────────────────────────────────
// Register authMiddleware on each namespace individually.
// In Socket.IO v4, io.use() middleware does NOT propagate to child namespaces;
// each namespace must register its own middleware for socket.data to be populated.
// The control namespace needs the full io server so it can broadcast
// force_close_tabs across all namespaces when the tree window closes.
registerControlNamespace(io, authMiddleware);
registerTerminalNamespace(io, authMiddleware);
registerXpraNamespace(io, authMiddleware);

httpServer.listen(PORT, () => {
  console.log(`WebSSH backend listening on port ${PORT}`);
});
