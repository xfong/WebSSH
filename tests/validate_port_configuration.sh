#!/usr/bin/env bash
# Lightweight regression checks for configurable WebSSH host ports.
# Does not require Docker; it validates the Compose declarations and the
# rendered nginx redirect syntax for a representative non-standard port pair.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.yml"
NGINX_TEMPLATE="$ROOT/docker/nginx/nginx.conf.template"

# Compose must publish configurable external ports to nginx's fixed internal
# ports rather than mapping literal host ports.
grep -Fq '"${HTTPS_PORT:-443}:443"' "$COMPOSE_FILE"
grep -Fq '"${HTTP_PORT:-80}:80"' "$COMPOSE_FILE"

# The template must retain internal nginx listener ports and direct HTTP to the
# configured external HTTPS port. This mirrors render-config.sh's envsubst call.
RENDERED=$(sed 's/${HTTPS_PORT}/8443/g' "$NGINX_TEMPLATE")
printf '%s\n' "$RENDERED" | grep -Fq 'listen 443 ssl;'
printf '%s\n' "$RENDERED" | grep -Fq 'listen 80;'
printf '%s\n' "$RENDERED" | grep -Fq 'return 301 https://$host:8443$request_uri;'

echo "Port configuration regression checks passed."
