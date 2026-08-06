# WebSSH — Known Issues

This file documents issues identified during code review and live testing. Issues are ranked by severity. Resolved issues are marked and retained for historical reference.

---

## Critical

### Issue 1 — SSH sessions are not persistent

**Area:** Backend / `backend/src/ws/terminal.ts`
**Status:** Open

Every time a user opens a terminal tab, `terminal.ts` opens a brand-new SSH shell connection. When the browser tab is closed or disconnected, the `disconnect` handler immediately calls `closeSSHSession`, tearing down the SSH connection. This means the backend SSH session does not survive browser closure, which directly violates the core specification requirement that backend sessions persist indefinitely until the user explicitly closes them.

**Required fix:** SSH sessions must be started once (when the terminal node is created) and kept alive in a persistent process manager or background map, independent of any browser WebSocket connection. Reconnecting to a terminal tab must re-attach to the existing running SSH PTY rather than opening a new one.

---

### Issue 2 — Password TTL breaks reconnection after 5 minutes

**Area:** Backend / `backend/src/ws/control.ts` and `backend/src/ws/terminal.ts`
**Status:** Open

When a new terminal is created, the user's SSH password is stored in Redis under `session:password:{nodeId}` with a hard-coded 5-minute TTL (`setex(..., 300, ...)`). When the terminal WebSocket connects, it retrieves this password to open the SSH session. If the user closes the browser and attempts to reconnect to the same terminal after 5 minutes, the password has expired and the connection is rejected with the error *"Session credentials expired. Please create a new terminal."*

This breaks the indefinite session persistence requirement. The password is only needed at the moment the SSH connection is first established. Once the SSH connection is open and held persistently (see Issue 1), the password no longer needs to be stored at all.

**Required fix:** Resolve Issue 1 first (persistent SSH sessions). Once SSH sessions are held alive independently of browser connections, the password only needs to be present at initial session creation time and does not need to be stored in Redis at all for reconnection purposes.

---

### Issue 3 — Xpra daemon is never launched; X11 support is a stub

**Area:** Backend / `backend/src/xpra/manager.ts` and `docker/xpra/entrypoint.sh`
**Status:** Open

The `startXpraSession` function in `xpra/manager.ts` only records session metadata in Redis. It does not actually spawn an Xpra daemon process. The Xpra container's `entrypoint.sh` simply runs `tail -f /dev/null` and waits indefinitely, providing no active Xpra service. As a result, no GUI window creation path is wired end-to-end and X11 application streaming is entirely non-functional.

**Required fix:** `startXpraSession` must SSH into the host (or execute within the Xpra container) to run `xpra start` with the appropriate display number, bind address, and port. The `entrypoint.sh` should start a base Xpra service or at minimum provide the environment required for per-user Xpra sessions to be spawned on demand. The `XpraPage.tsx` frontend currently renders an `<iframe>` pointing at `/xpra-client/?nodeId=...`, which also requires an Nginx route to the Xpra HTML5 client — this route is missing from `nginx.conf`.

---

## High

### Issue 4 — Admin graceful-terminate has no effect; `sshSessions` map is never populated

**Area:** Backend / `backend/src/ws/control.ts`
**Status:** Open

The `control.ts` file declares an in-memory `sshSessions` map intended to hold live SSH session references for graceful termination. However, this map is never populated anywhere in the codebase. When an admin triggers a graceful terminate, `sshSessions.get(nodeId)` always returns `undefined`, so `closeSSHSession` is never called. The node is deleted from Redis and the tab is closed, but the underlying SSH process (if any) is not signalled. Force kill has the same problem.

**Required fix:** When an SSH session is opened (whether in `terminal.ts` or a future persistent session manager), its reference must be stored in a shared, accessible map (or Redis-backed structure if multi-process) keyed by `nodeId`, so that `control.ts` can retrieve and close it during admin termination.

---

### Issue 5 — "+" button is rendered twice for regular users

**Area:** Frontend / `frontend/src/components/tree/TreeView.tsx`
**Status:** Open

The `+` button for creating a new terminal is rendered by two separate conditional blocks that both evaluate to true for a regular user viewing their own username node. This results in two `+` buttons appearing side by side in the tree for every username row.

**Required fix:** Remove the first redundant conditional block and keep only the second one, or consolidate the two conditions into a single render path.

---

## Medium

### Issue 6 — Inline rename starts with an empty string instead of the current name

**Area:** Frontend / `frontend/src/components/tree/TreeView.tsx`
**Status:** Open

The action menu's Rename option calls `startRename(actionMenu.nodeId, '')`, passing an empty string as the initial value for the rename input field. The user must type the full new name from scratch, with no indication of what the current name is.

**Required fix:** Pass the current node name as the second argument: `startRename(actionMenu.nodeId, actionMenu.name)`. This requires adding `name` to the `ActionMenu` interface.

---

### Issue 7 — Logout does not invalidate the JWT on the server side

**Area:** Frontend / `frontend/src/pages/SessionTreePage.tsx`
**Status:** Open

The sign-out button clears the JWT and user data from `sessionStorage` on the client side but does not call `POST /api/v1/auth/logout` to notify the backend. The JWT remains technically valid until it expires naturally, which could allow a captured token to be reused.

**Required fix:** The logout handler should call `POST /api/v1/auth/logout` (with the current token in the `Authorization` header) before clearing client-side state, so the backend can add the token to a denylist or otherwise invalidate it.

---

### Issue 8 — Admin notification in `TerminalPage` uses `alert()` instead of the modal component

**Area:** Frontend / `frontend/src/pages/TerminalPage.tsx`
**Status:** Open

When the backend sends an `admin_notification` event to a terminal tab, `TerminalPage.tsx` handles it with a plain browser `alert()` call. The `AdminNotification` modal component was built specifically for this purpose and provides a styled, acknowledgeable notification consistent with the rest of the UI.

**Required fix:** Replace the `alert()` call in `TerminalPage.tsx` with the `AdminNotification` component, matching the pattern already used in `SessionTreePage.tsx`. The same fix should be verified for `XpraPage.tsx`.

---

## Low

### Issue 9 — Backend Dockerfile does not compile TypeScript; relies on pre-built `dist/`

**Area:** Infrastructure / `backend/Dockerfile`
**Status:** ✅ Resolved

Converted to a two-stage Docker build. Stage 1 installs all dependencies and compiles TypeScript inside Docker. Stage 2 copies only the compiled output and production dependencies into the final image.

---

### Issue 10 — `docker-compose.yml` uses deprecated `version` key

**Area:** Infrastructure / `docker-compose.yml`
**Status:** ✅ Resolved

Removed the deprecated `version: "3.9"` line.

---

## Issues Found During Live Testing

### Issue 11 — Alpine-based images fail with TLS errors under `userns-remap`

**Area:** Infrastructure / Docker images
**Status:** ✅ Resolved

Alpine Linux's `libretls` implementation fails with a generic TLS error when Docker's `userns-remap` is active, preventing `apk` from fetching packages during build. All Alpine-based images (`node:22-alpine`, `nginx:alpine`, `redis:alpine`) were replaced with Debian Bookworm equivalents (`node:22-bookworm-slim`, `nginx:bookworm`, `redis:bookworm`).

---

### Issue 12 — Xpra Dockerfile missing official Xpra apt repository

**Area:** Infrastructure / `docker/xpra/Dockerfile`
**Status:** ✅ Resolved

`xpra` and `xpra-html5` are not in Ubuntu's default apt repositories. The Dockerfile was updated to add the official Xpra repository for Ubuntu 24.04 (Noble) before installing packages.

---

### Issue 13 — Backend `package-lock.json` missing; `npm ci` fails during Docker build

**Area:** Infrastructure / `backend/package-lock.json`
**Status:** ✅ Resolved

Generated and committed `backend/package-lock.json`. The multi-stage Dockerfile uses `npm ci` which requires a lockfile.

---

### Issue 14 — `setup.sh` bcrypt hashing fails due to global npm install not being resolvable

**Area:** Infrastructure / `scripts/setup.sh`
**Status:** ✅ Resolved

Replaced `npm install -g bcrypt` with a local temporary directory install. The password is passed via environment variable to avoid all shell quoting issues.

---

### Issue 15 — `setup.sh` heredoc expands `$` signs, corrupting bcrypt hash and JWT secret in `.env`

**Area:** Infrastructure / `scripts/setup.sh` and `docker-compose.yml`
**Status:** ✅ Resolved (permanent fix applied)

Shell heredocs expand `$` signs, corrupting bcrypt hashes and JWT secrets written to `.env`. Docker Compose v2.24+ also interpolates `$` signs from `env_file` values, requiring `$$` escaping. This was a recurring source of admin login failures.

**Permanent fix:** `ADMIN_PASSWORD_HASH` and `JWT_SECRET` are no longer stored in `.env`. They are written as plain files to `docker/secrets/admin_hash` and `docker/secrets/jwt_secret` by `setup.sh`, and mounted read-only into the container at `/run/secrets/`. The backend reads them from the filesystem via `backend/src/utils/secrets.ts`, completely bypassing Docker Compose interpolation.

---

### Issue 16 — PAM socket inaccessible from container under `userns-remap`

**Area:** Infrastructure / `pam-helper/index.js` and `scripts/setup.sh`
**Status:** ✅ Resolved

With `userns-remap` active, the container's GID 996 maps to host GID 166532, not 996. The PAM socket (`/run/webssh/pam.sock`) was created with `0660` permissions owned `root:webssh`, which the remapped container process could not access. Fixed by creating the socket with `0666` permissions and the socket directory with `0755`.

---

### Issue 17 — nginx `nginx -s reload` does not pick up bind-mounted config changes

**Area:** Infrastructure / `docker/nginx/nginx.conf`
**Status:** ✅ Resolved (workaround documented)

`nginx -s reload` inside the container does not re-read bind-mounted files that were updated after the container started. A full container restart (`docker compose restart nginx`) is required to pick up changes to `nginx.conf`. This is a known Docker bind-mount behaviour with `userns-remap`.

---

### Issue 18 — Socket.IO WebSocket upgrade fails; falls back to HTTP polling

**Area:** Backend / `backend/src/index.ts` and `docker/nginx/nginx.conf`
**Status:** ✅ Resolved

Two root causes:
1. The Socket.IO server was configured with `transports: ['websocket']` only. Socket.IO requires a polling handshake to exchange session IDs before upgrading to WebSocket. Fixed by allowing `['websocket', 'polling']`.
2. nginx had no location block for `/socket.io/`, so WebSocket upgrade headers were not forwarded. Fixed by adding a dedicated `/socket.io/` location block with `proxy_http_version 1.1` and `Upgrade`/`Connection` headers.

---

### Issue 19 — Socket.IO auth middleware not applied to child namespaces

**Area:** Backend / `backend/src/index.ts`, `ws/control.ts`, `ws/terminal.ts`, `ws/xpra.ts`
**Status:** ✅ Resolved

In Socket.IO v4, `io.use()` middleware registered on the root `io` object does **not** propagate to child namespaces (`/ws/control`, `/ws/terminal`, `/ws/xpra`). As a result, `socket.data.auth` was `undefined` when namespace connection handlers ran, causing `TypeError: Cannot read properties of undefined (reading 'role')`. Fixed by registering `authMiddleware` on each namespace individually via `ns.use(middleware)`.

---

### Issue 20 — `docker compose restart` does not recreate containers with updated env vars

**Area:** Infrastructure / deployment procedure
**Status:** ✅ Resolved (documented)

`docker compose restart` restarts containers without recreating them, so updated environment variables from `.env` are not picked up. Use `docker compose up -d --force-recreate <service>` to apply `.env` changes to a running container.

---

*Last updated: 2026-08-06*
