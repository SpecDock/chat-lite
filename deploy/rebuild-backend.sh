#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.backend.yml}"

SERVICE_NAME="${SERVICE_NAME:-chat-lite}"
SANDBOX_SERVICE="table-sandbox"
SERVICES=("$SERVICE_NAME" "$SANDBOX_SERVICE")
NO_CACHE="${NO_CACHE:-0}"
STOP_BEFORE_BUILD="${STOP_BEFORE_BUILD:-1}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found" >&2
  exit 1
fi
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Compose file not found: $COMPOSE_FILE" >&2
  exit 1
fi

echo "Using compose file: $COMPOSE_FILE"
if [ "$STOP_BEFORE_BUILD" = "1" ]; then
  echo "Stopping $SERVICE_NAME and $SANDBOX_SERVICE before build..."
  docker compose -f "$COMPOSE_FILE" stop "${SERVICES[@]}" || true
fi

cache=()
if [ "$NO_CACHE" = "1" ]; then
  cache=(--no-cache)
fi
mirror_prefix="docker.m.daocloud.io/library"
official_prefix="docker.io/library"

build_app() {
  local prefix="$1"
  local now_kb go_mb
  now_kb="$(awk '/MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  go_mb=384
  if [ "$now_kb" -gt 0 ]; then
    go_mb=$((now_kb / 1024 - 500))
  fi
  if [ "$go_mb" -gt 512 ]; then go_mb=512; fi
  if [ "$go_mb" -lt 256 ]; then go_mb=256; fi
  echo "MemAvailable ${now_kb} kB; Go compiler capped at ${go_mb} MB"
  echo "Building $SERVICE_NAME with $prefix"
  docker compose -f "$COMPOSE_FILE" build \
    --build-arg "GO_IMAGE=${prefix}/golang:1.26-bookworm" \
    --build-arg "DEBIAN_IMAGE=${prefix}/debian:bookworm-slim" \
    --build-arg "GO_MEM_LIMIT_MB=${go_mb}" \
    "$SERVICE_NAME" || return 1
}

build_sandbox() {
  local prefix="$1"
  echo "Building $SANDBOX_SERVICE with $prefix"
  docker compose -f "$COMPOSE_FILE" build "${cache[@]}" \
    --build-arg "PYTHON_IMAGE=${prefix}/python:3.12-slim" \
    "$SANDBOX_SERVICE" || return 1
}

if ! build_app "$mirror_prefix"; then
  echo "Go image mirror failed. Falling back to Docker Hub..."
  build_app "$official_prefix"
fi
if ! build_sandbox "$mirror_prefix"; then
  echo "Sandbox mirror failed. Falling back to Docker Hub..."
  build_sandbox "$official_prefix"
fi

echo "Recreating services: ${SERVICES[*]}"
docker compose -f "$COMPOSE_FILE" up -d --no-build --force-recreate "${SERVICES[@]}"

echo "Waiting for service to become healthy (up to $((HEALTH_RETRIES * 2))s)..."
healthy=0
for _ in $(seq 1 "$HEALTH_RETRIES"); do
  if docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE_NAME" wget -q -O /dev/null http://127.0.0.1:3000/api/health; then
    healthy=1
    break
  fi
  sleep 2
done

docker compose -f "$COMPOSE_FILE" ps "$SERVICE_NAME"
if [ "$healthy" != "1" ]; then
  echo "Health check FAILED. Recent logs:" >&2
  docker compose -f "$COMPOSE_FILE" logs --tail=100 "$SERVICE_NAME" >&2
  exit 1
fi
echo "Health check: OK"
