"""Reads a sliced Bambu plate: which filament each layer uses, how many filament changes and pauses there are.

Counts only what happens after the machine start G-code, whose own initial load
(`M620 S<n>A … T<n>`) is not a change. Prime-tower moves are reported separately,
because the tower is printed with whichever filament is loaded.
"""
from __future__ import annotations

import re
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

_TOOL = re.compile(r'^\s*T(\d+)\s*(?:;.*)?$')
_EXTRUDE = re.compile(r'^G[123]\b[^;]*\bE(-?[0-9.]+)')


@dataclass
class PlateReport:
    initial_filament: int | None
    changes: list[tuple[float | None, int, int]] = field(default_factory=list)  # (z, from, to)
    pauses: list[float | None] = field(default_factory=list)
    layers: dict[float, set[int]] = field(default_factory=dict)  # z -> filaments that print the part (no tower)
    tower_layers: int = 0

    @property
    def mixed_layers(self) -> list[float]:
        return [z for z, used in self.layers.items() if len(used) > 1]


def read_plate_gcode(path: str | Path, plate: int = 1) -> str:
    path = Path(path)
    if path.suffix.lower() == '.gcode':
        return path.read_text()
    with zipfile.ZipFile(path) as archive:
        return archive.read(f'Metadata/plate_{plate}.gcode').decode()


def analyse(gcode: str, pause_command: str = 'M400 U1') -> PlateReport:
    lines = gcode.splitlines()
    try:
        start_end = next(i for i, line in enumerate(lines) if 'MACHINE_START_GCODE_END' in line)
    except StopIteration:
        raise ValueError('no MACHINE_START_GCODE_END marker: not a Bambu-sliced plate') from None
    current: int | None = None
    for line in lines[:start_end]:
        match = _TOOL.match(line)
        if match and int(match.group(1)) < 200:
            current = int(match.group(1))
    report = PlateReport(initial_filament=current)
    z: float | None = None
    feature = ''
    in_tower = False
    tower_zs: set[float] = set()
    for line in lines[start_end + 1:]:
        if line.startswith('; WIPE_TOWER_START'):
            in_tower = True
        elif line.startswith('; WIPE_TOWER_END'):
            in_tower = False
        if line.startswith('; Z_HEIGHT:'):
            z = round(float(line.split(':', 1)[1]), 3)
            continue
        if line.startswith('; FEATURE:'):
            feature = line[10:].strip()
            continue
        if line.startswith('; CHANGE_LAYER'):
            feature = ''
        match = _TOOL.match(line)
        if match:
            tool = int(match.group(1))
            if tool < 200:  # T255 unloads at the end, T1000 is the nozzle load line
                if current is not None and tool != current:
                    report.changes.append((z, current, tool))
                current = tool
            continue
        if line.strip().startswith(pause_command):
            report.pauses.append(z)
            continue
        extrude = _EXTRUDE.match(line)
        if extrude and float(extrude.group(1)) > 0 and z is not None and current is not None:
            if in_tower or feature == 'Prime tower':
                tower_zs.add(z)
            elif feature:
                report.layers.setdefault(z, set()).add(current)
    report.tower_layers = len(tower_zs)
    return report
