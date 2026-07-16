#!/bin/bash
# Xpra container entrypoint
# Keeps the container alive; individual Xpra sessions are spawned
# on-demand by the backend via SSH into the host.
set -e

echo "Xpra container ready. Waiting for session requests..."
# Keep the container running
tail -f /dev/null
