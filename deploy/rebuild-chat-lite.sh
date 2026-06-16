#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
SERVICE_NAME="${SERVICE_NAME:-chat-lite}"
INSTALL_UVX="${INSTALL_UVX:-1}"
NO_CACHE="${NO_CACHE:-0}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found" >&2
  exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Compose file not found: $COMPOSE_FILE" >&2
  echo "Run this script in your chat-lite project directory." >&2
  exit 1
fi

echo "Rebuilding service: $SERVICE_NAME"
if [ "$NO_CACHE" = "1" ]; then
  docker compose -f "$COMPOSE_FILE" build --no-cache "$SERVICE_NAME"
else
  docker compose -f "$COMPOSE_FILE" build "$SERVICE_NAME"
fi

echo "Recreating service: $SERVICE_NAME"
docker compose -f "$COMPOSE_FILE" up -d --force-recreate "$SERVICE_NAME"

echo "Waiting for service to start..."
sleep 3

echo "Service status:"
docker compose -f "$COMPOSE_FILE" ps "$SERVICE_NAME"

echo "Health check:"
docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE_NAME" node -e "
fetch('http://127.0.0.1:3000/api/health')
  .then(async r => { console.log(r.status, await r.text()); if (!r.ok) process.exit(1); })
  .catch(e => { console.error(e); process.exit(1); });
"

if [ "$INSTALL_UVX" = "1" ]; then
  if [ -f "deploy/install-uvx-runtime.sh" ]; then
    echo "Installing uvx into the recreated container..."
    bash deploy/install-uvx-runtime.sh
  else
    echo "deploy/install-uvx-runtime.sh not found, skipping uvx installation."
  fi
else
  echo "Skipping uvx installation because INSTALL_UVX=0."
fi

echo "Recent logs:"
docker compose -f "$COMPOSE_FILE" logs --tail=50 "$SERVICE_NAME"

echo "Done."
