import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { registerAuthRoutes } from './auth/routes';
import { registerConfigRoutes } from './utils/configRoutes';
import { registerControlNamespace } from './ws/control';
import { registerTerminalNamespace } from './ws/terminal';
import { registerXpraNamespace } from './ws/xpra';
import { authMiddleware } from './middleware/auth';
import { JWT_SECRET, getAdminHash } from './utils/secrets';

// ── Startup validation ────────────────────────────────────────────────────────
// Fail fast with a clear error if required secrets are missing.
// Without JWT_SECRET every login attempt throws and hangs until nginx times out.
if (!JWT_SECRET) {
  console.error(
    'FATAL: JWT_SECRET is empty. ' +
    'Ensure docker/secrets/jwt_secret was written by setup.sh and is mounted ' +
    'at /run/secrets/jwt_secret inside the container. ' +
    'Re-run setup.sh to regenerate secrets.'
  );
  process.exit(1);
}
if (!getAdminHash()) {
  console.error(
    'FATAL: admin_hash is empty. ' +
    'Ensure docker/secrets/admin_hash was written by setup.sh and is mounted ' +
    'at /run/secrets/admin_hash inside the container. ' +
    'Re-run setup.sh to regenerate secrets.'
  );
  process.exit(1);
}

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
