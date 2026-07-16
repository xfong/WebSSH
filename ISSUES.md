# WebSSH — Known Issues

This file documents issues identified during the initial code review. Issues are ranked by severity and should be resolved before the application is considered production-ready.

---

## Critical

### Issue 1 — SSH sessions are not persistent

**Area:** Backend / `backend/src/ws/terminal.ts`

Every time a user opens a terminal tab, `terminal.ts` opens a brand-new SSH shell connection. When the browser tab is closed or disconnected, the `disconnect` handler immediately calls `closeSSHSession`, tearing down the SSH connection. This means the backend SSH session does not survive browser closure, which directly violates the core specification requirement that backend sessions persist indefinitely until the user explicitly closes them.

**Required fix:** SSH sessions must be started once (when the terminal node is created) and kept alive in a persistent process manager or background map, independent of any browser WebSocket connection. Reconnecting to a terminal tab must re-attach to the existing running SSH PTY rather than opening a new one.

---

### Issue 2 — Password TTL breaks reconnection after 5 minutes

**Area:** Backend / `backend/src/ws/control.ts` and `backend/src/ws/terminal.ts`

When a new terminal is created, the user's SSH password is stored in Redis under `session:password:{nodeId}` with a hard-coded 5-minute TTL (`setex(..., 300, ...)`). When the terminal WebSocket connects, it retrieves this password to open the SSH session. If the user closes the browser and attempts to reconnect to the same terminal after 5 minutes, the password has expired and the connection is rejected with the error *"Session credentials expired. Please create a new terminal."*

This breaks the indefinite session persistence requirement. The password is only needed at the moment the SSH connection is first established. Once the SSH connection is open and held persistently (see Issue 1), the password no longer needs to be stored at all.

**Required fix:** Resolve Issue 1 first (persistent SSH sessions). Once SSH sessions are held alive independently of browser connections, the password only needs to be present at initial session creation time and does not need to be stored in Redis at all for reconnection purposes.

---

### Issue 3 — Xpra daemon is never launched; X11 support is a stub

**Area:** Backend / `backend/src/xpra/manager.ts` and `docker/xpra/entrypoint.sh`

The `startXpraSession` function in `xpra/manager.ts` only records session metadata in Redis. It does not actually spawn an Xpra daemon process. The Xpra container's `entrypoint.sh` simply runs `tail -f /dev/null` and waits indefinitely, providing no active Xpra service. As a result, no GUI window creation path is wired end-to-end and X11 application streaming is entirely non-functional.

**Required fix:** `startXpraSession` must SSH into the host (or execute within the Xpra container) to run `xpra start` with the appropriate display number, bind address, and port. The `entrypoint.sh` should start a base Xpra service or at minimum provide the environment required for per-user Xpra sessions to be spawned on demand. The `XpraPage.tsx` frontend currently renders an `<iframe>` pointing at `/xpra-client/?nodeId=...`, which also requires an Nginx route to the Xpra HTML5 client — this route is missing from `nginx.conf`.

---

## High

### Issue 4 — Admin graceful-terminate has no effect; `sshSessions` map is never populated

**Area:** Backend / `backend/src/ws/control.ts`

The `control.ts` file declares an in-memory `sshSessions` map intended to hold live SSH session references for graceful termination. However, this map is never populated anywhere in the codebase. When an admin triggers a graceful terminate, `sshSessions.get(nodeId)` always returns `undefined`, so `closeSSHSession` is never called. The node is deleted from Redis and the tab is closed, but the underlying SSH process (if any) is not signalled. Force kill has the same problem.

**Required fix:** When an SSH session is opened (whether in `terminal.ts` or a future persistent session manager), its reference must be stored in a shared, accessible map (or Redis-backed structure if multi-process) keyed by `nodeId`, so that `control.ts` can retrieve and close it during admin termination.

---

### Issue 5 — "+" button is rendered twice for regular users

**Area:** Frontend / `frontend/src/components/tree/TreeView.tsx` (lines 835–845)

The `+` button for creating a new terminal is rendered by two separate conditional blocks that both evaluate to true for a regular user viewing their own username node. This results in two `+` buttons appearing side by side in the tree for every username row.

**Required fix:** Remove the first redundant conditional block (lines 835–840) and keep only the second one (lines 843–845), or consolidate the two conditions into a single render path.

---

## Medium

### Issue 6 — Inline rename starts with an empty string instead of the current name

**Area:** Frontend / `frontend/src/components/tree/TreeView.tsx`

The action menu's Rename option calls `startRename(actionMenu.nodeId, '')`, passing an empty string as the initial value for the rename input field. The user must type the full new name from scratch, with no indication of what the current name is.

**Required fix:** Pass the current node name as the second argument: `startRename(actionMenu.nodeId, actionMenu.name)`. This requires adding `name` to the `ActionMenu` interface.

---

### Issue 7 — Logout does not invalidate the JWT on the server side

**Area:** Frontend / `frontend/src/pages/SessionTreePage.tsx`

The sign-out button clears the JWT and user data from `sessionStorage` on the client side but does not call `POST /api/v1/auth/logout` to notify the backend. The JWT remains technically valid until it expires naturally, which could allow a captured token to be reused.

**Required fix:** The logout handler should call `POST /api/v1/auth/logout` (with the current token in the `Authorization` header) before clearing client-side state, so the backend can add the token to a denylist or otherwise invalidate it.

---

### Issue 8 — Admin notification in `TerminalPage` uses `alert()` instead of the modal component

**Area:** Frontend / `frontend/src/pages/TerminalPage.tsx`

When the backend sends an `admin_notification` event to a terminal tab, `TerminalPage.tsx` handles it with a plain browser `alert()` call. The `AdminNotification` modal component was built specifically for this purpose and provides a styled, acknowledgeable notification consistent with the rest of the UI.

**Required fix:** Replace the `alert()` call in `TerminalPage.tsx` with the `AdminNotification` component, matching the pattern already used in `SessionTreePage.tsx`. The same fix should be verified for `XpraPage.tsx`.

---

## Low

### Issue 9 — Backend Dockerfile does not compile TypeScript; relies on pre-built `dist/`

**Area:** Infrastructure / `backend/Dockerfile`

The backend `Dockerfile` copies the `dist/` directory (pre-compiled TypeScript output) directly into the image. If `dist/` does not exist on the host before running `docker compose build` (e.g., on a fresh clone), the container will fail to start with a missing file error. This makes the build non-reproducible from a clean checkout.

**Required fix:** Convert the backend `Dockerfile` to a multi-stage build. The first stage should install all dependencies (including `devDependencies`) and run `npm run build` to compile TypeScript. The second stage should copy only the compiled `dist/` output and production `node_modules` into the final image.

---

### Issue 10 — `docker-compose.yml` uses deprecated `version` key

**Area:** Infrastructure / `docker-compose.yml`

The file begins with `version: "3.9"`. The `version` top-level key is deprecated and ignored in Docker Compose v2 (v2.0+). Its presence generates a deprecation warning on every `docker compose` command.

**Required fix:** Remove the `version: "3.9"` line from `docker-compose.yml`.

---

*Last updated: 2026-07-17*
