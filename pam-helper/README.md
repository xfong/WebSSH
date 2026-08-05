# WebSSH PAM Authentication Helper

This directory contains a small privileged service that runs **on the Docker host** (outside any container). It allows the WebSSH backend container to authenticate users via the host's PAM stack, which in turn uses SSSD for LDAP/AD users and handles local accounts natively.

## Why a separate helper?

Docker containers cannot call `pam_authenticate()` against the host's PAM/SSSD stack directly without elevated privileges and access to host system files. Running a minimal privileged helper on the host and exposing it via a Unix socket is the safest approach — the container itself remains unprivileged.

## How it works

```
Browser → Nginx → WebSSH backend (container)
                        │
                        │  Unix socket: /run/webssh/pam.sock
                        ▼
               webssh-pam-helper (host, root)
                        │
                        ▼
                   PAM → SSSD → LDAP / local accounts
```

1. The backend sends a JSON request over the Unix socket: `{"username":"...","password":"..."}`
2. The helper calls `pam_authenticate()` using the `authenticate-pam` Node.js module.
3. The helper responds with `{"ok":true}` or `{"ok":false,"error":"..."}`.
4. If the helper is unreachable, the backend falls back to direct LDAP authentication.

## Installation

`setup.sh` handles installation automatically. To install manually:

```bash
# 1. Copy the helper to its install location
cp -r pam-helper /opt/webssh-pam-helper

# 2. Install dependencies
cd /opt/webssh-pam-helper && npm install --omit=dev

# 3. Create the webssh group (used for socket access)
groupadd --system webssh

# 4. Add the Docker container user to the webssh group
# (The container runs as UID/GID set by userns-remap; see setup.sh for details)

# 5. Install and start the systemd service
cp webssh-pam-helper.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now webssh-pam-helper
```

## Configuration

The helper is configured via environment variables set in the systemd service unit:

| Variable | Default | Description |
|---|---|---|
| `WEBSSH_PAM_SOCKET` | `/run/webssh/pam.sock` | Path to the Unix socket |
| `WEBSSH_PAM_SERVICE` | `login` | PAM service name (matches `/etc/pam.d/<service>`) |
| `WEBSSH_SOCKET_GID` | *(unset)* | Numeric GID of the group that may connect to the socket |
