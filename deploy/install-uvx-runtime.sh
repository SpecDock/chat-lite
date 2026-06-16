#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
SERVICE_NAME="${SERVICE_NAME:-chat-lite}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found" >&2
  exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Compose file not found: $COMPOSE_FILE" >&2
  echo "Run this script in your chat-lite project directory." >&2
  exit 1
fi

echo "Installing uvx inside running container: $SERVICE_NAME"
docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE_NAME" sh -lc '
set -e
apt-get update
apt-get install -y curl ca-certificates python3
curl -LsSf https://astral.sh/uv/install.sh | sh
ln -sf /root/.local/bin/uv /usr/local/bin/uv
ln -sf /root/.local/bin/uvx /usr/local/bin/uvx
uvx --version
'

echo "Restarting service: $SERVICE_NAME"
docker compose -f "$COMPOSE_FILE" restart "$SERVICE_NAME"

echo "Verifying uvx after restart..."
docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE_NAME" sh -lc 'which uvx && uvx --version'

echo "Done. If the container is recreated later, run this script again."
