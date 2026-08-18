#!/usr/bin/env bash
set -euo pipefail

# 2 核 2GB 服务器上的重建流程。
# 核心变化：构建前先停掉旧容器，避免「旧容器 150~350MB + vite build 峰值 565MB
# + dockerd 150~250MB」叠加把内存顶爆。代价是构建期间有停机，这是有意为之。
# 不想停机就 STOP_BEFORE_BUILD=0（内存紧张时不建议）。

# 自动探测 compose 文件：优先用显式指定的，其次 prod，最后仓库里的默认文件。
if [ -z "${COMPOSE_FILE:-}" ]; then
  if [ -f docker-compose.prod.yml ]; then
    COMPOSE_FILE=docker-compose.prod.yml
  else
    COMPOSE_FILE=docker-compose.yml
  fi
fi

SERVICE_NAME="${SERVICE_NAME:-chat-lite}"
SANDBOX_SERVICE="table-sandbox"
NO_CACHE="${NO_CACHE:-0}"
STOP_BEFORE_BUILD="${STOP_BEFORE_BUILD:-1}"
PRUNE_AFTER="${PRUNE_AFTER:-0}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found" >&2
  exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Compose file not found: $COMPOSE_FILE" >&2
  echo "Run this script in your chat-lite project directory." >&2
  exit 1
fi

echo "Using compose file: $COMPOSE_FILE"

if [ "$STOP_BEFORE_BUILD" = "1" ]; then
  echo "Stopping $SERVICE_NAME and $SANDBOX_SERVICE before build (frees memory for the build step)..."
  docker compose -f "$COMPOSE_FILE" stop "$SERVICE_NAME" "$SANDBOX_SERVICE" || true
fi

echo "Rebuilding services: $SERVICE_NAME $SANDBOX_SERVICE"
if [ "$NO_CACHE" = "1" ]; then
  docker compose -f "$COMPOSE_FILE" build --no-cache "$SERVICE_NAME" "$SANDBOX_SERVICE"
else
  docker compose -f "$COMPOSE_FILE" build "$SERVICE_NAME" "$SANDBOX_SERVICE"
fi

echo "Recreating services: $SERVICE_NAME $SANDBOX_SERVICE"
docker compose -f "$COMPOSE_FILE" up -d --force-recreate "$SERVICE_NAME" "$SANDBOX_SERVICE"

# 轮询而不是 sleep 3 + 一次性探测：原来在 set -e 下只要启动稍慢就会误报部署失败。
echo "Waiting for service to become healthy (up to $((HEALTH_RETRIES * 2))s)..."
healthy=0
for _ in $(seq 1 "$HEALTH_RETRIES"); do
  if docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE_NAME" node -e "
fetch('http://127.0.0.1:3000/api/health')
  .then(r => process.exit(r.ok ? 0 : 1))
  .catch(() => process.exit(1));
" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done

echo "Service status:"
docker compose -f "$COMPOSE_FILE" ps "$SERVICE_NAME"

if [ "$healthy" != "1" ]; then
  echo "Health check FAILED. Recent logs:" >&2
  docker compose -f "$COMPOSE_FILE" logs --tail=100 "$SERVICE_NAME" >&2
  exit 1
fi
echo "Health check: OK"

if [ "$PRUNE_AFTER" = "1" ]; then
  echo "Pruning dangling images..."
  docker image prune -f
fi

echo "Recent logs:"
docker compose -f "$COMPOSE_FILE" logs --tail=50 "$SERVICE_NAME"

echo "Done."
