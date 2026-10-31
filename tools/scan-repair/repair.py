#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Stdlib-only entry point; Blender diagnostics go to stderr, JSON to stdout."""
import argparse
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


def find_blender():
    configured = os.environ.get("BLENDER")
    if configured:
        found = shutil.which(configured)
        if not found:
            raise ValueError("BLENDER does not name an executable")
        return found
    found = shutil.which("blender")
    if found:
        return found
    mac = "/Applications/Blender.app/Contents/MacOS/Blender"
    if os.access(mac, os.X_OK):
        return mac
    raise ValueError("Blender absent; set BLENDER to Blender 5.0.1")


PLAIN_NAME = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._-]*")
TEXTURE_STATEMENTS = ("map_", "bump", "disp", "decal", "refl", "norm")
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def stage_obj(source, stage):
    """Snapshot an OBJ and its sibling MTL/PNG files; Blender reads only the snapshot.

    References that leave the input folder or pass through links reject. Other
    material problems drop the material and are reported, keeping the repair."""
    def reference(name):
        parts = re.split(r"[\\/]", name)
        if Path(name).is_absolute() or name.startswith(("/", "\\")) or ".." in parts:
            raise ValueError("material reference leaves the input folder: "+name)
        path = source.parent/name
        if any(p.is_symlink() for p in [path, *path.parents][:len(parts)]):
            raise ValueError("material reference is a link: "+name)
        if not PLAIN_NAME.fullmatch(name):
            return None, "only plain sibling material files are copied: "+name
        return path, None
    obj = source.read_bytes()
    files, names, notes = {}, [], []
    libraries = [name.decode("utf-8", "replace") for match in re.finditer(rb"(?m)^[ \t]*mtllib[ \t]+([^\r\n]*)", obj)
                 for name in match.group(1).split()]
    for library in libraries:
        path, note = reference(library)
        if path and not library.lower().endswith(".mtl"):
            raise ValueError("material library must be .mtl: "+library)
        if path and not path.is_file():
            note = "material library missing: "+library
        if note:
            notes.append(note)
            continue
        files[library] = path.read_bytes()
        for line in files[library].decode("utf-8", "replace").splitlines():
            words = line.split()
            if words[:1] == ["newmtl"] and len(words) == 2:
                names.append(words[1])
            elif len(words) > 1 and words[0].lower().startswith(TEXTURE_STATEMENTS):
                path, note = reference(words[-1])
                if path and not path.is_file():
                    note = "texture missing: "+words[-1]
                elif path:
                    data = path.read_bytes()
                    if words[-1].lower().endswith(".png") and data.startswith(PNG_SIGNATURE):
                        files[words[-1]] = data
                    else:
                        note = "only PNG textures are copied: "+words[-1]
                if note:
                    notes.append(note)
    stage.mkdir()
    (stage/"input.obj").write_bytes(obj)
    if notes:
        files = {}
    for name, data in files.items():
        (stage/name).write_bytes(data)
    return {"import_path": str(stage/"input.obj"),
            "material": {"stage": str(stage), "libraries": libraries if files else [], "files": list(files),
                         "names": names if files else [], "note": "; ".join(notes) or None}}


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    subs = p.add_subparsers(dest="command", required=True)
    for command in ("repair", "measure", "render"):
        s = subs.add_parser(command)
        s.add_argument("input", type=Path)
        units = s.add_mutually_exclusive_group(required=True)
        units.add_argument("--units", choices=("m","cm","mm"))
        units.add_argument("--units-sidecar", type=Path)
        if command != "measure":
            s.add_argument("--out", type=Path, required=True)
        if command == "render":
            s.add_argument("--resolution", type=int, default=512)
            frame = s.add_mutually_exclusive_group()
            frame.add_argument("--keep-orientation", dest="keep_orientation", action="store_true",
                               default=True, help="preserve input axes (default)")
            frame.add_argument("--pca-orientation", dest="keep_orientation", action="store_false",
                               help="reorient with PCA and ground Z=0")
        if command == "repair":
            s.add_argument("--weld-mm", type=float, default=.01)
            s.add_argument("--component-fraction", type=float, default=.01)
            s.add_argument("--component-metric", choices=("area","volume"), default="area")
            s.add_argument("--hole-max-edges", type=int, default=0)
            s.add_argument("--voxel-size-mm", type=float, default=.3)
            s.add_argument("--force-voxel", action="store_true")
            s.add_argument("--denoise-iterations", type=int, default=15, help="Taubin cycles")
            s.add_argument("--denoise-factor", type=float, default=.5, help="Taubin lambda")
            s.add_argument("--denoise-mu", type=float, default=-.53, help="Taubin mu; pass-band 1/lambda+1/mu in (0,.2]")
            s.add_argument("--denoise-max-mm", type=float, default=.35)
            s.add_argument("--sharp-angle-deg", type=float, default=30)
            s.add_argument("--target-faces", type=int)
            s.add_argument("--deviation-samples", type=int, default=10000)
            s.add_argument("--orient", choices=("box","pca","keep"), default="box",
                           help="output frame: minimum-volume box (default), vertex PCA, or input axes")
            s.add_argument("--coarse-fill", choices=("refill","keep"), default="refill",
                           help="re-fill faces over 10x the median area with faired, densified patches")
            s.add_argument("--fill-crease-deg", type=float, default=60,
                           help="coarse regions split, and biharmonic patches stop following curvature, at creases above this")
            s.add_argument("--fill-fairing", choices=("harmonic","biharmonic"), default="harmonic",
                           help="harmonic stays within the rim; biharmonic continues rim curvature and can overshoot")
    return p


def main():
    p = parser()
    a = p.parse_args()
    try:
        config = vars(a).copy()
        if not a.input.is_file():
            raise ValueError("input must be an existing mesh")
        if a.units_sidecar:
            sidecar = json.loads(a.units_sidecar.read_text())
            if sidecar.get("unitsAuthored") is not True:
                raise ValueError("sidecar requires unitsAuthored: true")
            scale = float(sidecar["metersPerUnit"])*1000
        else:
            scale = {"m":1000, "cm":10,"mm":1}[a.units]
        if not math.isfinite(scale) or scale <= 0:
            raise ValueError("units must have a positive finite scale")
        config["scale_mm"] = scale
        for key, value in config.items():
            if isinstance(value,float) and (not math.isfinite(value) or (value < 0 and key != "denoise_mu")):
                raise ValueError(key+" must be finite and nonnegative")
        if a.command == "repair":
            if not 0 <= a.component_fraction < 1 or not 0 < a.denoise_factor <= .5:
                raise ValueError("component fraction must be [0,1); denoise factor (0,.5]")
            # Taubin pass-band 1/lambda+1/mu: at or below 0 cycles shrink; above .2 they amplify noise.
            if not -1 <= a.denoise_mu < 0 or not 0 < 1/a.denoise_factor+1/a.denoise_mu <= .2:
                raise ValueError("denoise mu must be [-1,0) with pass-band 1/factor+1/mu in (0,.2]; "
                                 "factor .5 with mu -.53 gives .113")
            if not 0 <= a.denoise_iterations <= 50 or not 0 <= a.sharp_angle_deg <= 90:
                raise ValueError("denoise iterations must be [0,50]; sharp angle [0,90]")
            if a.voxel_size_mm <= 0 or a.deviation_samples < 1 or a.hole_max_edges < 0:
                raise ValueError("invalid voxel size, sample count or hole limit")
            if not 0 <= a.fill_crease_deg <= 180:
                raise ValueError("fill crease angle must be [0,180]")
            if a.target_faces is not None and a.target_faces < 4:
                raise ValueError("target faces must be at least 4")
        if a.command == "render" and not 16 <= a.resolution <= 4096:
            raise ValueError("resolution must be [16,4096]")
        config = {k:str(v.resolve()) if isinstance(v,Path) else v for k,v in config.items()}
        if config.get("out") and Path(config["out"]).resolve() in a.input.resolve().parents:
            raise ValueError("output must not contain the input")
        with tempfile.TemporaryDirectory(prefix="scan-repair-") as tmp:
            request, result = Path(tmp)/"request.json", Path(tmp)/"result.json"
            if a.input.suffix.lower() == ".obj":
                config.update(stage_obj(a.input, Path(tmp)/"stage"))
            config["result"] = str(result)
            request.write_text(json.dumps(config))
            run = subprocess.run([find_blender(),"--background","--factory-startup","--python-exit-code","1",
                                  "--python",str(Path(__file__).with_name("blender_tool.py")),
                                  "--",str(request)],capture_output=True,text=True)
            if run.returncode:
                raise ValueError("Blender failed:\n"+run.stdout+run.stderr)
            print(result.read_text(), end="")
        return 0
    except (ValueError,OSError,KeyError,TypeError,json.JSONDecodeError) as exc:
        print(str(exc),file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
