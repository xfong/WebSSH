#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# WebSSH Setup Script
# Run this on the host server to configure and launch the application.
# Requirements: Docker, Docker Compose v2, OpenSSL, Node.js v22+, python3
#
# Configuration is loaded from webssh.conf in the repo root.
# Copy webssh.conf, fill in your values, then run this script.
# Any values left blank in webssh.conf will be prompted interactively.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF_FILE="$REPO_ROOT/webssh.conf"
CONF_EXAMPLE="$REPO_ROOT/webssh.conf.example"
SSL_DIR="$REPO_ROOT/docker/nginx/ssl"
ENV_FILE="$REPO_ROOT/.env"

echo "========================================"
echo "  WebSSH Setup"
echo "========================================"
echo ""

# ── 1. Check dependencies ─────────────────────────────────────────────────────
for cmd in docker openssl node python3; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' is required but not installed. Aborting."
    exit 1
  fi
done
if ! docker compose version &>/dev/null; then
  echo "ERROR: 'docker compose' (v2) is required but not found. Aborting."
  exit 1
fi

# ── 2. Load configuration from webssh.conf ────────────────────────────────────
if [ -f "$CONF_FILE" ]; then
  echo "Loading configuration from webssh.conf..."
  # Source only KEY=value lines; skip comments and blank lines.
  # Values are trimmed of surrounding whitespace.
  while IFS='=' read -r key value; do
    # Skip comments and blank lines
    [[ "$key" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${key// }" ]] && continue
    # Trim whitespace from key and value
    key="${key// /}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"    # Only export non-empty values
    if [ -n "$value" ]; then
      export "$key"="$value"
    fi
  done < "$CONF_FILE"
  echo "  Configuration loaded."
else
  echo "  NOTE: webssh.conf not found. All values will be prompted interactively."
  if [ -f "$CONF_EXAMPLE" ]; then
    echo "  TIP: Copy webssh.conf.example to webssh.conf and fill in your values:"
    echo "       cp webssh.conf.example webssh.conf && nano webssh.conf"
  fi
fi
echo ""

# ── 3. Prompt for any missing required values ─────────────────────────────────
echo "Checking configuration values..."
echo "(Press Enter to accept defaults where shown.)"
echo ""

if [ -z "${SERVER_HOSTNAME:-}" ]; then
  read -rp "Server hostname [$(hostname)]: " SERVER_HOSTNAME
  SERVER_HOSTNAME="${SERVER_HOSTNAME:-$(hostname)}"
else
  echo "  Server hostname:        $SERVER_HOSTNAME"
fi

if [ -z "${LDAP_HOST:-}" ]; then
  read -rp "LDAP server host (e.g. ldap.example.com): " LDAP_HOST
fi

if [ -z "${LDAP_BASE_DN:-}" ]; then
  read -rp "LDAP base DN (e.g. dc=example,dc=com): " LDAP_BASE_DN
fi

if [ -z "${LDAP_USER_DN_TEMPLATE:-}" ]; then
  read -rp "LDAP user DN template [{username} as placeholder, default uid={username},ou=people,${LDAP_BASE_DN}]: " LDAP_USER_DN_TEMPLATE
  LDAP_USER_DN_TEMPLATE="${LDAP_USER_DN_TEMPLATE:-uid={username},ou=people,${LDAP_BASE_DN}}"
fi

if [ -z "${LDAP_CA_CERT_PATH:-}" ]; then
  read -rp "Path to LDAP CA certificate file (leave blank to skip): " LDAP_CA_SRC
else
  LDAP_CA_SRC="$LDAP_CA_CERT_PATH"
  echo "  LDAP CA cert:           $LDAP_CA_SRC"
fi

if [ -z "${SSH_HOST:-}" ]; then
  read -rp "SSH host [host.docker.internal]: " SSH_HOST
  SSH_HOST="${SSH_HOST:-host.docker.internal}"
else
  echo "  SSH host:               $SSH_HOST"
fi

if [ -z "${SSH_PORT:-}" ]; then
  read -rp "SSH port [22]: " SSH_PORT
  SSH_PORT="${SSH_PORT:-22}"
else
  echo "  SSH port:               $SSH_PORT"
fi

if [ -z "${ADMIN_USERNAME:-}" ]; then
  read -rp "Admin username [admin]: " ADMIN_USERNAME
  ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
else
  echo "  Admin username:         $ADMIN_USERNAME"
fi

HTTPS_PORT="${HTTPS_PORT:-443}"
HTTP_PORT="${HTTP_PORT:-80}"
XPRA_PORT_START="${XPRA_PORT_START:-10000}"
XPRA_PORT_END="${XPRA_PORT_END:-11000}"

echo ""

# ── 4. Admin password: reuse existing hash or generate a new one ──────────────
EXISTING_HASH=""
if [ -f "$ENV_FILE" ]; then
  # Extract the existing hash from .env, stripping any $$ escaping
  EXISTING_HASH=$(grep '^ADMIN_PASSWORD_HASH=' "$ENV_FILE" | cut -d= -f2- | sed 's/\$\$/\$/g' || true)
fi

if [ -n "$EXISTING_HASH" ]; then
  echo "An existing admin password hash was found in .env."
  read -rp "Reset admin password? [y/N]: " RESET_PASS
  RESET_PASS="${RESET_PASS:-N}"
  if [[ "$RESET_PASS" =~ ^[Yy]$ ]]; then
    EXISTING_HASH=""
  else
    ADMIN_PASSWORD_HASH="$EXISTING_HASH"
    echo "  Reusing existing admin password hash."
  fi
fi

if [ -z "$EXISTING_HASH" ]; then
  echo "Generating admin password hash..."
  while true; do
    read -rsp "Admin password: " ADMIN_PASS
    echo ""
    read -rsp "Confirm admin password: " ADMIN_PASS2
    echo ""
    if [ "$ADMIN_PASS" = "$ADMIN_PASS2" ]; then
      break
    fi
    echo "Passwords do not match. Please try again."
  done

  # Install bcrypt into a temporary directory so require() can always find it,
  # regardless of global npm prefix configuration.
  BCRYPT_TMP=$(mktemp -d)
  trap 'rm -rf "$BCRYPT_TMP"' EXIT

  (cd "$BCRYPT_TMP" && npm init -y --silent >/dev/null 2>&1 && npm install bcrypt --silent >/dev/null 2>&1)

  cat > "$BCRYPT_TMP/hash.js" <<'JSEOF'
const bcrypt = require('./node_modules/bcrypt');
bcrypt.hash(process.env.WEBSSH_ADMIN_PASS, 12).then(h => {
  process.stdout.write(h);
  process.exit(0);
});
JSEOF

  ADMIN_PASSWORD_HASH=$(WEBSSH_ADMIN_PASS="${ADMIN_PASS}" node "$BCRYPT_TMP/hash.js")
  echo "  Admin password hash generated."
fi

# ── 5. Generate JWT secret (always regenerate on fresh setup) ─────────────────
EXISTING_JWT=""
if [ -f "$ENV_FILE" ]; then
  EXISTING_JWT=$(grep '^JWT_SECRET=' "$ENV_FILE" | cut -d= -f2- | sed 's/\$\$/\$/g' || true)
fi

if [ -n "$EXISTING_JWT" ]; then
  JWT_SECRET="$EXISTING_JWT"
  echo "  Reusing existing JWT secret."
else
  JWT_SECRET=$(openssl rand -hex 64)
  echo "  JWT secret generated."
fi

# ── 6. Create SSL directory and generate self-signed certificate ──────────────
mkdir -p "$SSL_DIR"

if [ -f "$SSL_DIR/server.crt" ] && [ -f "$SSL_DIR/server.key" ]; then
  echo "  TLS certificate already exists. Skipping generation."
else
  echo ""
  echo "Generating self-signed TLS certificate for '$SERVER_HOSTNAME'..."
  openssl req -x509 -nodes -days 3650 -newkey rsa:4096 \
    -keyout "$SSL_DIR/server.key" \
    -out "$SSL_DIR/server.crt" \
    -subj "/CN=${SERVER_HOSTNAME}" \
    -addext "subjectAltName=DNS:${SERVER_HOSTNAME},IP:127.0.0.1" \
    2>/dev/null
  echo "  Certificate saved to $SSL_DIR/server.crt"
  echo "  Private key saved to $SSL_DIR/server.key"
fi
# 644 (world-readable) is required when Docker userns-remap is active:
# the nginx container's remapped UID cannot read a 600 root-owned key file.
chmod 644 "$SSL_DIR/server.key"

# ── 7. Copy LDAP CA certificate if provided ───────────────────────────────────
if [ -n "${LDAP_CA_SRC:-}" ] && [ -f "$LDAP_CA_SRC" ]; then
  cp "$LDAP_CA_SRC" "$SSL_DIR/ldap-ca.crt"
  echo "  LDAP CA certificate copied to $SSL_DIR/ldap-ca.crt"
else
  touch "$SSL_DIR/ldap-ca.crt"
  echo "  WARNING: No LDAP CA certificate provided. LDAPS may fail certificate validation."
fi

# ── 8. Write .env file ────────────────────────────────────────────────────────
# Use Python to write the .env file so that special characters in values
# (especially $ signs in bcrypt hashes and JWT secrets) are written verbatim
# without shell expansion issues.
# All variables must be exported so that Python's os.environ can access them.
export SERVER_HOSTNAME JWT_SECRET ADMIN_USERNAME ADMIN_PASSWORD_HASH
export LDAP_HOST LDAP_BASE_DN LDAP_USER_DN_TEMPLATE SSH_HOST SSH_PORT ENV_FILE
export HTTPS_PORT HTTP_PORT XPRA_PORT_START XPRA_PORT_END
# WEBSSH_GID is written to .env so docker-compose.yml can use it in group_add
# to grant the app container access to the PAM helper Unix socket.
# It is set after the webssh group is created in step 9; pre-populate with
# an empty string here so Python does not raise a KeyError if step 9 has
# not run yet (e.g. on a fresh run where the group will be created shortly).
export WEBSSH_GID=""
echo ""
echo "Writing .env configuration file..."
python3 - <<PYEOF
import os, datetime

# Docker Compose v2.24+ interpolates $ signs from env_file values.
# Escape every $ as $$ so the container receives the literal single $ character.
def dc_escape(value):
    return value.replace('$', '$$')

lines = [
    "# Generated by setup.sh on " + datetime.datetime.now().strftime("%c"),
    "# NOTE: $ signs in values are doubled ($$) for Docker Compose interpolation.",
    "# The container receives the correct single-$ values at runtime.",
    "SERVER_HOSTNAME=" + os.environ["SERVER_HOSTNAME"],
    "JWT_SECRET=" + dc_escape(os.environ["JWT_SECRET"]),
    "ADMIN_USERNAME=" + os.environ["ADMIN_USERNAME"],
    "ADMIN_PASSWORD_HASH=" + dc_escape(os.environ["ADMIN_PASSWORD_HASH"]),
    "LDAP_HOST=" + os.environ["LDAP_HOST"],
    "LDAP_BASE_DN=" + os.environ["LDAP_BASE_DN"],
    "LDAP_USER_DN_TEMPLATE=" + os.environ["LDAP_USER_DN_TEMPLATE"],
    "LDAP_CA_CERT_PATH=/app/certs/ldap-ca.crt",
    "SSH_HOST=" + os.environ["SSH_HOST"],
    "SSH_PORT=" + os.environ["SSH_PORT"],
    "REDIS_HOST=redis",
    "REDIS_PORT=6379",
    "XPRA_HOST=xpra",
    "XPRA_PORT_START=" + os.environ["XPRA_PORT_START"],
    "XPRA_PORT_END=" + os.environ["XPRA_PORT_END"],
    "TLS_CERT_FILE=server.crt",
    "TLS_KEY_FILE=server.key",
    "NODE_ENV=production",
    # WEBSSH_GID is used by docker-compose.yml group_add so the app container
    # can access the PAM helper Unix socket. Written as a plain variable
    # (not via env_file) to avoid Docker Compose interpolation issues.
    "WEBSSH_GID=" + os.environ.get("WEBSSH_GID", ""),
]
with open(os.environ["ENV_FILE"], "w") as f:
    f.write("\n".join(lines) + "\n")
PYEOF
echo "  .env written."

# ── 9. Install and start the PAM authentication helper ───────────────────────
echo ""
echo "Setting up PAM authentication helper..."

PAM_HELPER_SRC="$REPO_ROOT/pam-helper"
PAM_HELPER_DEST="/opt/webssh-pam-helper"
PAM_SERVICE_FILE="/etc/systemd/system/webssh-pam-helper.service"
PAM_SERVICE_NAME="${PAM_SERVICE:-login}"
PAM_SOCKET_DIR="/run/webssh"

# Create the webssh system group if it does not exist.
# The Docker container's process will be added to this group so it can
# connect to the PAM socket.
if ! getent group webssh &>/dev/null; then
  groupadd --system webssh
  echo "  Created system group 'webssh'."
fi
WEBSSH_GID=$(getent group webssh | cut -d: -f3)
export WEBSSH_GID

# Update the .env file with the real WEBSSH_GID now that the group exists.
# sed replaces the placeholder empty value written earlier by the Python block.
sed -i "s/^WEBSSH_GID=.*/WEBSSH_GID=${WEBSSH_GID}/" "$ENV_FILE"
echo "  WEBSSH_GID set to ${WEBSSH_GID} in .env."

# Copy the helper to its install location.
rm -rf "$PAM_HELPER_DEST"
cp -r "$PAM_HELPER_SRC" "$PAM_HELPER_DEST"

# Install Node.js production dependencies.
(cd "$PAM_HELPER_DEST" && npm install --omit=dev --silent)
echo "  PAM helper installed to $PAM_HELPER_DEST."

# Create the socket directory with correct permissions.
mkdir -p "$PAM_SOCKET_DIR"
chown root:webssh "$PAM_SOCKET_DIR"
chmod 750 "$PAM_SOCKET_DIR"

# Write the systemd service unit, substituting the PAM service name and GID.
cat > "$PAM_SERVICE_FILE" <<SVCEOF
[Unit]
Description=WebSSH PAM Authentication Helper
Documentation=https://github.com/xfong/WebSSH
After=network.target sssd.service
Wants=sssd.service

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=$PAM_HELPER_DEST
ExecStart=/usr/bin/node $PAM_HELPER_DEST/index.js
Restart=on-failure
RestartSec=5s
Environment=WEBSSH_PAM_SOCKET=$PAM_SOCKET_DIR/pam.sock
Environment=WEBSSH_PAM_SERVICE=$PAM_SERVICE_NAME
Environment=WEBSSH_SOCKET_GID=$WEBSSH_GID
NoNewPrivileges=no
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$PAM_SOCKET_DIR
PrivateTmp=true

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable webssh-pam-helper
systemctl restart webssh-pam-helper
echo "  webssh-pam-helper service enabled and started."

# ── 10. Build frontend static assets ──────────────────────────────────────────
echo ""
echo "Building frontend..."
cd "$REPO_ROOT/frontend"
npm install --silent
npm run build
echo "  Frontend built. Output in frontend/dist/"

# ── 10. Build and start Docker containers ─────────────────────────────────────
echo ""
echo "Building and starting Docker containers..."
cd "$REPO_ROOT"
docker compose build --no-cache
docker compose up -d

echo ""
echo "========================================"
echo "  WebSSH is now running!"
echo "  Open https://${SERVER_HOSTNAME} in your browser."
echo "  (Accept the self-signed certificate warning on first visit.)"
echo "========================================"
