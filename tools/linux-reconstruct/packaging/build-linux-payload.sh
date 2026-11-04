#!/bin/bash
# Build the relocatable Linux reconstruction runtime payload (x86_64):
#
#   OUT_DIR/BUILD-ID            reconstruction-<toolVersion>-g<commit>-linux-x64
#   OUT_DIR/bin/linux-reconstruct   relocatable launcher (bundled Python, never PATH python3)
#   OUT_DIR/bin/colmap              wrapper over the extracted distro COLMAP closure
#   OUT_DIR/tool/                   tools/linux-reconstruct source at git HEAD
#   OUT_DIR/python/                 standalone CPython + usd-core + Pillow (pinned wheels)
#   OUT_DIR/colmap-root/            Ubuntu .deb closure for the COLMAP binary (dpkg -x, not installed)
#   OUT_DIR/openmvs/                the three OpenMVS binaries the tool invokes
#   OUT_DIR/lib/                    GCC runtime libraries, via wrappers' LD_LIBRARY_PATH
#   OUT_DIR/licenses/               notices extracted from the exact shipped artifacts + OpenMVS source
#   OUT_DIR/manifest.json           versions and SHA-256 of everything above
#
# Supported target: Ubuntu 26.04 LTS x86_64 (the .deb closure and its glibc
# 2.43 baseline). The payload assumes only glibc/ld-linux from the host.
# Everything is downloaded into OUT_DIR-adjacent scratch; nothing is
# installed system-wide and no system package is touched.
#
# Usage: build-linux-payload.sh OUT_DIR   (run on Ubuntu 26.04 x86_64; needs git, curl, apt-get, dpkg, unzip)
set -euo pipefail
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || { echo 'Build the Linux payload on Linux x86_64.' >&2; exit 1; }
[ $# -eq 1 ] || { echo 'Usage: build-linux-payload.sh OUT_DIR' >&2; exit 1; }
out=$1; case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
if [ -e "$out" ] && [ -n "$(ls -A "$out" 2>/dev/null)" ]; then echo "OUT_DIR must be absent or empty: $out" >&2; exit 1; fi
repo=$(cd "$(dirname "$0")/../../.." && pwd)
tool_dir="$repo/tools/linux-reconstruct"

PYTHON_URL=https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.12.16+20261026-x86_64-unknown-linux-gnu-install_only.tar.gz
PYTHON_SHA=6a79e922e50006b601f29e688407659da1c2b86ebcd4e9c7254cf234be8b89de
OPENMVS_ZIP_URL=https://github.com/cdcseacave/openMVS/releases/download/v2.4.0/OpenMVS_Ubuntu_x64.zip
OPENMVS_ZIP_SHA=7104ae1ddd6ca38fbca9e0e4a70b20af59e21e0b497eb7181c864fbf38ca8d00
OPENMVS_SRC_URL=https://github.com/cdcseacave/openMVS/archive/refs/tags/v2.4.0.tar.gz
OPENMVS_SRC_SHA=1668a991fa1fdd3540ee47fdba282a7579ed876af713e8fa907625be1cf8dfc8
USD_WHEEL=usd_core-26.8-cp312-none-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl
USD_WHEEL_URL=https://files.pythonhosted.org/packages/19/0b/efe5c0d7c273149ac94083831e5b36649925a621a73cd2ddf9616e160c8c/$USD_WHEEL
USD_WHEEL_SHA=204fb1ef1fc977b827c491f4e9fa39b57518504ed0cacfe12e026e95123cacf1
PIL_WHEEL=pillow-13.0.0-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl
PIL_WHEEL_URL=https://files.pythonhosted.org/packages/e6/99/fdf65cc539e266ab93546c261bdf98411fe165c6e4e13f9dbf597097192b/$PIL_WHEEL
PIL_WHEEL_SHA=42d63be3af4f9b951b199b0a9d23365d37ab14687e6d77b74940432c8515c4ca
# distro packages providing COLMAP and every shared library its binary needs
# (ldd closure, minus glibc/ld-linux which the supported target provides).
COLMAP_PACKAGES="colmap libamd3 libatomic1 libboost-program-options1.90.0 libbrotli1 libbz2-1.0 libcamd3 libccolamd3 libceres4t64 libcholmod5 libcolamd3 libdeflate0 libdouble-conversion3 libfreeimage3 libfreetype6 libgcc-s1 libgflags2.2 libgfortran5 libgl1 libglew2.2 libglib2.0-0t64 libglvnd0 libglx0 libgomp1 libgoogle-glog0v6t64 libgraphite2-3 libharfbuzz0b libicu78 libimath-3-1-29t64 libjbig0 libjpeg-turbo8 libjxr0t64 liblcms2-2 liblerc4 liblzma5 libmd4c0 libmetis5 libopenexr-3-1-30 libopengl0 libopenjp2-7 libpcre2-16-0 libpcre2-8-0 libpng16-16t64 libposelib libqt5core5t64 libqt5gui5t64 libqt5widgets5t64 libraw23t64 libsharpyuv0 libspqr4 libsqlite3-0 libstdc++6 libsuitesparseconfig7 libtiff6 libunwind8 libwebp7 libwebpmux3 libx11-6 libxau6 libxcb1 libxdmcp6 libzstd1 zlib1g"

mkdir -p "$(dirname "$out")"
work=$(mktemp -d "$(dirname "$out")/.reconstruction-payload.XXXXXX")
trap 'rm -rf "$work"' EXIT
stage="$work/out"
mkdir -p "$stage/bin" "$stage/licenses" "$stage/openmvs" "$stage/lib"
dl="$work/dl"; mkdir -p "$dl"

fetch() { # url sha dest
  curl --fail --location --retry 3 --silent --show-error -o "$3" "$1"
  echo "$2  $3" | sha256sum --check --quiet || { echo "Checksum mismatch: $1" >&2; exit 1; }
}
fetch "$PYTHON_URL" "$PYTHON_SHA" "$dl/python.tar.gz"
fetch "$OPENMVS_ZIP_URL" "$OPENMVS_ZIP_SHA" "$dl/OpenMVS_Ubuntu_x64.zip"
fetch "$OPENMVS_SRC_URL" "$OPENMVS_SRC_SHA" "$dl/openmvs-v2.4.0.tar.gz"
fetch "$USD_WHEEL_URL" "$USD_WHEEL_SHA" "$dl/$USD_WHEEL"
fetch "$PIL_WHEEL_URL" "$PIL_WHEEL_SHA" "$dl/$PIL_WHEEL"

# --- Python (relocatable standalone build) -----------------------------------
mkdir -p "$stage/python"
tar -xzf "$dl/python.tar.gz" --strip-components=1 -C "$stage/python"
python="$stage/python/bin/python3"
"$python" -m pip install --no-deps --no-index --quiet "$dl/$USD_WHEEL" "$dl/$PIL_WHEEL"
"$python" -c 'import pxr, PIL; print("python closure ok")'
# Wheel notices from the exact shipped distributions.
site=$("$python" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')
for dist in usd_core pillow; do
  mkdir -p "$stage/licenses/$dist"
  find "$site" -maxdepth 2 -path "*$dist-*.dist-info/*" \( -iname 'LICENSE*' -o -iname 'NOTICE*' -o -iname 'METADATA' -o -type d -iname 'licenses' \) \
    -exec cp -r {} "$stage/licenses/$dist/" \;
done
cp "$stage/python/LICENSE.txt" "$stage/licenses/python-LICENSE.txt" 2>/dev/null || \
  find "$stage/python" -maxdepth 3 -name 'LICENSE.txt' -exec cp {} "$stage/licenses/python-LICENSE.txt" \;

# --- OpenMVS official binaries + corresponding source -------------------------
unzip -q -o "$dl/OpenMVS_Ubuntu_x64.zip" -d "$work/openmvs-zip"
for tool in InterfaceCOLMAP DensifyPointCloud ReconstructMesh; do
  install -m 0755 "$work/openmvs-zip/$tool" "$stage/openmvs/$tool"
done
cp "$dl/openmvs-v2.4.0.tar.gz" "$stage/licenses/openmvs-v2.4.0-corresponding-source.tar.gz"
mkdir -p "$work/openmvs-src" && tar -xzf "$dl/openmvs-v2.4.0.tar.gz" -C "$work/openmvs-src" --strip-components=1
cp "$work/openmvs-src/LICENSE" "$stage/licenses/openmvs-LICENSE" 2>/dev/null || \
  find "$work/openmvs-src" -maxdepth 1 -iname 'LICENSE*' -exec cp {} "$stage/licenses/openmvs-LICENSE" \;

# --- COLMAP closure from distro .debs (download + extract, never install) -----
mkdir -p "$work/debs" "$stage/colmap-root"
(cd "$work/debs" && apt-get download $COLMAP_PACKAGES >/dev/null)
for deb in "$work/debs"/*.deb; do dpkg -x "$deb" "$stage/colmap-root"; done
# Closure proof: every library the extracted COLMAP binary needs must
# resolve inside the payload (the distro package under-declares libposelib).
missing=$(LD_LIBRARY_PATH="$stage/colmap-root/usr/lib/x86_64-linux-gnu:$stage/lib" ldd "$stage/colmap-root/usr/bin/colmap" | grep 'not found' || true)
if [ -n "$missing" ]; then echo "COLMAP closure is incomplete:" >&2; echo "$missing" >&2; exit 1; fi
# GCC runtime libraries for the OpenMVS binaries, from the same extracted debs.
for lib in libgomp.so.1 libstdc++.so.6 libgcc_s.so.1; do
  cp -L "$stage/colmap-root/usr/lib/x86_64-linux-gnu/$lib" "$stage/lib/" 2>/dev/null || \
    find "$stage/colmap-root" -name "$lib*" -exec cp -L {} "$stage/lib/" \; -quit
done
# Distro copyright files for the closure (COLMAP itself and the libraries).
mkdir -p "$stage/licenses/debian"
for pkg in $COLMAP_PACKAGES; do
  src="$stage/colmap-root/usr/share/doc/$pkg/copyright"
  [ -f "$src" ] && cp "$src" "$stage/licenses/debian/$pkg.copyright"
done
# Qt platform plugin colmap's Qt linkage loads at startup (offscreen only).
mkdir -p "$stage/colmap-root/usr/lib/x86_64-linux-gnu/qt5/plugins/platforms"
[ -f "$stage/colmap-root/usr/lib/x86_64-linux-gnu/qt5/plugins/platforms/libqoffscreen.so" ] || \
  echo 'warning: libqoffscreen.so not in deb closure' >&2

# --- Tool source at git HEAD + relocatable launchers ---------------------------
mkdir -p "$stage/tool"
git -C "$repo" archive HEAD tools/linux-reconstruct | tar -x -C "$stage/tool" --strip-components=2
rm -rf "$stage/tool/.venv" "$stage/tool/__pycache__" "$stage/tool/tests/__pycache__"
cat > "$stage/bin/linux-reconstruct" <<'LAUNCHER'
#!/bin/sh
# Relocatable: everything resolves from this script's own location.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(dirname "$HERE")
export SCAN_TO_MAKE_OPENMVS_DIR="${SCAN_TO_MAKE_OPENMVS_DIR:-$ROOT/openmvs}"
export SCAN_TO_MAKE_COLMAP="${SCAN_TO_MAKE_COLMAP:-$ROOT/bin/colmap}"
export LD_LIBRARY_PATH="$ROOT/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$ROOT/python/bin/python3" "$ROOT/tool/reconstruct.py" "$@"
LAUNCHER
cat > "$stage/bin/colmap" <<'LAUNCHER'
#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(dirname "$HERE")
export LD_LIBRARY_PATH="$ROOT/colmap-root/usr/lib/x86_64-linux-gnu:$ROOT/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export QT_QPA_PLATFORM="${QT_QPA_PLATFORM:-offscreen}"
export QT_PLUGIN_PATH="${QT_PLUGIN_PATH:-$ROOT/colmap-root/usr/lib/x86_64-linux-gnu/qt5/plugins}"
exec "$ROOT/colmap-root/usr/bin/colmap" "$@"
LAUNCHER
chmod +x "$stage/bin/linux-reconstruct" "$stage/bin/colmap"

# --- Identity, manifest, relocation proof -------------------------------------
commit=$(git -C "$repo" rev-parse HEAD)
tool_version=$("$python" -c "import re; print(re.search(r'TOOL_VERSION = \"(.+)\"', open('$stage/tool/reconstruct.py').read()).group(1))")
build_id="reconstruction-$tool_version-g${commit:0:12}-linux-x64"
printf '%s\n' "$build_id" > "$stage/BUILD-ID"
"$python" - "$stage" "$build_id" "$commit" <<'PYEOF'
import hashlib, json, sys
from pathlib import Path
stage, build_id, commit = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
def sha(p):
    h = hashlib.sha256()
    h.update(Path(p).read_bytes())
    return h.hexdigest()
files = {}
for rel in ["bin/linux-reconstruct", "bin/colmap", "tool/reconstruct.py",
            "openmvs/InterfaceCOLMAP", "openmvs/DensifyPointCloud", "openmvs/ReconstructMesh",
            "python/bin/python3", "licenses/openmvs-v2.4.0-corresponding-source.tar.gz"]:
    p = stage / rel
    if p.exists(): files[rel] = sha(p)
manifest = {
  "version": 1, "buildId": build_id, "commit": commit,
  "target": "Ubuntu 26.04 LTS x86_64 (glibc baseline of that archive); host provides glibc/ld-linux only",
  "artifacts": {
    "python": {"url": "https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.12.16+20261026-x86_64-unknown-linux-gnu-install_only.tar.gz", "sha256": "6a79e922e50006b601f29e688407659da1c2b86ebcd4e9c7254cf234be8b89de"},
    "openmvsBinaries": {"url": "https://github.com/cdcseacave/openMVS/releases/download/v2.4.0/OpenMVS_Ubuntu_x64.zip", "sha256": "7104ae1ddd6ca38fbca9e0e4a70b20af59e21e0b497eb7181c864fbf38ca8d00"},
    "openmvsSource": {"url": "https://github.com/cdcseacave/openMVS/archive/refs/tags/v2.4.0.tar.gz", "sha256": "1668a991fa1fdd3540ee47fdba282a7579ed876af713e8fa907625be1cf8dfc8"},
    "usdCoreWheel": {"file": "usd_core-26.8-cp312-none-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl", "sha256": "204fb1ef1fc977b827c491f4e9fa39b57518504ed0cacfe12e026e95123cacf1"},
    "pillowWheel": {"file": "pillow-13.0.0-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl", "sha256": "42d63be3af4f9b951b199b0a9d23365d37ab14687e6d77b74940432c8515c4ca"},
  },
  "files": files,
}
(stage / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
PYEOF
# Relocated proof: minimal environment, no developer PATH.
env -i HOME="$work" "$stage/bin/linux-reconstruct" check --mode samples > "$work/check.json"
"$python" -c "import json; d=json.load(open('$work/check.json')); assert d['ok'], d; print('payload check ok:', d.get('versions'))"
cp "$work/check.json" "$stage/licenses/build-check.json"

chmod -R go-w "$stage"
rmdir "$out" 2>/dev/null || true
mv "$stage" "$out"
echo "Prepared $build_id in $out ($(du -sh "$out" | cut -f1))"
