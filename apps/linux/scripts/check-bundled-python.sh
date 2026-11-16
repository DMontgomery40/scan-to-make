#!/usr/bin/env bash
# #856: a package's own Python converts a scan over the 32 MiB upload limit, geometry-only, the way the companion
# converts a rebuild it keeps (capture-converter.ts, convertLocalScan), with an empty environment and a fresh HOME,
# so no system Python or user pip package can stand in for it. Engineering check only; starts no companion.
#
#   check-bundled-python.sh ROOT     ROOT holds Payload/ (prepared resources, or an unpacked .deb or AppImage)
set -euo pipefail
[[ $# == 1 ]] || { echo 'Usage: check-bundled-python.sh ROOT' >&2; exit 1; }
root=$(realpath "$1")
app=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$app/../.." && pwd)
python="$root/Payload/python/bin/python3"
source="$root/Payload/source"
python3 "$repo/tools/linux-host/check-python.py" "$repo/apps/mac/distribution.json" "$root/Payload/python"
mkdir -p "$app/src-tauri/build-tmp"
work=$(mktemp -d "$app/src-tauri/build-tmp/python.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir "$work/home"
clean=(env -i HOME="$work/home" PATH=/usr/bin:/bin LANG=C.UTF-8 TMPDIR="$work")
"${clean[@]}" "$python" -I "$source/tools/capture-mesh-convert/make_rebuild_fixture.py" "$work/rebuild.usdz" --texture-bytes $((40 * 1024 * 1024))
bytes=$(stat -c %s "$work/rebuild.usdz")
(( bytes > 32 * 1024 * 1024 )) || { echo "The fixture is only $bytes bytes" >&2; exit 1; }
# The same arguments convertLocalScan passes (LOCAL_SCAN_MAX_BYTES, DEFAULT_CAPTURE_LIMITS.maxDerivedBytes, 120 s).
"${clean[@]}" "$python" "$source/services/companion/python/capture_convert.py" --source "$work/rebuild.usdz" \
  --out "$work/mesh.obj" --report "$work/conversion.json" --max-source-bytes $((1024 * 1024 * 1024)) --geometry-only \
  --max-derived-bytes $((64 * 1024 * 1024)) --timeout-ms 120000
"${clean[@]}" "$python" -I - "$work/conversion.json" "$work/mesh.obj" "$bytes" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
faces = sum(1 for line in open(sys.argv[2]) if line.startswith('f '))
if report.get('geometryOnly') is not True or report.get('source', {}).get('bytes') != int(sys.argv[3]) or not faces:
    raise SystemExit('The bundled Python did not convert the scan: ' + json.dumps(report)[:400])
print(f'Bundled Python converted a {int(sys.argv[3]) / 1048576:.1f} MiB scan geometry-only: {faces} faces')
PY
