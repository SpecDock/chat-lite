#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Existing environment controls only. Image selection is via CLI, never new env vars.
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.backend.yml}"
SERVICE_NAME="${SERVICE_NAME:-chat-lite}"
NO_CACHE="${NO_CACHE:-0}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
broker_service=sandbox-broker
runtime_image=localhost/chat-lite/backend-runtime:2026-11-17-v1
sandbox_image=localhost/chat-lite/table-sandbox:2026-11-17-v1
worker_alias=chat-lite-table-sandbox:latest
backend_alias=chat-lite-backend:latest

usage() {
  echo 'Usage: bash deploy/rebuild-backend.sh [--runtime-image REGISTRY/NAME:VERSION_OR_DIGEST] [--sandbox-image REGISTRY/NAME:VERSION_OR_DIGEST]'
  echo 'Local versioned defaults must first be made with bash deploy/build-runtime-images.sh.'
  echo 'Missing images are pulled only from an explicit registry ref. No environment is built here.'
  echo 'Low-memory mode only: app and broker are stopped before compilation; failures restore the old deployment.'
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-image|--sandbox-image)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { usage >&2; exit 2; }
      if [ "$1" = --runtime-image ]; then runtime_image="$2"; else sandbox_image="$2"; fi
      shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ "$HEALTH_RETRIES" =~ ^[1-9][0-9]*$ ]] || { echo 'HEALTH_RETRIES must be a positive integer' >&2; exit 2; }
[[ "$SERVICE_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || { echo 'Invalid service name' >&2; exit 2; }
[ "$SERVICE_NAME" != "$broker_service" ] || { echo 'App and broker services must differ' >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo 'docker not found' >&2; exit 1; }
[ -f "$COMPOSE_FILE" ] || { echo "Compose file not found: $COMPOSE_FILE" >&2; exit 1; }
# Worker/backend aliases are host-wide; hold this lock through rollback and exit.
command -v flock >/dev/null 2>&1 || { echo 'flock is required for safe deployment' >&2; exit 1; }
exec 9>/var/lock/chat-lite-backend-deploy.lock
flock -n 9 || { echo 'Another backend deployment or environment build holds the host lock; no services were changed.' >&2; exit 1; }
echo 'Low-memory mode only; STOP_BEFORE_BUILD is ignored regardless of its value.'
echo 'Host lock serializes these deployment/environment scripts only; manual Docker builds and other host processes are not controlled.'

ensure_image() {
  local image="$1" last registry
  last="${image##*/}"
  if [[ "$image" == *@* ]]; then
    [[ "$image" =~ @sha256:[a-fA-F0-9]{64}$ ]] || { echo "Invalid image digest: $image" >&2; return 1; }
  elif [[ "$last" != *:* || "${last##*:}" == latest || -z "${last##*:}" ]]; then
    echo "Select a fixed version tag or sha256 digest, not latest: $image" >&2
    return 1
  fi
  if docker image inspect "$image" >/dev/null 2>&1; then
    echo "Reusing local environment: $image (no freshness check)"
    return 0
  fi
  registry="${image%%/*}"
  if [[ "$image" != */* || ( "$registry" != *.* && "$registry" != *:* && "$registry" != localhost ) || "$registry" == localhost ]]; then
    echo "Local environment missing: $image. Not guessing a Docker Hub registry." >&2
    echo 'Run bash deploy/build-runtime-images.sh, or provide --runtime-image / --sandbox-image with your real registry ref.' >&2
    return 1
  fi
  echo "Pulling missing environment: $image"
  if ! docker pull "$image"; then
    echo 'Pull failed. Existing services are untouched; provide an accessible registry ref or explicitly build environments with deploy/build-runtime-images.sh.' >&2
    return 1
  fi
}
ensure_image "$runtime_image"
ensure_image "$sandbox_image"
runtime_id="$(docker image inspect --format '{{.Id}}' "$runtime_image")"
worker_id="$(docker image inspect --format '{{.Id}}' "$sandbox_image")"

# Immutable local pins also handle digest sources without ever tagging a digest as a destination.
stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
candidate="localhost/chat-lite/backend-candidate:$stamp"
runtime_pin="localhost/chat-lite/backend-runtime-selected:$stamp"
docker image tag "$runtime_id" "$runtime_pin"
cache=()
if [ "$NO_CACHE" = 1 ]; then cache=(--no-cache); fi
build_app() {
  docker build "${cache[@]}" --target runner \
    --build-arg "GO_IMAGE=$1/golang:1.26-bookworm" \
    --build-arg "BACKEND_RUNTIME_IMAGE=$runtime_pin" \
    --build-arg "GO_MEM_LIMIT_MB=$go_mb" -t "$candidate" .
}
# Save the actual deployed image IDs, not just a mutable shared tag.
old_app_container="$(docker compose -f "$COMPOSE_FILE" ps -aq "$SERVICE_NAME")"
old_broker_container="$(docker compose -f "$COMPOSE_FILE" ps -aq "$broker_service")"
if [[ "$old_app_container" == *$'\n'* || "$old_broker_container" == *$'\n'* ]]; then
  echo 'Multiple containers per service are not supported by this local rollback script.' >&2
  exit 1
fi
if { [ -n "$old_app_container" ] && [ -z "$old_broker_container" ]; } || { [ -z "$old_app_container" ] && [ -n "$old_broker_container" ]; }; then
  echo 'Only one old service exists; refusing an ambiguous rollback. Existing services are untouched.' >&2
  exit 1
fi
old_app_image=
old_broker_image=
if [ -n "$old_app_container" ]; then
  old_app_image="localhost/chat-lite/backend-rollback:$stamp"
  old_broker_image="localhost/chat-lite/broker-rollback:$stamp"
  docker image tag "$(docker inspect --format '{{.Image}}' "$old_app_container")" "$old_app_image"
  docker image tag "$(docker inspect --format '{{.Image}}' "$old_broker_container")" "$old_broker_image"
fi
old_worker_alias="$(docker image inspect --format '{{.Id}}' "$worker_alias" 2>/dev/null || true)"
old_backend_alias="$(docker image inspect --format '{{.Id}}' "$backend_alias" 2>/dev/null || true)"
if [ -n "$old_worker_alias" ]; then
  docker image tag "$old_worker_alias" "localhost/chat-lite/worker-rollback:$stamp"
fi
if [ -n "$old_backend_alias" ]; then
  docker image tag "$old_backend_alias" "localhost/chat-lite/backend-alias-rollback:$stamp"
fi

override="$(mktemp "./deploy/.backend-switch.XXXXXX")"
rollback_override="$(mktemp "./deploy/.backend-rollback.XXXXXX")"
switching=0
committed=0
aliases_changed=0
compose_candidate() { docker compose -f "$COMPOSE_FILE" -f "$override" "$@"; }
compose_old() { docker compose -f "$COMPOSE_FILE" -f "$rollback_override" "$@"; }
wait_healthy() {
  local file="$1" i service id status all_ok
  for ((i=0; i<HEALTH_RETRIES; i++)); do
    all_ok=1
    for service in "$SERVICE_NAME" "$broker_service"; do
      id="$(docker compose -f "$COMPOSE_FILE" -f "$file" ps -q "$service")" || id=
      status=
      if [ -n "$id" ]; then
        status="$(docker inspect --format '{{if .State.Running}}{{if .State.Health}}{{.State.Health.Status}}{{end}}{{end}}' "$id" 2>/dev/null)" || status=
      fi
      if [ "$status" != healthy ]; then all_ok=0; fi
    done
    if [ "$all_ok" = 1 ]; then return 0; fi
    sleep 2
  done
  return 1
}
restore_alias() {
  local alias="$1" old="$2"
  if [ -n "$old" ]; then docker image tag "$old" "$alias";
  else docker image rm "$alias"; fi
}
finish() {
  local result=$? failed=0
  trap - EXIT INT TERM
  if [ "$switching" = 1 ] && [ "$committed" = 0 ]; then
    set +e
    echo 'Build/switch failed or interrupted; restoring the previous deployment.' >&2
    compose_candidate stop --timeout 30 "$SERVICE_NAME" "$broker_service" || failed=1
    if [ "$aliases_changed" = 1 ]; then
      restore_alias "$worker_alias" "$old_worker_alias" || failed=1
      restore_alias "$backend_alias" "$old_backend_alias" || failed=1
    fi
    if [ -n "$old_app_image" ]; then
      compose_old up -d --no-build --pull never --no-deps --force-recreate "$broker_service" "$SERVICE_NAME" || failed=1
      wait_healthy "$rollback_override" || failed=1
      echo "Rollback images retained: $old_app_image $old_broker_image" >&2
    else
      echo 'Initial deployment had no previous services; failed candidate services were stopped.' >&2
    fi
    if [ "$failed" = 0 ]; then echo 'Rollback completed.' >&2;
    else echo 'ROLLBACK INCOMPLETE: manual recovery required; retained images and service logs must be checked.' >&2; fi
    result=1
  fi
  rm -f "$override" "$rollback_override"
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'services:\n  %s:\n    image: "%s"\n  %s:\n    image: "%s"\n' \
  "$SERVICE_NAME" "$candidate" "$broker_service" "$candidate" > "$override"
if [ -n "$old_app_image" ]; then
  printf 'services:\n  %s:\n    image: "%s"\n  %s:\n    image: "%s"\n' \
    "$SERVICE_NAME" "$old_app_image" "$broker_service" "$old_broker_image" > "$rollback_override"
fi
# Parse both merged compose configurations before entering the maintenance window.
compose_candidate config --quiet
if [ -n "$old_app_image" ]; then compose_old config --quiet; fi
echo 'Entering low-memory maintenance window BEFORE compilation.'
echo 'Independent session workers are NOT stopped by this script and may still consume memory.'
echo 'Existing broker startup cleanup removes managed workers, including on rollback; sessions/tasks cannot be restored.'
echo 'This script does not delete worker containers, job directories, permissions, caches, or volumes.'
switching=1
compose_candidate stop --timeout 30 "$SERVICE_NAME" "$broker_service"
# Measure only after stopping services. Reserve 500 MiB for Docker, BuildKit and the OS.
# GOMEMLIMIT is a Go runtime soft target, not a container limit or an OOM guarantee.
available_kb=0
if [ -r /proc/meminfo ]; then
  while read -r key value rest; do
    if [ "$key" = MemAvailable: ]; then
      available_kb="$value"
      break
    fi
  done < /proc/meminfo
fi
if ! [[ "$available_kb" =~ ^[0-9]+$ ]] || [ "$available_kb" -lt $((756 * 1024)) ]; then
  echo "Insufficient/unknown MemAvailable after stop: ${available_kb} kB; need at least 756 MiB (500 reserve + 256 Go target). Restoring old services." >&2
  exit 1
fi
go_mb=$((available_kb / 1024 - 500))
if [ "$go_mb" -gt 512 ]; then go_mb=512; fi
echo "MemAvailable ${available_kb} kB; serial Go build with soft GOMEMLIMIT ${go_mb} MiB (not an OOM guarantee)."
if ! build_app docker.m.daocloud.io/library; then
  echo 'Backend build failed; retrying official Go base with the SAME selected runtime.' >&2
  build_app docker.io/library
fi
aliases_changed=1
docker image tag "$worker_id" "$worker_alias"
docker image tag "$candidate" "$backend_alias"
compose_candidate up -d --no-build --pull never --no-deps --force-recreate "$broker_service" "$SERVICE_NAME"
if ! wait_healthy "$override"; then
  echo 'Candidate health check FAILED. Rolling back.' >&2
  compose_candidate logs --tail=100 "$SERVICE_NAME" "$broker_service" >&2 || true
  exit 1
fi
committed=1
echo "Health check OK. Backend: $candidate; worker: $sandbox_image ($worker_id)"
if [ -n "$old_app_image" ]; then echo "Rollback tags retained: $old_app_image $old_broker_image"; fi
