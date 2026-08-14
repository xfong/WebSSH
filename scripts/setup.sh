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

# Validate the network ports before any files or services are changed. HTTP and
# HTTPS must use different host ports because Docker cannot bind both protocols
# to the same TCP port. Xpra is host-native (not a Compose service), but its
# allocation range still needs valid, non-overlapping port numbers.
validate_port() {
  local name="$1" value="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
    echo "ERROR: $name must be an integer from 1 to 65535; got '$value'."
    exit 1
  fi
}

validate_port "HTTPS_PORT" "$HTTPS_PORT"
validate_port "HTTP_PORT" "$HTTP_PORT"
validate_port "XPRA_PORT_START" "$XPRA_PORT_START"
validate_port "XPRA_PORT_END" "$XPRA_PORT_END"

if [ "$HTTPS_PORT" -eq "$HTTP_PORT" ]; then
  echo "ERROR: HTTPS_PORT and HTTP_PORT must be different because both are published by nginx."
  exit 1
fi
if [ "$XPRA_PORT_START" -gt "$XPRA_PORT_END" ]; then
  echo "ERROR: XPRA_PORT_START must not be greater than XPRA_PORT_END."
  exit 1
fi
if { [ "$HTTPS_PORT" -ge "$XPRA_PORT_START" ] && [ "$HTTPS_PORT" -le "$XPRA_PORT_END" ]; } || \
   { [ "$HTTP_PORT" -ge "$XPRA_PORT_START" ] && [ "$HTTP_PORT" -le "$XPRA_PORT_END" ]; }; then
  echo "ERROR: the Xpra port range must not include HTTPS_PORT or HTTP_PORT."
  exit 1
fi

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

# ── 8. Write secrets files and .env ──────────────────────────────────────────
# ADMIN_PASSWORD_HASH and JWT_SECRET are written as plain files under
# docker/secrets/ and mounted into the container at /run/secrets/.
# This avoids Docker Compose $$ interpolation corrupting bcrypt hashes
# and JWT secrets that contain $ characters.
#
# With Docker userns-remap enabled, container root maps to the first subordinate
# UID/GID assigned to the configured remap user (for example, dockremap maps to
# 165536 on a typical Ubuntu host). A host root-owned 0600 bind-mounted file is
# therefore unreadable inside the container. The helper below preserves 0600
# permissions while chowning the files to that mapped root identity.
SECRETS_DIR="$REPO_ROOT/docker/secrets"
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

get_userns_remap_identity() {
  local remap_value remap_user subuid_start subgid_start

  remap_value=$(python3 - <<'PYEOF'
import json
try:
    with open('/etc/docker/daemon.json', 'r', encoding='utf-8') as f:
        value = json.load(f).get('userns-remap', '')
    print(value if value else '')
except (FileNotFoundError, json.JSONDecodeError, PermissionError):
    print('')
PYEOF
)

  # Docker user namespace remapping is not enabled.
  if [ -z "$remap_value" ]; then
    return 0
  fi

  # Docker's special "default" value creates and uses the dockremap account.
  remap_user="${remap_value%%:*}"
  if [ "$remap_user" = "default" ]; then
    remap_user="dockremap"
  fi

  subuid_start=$(awk -F: -v user="$remap_user" '$1 == user { print $2; exit }' /etc/subuid 2>/dev/null || true)
  subgid_start=$(awk -F: -v user="$remap_user" '$1 == user { print $2; exit }' /etc/subgid 2>/dev/null || true)

  if [ -z "$subuid_start" ] || [ -z "$subgid_start" ]; then
    echo "ERROR: Docker userns-remap is configured for '$remap_value', but its subordinate UID/GID ranges could not be found." >&2
    echo "       Check /etc/subuid and /etc/subgid, then re-run setup.sh." >&2
    exit 1
  fi

  printf '%s:%s' "$subuid_start" "$subgid_start"
}

set_secret_permissions() {
  local secret_file="$1" mapped_identity

  # Standard Docker configuration: root is the only host identity that can read
  # the secret. This also establishes a known-safe ownership before checking
  # whether user namespace remapping is active.
  chown root:root "$secret_file"
  chmod 600 "$secret_file"

  mapped_identity=$(get_userns_remap_identity)
  if [ -n "$mapped_identity" ]; then
    chown "$mapped_identity" "$secret_file"
    chmod 600 "$secret_file"
  fi
}

printf '%s' "$ADMIN_PASSWORD_HASH" > "$SECRETS_DIR/admin_hash"
printf '%s' "$JWT_SECRET" > "$SECRETS_DIR/jwt_secret"
set_secret_permissions "$SECRETS_DIR/admin_hash"
set_secret_permissions "$SECRETS_DIR/jwt_secret"

# Verify the files were written non-empty. An empty or unreadable secrets file
# causes the backend to fail at startup (jwt.sign throws), which otherwise
# manifests as a login "Network Error" / nginx 502 timeout.
if [ ! -s "$SECRETS_DIR/admin_hash" ]; then
  echo "ERROR: docker/secrets/admin_hash is empty after write. Aborting."
  exit 1
fi
if [ ! -s "$SECRETS_DIR/jwt_secret" ]; then
  echo "ERROR: docker/secrets/jwt_secret is empty after write. Aborting."
  exit 1
fi

echo "  Secrets written to docker/secrets/ (admin_hash, jwt_secret)."

# Write .env for all other configuration (no sensitive values).
# All variables must be exported so that Python's os.environ can access them.
export SERVER_HOSTNAME ADMIN_USERNAME
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

lines = [
    "# Generated by setup.sh on " + datetime.datetime.now().strftime("%c"),
    "# NOTE: ADMIN_PASSWORD_HASH and JWT_SECRET are stored in docker/secrets/",
    "# and mounted into the container at /run/secrets/ to avoid Docker Compose",
    "# dollar-sign interpolation issues. Do not add them back here.",
    "SERVER_HOSTNAME=" + os.environ["SERVER_HOSTNAME"],
    "ADMIN_USERNAME=" + os.environ["ADMIN_USERNAME"],
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
    # can access the PAM helper Unix socket.
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
# 0755 (world-executable) is required when Docker userns-remap is active:
# the container's remapped GID does not match the host 'webssh' group GID,
# so the directory must be world-traversable for the container to reach the socket.
mkdir -p "$PAM_SOCKET_DIR"
chown root:webssh "$PAM_SOCKET_DIR"
chmod 755 "$PAM_SOCKET_DIR"

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


# ── 10. Configure sshd to accept DISPLAY environment variable ────────────────
echo ""
echo "Configuring sshd to accept DISPLAY environment variable..."
SSHD_CONFIG="/etc/ssh/sshd_config"
if [ -f "$SSHD_CONFIG" ]; then
  if grep -qE '^AcceptEnv.*\bDISPLAY\b' "$SSHD_CONFIG"; then
    echo "  sshd already configured to accept DISPLAY — skipping."
  else
    if grep -qE '^AcceptEnv' "$SSHD_CONFIG"; then
      sed -i 's/^AcceptEnv\(.*\)/AcceptEnv\1 DISPLAY/' "$SSHD_CONFIG"
      echo "  Added DISPLAY to existing AcceptEnv line in $SSHD_CONFIG."
    else
      echo '' >> "$SSHD_CONFIG"
      echo '# Allow WebSSH to set DISPLAY for Xpra X11 forwarding' >> "$SSHD_CONFIG"
      echo 'AcceptEnv DISPLAY' >> "$SSHD_CONFIG"
      echo "  Added AcceptEnv DISPLAY to $SSHD_CONFIG."
    fi
    if systemctl is-active --quiet sshd 2>/dev/null || systemctl is-active --quiet ssh 2>/dev/null; then
      systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || true
      echo "  sshd reloaded."
    fi
  fi
else
  echo "  WARNING: $SSHD_CONFIG not found. Skipping sshd configuration."
  echo "  The DISPLAY variable will be set via shell command instead."
fi

# ── 11. Build frontend static assets ──────────────────────────────────────────
echo ""
echo "Building frontend..."
cd "$REPO_ROOT/frontend"
npm install --silent
npm run build
echo "  Frontend built. Output in frontend/dist/"

# ── 12. Build and start Docker containers ─────────────────────────────────────
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
