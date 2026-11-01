#!/bin/bash
# The handheld-scan gate: a synthetic "hold it up and turn it" capture of a known model, rebuilt three ways.
# Usage: scripts/handheld-gate.sh <reference.usdz> <background-photo> <photo-of-a-hand-holding-something> <work-dir>
# Passes when the rebuild from Mac-side Vision masks matches the reference within ±2 mm on every axis
# (after rigid alignment), its mean surface distance is under 1 mm, no photo is skipped, and the masks cover
# the object (mean IoU ≥ 0.9) while leaving out the hand (≤ 5% of hand pixels kept).
set -euo pipefail
[ $# -eq 4 ] || { echo "usage: $0 <reference.usdz> <background-photo> <hand-photo> <work-dir>" >&2; exit 2; }
here="$(cd "$(dirname "$0")/.." && pwd)"
reference="$1"; background="$2"; hand="$3"; work="$4"
swift build -c release --package-path "$here" >/dev/null
bin="$here/.build/release"
mkdir -p "$work"
"$bin/turntable-synth" render "$reference" "$background" "$hand" "$work" > "$work/render.log"

run() { # name, extra args…
  local name="$1"; shift
  "$bin/mac-reconstruct" samples "$work/frames" "$work/recon-$name.usdz" full "$@" > "$work/recon-$name.log" 2>/dev/null || true
  "$bin/model-look" "$work/recon-$name.usdz" "$work/renders-$name" --clay --pca > "$work/look-$name.json" 2>/dev/null || echo '{}' > "$work/look-$name.json"
  "$bin/model-compare" "$reference" "$work/recon-$name.usdz" > "$work/compare-$name.json" 2>/dev/null || echo '{}' > "$work/compare-$name.json"
}
run truth --masks "$work/truth-object" --save-masks "$work/used-truth"
run vision --save-masks "$work/used-vision"
run nomask --no-masks
"$bin/turntable-synth" score "$work" "$work/used-vision" > "$work/score-vision.json"
"$bin/model-look" "$reference" "$work/renders-reference" --clay --pca > /dev/null

python3 - "$work" <<'PY'
import json, sys, os
work = sys.argv[1]
def load(name):
    try: return json.load(open(os.path.join(work, name)))
    except Exception: return {}
def skipped(name):
    try: return sum('"skipped"' in line for line in open(os.path.join(work, f"recon-{name}.log")))
    except Exception: return -1
score = load("score-vision.json")
ok = True
for name in ["truth", "vision", "nomask"]:
    c = load(f"compare-{name}.json")
    ref, got = c.get("referenceSizeMm"), c.get("candidateSizeMm")
    fits = bool(ref and got) and all(abs(a - b) <= 2 for a, b in zip(ref, got)) and c.get("meanMm", 99) < 1
    print(f"{name:7s} size {got} vs {ref}  mean {c.get('meanMm')} mm  p95 {c.get('p95Mm')} mm  skipped {skipped(name)}  {'fits' if fits else 'DOES NOT FIT'}")
    if name == "vision": ok = ok and fits and skipped(name) == 0
print(f"masks   mean IoU {score.get('meanIoU')}  min {score.get('minIoU')}  hand kept mean {score.get('meanHandIncluded')} max {score.get('maxHandIncluded')}")
ok = ok and score.get("meanIoU", 0) >= 0.9 and score.get("maxHandIncluded", 1) <= 0.05
print(f"renders {work}/renders-*-front.png (reference: renders-reference-*)")
print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
PY
