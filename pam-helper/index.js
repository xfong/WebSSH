'use strict';

/**
 * WebSSH PAM Authentication Helper
 *
 * Runs as a privileged service on the Docker host (outside any container).
 * Listens on a Unix domain socket and authenticates users via the host's
 * PAM stack (which in turn calls SSSD for LDAP/AD users and handles local
 * accounts natively).
 *
 * Protocol (newline-delimited JSON over the Unix socket):
 *   Request:  { "username": "...", "password": "..." }
 *   Response: { "ok": true }  or  { "ok": false, "error": "..." }
 *
 * The socket is created at SOCKET_PATH (default: /run/webssh/pam.sock).
 * Permissions are set to 0660 so that the Docker container's process
 * (running as a non-root user in the webssh group) can connect.
 */

const net  = require('net');
const fs   = require('fs');
const path = require('path');
const pam  = require('authenticate-pam');

const SOCKET_PATH = process.env.WEBSSH_PAM_SOCKET || '/run/webssh/pam.sock';
const PAM_SERVICE = process.env.WEBSSH_PAM_SERVICE || 'login';
const SOCKET_GID  = process.env.WEBSSH_SOCKET_GID  || null; // optional: numeric GID

// ── Ensure socket directory exists ───────────────────────────────────────────
const socketDir = path.dirname(SOCKET_PATH);
if (!fs.existsSync(socketDir)) {
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o755 });
}

// ── Remove stale socket from a previous run ───────────────────────────────────
if (fs.existsSync(SOCKET_PATH)) {
  fs.unlinkSync(SOCKET_PATH);
}

// ── PAM authentication wrapper ────────────────────────────────────────────────
function authenticate(username, password) {
  return new Promise((resolve, reject) => {
    pam.authenticate(username, password, (err) => {
      if (err) {
        reject(new Error(err));
      } else {
        resolve(true);
      }
    }, { serviceName: PAM_SERVICE });
  });
}

// ── Unix socket server ────────────────────────────────────────────────────────
const server = net.createServer((socket) => {
  let buffer = '';

  socket.on('data', (chunk) => {
    buffer += chunk.toString();

    // Process all complete newline-delimited JSON messages in the buffer.
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (!line) continue;

      let request;
      try {
        request = JSON.parse(line);
      } catch {
        socket.write(JSON.stringify({ ok: false, error: 'Invalid JSON request' }) + '\n');
        continue;
      }

      const { username, password } = request;
      if (typeof username !== 'string' || typeof password !== 'string') {
        socket.write(JSON.stringify({ ok: false, error: 'Missing username or password' }) + '\n');
        continue;
      }

      authenticate(username, password)
        .then(() => {
          socket.write(JSON.stringify({ ok: true }) + '\n');
        })
        .catch((err) => {
          // Distinguish between auth failure and unexpected errors.
          const msg = err.message || String(err);
          const isAuthFailure = /authentication failure|incorrect password|user not known/i.test(msg);
          socket.write(JSON.stringify({
            ok: false,
            error: isAuthFailure ? 'Authentication failed' : msg,
          }) + '\n');
        });
    }
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err.message);
  });
});

server.listen(SOCKET_PATH, () => {
  // Set socket permissions: owner=root (rw), group=webssh (rw), others=none.
  fs.chmodSync(SOCKET_PATH, 0o660);

  // Optionally change the socket's group ownership.
  if (SOCKET_GID !== null) {
    try {
      fs.chownSync(SOCKET_PATH, 0, parseInt(SOCKET_GID, 10));
    } catch (err) {
      console.warn(`Could not set socket GID to ${SOCKET_GID}:`, err.message);
    }
  }

  console.log(`WebSSH PAM helper listening on ${SOCKET_PATH} (service: ${PAM_SERVICE})`);
});

server.on('error', (err) => {
  console.error('Server error:', err.message);
  process.exit(1);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`Received ${signal}, shutting down.`);
  server.close(() => {
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
