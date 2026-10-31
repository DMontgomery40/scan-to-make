#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
python=${CI_LOCAL_PYTHON:-python3}
if ! "$python" -c 'import yaml' >/dev/null 2>&1; then
  runtime="${XDG_CACHE_HOME:-$HOME/.cache}/scan-to-make/ci-local/parser"
  "$python" -m venv "$runtime"
  "$runtime/bin/python" -m pip install --disable-pip-version-check -r "$root/scripts/requirements-ci-local.txt" >&2
  python="$runtime/bin/python"
fi
exec "$python" "$root/scripts/ci_local.py" "$@"
