"""Bambu Studio project 3MF writer: objects made of parts, each part printed with one filament slot.

The layout follows what Bambu Studio itself saves (3MF core + production extension):
3D/3dmodel.model holds one component object per printable object, the meshes live in
3D/Objects/object_N.model, and Metadata/model_settings.config assigns each part its
filament slot. Optional per-layer events (tool changes or pauses) go in
Metadata/custom_gcode_per_layer.xml. No machine, process or filament settings are
written: the user's printer MCP supplies its own when it slices the project.
"""
from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass, field
from typing import Iterable, Sequence
from xml.sax.saxutils import quoteattr

import numpy as np

# Bambu Studio's CustomGCode::Type values.
COLOR_CHANGE, PAUSE_PRINT, TOOL_CHANGE = 0, 1, 2


@dataclass
class Part:
    name: str
    vertices: np.ndarray  # (n, 3) float, millimetres, object-local
    triangles: np.ndarray  # (m, 3) int
    extruder: int = 1  # one-based filament slot


@dataclass
class Object:
    name: str
    parts: list[Part]
    position: tuple[float, float] = (128.0, 128.0)  # plate XY for the object's local origin


@dataclass
class LayerEvent:
    top_z: float
    type: int
    extruder: int = 1
    colour: str = ''
    gcode: str = ''


@dataclass
class Project:
    objects: list[Object]
    events: list[LayerEvent] = field(default_factory=list)
    title: str = ''
    description: str = ''
    designer: str = 'Counterpart'


def _mesh_xml(object_id: int, part: Part) -> str:
    v = np.asarray(part.vertices, dtype=np.float64)
    t = np.asarray(part.triangles, dtype=np.int64)
    if v.ndim != 2 or v.shape[1] != 3 or t.ndim != 2 or t.shape[1] != 3 or len(t) == 0:
        raise ValueError(f'part {part.name!r} has no usable mesh')
    out = io.StringIO()
    out.write(f'  <object id="{object_id}" type="model">\n   <mesh>\n    <vertices>\n')
    for x, y, z in v:
        out.write(f'     <vertex x="{x:.6f}" y="{y:.6f}" z="{z:.6f}"/>\n')
    out.write('    </vertices>\n    <triangles>\n')
    for a, b, c in t:
        out.write(f'     <triangle v1="{a}" v2="{b}" v3="{c}"/>\n')
    out.write('    </triangles>\n   </mesh>\n  </object>\n')
    return out.getvalue()


_NS = ('xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" '
       'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" '
       'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"')


def project_bytes(project: Project, thumbnail: bytes | None = None) -> bytes:
    """The complete .3mf archive for `project`."""
    if not project.objects:
        raise ValueError('a project needs at least one object')
    files: dict[str, str] = {}
    resources, items, rels, settings, instances = [], [], [], [], []
    next_id = 1
    for index, obj in enumerate(project.objects):
        part_ids = []
        meshes = []
        for part in obj.parts:
            part_ids.append(next_id)
            meshes.append(_mesh_xml(next_id, part))
            next_id += 1
        object_id = next_id
        next_id += 1
        path = f'3D/Objects/object_{object_id}.model'
        files[path] = (f'<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" {_NS}>\n'
                       f' <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n{"".join(meshes)} </resources>\n <build/>\n</model>\n')
        rels.append(f' <Relationship Target="/{path}" Id="rel-{index + 1}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n')
        components = ''.join(f'    <component p:path="/{path}" objectid="{pid}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n' for pid in part_ids)
        resources.append(f'  <object id="{object_id}" type="model">\n   <components>\n{components}   </components>\n  </object>\n')
        x, y = obj.position
        items.append(f'  <item objectid="{object_id}" transform="1 0 0 0 1 0 0 0 1 {x:.4f} {y:.4f} 0" printable="1"/>\n')
        parts_xml = ''.join(
            f'    <part id="{pid}" subtype="normal_part">\n'
            f'      <metadata key="name" value={quoteattr(part.name)}/>\n'
            f'      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n'
            f'      <metadata key="extruder" value="{part.extruder}"/>\n'
            f'      <mesh_stat face_count="{len(part.triangles)}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n'
            f'    </part>\n' for pid, part in zip(part_ids, obj.parts))
        settings.append(f'  <object id="{object_id}">\n    <metadata key="name" value={quoteattr(obj.name)}/>\n'
                        f'    <metadata key="extruder" value="{min(part.extruder for part in obj.parts)}"/>\n{parts_xml}  </object>\n')
        instances.append(f'    <model_instance>\n      <metadata key="object_id" value="{object_id}"/>\n'
                         f'      <metadata key="instance_id" value="0"/>\n      <metadata key="identify_id" value="{1000 + index}"/>\n    </model_instance>\n')
    meta = ''.join(f' <metadata name="{k}">{v}</metadata>\n' for k, v in (
        ('Application', 'Counterpart caliper'), ('BambuStudio:3mfVersion', '1'),
        ('License', 'GPL-3.0-only'), ('Title', _text(project.title)), ('Designer', _text(project.designer)), ('Description', _text(project.description))))
    files['3D/3dmodel.model'] = (f'<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" {_NS}>\n{meta}'
                                 f' <resources>\n{"".join(resources)} </resources>\n <build>\n{"".join(items)} </build>\n</model>\n')
    files['3D/_rels/3dmodel.model.rels'] = ('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
                                           f'{"".join(rels)}</Relationships>\n')
    files['_rels/.rels'] = ('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
                            ' <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n')
    files['[Content_Types].xml'] = ('<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
                                    ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
                                    ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n'
                                    ' <Default Extension="png" ContentType="image/png"/>\n</Types>\n')
    if thumbnail is not None:
        files['Metadata/plate_1.png'] = thumbnail
    files['Metadata/model_settings.config'] = ('<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' + ''.join(settings) +
                                              '  <plate>\n    <metadata key="plater_id" value="1"/>\n    <metadata key="plater_name" value=""/>\n'
                                              '    <metadata key="locked" value="false"/>\n' + ''.join(instances) + '  </plate>\n</config>\n')
    if project.events:
        layers = ''.join(f'<layer top_z="{e.top_z:.4f}" type="{e.type}" extruder="{e.extruder}" color={quoteattr(e.colour)} extra="" gcode={quoteattr(e.gcode)}/>\n'
                         for e in sorted(project.events, key=lambda e: e.top_z))
        mode = 'MultiAsSingle' if any(e.type == TOOL_CHANGE for e in project.events) else 'SingleExtruder'
        files['Metadata/custom_gcode_per_layer.xml'] = ('<?xml version="1.0" encoding="utf-8"?>\n<custom_gcodes_per_layer>\n<plate>\n<plate_info id="1"/>\n'
                                                        f'{layers}<mode value="{mode}"/>\n</plate>\n</custom_gcodes_per_layer>\n')
    buffer = io.BytesIO()
    # Fixed timestamps keep regenerated files byte-identical.
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, files[name])
    return buffer.getvalue()


def _text(value: str) -> str:
    return value.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def stl_bytes(parts: Iterable[Part], offset: Sequence[float] = (0.0, 0.0, 0.0)) -> bytes:
    """One binary STL holding every given part (for printers without multi-material)."""
    tris = []
    for part in parts:
        v = np.asarray(part.vertices, dtype=np.float64) + np.asarray(offset, dtype=np.float64)
        tris.append(v[np.asarray(part.triangles, dtype=np.int64)])
    tri = np.concatenate(tris).astype(np.float32)
    normals = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    normals = np.divide(normals, lengths, out=np.zeros_like(normals), where=lengths > 0)
    record = np.zeros(len(tri), dtype=[('n', '<f4', 3), ('v', '<f4', (3, 3)), ('a', '<u2')])
    record['n'], record['v'] = normals, tri
    header = b'Counterpart caliper'.ljust(80, b' ')
    return header + np.uint32(len(tri)).tobytes() + record.tobytes()
