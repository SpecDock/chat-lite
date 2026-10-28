#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

STOP_BEFORE_BUILD="${STOP_BEFORE_BUILD:-1}"
NO_CACHE="${NO_CACHE:-0}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.backend.yml}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found" >&2
  exit 1
fi

if [ "$STOP_BEFORE_BUILD" = "1" ] && [ -f "$COMPOSE_FILE" ]; then
  echo "Stopping chat-lite, sandbox-broker, and the old sandbox before the frontend build..."
  docker compose -f "$COMPOSE_FILE" --profile image stop chat-lite sandbox-broker table-sandbox || true
fi

avail_kb="$(awk '/MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
node_mb=512
if [ "$avail_kb" -gt 0 ]; then
  node_mb=$((avail_kb / 1024 - 450))
fi
if [ "$node_mb" -gt 768 ]; then node_mb=768; fi
if [ "$node_mb" -lt 384 ]; then node_mb=384; fi
echo "MemAvailable ${avail_kb} kB; Node heap capped at ${node_mb} MB"

cache=()
if [ "$NO_CACHE" = "1" ]; then
  cache=(--no-cache)
fi
vite_ms="${VITE_STREAM_MARKDOWN_INTERVAL_MS:-50}"
mirror_prefix="docker.m.daocloud.io/library"
official_prefix="docker.io/library"

build_web() {
  local prefix="$1"
  echo "Building frontend with $prefix"
  docker build "${cache[@]}" --target web -t chat-lite-web:build \
    --build-arg "NODE_IMAGE=${prefix}/node:24.18.0-bookworm-slim" \
    --build-arg "NODE_HEAP_MB=${node_mb}" \
    --build-arg "VITE_STREAM_MARKDOWN_INTERVAL_MS=${vite_ms}" \
    -f Dockerfile . || return 1
}

if ! build_web "$mirror_prefix"; then
  echo "Frontend mirror failed. Falling back to Docker Hub..."
  build_web "$official_prefix"
fi

rm -rf deploy/www/chat
mkdir -p deploy/www/chat
container="$(docker create chat-lite-web:build)"
docker cp "$container":/app/dist/. deploy/www/chat/
docker rm "$container" >/dev/null
echo "Frontend files are in deploy/www/chat"
if [ -f docker-compose.web.yml ]; then
  docker compose -f docker-compose.web.yml up -d
fi
