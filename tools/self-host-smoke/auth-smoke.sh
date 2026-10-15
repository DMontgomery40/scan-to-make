#!/usr/bin/env bash
# Authenticated portable-project sync → real USDZ import → restart →
# verified reopen / exact download, using isolated fixture auth only.
#   tools/self-host-smoke/auth-smoke.sh
# Offline tool smoke is separate and unchanged:
#   tools/self-host-smoke/smoke.sh
# Exit 0 only when the authenticated HTTP path and negative scope/stale
# checks pass. Native review/export acceptance is always reported OPEN.
set -u -o pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
USD_CORE_VERSION="26.8"
VENV="${SMOKE_VENV:-${XDG_CACHE_HOME:-$HOME/.cache}/scan-to-make/usd-core-$USD_CORE_VERSION-venv}"
if [ -z "${PYTHON:-}" ]; then
  if command -v python3.12 >/dev/null 2>&1; then
    PY_BOOT=python3.12
  else
    PY_BOOT=python3
  fi
else
  PY_BOOT="$PYTHON"
fi
OUT="$(mktemp -d "${TMPDIR:-/tmp}/self-host-auth-smoke.XXXXXX")"
AUTH_DIR="$OUT/auth"
CAPTURE_DIR="$OUT/capture"
CLEANUP_LIST="$OUT/created-checkout-paths"
LISTENER_PID=""
LISTENER_URL=""
export PYTHONDONTWRITEBYTECODE=1
cd "$REPO"
: >"$CLEANUP_LIST"

results=()
fail=0
step() {  # step NAME CMD...
  local name="$1"; shift
  local log="$OUT/$(echo "$name" | tr ' /' '__').log"
  printf '==> %s\n' "$name"
  if "$@" >"$log" 2>&1; then
    results+=("PASS  $name"); printf '    PASS\n'
  else
    results+=("FAIL  $name  (log: $log)"); fail=1; printf '    FAIL (see %s)\n' "$log"; tail -n 40 "$log" | sed 's/^/    | /'
  fi
}

track_if_missing() {
  if [ ! -e "$1" ]; then
    printf '%s\n' "$1" >>"$CLEANUP_LIST"
  fi
}

cleanup() {
  if [ -n "${LISTENER_PID:-}" ] && kill -0 "$LISTENER_PID" 2>/dev/null; then
    kill "$LISTENER_PID" 2>/dev/null || true
    wait "$LISTENER_PID" 2>/dev/null || true
  fi
  if [ -z "${SMOKE_KEEP_BUILD:-}" ] && [ -f "$CLEANUP_LIST" ]; then
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      rm -rf "$path"
    done <"$CLEANUP_LIST"
  fi
}
trap cleanup EXIT

bootstrap_python() {
  "$PY_BOOT" -c 'import sys; assert sys.version_info >= (3, 10), sys.version' || return 1
  if [ ! -x "$VENV/bin/python" ]; then
    mkdir -p "$(dirname "$VENV")" && "$PY_BOOT" -m venv "$VENV" || return 1
  fi
  if [ -z "${SMOKE_SKIP_INSTALL:-}" ]; then
    "$VENV/bin/python" -m pip install --disable-pip-version-check -q "usd-core==$USD_CORE_VERSION" || return 1
  fi
  "$VENV/bin/python" -c "from pxr import Usd; v='.'.join(map(str, Usd.GetVersion())); print('pxr', v, 'python', __import__('sys').version.split()[0]); assert v.endswith('$USD_CORE_VERSION'), v"
}

install_companion() {
  command -v node >/dev/null 2>&1 || { echo "node is required"; return 1; }
  command -v npm >/dev/null 2>&1 || { echo "npm is required"; return 1; }
  track_if_missing "$REPO/packages/contracts/node_modules"
  track_if_missing "$REPO/packages/contracts/dist"
  track_if_missing "$REPO/services/project/node_modules"
  track_if_missing "$REPO/services/project/dist"
  track_if_missing "$REPO/services/companion/node_modules"
  track_if_missing "$REPO/services/companion/dist"
  npm ci --prefix "$REPO/packages/contracts" --ignore-scripts || return 1
  npm ci --prefix "$REPO/services/project" --ignore-scripts || return 1
  npm ci --prefix "$REPO/services/companion" --ignore-scripts || return 1
  npm run build --prefix "$REPO/services/companion" || return 1
  test -f "$REPO/services/companion/dist/generation-cli.js"
  test -f "$REPO/services/companion/dist/remote-auth-cli.js"
}

start_listener() {
  local log="$1"
  mkdir -p "$CAPTURE_DIR"
  SCAN_TO_MAKE_REMOTE_AUTH_DIR="$AUTH_DIR" \
  SCAN_TO_MAKE_CAPTURE_DIR="$CAPTURE_DIR" \
  SCAN_TO_MAKE_CAPTURE_PYTHON="$VENV/bin/python" \
  SCAN_TO_MAKE_GENERATION_PORT=0 \
  node "$REPO/services/companion/dist/generation-cli.js" >"$log" 2>&1 &
  LISTENER_PID=$!
  local i
  for i in $(seq 1 100); do
    if ! kill -0 "$LISTENER_PID" 2>/dev/null; then
      echo "listener exited during startup" >&2
      cat "$log" >&2
      return 1
    fi
    if grep -q 'Private Serve generation ready at http://127.0.0.1:' "$log"; then
      LISTENER_URL="$(sed -n 's/.*ready at \(http:\/\/127.0.0.1:[0-9][0-9]*\).*/\1/p' "$log" | tail -n 1)"
      return 0
    fi
    sleep 0.1
  done
  echo "listener did not become ready" >&2
  cat "$log" >&2
  return 1
}

stop_listener() {
  if [ -n "${LISTENER_PID:-}" ] && kill -0 "$LISTENER_PID" 2>/dev/null; then
    kill "$LISTENER_PID" 2>/dev/null || true
    local i
    for i in $(seq 1 50); do
      kill -0 "$LISTENER_PID" 2>/dev/null || { LISTENER_PID=""; return 0; }
      sleep 0.1
    done
    kill -9 "$LISTENER_PID" 2>/dev/null || true
    wait "$LISTENER_PID" 2>/dev/null || true
  fi
  LISTENER_PID=""
}

init_fixture_auth() {
  # RemoteAuthStore.create requires a new absolute directory and will not replace one.
  rm -rf "$AUTH_DIR"
  node "$REPO/services/companion/dist/remote-auth-cli.js" init \
    "$AUTH_DIR" companion.example-tail.ts.net alice@example.test || return 1
}

invite_devices() {
  node "$REPO/services/companion/dist/remote-auth-cli.js" pair-capture \
    "$AUTH_DIR" alice@example.test >"$OUT/capture-invite.json" || return 1
  node "$REPO/services/companion/dist/remote-auth-cli.js" pair \
    "$AUTH_DIR" alice@example.test >"$OUT/generation-invite.json" || return 1
}

run_phase() {
  local phase="$1" base="$2"
  node "$REPO/tools/self-host-smoke/auth-http.mjs" "$phase" \
    --base "$base" \
    --state "$OUT/http-state.json" \
    --project "$REPO/tools/self-host-smoke/fixtures/phone-project.json" \
    --usdz "$OUT/fixtures/two_layer.usdz" \
    --capture-invite "$OUT/capture-invite.json" \
    --generation-invite "$OUT/generation-invite.json" \
    --serve-fixture "$REPO/services/companion/tests/fixtures/tailscale-serve-v1.94.2.json"
}

authenticated_path() {
  local first_log="$OUT/listener-1.log" second_log="$OUT/listener-2.log" base
  init_fixture_auth || return 1
  start_listener "$first_log" || return 1
  base="$LISTENER_URL"
  printf 'listener 1 %s\n' "$base"
  invite_devices || { stop_listener; return 1; }
  run_phase pair-sync-import "$base" || { stop_listener; return 1; }
  stop_listener || return 1
  start_listener "$second_log" || return 1
  base="$LISTENER_URL"
  printf 'listener 2 %s\n' "$base"
  run_phase reopen-negatives "$base"
  local status=$?
  stop_listener || true
  return "$status"
}

assert_clean_checkout() {
  local dirty
  dirty="$(git -C "$REPO" status --porcelain)"
  if [ -n "$dirty" ]; then
    printf 'checkout is dirty after smoke:\n%s\n' "$dirty"
    return 1
  fi
}

step "bootstrap venv (usd-core $USD_CORE_VERSION, prefer python3.12)" bootstrap_python
if [ "$fail" -eq 0 ]; then
  step "install companion/project/contracts into isolated build artifacts" install_companion
fi
if [ "$fail" -eq 0 ]; then
  step "capture-mesh-convert fixture build (two_layer.usdz)" \
    "$VENV/bin/python" "$REPO/tools/capture-mesh-convert/make_fixtures.py" "$OUT/fixtures"
fi
if [ "$fail" -eq 0 ]; then
  step "authenticated sync → import → restart → reopen/exact download + negatives" \
    authenticated_path
fi
cleanup
trap - EXIT
if [ "$fail" -eq 0 ]; then
  step "checkout remains clean (git status --porcelain)" assert_clean_checkout
fi

echo
echo "================ self-host authenticated smoke summary ================"
echo "repo:   $(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
echo "venv:   $VENV"
echo "python: $PY_BOOT ($("$PY_BOOT" -c 'import sys; print("%d.%d.%d"%sys.version_info[:3])'))"
echo "logs:   $OUT"
echo "auth:   isolated RemoteAuthStore + Tailscale Serve fixture headers (no live tailnet)"
for r in "${results[@]}"; do echo "  $r"; done
echo "  OPEN  native review/export acceptance (not exercised; pending separate native evidence)"
if [ "$fail" -eq 0 ]; then
  echo "RESULT: PASS (authenticated HTTP path only; native review/export gate OPEN)"
else
  echo "RESULT: FAIL"
fi
exit "$fail"
