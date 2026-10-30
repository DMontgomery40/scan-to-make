#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Generate preview-only, mm scan cradles through an isolated Blender process."""
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile

REPAIR = Path(__file__).resolve().parents[2] / 'scan-repair' / 'repair.py'
spec = importlib.util.spec_from_file_location('scan_repair_cli', REPAIR)
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)
find_blender = repair.find_blender


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('input', type=Path, help='repaired OBJ or STL, millimetres')
    p.add_argument('--out', required=True, type=Path)
    p.add_argument('--clearance-mm', type=float, default=.3)
    p.add_argument('--wall-mm', type=float, default=2.)
    p.add_argument('--seat-depth', type=float, default=.4)
    p.add_argument('--margin-mm', type=float, default=3.)
    p.add_argument('--up', choices=['X','Y','Z','-X','-Y','-Z'], default='Z')
    p.add_argument('--grid-mm', type=float, default=.4)
    p.add_argument('--notch-side', choices=['+X','-X','+Y','-Y'])
    p.add_argument('--notch-position-mm', type=float, default=0.)
    p.add_argument('--notch-width-mm', type=float, default=4.)
    p.add_argument('--render', action='store_true', help='reuse scan-repair render (PCA views)')
    a = p.parse_args()
    try:
        for k,v in vars(a).items():
            if isinstance(v,float) and not math.isfinite(v):
                raise ValueError(k+' must be finite')
        if min(a.clearance_mm,a.wall_mm,a.grid_mm,a.notch_width_mm) <= 0:
            raise ValueError('clearance, wall, grid and notch width must be positive')
        if not 0 < a.seat_depth < 1 or a.margin_mm < a.wall_mm+2*a.grid_mm:
            raise ValueError('seat depth must be (0,1); margin must be >= wall + 2*grid')
        if not a.input.is_file() or a.input.suffix.lower() not in ('.obj','.stl'):
            raise ValueError('input must be an existing mm OBJ or STL')
        if a.out.resolve() == a.input.resolve() or a.out.resolve() in a.input.resolve().parents:
            raise ValueError('output must not contain input')
        a.out.mkdir(parents=True,exist_ok=True)
        if any(a.out.iterdir()):
            raise ValueError('output directory must be empty (avoid stale evidence)')
        config = {k:str(v.resolve()) if isinstance(v,Path) else v for k,v in vars(a).items()}
        with tempfile.TemporaryDirectory(prefix='scan-cradle-') as tmp:
            request = Path(tmp)/'request.json'
            request.write_text(json.dumps(config))
            run = subprocess.run([find_blender(),'--background','--factory-startup','--python-exit-code','1',
                                  '--python',str(Path(__file__).with_name('blender_tool.py')),
                                  '--',str(request)],capture_output=True,text=True)
            if run.returncode:
                raise ValueError('Blender failed:\n'+run.stdout+run.stderr)
        if a.render:
            subprocess.run([sys.executable,str(REPAIR),'render',str(a.out/'cradle.stl'),
                            '--units','mm','--out',str(a.out/'renders')],check=True,stdout=sys.stderr)
        manifest_path = a.out/'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        if a.render:
            manifest['outputSha256'].update({str(f.relative_to(a.out)): hashlib.sha256(f.read_bytes()).hexdigest()
                                             for f in sorted((a.out/'renders').glob('*.png'))})
        manifest_path.write_text(json.dumps(manifest,sort_keys=True,indent=2,allow_nan=False)+'\n')
        print(manifest_path.read_text(),end='')
        return 0
    except (ValueError,OSError,subprocess.CalledProcessError) as exc:
        print(str(exc),file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
