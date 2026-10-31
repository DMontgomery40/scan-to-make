#!/usr/bin/env bash
set -euo pipefail
image=${1:-scan-to-make-companion:local}
name="stm-package-smoke-$$"
volume="$name-data"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker volume create "$volume" >/dev/null
docker run --rm -v "$volume:/data" "$image" node /app/services/companion/dist/remote-auth-cli.js \
  init /data/auth smoke.example.ts.net smoke@example.com
# Isolated network namespace: this smoke test never publishes a host port.
docker run -d --name "$name" -v "$volume:/data" \
  -e SCAN_TO_MAKE_REMOTE_AUTH_DIR=/data/auth -e SCAN_TO_MAKE_CAPTURE_DIR=/data/capture \
  -e SCAN_TO_MAKE_CAPTURE_PYTHON=/opt/python/bin/python3 \
  -e SCAN_TO_MAKE_SCAN_REPAIR_TOOL=/app/tools/scan-repair/repair.py \
  -e SCAN_TO_MAKE_SCAN_BLENDER=/opt/blender/blender "$image" >/dev/null
ready=0
for attempt in $(seq 1 30); do
  if docker exec "$name" node /app/deploy/companion/healthcheck.mjs >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != 1 ]; then docker logs "$name"; exit 1; fi
docker exec "$name" node /app/deploy/companion/auth-smoke.mjs
docker exec "$name" node /app/deploy/companion/mcp-smoke.mjs
docker exec "$name" sh -c 'blender --version | head -1 | grep -Fx "Blender 5.0.1"'
docker exec "$name" python3 -c 'from pxr import Usd; from PIL import Image; import pillow_heif; print("Python codecs:", Usd.GetVersion(), Image.__version__, pillow_heif.__version__)'
# Exercise the real correction sandbox as the image's non-root user.
docker exec "$name" python3 -m unittest discover -s tools/scan-correct/tests -p test_service.py -k network_sandbox -v
docker exec "$name" xvfb-run -a python3 -m unittest discover -s tools/scan-repair/tests -p test_repair.py -k test_render_and_decimate -v
docker run --rm --entrypoint node "$image" --test /app/services/companion/tests/lan-pairing.test.mjs
echo 'Companion container smoke passed'
