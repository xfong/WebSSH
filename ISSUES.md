# WebSSH — Issues Log

All issues listed below have been **resolved**. This file is retained as a record of the problems encountered during development and their fixes.

---

## Critical

### Issue 1 — SSH Sessions Not Persistent ✅ RESOLVED
**Area:** Backend / `backend/src/ws/terminal.ts`, `backend/src/session/sshSessionManager.ts`

Every time a user opened a terminal tab, a new SSH shell was opened and torn down on disconnect. Sessions did not survive browser closure.

**Fix:** Introduced `sshSessionManager.ts` — a singleton session registry that owns all live SSH connections keyed by `nodeId`, independent of any WebSocket. `terminal.ts` now only attaches/detaches socket streams; the SSH session remains alive on disconnect. PTY output is buffered in Redis (capped at 500 chunks) and replayed to reconnecting clients.

---

### Issue 2 — Password TTL Breaks Reconnection ✅ RESOLVED
**Area:** Backend / `backend/src/session/sshSessionManager.ts`

Passwords were stored in Redis with a 5-minute TTL, making reconnection impossible after expiry.

**Fix:** Passwords are never stored in Redis. They are used once at session creation to open the SSH connection, then held only in an in-memory cache (`_passwordCache`) for Xpra SSH commands. The cache is cleared when the user's last session is terminated.

---

### Issue 3 — Xpra/X11 GUI Streaming Not Wired ✅ RESOLVED
**Area:** Backend / `backend/src/xpra/manager.ts`, `ws/xpra.ts`, `ws/control.ts`; Frontend / `XpraPage.tsx`; Infrastructure / `nginx.conf`, `docker-compose.yml`

The Xpra container was a placeholder (`tail -f /dev/null`). No Xpra sessions were started, no windows were detected, and the frontend showed a broken iframe.

**Fix:** Complete Xpra implementation:
- Xpra runs on the SSH host (installed by `prereq.sh`), not in a Docker container.
- `xpra/manager.ts` starts/stops Xpra via SSH, polls for new/closed windows using `xpra info`, and diffs against Redis-stored window state.
- `ws/control.ts` starts Xpra before the SSH PTY, sets `DISPLAY` and `XAUTHORITY` in the shell, and runs a 3-second window poller per user.
- nginx proxies the Xpra HTML5 server at `/xpra-proxy/PORT/` using the pinned gateway IP `172.18.0.1`.
- `XpraPage.tsx` fetches the proxy URL from `GET /api/v1/xpra-url/:nodeId` and loads it in an iframe.

---

### Issue 4 — Admin Terminate Has No Effect ✅ RESOLVED
**Area:** Backend / `backend/src/ws/control.ts`

The `admin_terminate` handler never called any session termination logic.

**Fix:** `admin_terminate` now calls `terminateSession()` or `terminateAllUserSessions()` from `sshSessionManager.ts`, and also stops Xpra and clears the password cache for the affected user.

---

## High

### Issue 5 — "+" Button Rendered Twice ✅ RESOLVED
**Area:** Frontend / `frontend/src/components/tree/TreeView.tsx`

Two separate conditional blocks both evaluated to true for a regular user, rendering two `+` buttons.

**Fix:** Removed the redundant block; a single clean condition remains.

---

## Medium

### Issue 6 — Inline Rename Starts with Empty Field ✅ RESOLVED
**Area:** Frontend / `frontend/src/components/tree/TreeView.tsx`

`startRename()` was called with an empty string, forcing the user to retype the full name.

**Fix:** The node's current name is stored in `ActionMenu` state and passed as the initial value to `startRename()`.

---

### Issue 7 — Logout Does Not Invalidate JWT on Server ✅ RESOLVED
**Area:** Frontend / `frontend/src/context/AuthContext.tsx`

`logout()` cleared `sessionStorage` but never called `/api/v1/auth/logout`.

**Fix:** `logout()` now sends a best-effort `POST /api/v1/auth/logout` with the current token before clearing local state.

---

### Issue 8 — Admin Notification Uses `alert()` ✅ RESOLVED
**Area:** Frontend / `frontend/src/pages/TerminalPage.tsx`, `XpraPage.tsx`

Both pages used `alert(d.message)` for admin notifications, bypassing the `AdminNotification` modal.

**Fix:** Both pages now set `adminMsg` state on `admin_notification`, rendering the `AdminNotification` modal overlay. The user must click "Acknowledge & Return to Login" before being redirected.

---

## Low

### Issue 9 — Backend Dockerfile Relies on Pre-built `dist/` ✅ RESOLVED
**Area:** Infrastructure / `backend/Dockerfile`

Converted to a two-stage Docker build. Stage 1 compiles TypeScript inside Docker; Stage 2 copies only the compiled output and production deps.

---

### Issue 10 — Deprecated `version` Key in Compose File ✅ RESOLVED
**Area:** Infrastructure / `docker-compose.yml`

Removed the deprecated `version: "3.9"` line.

---

## Issues Found During Live Testing

### Issue 11 — Node.js Version Too Old for `@vitejs/plugin-react` v5 ✅ RESOLVED
`@vitejs/plugin-react` v5 requires Node ≥ 20.19.0 or ≥ 22.12.0. `prereq.sh` now enforces Node.js v22+; `frontend/package.json` has an `engines` field.

### Issue 12 — Alpine TLS Failure with `userns-remap` ✅ RESOLVED
Alpine's `libretls` fails with `TLS: unspecified error` under `userns-remap`. All Alpine images replaced with Debian Bookworm equivalents.

### Issue 13 — Xpra Package Not in Ubuntu Default Repos ✅ RESOLVED
`prereq.sh` now adds the official Xpra.org repository before installing `xpra`, `xpra-x11`, `xpra-html5`, and X11 utilities.

### Issue 14 — `package-lock.json` Missing for Backend ✅ RESOLVED
Generated and committed `backend/package-lock.json`.

### Issue 15 — Admin Password Hash Corrupted by Shell Heredoc / Docker Compose Interpolation ✅ RESOLVED
`ADMIN_PASSWORD_HASH` and `JWT_SECRET` are now stored as plain files in `docker/secrets/` and mounted into the container, completely bypassing Docker Compose `$` interpolation.

### Issue 16 — PAM Socket Inaccessible from Container under `userns-remap` ✅ RESOLVED
PAM socket now created with `0666` permissions; socket directory with `0755`.

### Issue 17 — nginx `nginx -s reload` Does Not Pick Up Bind-Mounted Config Changes ✅ RESOLVED
A full `docker compose restart nginx` is required to pick up `nginx.conf` changes under `userns-remap`. Documented.

### Issue 18 — Socket.IO WebSocket Upgrade Fails ✅ RESOLVED
Two root causes: server configured with `websocket`-only transport (blocking the required polling handshake), and missing `/socket.io/` nginx location block. Both fixed.

### Issue 19 — Socket.IO Auth Middleware Not Applied to Child Namespaces ✅ RESOLVED
In Socket.IO v4, `io.use()` does not propagate to child namespaces. Auth middleware is now registered on each namespace individually.

### Issue 20 — `docker compose restart` Does Not Apply Updated Env Vars ✅ RESOLVED
Use `docker compose up -d --force-recreate <service>` to apply `.env` changes. Documented.

### Issue 21 — `DISPLAY` Not Set in SSH Shell ✅ RESOLVED
`control.ts` now starts Xpra before the SSH PTY. `sshSessionManager.ts` sends `export DISPLAY=:N; export XAUTHORITY="$HOME/.Xauthority"` as the first shell command. `setup.sh` adds `AcceptEnv DISPLAY` to `sshd_config`.

### Issue 22 — Xpra Window Detection Regex Wrong ✅ RESOLVED
`xpra info` outputs `windows.N.title=` (plural). The regex was matching `window.N.title=` (singular). Fixed in `xpra/manager.ts`.

### Issue 23 — `nodeId` Not Arriving at Backend WebSocket Handler ✅ RESOLVED
Socket.IO query parameters are not forwarded in the WebSocket upgrade handshake. `nodeId` is now passed in the `auth` object (reliably delivered in the Socket.IO handshake).

### Issue 24 — Xpra Proxy 502 Due to Wrong Host IP ✅ RESOLVED
`host.docker.internal` resolved to `172.17.0.1` (docker0) but WebSSH containers are on `172.18.0.0/16`. `webssh_net` subnet is now pinned to `172.18.0.0/16`; nginx Xpra proxy uses `172.18.0.1` directly.

### Issue 25 — Stale `webssh_xpra` Container Blocking Network Recreation ✅ RESOLVED
The old `xpra` Docker service left a stale container attached to the network. Remove with `docker rm -f webssh_xpra` before recreating the network.

### Issue 26 — `xpra-x11` Package Missing ✅ RESOLVED
`xpra start` in seamless mode requires `xpra-x11`. Added to the `prereq.sh` installation list.

---

*Last updated: 2026-08-10*
