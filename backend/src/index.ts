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
  transports: ['websocket'],
});

// Attach JWT auth middleware to all Socket.IO namespaces
io.use(authMiddleware);

// ── WebSocket namespaces ──────────────────────────────────────────────────────
registerControlNamespace(io);
registerTerminalNamespace(io);
registerXpraNamespace(io);

httpServer.listen(PORT, () => {
  console.log(`WebSSH backend listening on port ${PORT}`);
});
