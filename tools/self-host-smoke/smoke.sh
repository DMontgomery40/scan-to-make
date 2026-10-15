#!/usr/bin/env bash
# Clean-checkout bootstrap + smoke test for the offline capture tools.
#   tools/self-host-smoke/smoke.sh            # create/reuse venv, run everything
#   SMOKE_VENV=/path/venv tools/self-host-smoke/smoke.sh
#   SMOKE_SKIP_INSTALL=1 ...                  # reuse an existing venv without pip
# Exit 0 only if every step passes. The capture-import/native end-to-end gate is
# NOT exercised here and is always reported OPEN.
set -u -o pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
USD_CORE_VERSION="26.8"
VENV="${SMOKE_VENV:-${XDG_CACHE_HOME:-$HOME/.cache}/scan-to-make/usd-core-$USD_CORE_VERSION-venv}"
PY_BOOT="${PYTHON:-python3}"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/self-host-smoke.XXXXXX")"
cd "$REPO"

results=()
fail=0
step() {  # step NAME CMD...
  local name="$1"; shift
  local log="$OUT/$(echo "$name" | tr ' /' '__').log"
  printf '==> %s\n' "$name"
  if "$@" >"$log" 2>&1; then
    results+=("PASS  $name"); printf '    PASS\n'
  else
    results+=("FAIL  $name  (log: $log)"); fail=1; printf '    FAIL (see %s)\n' "$log"; tail -n 20 "$log" | sed 's/^/    | /'
  fi
}

bootstrap() {
  "$PY_BOOT" -c 'import sys; assert sys.version_info >= (3, 10), sys.version' || return 1
  if [ ! -x "$VENV/bin/python" ]; then
    mkdir -p "$(dirname "$VENV")" && "$PY_BOOT" -m venv "$VENV" || return 1
  fi
  if [ -z "${SMOKE_SKIP_INSTALL:-}" ]; then
    "$VENV/bin/python" -m pip install --disable-pip-version-check -q "usd-core==$USD_CORE_VERSION" || return 1
  fi
  "$VENV/bin/python" -c "from pxr import Usd; v='.'.join(map(str, Usd.GetVersion())); print('pxr', v); assert v.endswith('$USD_CORE_VERSION'), v"
}

V="$VENV/bin/python"
step "bootstrap venv (usd-core $USD_CORE_VERSION)" bootstrap
if [ "$fail" -ne 0 ]; then
  echo "bootstrap failed; skipping tool steps"
else
  step "capture-mesh-convert tests" "$V" -m unittest discover -s tools/capture-mesh-convert/tests -v
  step "capture-fit-eval tests" python3 -m unittest discover -s tools/capture-fit-eval/tests -v
  step "capture-pipeline tests (pipeline + duplicate)" "$V" -m unittest discover -s tools/capture-pipeline/tests -v
  step "capture-mesh-convert fixture build (binary USDC usdz)" "$V" tools/capture-mesh-convert/make_fixtures.py "$OUT/fixtures"
  step "capture-pipeline repro" "$V" tools/capture-pipeline/repro.py "$OUT/pipeline-repro"
  step "capture-pipeline duplicate repro" "$V" tools/capture-pipeline/duplicate_repro.py "$OUT/duplicate-repro"
fi

echo
echo "================ self-host smoke summary ================"
echo "repo:   $(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
echo "venv:   $VENV"
echo "logs:   $OUT"
for r in "${results[@]}"; do echo "  $r"; done
echo "  OPEN  capture-import/native end-to-end gate (not exercised: pending the import seam; synthetic fixtures only)"
if [ "$fail" -eq 0 ]; then
  echo "RESULT: PASS (offline tools only; import e2e gate OPEN)"
else
  echo "RESULT: FAIL"
fi
exit "$fail"
