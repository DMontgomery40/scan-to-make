#!/usr/bin/env python3
"""Read-only acceptance check for "Print a published model" (PRD §8.11).

Reads a project's files on the Mac; never calls the companion API, never contacts the printer.

  python3 -I tests/acceptance/published_check.py \
      --object <project id>            # default: the newest project whose kind is "published"
      --source ~/Downloads/A.3mf ...   # the designer's files the user downloaded
      [--expect-edit PART]             # a requested edit may change only a small region of this part (e.g. INNER)
      [--edit-box-mm 40]               # the largest allowed size of that region on each axis
      [--colours black,yellow]         # the AMS colours the request named, in filament order of preference

Exit 0 when every check passes, 1 otherwise. Prints one line per check and a JSON summary.
"""
import argparse, collections, glob, hashlib, json, os, re, sys, zipfile

ROOT = os.path.expanduser("~/Library/Application Support/Scan to Make")
OBJECTS = os.path.join(ROOT, "capture", "objects")
NAMED = {"black": (0, 0, 0), "yellow": (0xFE, 0xC6, 0x00), "white": (0xFF, 0xFF, 0xFF), "red": (0xD0, 0x20, 0x20),
         "blue": (0x20, 0x40, 0xD0), "green": (0x20, 0xA0, 0x40), "grey": (0x80, 0x80, 0x80), "gray": (0x80, 0x80, 0x80)}

results = []
def check(name, ok, detail=""):
    results.append({"check": name, "pass": bool(ok), "detail": detail})
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" · {detail}" if detail else ""))

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""): h.update(block)
    return h.hexdigest()

def parts(path):
    """Part name -> (sorted local vertex tuples, painted-triangle count) from a 3MF."""
    z = zipfile.ZipFile(path)
    settings = z.read("Metadata/model_settings.config").decode() if "Metadata/model_settings.config" in z.namelist() else ""
    names = {}  # object file -> part names, by order of components
    model = z.read("3D/3dmodel.model").decode()
    comps = re.findall(r'<component [^>]*p:path="([^"]+)"[^>]*objectid="(\d+)"', model)
    part_names = re.findall(r'<part id="(\d+)"[^>]*>\s*<metadata key="name" value="([^"]*)"', settings)
    by_id = dict(part_names)
    out = {}
    for file, oid in comps:
        t = z.read(file.lstrip("/")).decode()
        block = re.search(rf'<object id="{oid}"[^>]*>(.*?)</object>', t, re.S)
        body = block.group(1) if block else t
        verts = sorted((round(float(x), 2), round(float(y), 2), round(float(zz), 2))
                       for x, y, zz in re.findall(r'<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"', body))
        painted = len(re.findall(r'paint_color="', body))
        out[by_id.get(oid, f"{file}#{oid}")] = (verts, painted)
    plates = re.findall(r"<plate>(.*?)</plate>", settings, re.S)
    plate_objects = [re.findall(r'key="object_id" value="(\d+)"', p) for p in plates]
    return out, plate_objects

def short(name):
    for key in ("DEPTH GAUGE", "OUTER", "INNER"):
        if key in name.upper(): return key
    return name

def nearest(rgb):
    return min(NAMED, key=lambda n: sum((a - b) ** 2 for a, b in zip(NAMED[n], rgb)))

def hex_rgb(value):
    v = value.strip().lstrip("#")[:6]
    return tuple(int(v[i:i + 2], 16) for i in (0, 2, 4))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--object"); ap.add_argument("--source", nargs="+", required=True)
    ap.add_argument("--expect-edit"); ap.add_argument("--edit-box-mm", type=float, default=40)
    ap.add_argument("--colours", default="")
    a = ap.parse_args()

    if a.object: oid = a.object
    else:
        cands = []
        for f in glob.glob(os.path.join(OBJECTS, "*", "object.json")):
            try: d = json.load(open(f))
            except Exception: continue
            if d.get("kind") == "published": cands.append((os.path.getmtime(f), os.path.basename(os.path.dirname(f))))
        if not cands: check("a published project exists", False, "no object.json with kind=published"); return finish()
        oid = max(cands)[1]
    pdir = os.path.join(OBJECTS, oid)
    obj = json.load(open(os.path.join(pdir, "object.json")))
    print(f"project {oid} · state {obj.get('state')} · title {obj.get('title')!r}")

    # 1. Routing: published, and no design pass.
    check("routed as a published model", obj.get("kind") == "published", f"kind={obj.get('kind')}")
    passes = obj.get("passes") or []
    # A pass counts as a redraw unless it is the published job or a requested edit to the designer's file.
    design = [p for p in passes if p.get("kind") != "published" and p.get("trigger") not in ("changes", "edit")]
    check("no design pass redrew it", not design, f"{len(passes)} passes; design-like: {[p.get('kind') or p.get('engine') for p in design]}")

    # 2. The designer's own files are the inputs.
    srcs = [os.path.expanduser(s) for s in a.source]
    want = {sha256(s): os.path.basename(s) for s in srcs}
    have = {}
    for f in glob.glob(os.path.join(pdir, "original", "**", "*"), recursive=True):
        if os.path.isfile(f): have[sha256(f)] = os.path.relpath(f, pdir)
    missing = [n for h, n in want.items() if h not in have]
    check("designer's files kept byte-for-byte in original/", not missing, f"missing: {missing}" if missing else f"{len(want)} files matched")

    # 3. One plate, every requested part on it.
    model = (obj.get("current") or {}).get("model") or ""
    mpath = os.path.join(pdir, model) if model else ""
    check("current model is a 3MF", model.lower().endswith(".3mf") and os.path.isfile(mpath), model or "none")
    if not (model.lower().endswith(".3mf") and os.path.isfile(mpath)): return finish()
    cur, plates = parts(mpath)
    want_parts = set()
    orig = {}
    for s in srcs:
        p, _ = parts(s); orig.update(p); want_parts |= {short(n) for n in p}
    cur_short = {short(n): v for n, v in cur.items()}
    check("one plate holds every part", len(plates) == 1 and want_parts <= set(cur_short),
          f"plates={len(plates)} parts={sorted(cur_short)} want={sorted(want_parts)}")

    # 4. Geometry: unchanged except the requested edit region (object-local coordinates, so arranging doesn't count).
    for name, (verts, painted) in orig.items():
        key = short(name)
        if key not in cur_short: continue
        cverts, cpainted = cur_short[key]
        a_set, b_set = collections.Counter(verts), collections.Counter(cverts)
        changed = list(((a_set - b_set) + (b_set - a_set)).elements())
        if a.expect_edit and key == a.expect_edit.upper():
            if not changed:
                check(f"{key}: requested edit present", False, "no geometry changed")
            else:
                spans = [max(c[i] for c in changed) - min(c[i] for c in changed) for i in range(3)]
                check(f"{key}: edit confined to one small region", all(s <= a.edit_box_mm for s in spans),
                      f"{len(changed)} changed vertices, region {spans[0]:.1f}×{spans[1]:.1f}×{spans[2]:.1f} mm (limit {a.edit_box_mm})")
        else:
            check(f"{key}: geometry exactly as published", not changed and painted == cpainted,
                  f"{len(changed)} vertices differ, painted {painted}->{cpainted}")

    # 5. Colours: each file filament goes to a loaded AMS slot of the requested colour.
    printrec = obj.get("print") or {}
    blob = json.dumps(printrec)
    mapping = None
    for key in ("amsMapping", "ams_mapping"):
        m = re.search(rf'"{key}":\s*(\[[^\]]*\]|\{{[^}}]*\}})', blob)
        if m: mapping = json.loads(m.group(1)); break
    slots = {}
    for m in re.finditer(r'\{[^{}]*"slot":\s*(\d+)[^{}]*"colou?r":\s*"(#[0-9A-Fa-f]{6})"[^{}]*\}', blob):
        slots[int(m.group(1))] = m.group(2)
    want_cols = [c.strip().lower() for c in a.colours.split(",") if c.strip()]
    if want_cols:
        if mapping is None:
            check("AMS mapping recorded for the print", False, "no amsMapping in object.print")
        else:
            used = mapping if isinstance(mapping, list) else list(mapping.values())
            got = [nearest(hex_rgb(slots[s])) if s in slots else f"slot{s}" for s in used if isinstance(s, int) and s >= 0]
            check("AMS colours are the requested ones", sorted(set(got)) == sorted(set(want_cols)),
                  f"mapping={mapping} slots={slots} -> {got}, want {want_cols}")

    # 6. The print ran and was monitored to the end.
    mon = printrec.get("monitor") or {}
    check("print reached the printer and was monitored", bool(printrec.get("printId")) and mon.get("phase") in ("watching", "ended"),
          f"printId={printrec.get('printId')} phase={mon.get('phase')} end={mon.get('endState')} milestones={mon.get('milestonesSent')}")
    events = os.path.join(ROOT, "events.ndjson")
    if os.path.isfile(events) and printrec.get("printId"):
        types = [json.loads(l).get("type") for l in open(events) if printrec["printId"] in l]
        check("print events emitted", "print.started" in types, f"{collections.Counter(types)}")
    return finish()

def finish():
    ok = all(r["pass"] for r in results)
    print(json.dumps({"pass": ok, "checks": results}, indent=1))
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
