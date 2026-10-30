# SPDX-License-Identifier: GPL-3.0-or-later
"""Stdlib wrapper shared by fitted templates: argument checks and one isolated
Blender process per request. CLI stdout is the manifest JSON."""
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile

REPAIR = Path(__file__).resolve().parents[2]/'scan-repair'/'repair.py'
spec = importlib.util.spec_from_file_location('scan_repair_cli',REPAIR)
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)
find_blender = repair.find_blender


def check(a, limits):
    """Inclusive per-parameter bounds, then input/output safety (as scan-cradle)."""
    for name,(low,high) in limits.items():
        value = getattr(a,name)
        if not math.isfinite(value) or not low <= value <= high:
            raise ValueError(f'{name} must be finite and within [{low}, {high}]')
    if a.wall_mm < 2*a.grid_mm:
        raise ValueError('wall_mm must be at least 2 * grid_mm')
    if not a.input.is_file() or a.input.suffix.lower() not in ('.obj','.stl'):
        raise ValueError('input must be an existing mm OBJ or STL')
    if a.out.resolve() == a.input.resolve() or a.out.resolve() in a.input.resolve().parents:
        raise ValueError('output must not contain input')


def run(a, tool, prefix):
    a.out.mkdir(parents=True,exist_ok=True)
    if any(a.out.iterdir()):
        raise ValueError('output directory must be empty (avoid stale evidence)')
    config = {k:str(v.resolve()) if isinstance(v,Path) else v for k,v in vars(a).items()}
    with tempfile.TemporaryDirectory(prefix=prefix) as tmp:
        request = Path(tmp)/'request.json'
        request.write_text(json.dumps(config))
        result = subprocess.run([find_blender(),'--background','--factory-startup','--python-exit-code','1',
                                 '--python',str(tool),'--',str(request)],capture_output=True,text=True)
        if result.returncode:
            raise ValueError('Blender failed:\n'+result.stdout+result.stderr)
    manifest_path = a.out/'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    manifest_path.write_text(json.dumps(manifest,sort_keys=True,indent=2,allow_nan=False)+'\n')
    print(manifest_path.read_text(),end='')


def main(parser, limits, tool, prefix, extra_check=None):
    a = parser.parse_args()
    try:
        check(a,limits)
        if extra_check:
            extra_check(a)
        run(a,tool,prefix)
        return 0
    except (ValueError,OSError,subprocess.CalledProcessError) as exc:
        print(str(exc),file=sys.stderr)
        return 2
