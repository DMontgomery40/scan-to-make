# SPDX-License-Identifier: MIT
"""Read repaired-scan measurements produced by tools/scan-repair or tools/scan-correct."""
import json
import math
from pathlib import Path

MAX_BYTES = 4*1024*1024


def _triple(value, label):
    if (not isinstance(value,list) or len(value) != 3 or
            not all(not isinstance(v,bool) and isinstance(v,(int,float)) and math.isfinite(v) and v > 0 for v in value)):
        raise ValueError(f'{label} must be three positive finite millimetre values')
    return [round(float(v),3) for v in value]


def _optional_number(value, label):
    if value is None:
        return None
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or value < 0:
        raise ValueError(f'{label} must be a nonnegative finite number or null')
    return round(float(value),3)


def summarize(stats, source):
    """Reduce a scan-repair `stats` block to the measurements the planner shows the model."""
    if not isinstance(stats,dict):
        raise ValueError('scan measurements must be an object')
    summary = {'source':source,'units':'mm'}
    if 'boxExtentsMm' in stats:
        box = _triple(stats['boxExtentsMm'],'boxExtentsMm')
        if box != sorted(box,reverse=True):
            raise ValueError('boxExtentsMm must be ordered long to short')
        summary['boxExtentsMm'] = box
    bbox = stats.get('bboxMm')
    if bbox is not None:
        if not isinstance(bbox,dict):
            raise ValueError('bboxMm must be an object')
        summary['bboxExtentsMm'] = _triple(bbox.get('extents'),'bboxMm.extents')
    if 'principalExtentsMm' in stats:
        summary['principalExtentsMm'] = _triple(stats['principalExtentsMm'],'principalExtentsMm')
    if 'boxExtentsMm' not in summary and 'bboxExtentsMm' not in summary:
        raise ValueError('scan measurements need boxExtentsMm or bboxMm.extents')
    summary['volumeMm3'] = _optional_number(stats.get('volumeMm3'),'volumeMm3')
    summary['surfaceAreaMm2'] = _optional_number(stats.get('surfaceAreaMm2'),'surfaceAreaMm2')
    watertight = stats.get('watertight')
    if watertight is not None and not isinstance(watertight,bool):
        raise ValueError('watertight must be a boolean')
    summary['watertight'] = watertight
    return summary


def load(path):
    """Accept a scan-correct report, a scan-repair report, or `repair.py measure` output."""
    path = Path(path)
    if path.stat().st_size > MAX_BYTES:
        raise ValueError('scan measurement file too large')
    data = json.loads(path.read_text())
    if not isinstance(data,dict):
        raise ValueError('scan measurement file must contain a JSON object')
    if 'final' in data:
        if data.get('status') != 'complete':
            raise ValueError('scan-correct report is not complete')
        return summarize(data['final'],'scan-correct report (final)')
    if 'after' in data:
        if data.get('outputUnits','mm') != 'mm':
            raise ValueError('scan-repair report must use mm output units')
        return summarize(data['after'],'scan-repair report (after)')
    if 'boxExtentsMm' in data or 'bboxMm' in data:
        return summarize(data,'scan-repair measure')
    raise ValueError('unrecognised scan measurement file')
