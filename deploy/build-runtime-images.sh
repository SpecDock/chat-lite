#!/usr/bin/env bash
# Explicit local environment upgrade. Never invoked by rebuild-backend.sh; never pushes.
set -euo pipefail
cd "$(dirname "$0")/.."

runtime_image=localhost/chat-lite/backend-runtime:2026-11-17-v1
sandbox_image=localhost/chat-lite/table-sandbox:2026-11-17-v1
selection=both
usage() {
  echo "Usage: bash deploy/build-runtime-images.sh [--runtime-image REGISTRY/NAME:VERSION] [--sandbox-image REGISTRY/NAME:VERSION] [--runtime-only|--sandbox-only]"
  echo "Builds explicitly; does not deploy, change the broker's worker alias, or push. Use a new tag for each environment upgrade."
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-image|--sandbox-image)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { usage >&2; exit 2; }
      if [ "$1" = --runtime-image ]; then runtime_image="$2"; else sandbox_image="$2"; fi
      shift 2 ;;
    --runtime-only) selection=runtime; shift ;;
    --sandbox-only) selection=sandbox; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
for image in "$runtime_image" "$sandbox_image"; do
  last="${image##*/}"
  if [[ "$image" == *@* || "$last" != *:* || "${last##*:}" == latest || -z "${last##*:}" ]]; then
    echo "Environment build requires an explicit non-latest version tag, not a digest: $image" >&2
    exit 2
  fi
done
command -v docker >/dev/null 2>&1 || { echo 'docker not found' >&2; exit 1; }
# Share the deployment lock: environment builds must not compete with a backend build.
command -v flock >/dev/null 2>&1 || { echo 'flock is required for serial environment builds' >&2; exit 1; }
exec 9>/var/lock/chat-lite-backend-deploy.lock
flock -n 9 || { echo 'Another environment build or backend deployment holds the host lock; nothing was built.' >&2; exit 1; }
echo 'Host lock serializes these deployment/environment scripts only; manual Docker builds and other host processes are not controlled.'

build_runtime() {
  docker build -f deploy/Dockerfile.backend-runtime \
    --build-arg "DEBIAN_IMAGE=$1/debian:bookworm-slim" -t "$runtime_image" .
}
build_sandbox() {
  docker build -f sandbox/Dockerfile \
    --build-arg "PYTHON_IMAGE=$1/python:3.12-slim-bookworm" \
    --build-arg "GO_IMAGE=$1/golang:1.26-bookworm" -t "$sandbox_image" sandbox
}
if [ "$selection" != sandbox ]; then
  if ! build_runtime docker.m.daocloud.io/library; then
    echo 'Explicit runtime build failed using public mirror; retrying official base.' >&2
    build_runtime docker.io/library
  fi
fi
if [ "$selection" != runtime ]; then
  if ! build_sandbox docker.m.daocloud.io/library; then
    echo 'Explicit worker build failed using public mirror; retrying official bases.' >&2
    build_sandbox docker.io/library
  fi
fi
echo 'Environment build complete. No services or worker aliases were changed; no images were pushed.'
echo "Next: bash deploy/rebuild-backend.sh --runtime-image $runtime_image --sandbox-image $sandbox_image"
echo 'For registry distribution, choose your real registry/version with the options above, then explicitly docker push each image.'
