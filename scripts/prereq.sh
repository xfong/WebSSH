#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# WebSSH Prerequisites Installer
#
# Installs all software required on the host server before cloning the
# WebSSH repository and running setup.sh.
#
# Supported OS: Ubuntu 24.04 LTS
# Run as:       sudo bash prereq.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
section() { echo -e "\n${YELLOW}══ $* ══${NC}"; }

# ── Root check ────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root. Use: sudo bash prereq.sh"
  exit 1
fi

# ── OS check ──────────────────────────────────────────────────────────────────
if [[ ! -f /etc/os-release ]]; then
  error "Cannot detect OS. /etc/os-release not found."
  exit 1
fi
source /etc/os-release
if [[ "$ID" != "ubuntu" ]]; then
  warn "This script is designed for Ubuntu. Detected: $ID $VERSION_ID. Proceeding anyway."
fi

echo "========================================"
echo "  WebSSH Prerequisites Installer"
echo "  OS: $PRETTY_NAME"
echo "========================================"

# ── 1. System update ──────────────────────────────────────────────────────────
section "Step 1: Updating system package index"
apt-get update -y
info "Package index updated."

# ── 2. Core utilities ─────────────────────────────────────────────────────────
section "Step 2: Installing core utilities"
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  gnupg \
  lsb-release \
  openssl \
  git \
  jq \
  apt-transport-https \
  software-properties-common
info "Core utilities installed."

# ── 3. Docker Engine ──────────────────────────────────────────────────────────
section "Step 3: Installing Docker Engine"

if command -v docker &>/dev/null; then
  DOCKER_VER=$(docker --version)
  info "Docker already installed: $DOCKER_VER — skipping."
else
  info "Adding Docker's official GPG key and repository..."
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  info "Docker Engine installed: $(docker --version)"
fi

# ── 4. Docker Compose v2 ──────────────────────────────────────────────────────
section "Step 4: Verifying Docker Compose v2"

if docker compose version &>/dev/null; then
  info "Docker Compose v2 available: $(docker compose version)"
else
  error "Docker Compose v2 not found. Ensure the 'docker-compose-plugin' package is installed."
  exit 1
fi

# ── 5. Docker service ─────────────────────────────────────────────────────────
section "Step 5: Enabling and starting Docker service"
systemctl enable docker --now
info "Docker service is active."

# ── 6. Add current SUDO_USER to docker group ──────────────────────────────────
section "Step 6: Adding user to docker group"
REAL_USER="${SUDO_USER:-}"
if [[ -n "$REAL_USER" && "$REAL_USER" != "root" ]]; then
  if id -nG "$REAL_USER" | grep -qw docker; then
    info "User '$REAL_USER' is already in the docker group."
  else
    usermod -aG docker "$REAL_USER"
    info "User '$REAL_USER' added to the docker group."
    warn "You must log out and log back in (or run 'newgrp docker') for group membership to take effect."
  fi
else
  warn "Could not determine the invoking user. Add your user to the docker group manually: sudo usermod -aG docker \$USER"
fi

# ── 7. Node.js (LTS) ──────────────────────────────────────────────────────────
section "Step 7: Installing Node.js LTS"

if command -v node &>/dev/null; then
  NODE_VER=$(node --version)
  # Require Node.js v22 or higher
  NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v\([0-9]*\).*/\1/')
  if [[ "$NODE_MAJOR" -ge 22 ]]; then
    info "Node.js already installed: $NODE_VER — skipping."
  else
    warn "Node.js $NODE_VER is below the required v22. Upgrading to Node.js 22 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
    info "Node.js upgraded: $(node --version)"
  fi
else
  info "Installing Node.js 22 LTS via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
  info "Node.js installed: $(node --version)"
fi

# ── 8. npm (bundled with Node.js) ─────────────────────────────────────────────
section "Step 8: Verifying npm"
if command -v npm &>/dev/null; then
  info "npm available: $(npm --version)"
else
  error "npm not found. It should be bundled with Node.js. Please investigate."
  exit 1
fi

# ── 9. OpenSSL ────────────────────────────────────────────────────────────────
section "Step 9: Verifying OpenSSL"
if command -v openssl &>/dev/null; then
  info "OpenSSL available: $(openssl version)"
else
  error "OpenSSL not found despite installation attempt. Please investigate."
  exit 1
fi

# ── 10. SSH client ────────────────────────────────────────────────────────────
section "Step 10: Installing OpenSSH client"
if command -v ssh &>/dev/null; then
  info "OpenSSH client already installed: $(ssh -V 2>&1)"
else
  apt-get install -y openssh-client
  info "OpenSSH client installed."
fi

# ── 11. PAM development libraries (required by authenticate-pam npm module) ──────
section "Step 11: Installing PAM development libraries"
apt-get install -y --no-install-recommends \
  libpam0g \
  libpam0g-dev
info "libpam0g and libpam0g-dev installed."

# ── 12. Xpra (X11 session server — runs on the SSH host) ─────────────────────
section "Step 12: Installing Xpra"

if command -v xpra &>/dev/null; then
  info "Xpra already installed: $(xpra --version 2>&1 | head -1) — skipping."
else
  info "Adding the official Xpra repository for Ubuntu 24.04 (Noble)..."
  curl -fsSL https://xpra.org/xpra.asc -o /usr/share/keyrings/xpra.asc
  curl -fsSL \
    https://raw.githubusercontent.com/Xpra-org/xpra/master/packaging/repos/noble/xpra.sources \
    -o /etc/apt/sources.list.d/xpra.sources
  apt-get update -y
  apt-get install -y --no-install-recommends \
    xpra \
    xpra-html5 \
    xvfb \
    x11-utils \
    x11-xserver-utils \
    dbus-x11
  info "Xpra installed: $(xpra --version 2>&1 | head -1)"
fi

# ── 13. bcrypt via npm (used by setup.sh to hash admin password) ──────────────
section "Step 13: Installing bcrypt (npm global)"
if npm list -g bcrypt --depth=0 &>/dev/null; then
  info "bcrypt npm package already installed globally."
else
  npm install -g bcrypt --silent
  info "bcrypt npm package installed globally."
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "========================================"
  echo "  All prerequisites installed (including Xpra on this SSH host)."
echo ""
echo "  Next steps:"
echo "  1. Log out and back in (or run 'newgrp docker') to activate"
echo "     docker group membership."
echo "  2. Clone the repository:"
echo "       git clone https://github.com/xfong/WebSSH.git"
echo "  3. Build the frontend:"
echo "       cd WebSSH/frontend && npm install && npm run build && cd .."
echo "  4. Run the setup script:"
echo "       bash WebSSH/scripts/setup.sh"
echo "========================================"
