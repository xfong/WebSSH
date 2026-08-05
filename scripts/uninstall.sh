#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# WebSSH Uninstaller
#
# Interactively removes Docker containers, images, volumes, npm build artefacts,
# the PAM helper service, and optionally the configuration and TLS certificates.
#
# Supported OS: Ubuntu 24.04 LTS
# Run as:       sudo bash scripts/uninstall.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
section() { echo -e "\n${YELLOW}══ $* ══${NC}"; }
item()    { echo -e "  ${CYAN}${BOLD}[$1]${NC} $2"; }

# ── Root check ────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root. Use: sudo bash scripts/uninstall.sh"
  exit 1
fi

echo ""
echo -e "${BOLD}========================================"
echo "  WebSSH Uninstaller"
echo -e "========================================${NC}"
echo ""
echo "This script will help you remove WebSSH components from this server."
echo "You will be asked which items to remove before anything is deleted."
echo ""

# ── Define removable items ────────────────────────────────────────────────────
# Each item: ID | label | description
declare -A ITEM_LABEL ITEM_DESC
ITEM_LABEL[1]="Docker containers"
ITEM_DESC[1]="Stop and remove the webssh_app, webssh_nginx, webssh_redis, and webssh_xpra containers"

ITEM_LABEL[2]="Docker images"
ITEM_DESC[2]="Remove the webssh-app and webssh-xpra built images (frees disk space)"

ITEM_LABEL[3]="Docker volumes"
ITEM_DESC[3]="Remove the redis_data and xpra_data named volumes (DESTROYS all session state and Redis data)"

ITEM_LABEL[4]="Frontend build artefacts"
ITEM_DESC[4]="Remove frontend/node_modules/ and frontend/dist/ (npm build output)"

ITEM_LABEL[5]="Backend build artefacts"
ITEM_DESC[5]="Remove backend/node_modules/ and backend/dist/ (compiled TypeScript output)"

ITEM_LABEL[6]="PAM helper service"
ITEM_DESC[6]="Stop and disable webssh-pam-helper.service, remove /opt/webssh-pam-helper/ and /run/webssh/"

ITEM_LABEL[7]="TLS certificates"
ITEM_DESC[7]="Remove docker/nginx/ssl/ (server.crt, server.key, ldap-ca.crt)"

ITEM_LABEL[8]="Configuration file (.env)"
ITEM_DESC[8]="Remove the generated .env file (contains JWT secret and admin password hash)"

ITEM_LABEL[9]="webssh system group"
ITEM_DESC[9]="Remove the 'webssh' system group created by setup.sh"

ITEMS=(1 2 3 4 5 6 7 8 9)

# ── Display menu ──────────────────────────────────────────────────────────────
section "Select items to remove"
echo ""
for id in "${ITEMS[@]}"; do
  item "$id" "${ITEM_LABEL[$id]}"
  echo -e "       ${ITEM_DESC[$id]}"
  echo ""
done

echo -e "  ${CYAN}${BOLD}[A]${NC} Select ALL items"
echo -e "  ${CYAN}${BOLD}[Q]${NC} Quit without removing anything"
echo ""
echo "Enter item numbers separated by spaces (e.g. 1 2 4), or A for all, or Q to quit:"
read -rp "> " SELECTION

# Normalise input
SELECTION="${SELECTION^^}"  # uppercase
if [[ "$SELECTION" == "Q" ]]; then
  echo ""
  info "No changes made. Exiting."
  exit 0
fi

declare -A SELECTED
if [[ "$SELECTION" == "A" ]]; then
  for id in "${ITEMS[@]}"; do SELECTED[$id]=1; done
else
  for token in $SELECTION; do
    if [[ "$token" =~ ^[1-9]$ ]] && [[ -v ITEM_LABEL[$token] ]]; then
      SELECTED[$token]=1
    else
      warn "Unknown selection '$token' — ignored."
    fi
  done
fi

if [[ ${#SELECTED[@]} -eq 0 ]]; then
  warn "No valid items selected. Exiting."
  exit 0
fi

# ── Confirm ───────────────────────────────────────────────────────────────────
section "Confirm removal"
echo ""
echo "The following items will be removed:"
echo ""
for id in "${!SELECTED[@]}"; do
  echo -e "  ${RED}✗${NC} ${ITEM_LABEL[$id]}"
done
echo ""

# Extra warning for destructive items
if [[ -v SELECTED[3] ]]; then
  warn "Docker volumes contain ALL persistent session state and Redis data."
  warn "This data CANNOT be recovered after removal."
  echo ""
fi
if [[ -v SELECTED[8] ]]; then
  warn ".env contains the JWT secret and admin password hash."
  warn "You will need to re-run setup.sh to regenerate them."
  echo ""
fi

read -rp "Are you sure you want to proceed? [y/N]: " CONFIRM
CONFIRM="${CONFIRM:-N}"
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo ""
  info "Aborted. No changes made."
  exit 0
fi

# ── Execute removals ──────────────────────────────────────────────────────────
ERRORS=0

# ── Item 1: Docker containers ─────────────────────────────────────────────────
if [[ -v SELECTED[1] ]]; then
  section "Removing Docker containers"
  if command -v docker &>/dev/null && docker compose version &>/dev/null; then
    cd "$REPO_ROOT"
    if docker compose ps -q 2>/dev/null | grep -q .; then
      docker compose down --remove-orphans && info "Containers stopped and removed." \
        || { error "Failed to remove containers."; ((ERRORS++)); }
    else
      info "No running containers found — skipping."
    fi
  else
    warn "docker compose not available — skipping container removal."
  fi
fi

# ── Item 2: Docker images ─────────────────────────────────────────────────────
if [[ -v SELECTED[2] ]]; then
  section "Removing Docker images"
  for img in webssh-app webssh-xpra; do
    if docker image inspect "$img" &>/dev/null; then
      docker rmi "$img" && info "Removed image: $img" \
        || { error "Failed to remove image: $img"; ((ERRORS++)); }
    else
      info "Image '$img' not found — skipping."
    fi
  done
fi

# ── Item 3: Docker volumes ────────────────────────────────────────────────────
if [[ -v SELECTED[3] ]]; then
  section "Removing Docker volumes"
  # Derive project name from repo directory name (Docker Compose default)
  PROJECT_NAME=$(basename "$REPO_ROOT" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')
  for vol in "${PROJECT_NAME}_redis_data" "${PROJECT_NAME}_xpra_data"; do
    if docker volume inspect "$vol" &>/dev/null; then
      docker volume rm "$vol" && info "Removed volume: $vol" \
        || { error "Failed to remove volume: $vol"; ((ERRORS++)); }
    else
      info "Volume '$vol' not found — skipping."
    fi
  done
fi

# ── Item 4: Frontend build artefacts ──────────────────────────────────────────
if [[ -v SELECTED[4] ]]; then
  section "Removing frontend build artefacts"
  for dir in "$REPO_ROOT/frontend/node_modules" "$REPO_ROOT/frontend/dist"; do
    if [[ -d "$dir" ]]; then
      rm -rf "$dir" && info "Removed: $dir"
    else
      info "Not found (already clean): $dir"
    fi
  done
fi

# ── Item 5: Backend build artefacts ───────────────────────────────────────────
if [[ -v SELECTED[5] ]]; then
  section "Removing backend build artefacts"
  for dir in "$REPO_ROOT/backend/node_modules" "$REPO_ROOT/backend/dist"; do
    if [[ -d "$dir" ]]; then
      rm -rf "$dir" && info "Removed: $dir"
    else
      info "Not found (already clean): $dir"
    fi
  done
fi

# ── Item 6: PAM helper service ────────────────────────────────────────────────
if [[ -v SELECTED[6] ]]; then
  section "Removing PAM helper service"
  if systemctl is-active --quiet webssh-pam-helper 2>/dev/null; then
    systemctl stop webssh-pam-helper && info "Stopped webssh-pam-helper service."
  fi
  if systemctl is-enabled --quiet webssh-pam-helper 2>/dev/null; then
    systemctl disable webssh-pam-helper && info "Disabled webssh-pam-helper service."
  fi
  if [[ -f /etc/systemd/system/webssh-pam-helper.service ]]; then
    rm -f /etc/systemd/system/webssh-pam-helper.service
    systemctl daemon-reload
    info "Removed systemd unit file."
  fi
  if [[ -d /opt/webssh-pam-helper ]]; then
    rm -rf /opt/webssh-pam-helper && info "Removed /opt/webssh-pam-helper/."
  fi
  if [[ -d /run/webssh ]]; then
    rm -rf /run/webssh && info "Removed /run/webssh/."
  fi
fi

# ── Item 7: TLS certificates ──────────────────────────────────────────────────
if [[ -v SELECTED[7] ]]; then
  section "Removing TLS certificates"
  SSL_DIR="$REPO_ROOT/docker/nginx/ssl"
  if [[ -d "$SSL_DIR" ]]; then
    rm -rf "$SSL_DIR" && info "Removed: $SSL_DIR"
  else
    info "Not found (already clean): $SSL_DIR"
  fi
fi

# ── Item 8: .env configuration file ──────────────────────────────────────────
if [[ -v SELECTED[8] ]]; then
  section "Removing .env configuration file"
  ENV_FILE="$REPO_ROOT/.env"
  if [[ -f "$ENV_FILE" ]]; then
    rm -f "$ENV_FILE" && info "Removed: $ENV_FILE"
  else
    info "Not found (already clean): $ENV_FILE"
  fi
fi

# ── Item 9: webssh system group ───────────────────────────────────────────────
if [[ -v SELECTED[9] ]]; then
  section "Removing webssh system group"
  if getent group webssh &>/dev/null; then
    groupdel webssh && info "Removed system group 'webssh'." \
      || { error "Failed to remove group 'webssh'. It may still have members."; ((ERRORS++)); }
  else
    info "Group 'webssh' does not exist — skipping."
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}========================================"
if [[ $ERRORS -eq 0 ]]; then
  echo -e "${GREEN}  Uninstall complete. No errors.${NC}"
else
  echo -e "${RED}  Uninstall finished with ${ERRORS} error(s).${NC}"
  echo "  Review the output above for details."
fi
echo -e "${BOLD}========================================${NC}"
echo ""
if [[ -v SELECTED[4] ]] || [[ -v SELECTED[5] ]]; then
  info "To rebuild, run:  bash scripts/setup.sh"
fi
