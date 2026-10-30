#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Generate preview-only, mm wall-mount holders through an isolated Blender process."""
import argparse
import importlib.util
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('fitted_cli',Path(__file__).resolve().parents[1]/'_fitted-core'/'cli_core.py')
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)
find_blender = cli.find_blender

LIMITS = {'clearance_mm':(0.05,5.0),'wall_mm':(0.8,10.0),'floor_mm':(0.8,10.0),
          'hold_depth':(0.1,1.0),'plate_mm':(2.0,10.0),'plate_extension_mm':(8.0,80.0),
          'screw_hole_mm':(2.0,8.0),'screw_spacing_mm':(4.0,200.0),'grid_mm':(0.1,2.0)}


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('input', type=Path, help='repaired OBJ or STL, millimetres')
    p.add_argument('--out', required=True, type=Path)
    p.add_argument('--clearance-mm', type=float, default=.5)
    p.add_argument('--wall-mm', type=float, default=2.)
    p.add_argument('--floor-mm', type=float, default=2.)
    p.add_argument('--hold-depth', type=float, default=.6)
    p.add_argument('--plate-mm', type=float, default=3.)
    p.add_argument('--plate-extension-mm', type=float, default=16.)
    p.add_argument('--screw-hole-mm', type=float, default=4.5)
    p.add_argument('--screw-spacing-mm', type=float, default=30.)
    p.add_argument('--up', choices=['X','Y','Z','-X','-Y','-Z'], default='Z')
    p.add_argument('--grid-mm', type=float, default=.4)
    return p


def relations(a):
    if a.plate_extension_mm < a.screw_hole_mm+2*a.wall_mm:
        raise ValueError('plate_extension_mm must be at least screw_hole_mm + 2 * wall_mm')
    if a.screw_spacing_mm < a.screw_hole_mm+2*a.wall_mm:
        raise ValueError('screw_spacing_mm must be at least screw_hole_mm + 2 * wall_mm')


if __name__ == '__main__':
    sys.exit(cli.main(parser(),LIMITS,Path(__file__).with_name('blender_tool.py'),'wall-mount-',relations))
