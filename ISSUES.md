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

### Issue 27 — `prereq.sh` Does Not Install `xpra-x11` (Fresh Install) ✅ RESOLVED
**Area:** Infrastructure / `scripts/prereq.sh`

On a fresh install the `apt-get install` block for Xpra (Step 12) was missing `xpra-x11`. Without it, `xpra start` in seamless mode fails with:

```
you must install `xpra-x11` to use 'seamless'
```

**Fix:** Added `xpra-x11` to the `apt-get install` list in Step 12 of `prereq.sh`, immediately after `xpra`.

### Issue 28 — Login Hangs with "Network Error" When `docker/secrets/` Files Are Missing ✅ RESOLVED
**Area:** Infrastructure / `scripts/setup.sh`; Backend / `backend/src/index.ts`

On a fresh install, if `setup.sh` did not write `docker/secrets/jwt_secret` (e.g. due to a partial run or the file being empty), the backend starts successfully but `JWT_SECRET` is an empty string. Every call to `jwt.sign()` during login throws `Error: secretOrPrivateKey must have a value`. The error is not caught at the HTTP layer, so the request hangs until nginx times out with a 504, which the frontend reports as "Network Error".

**Fix (two parts):**
1. `backend/src/index.ts` now validates `JWT_SECRET` and `admin_hash` at startup and calls `process.exit(1)` with a clear `FATAL:` message if either is empty. The container will exit immediately rather than silently accepting connections that always fail.
2. `scripts/setup.sh` now verifies that both `docker/secrets/admin_hash` and `docker/secrets/jwt_secret` are non-empty immediately after writing them, and aborts with a clear error if either is empty.

### Issue 29 — PAM Unavailable Causes Silent LDAP Attempt Even When LDAP Is Not Configured ✅ RESOLVED
**Area:** Backend / `backend/src/auth/routes.ts`

When the PAM helper is unavailable (socket missing, EACCES, timeout), `routes.ts` always fell through to the LDAP fallback regardless of whether `LDAP_HOST` was configured. With no LDAP servers set, `ldap.ts` logged `LDAP_HOST is not configured` and returned `false`, resulting in a silent `401 Invalid credentials`. The user had no indication that the real problem was the PAM helper not running.

Additionally, even with `LDAP_HOST` empty the code still called `authenticateViaLdap()`, which created ldapjs client objects and attempted connections before returning.

**Fix:** Added a `ldapConfigured()` guard in `routes.ts`. When PAM is unavailable:
- If `LDAP_HOST` is empty: return `503 Service Unavailable` with a message explaining that the PAM helper is not running and no LDAP fallback is configured, and log a `console.error` pointing to `systemctl status webssh-pam-helper`.
- If `LDAP_HOST` is set: proceed with the LDAP fallback as before (existing behaviour).

This makes the PAM-only configuration work correctly and gives operators a clear, actionable error message.

### Issue 30 — Bind-Mounted Secret Files Are Unreadable with Docker `userns-remap` ✅ RESOLVED
**Area:** Infrastructure / `scripts/setup.sh`

On a host with Docker `userns-remap` enabled, `setup.sh` wrote `docker/secrets/admin_hash` and `docker/secrets/jwt_secret` as host-owned `root:root` files with mode `0600`. The container's root identity maps to the configured remap account's subordinate UID/GID range (for example `dockremap:165536:65536`), not host UID 0. Consequently, the bind-mounted files were unreadable in the `app` container, even when both files contained correct non-empty values.

The backend correctly failed fast with `FATAL: JWT_SECRET is empty`, but PM2 continuously restarted the process and nginx intermittently returned `502 Bad Gateway` for the login API.

**Fix:** `setup.sh` now detects Docker's configured `userns-remap` identity from `/etc/docker/daemon.json` and resolves its first subordinate UID/GID from `/etc/subuid` and `/etc/subgid`. It retains mode `0600`, but changes the secret file owner to that mapped identity before the container starts. Without `userns-remap`, files remain host-owned `root:root` with mode `0600`. The script aborts with a clear error if remapping is configured but its subordinate ranges cannot be resolved.

### Issue 31 — Configured HTTP and HTTPS Ports Were Written but Never Published by Docker ✅ RESOLVED
**Area:** Infrastructure / `docker-compose.yml`, `docker/nginx/`, `scripts/setup.sh`, `webssh.conf.example`

`setup.sh` read `HTTPS_PORT`, `HTTP_PORT`, `XPRA_PORT_START`, and `XPRA_PORT_END` from `webssh.conf` and wrote the values to `.env`. However, the nginx service used literal Docker port mappings (`443:443` and `80:80`), so changing `HTTPS_PORT` or `HTTP_PORT` had no effect on the actual host ports. This made clean installations ignore the stated configuration.

**Fix:** Docker Compose now publishes `${HTTPS_PORT}:443` and `${HTTP_PORT}:80`, preserving standard fixed nginx container listeners while making the host mappings configurable. A small nginx configuration renderer interpolates `HTTPS_PORT` into the HTTP-to-HTTPS redirect target so `HTTP_PORT=8080` correctly redirects to `https://host:8443` when `HTTPS_PORT=8443`. `setup.sh` validates that all configured ports are numeric and valid, that HTTP and HTTPS ports differ, and that neither overlaps the Xpra range.

`XPRA_PORT_START` and `XPRA_PORT_END` were already functioning: Xpra runs directly on the SSH host rather than in Docker, so those host-native listeners are deliberately absent from `docker compose ps`. The configuration documentation now makes this distinction explicit. A lightweight regression check validates the non-standard port configuration without requiring Docker.

---

*Last updated: 2026-08-14*
