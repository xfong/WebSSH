#!/bin/sh
# Render the complete nginx configuration immediately before nginx starts.
# Only the two WebSSH port placeholders are expanded; nginx runtime variables
# such as $host, $uri, and $proxy_add_x_forwarded_for must remain untouched.
set -eu

envsubst '${HTTPS_PORT} ${HTTP_PORT}' \
  < /etc/nginx/webssh-nginx.conf.template \
  > /etc/nginx/nginx.conf

exec nginx -g 'daemon off;'
