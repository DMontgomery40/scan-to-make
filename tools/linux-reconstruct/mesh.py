"""Minimal PLY triangle-mesh handling plus COLMAP model parsing.

Only what the pipeline needs: read OpenMVS PLY output (ascii or binary
little-endian, vertex xyz + optional colours, triangle faces), find
connected components, measure extents, check winding via signed volume,
and write a PLY back for cached reuse.
"""
import math
import struct
from pathlib import Path

_PLY_TYPES = {
    "char": ("b", 1), "int8": ("b", 1), "uchar": ("B", 1), "uint8": ("B", 1),
    "short": ("h", 2), "int16": ("h", 2), "ushort": ("H", 2), "uint16": ("H", 2),
    "int": ("i", 4), "int32": ("i", 4), "uint": ("I", 4), "uint32": ("I", 4),
    "float": ("f", 4), "float32": ("f", 4), "double": ("d", 8), "float64": ("d", 8),
}
MAX_VERTICES = 20_000_000
MAX_FACES = 40_000_000


class MeshError(ValueError):
    pass


class Mesh:
    def __init__(self, vertices, faces):
        self.vertices = vertices    # list[(x,y,z)] floats
        self.faces = faces          # list[(a,b,c)] ints

    def extents(self):
        lo = [min(v[i] for v in self.vertices) for i in range(3)]
        hi = [max(v[i] for v in self.vertices) for i in range(3)]
        return lo, hi, {"x": hi[0] - lo[0], "y": hi[1] - lo[1], "z": hi[2] - lo[2]}

    def signed_volume(self):
        total = 0.0
        vs = self.vertices
        for a, b, c in self.faces:
            ax, ay, az = vs[a]
            bx, by, bz = vs[b]
            cx, cy, cz = vs[c]
            total += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx)
                      + az * (bx * cy - by * cx)) / 6.0
        return total

    def validate(self):
        n = len(self.vertices)
        if n < 4 or not self.faces:
            raise MeshError("mesh is empty or degenerate")
        for v in self.vertices:
            if not all(math.isfinite(c) for c in v):
                raise MeshError("mesh contains non-finite vertices")
        area2 = 0.0
        vs = self.vertices
        for a, b, c in self.faces:
            if not (0 <= a < n and 0 <= b < n and 0 <= c < n) or len({a, b, c}) != 3:
                raise MeshError("mesh contains an invalid face index")
            ux, uy, uz = (vs[b][i] - vs[a][i] for i in range(3))
            vx, vy, vz = (vs[c][i] - vs[a][i] for i in range(3))
            area2 += math.sqrt((uy * vz - uz * vy) ** 2 + (uz * vx - ux * vz) ** 2
                               + (ux * vy - uy * vx) ** 2)
        if area2 <= 0:
            raise MeshError("mesh has zero total area")


def read_ply(path):
    raw = Path(path).read_bytes()
    header_end = raw.find(b"end_header")
    if header_end < 0:
        raise MeshError(f"{Path(path).name} is not a PLY file")
    header = raw[:header_end].decode("ascii", "strict")
    body_start = header_end + len(b"end_header")
    while body_start < len(raw) and raw[body_start:body_start + 1] in (b"\r", b"\n"):
        body_start += 1
    fmt = None
    elements = []   # (name, count, [(prop, type, is_list, count_type, item_type)])
    current = None
    for line in header.splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "format":
            fmt = parts[1]
        elif parts[0] == "element":
            current = (parts[1], int(parts[2]), [])
            elements.append(current)
        elif parts[0] == "property" and current is not None:
            if parts[1] == "list":
                current[2].append((parts[4], None, True, parts[2], parts[3]))
            else:
                current[2].append((parts[2], parts[1], False, None, None))
    if fmt not in ("ascii", "binary_little_endian"):
        raise MeshError(f"unsupported PLY format: {fmt}")
    by_name = {e[0]: e for e in elements}
    if "vertex" not in by_name or "face" not in by_name:
        raise MeshError("PLY has no vertex/face elements")
    if by_name["vertex"][1] > MAX_VERTICES or by_name["face"][1] > MAX_FACES:
        raise MeshError("PLY is implausibly large")

    def records_ascii(elem, lines, offset):
        out = []
        for i in range(elem[1]):
            vals = lines[offset + i].split()
            out.append(vals)
        return out, offset + elem[1]

    vertices, faces = [], []
    if fmt == "ascii":
        lines = raw[body_start:].decode("ascii", "strict").splitlines()
        offset = 0
        for elem in elements:
            recs, offset = records_ascii(elem, lines, offset)
            names = [p[0] for p in elem[2]]
            if elem[0] == "vertex":
                xi, yi, zi = names.index("x"), names.index("y"), names.index("z")
                vertices = [(float(r[xi]), float(r[yi]), float(r[zi])) for r in recs]
            elif elem[0] == "face":
                for r in recs:
                    count = int(r[0])
                    idx = [int(v) for v in r[1:1 + count]]
                    for k in range(1, count - 1):
                        faces.append((idx[0], idx[k], idx[k + 1]))
    else:
        pos = body_start
        for elem in elements:
            names = [p[0] for p in elem[2]]
            if elem[0] == "vertex":
                pattern = "<" + "".join(_PLY_TYPES[p[1]][0] for p in elem[2] if not p[2])
                size = struct.calcsize(pattern)
                xi, yi, zi = names.index("x"), names.index("y"), names.index("z")
                for i in range(elem[1]):
                    vals = struct.unpack_from(pattern, raw, pos + i * size)
                    vertices.append((float(vals[xi]), float(vals[yi]), float(vals[zi])))
                pos += size * elem[1]
            elif elem[0] == "face":
                list_prop = next(p for p in elem[2] if p[2])
                cf, _ = _PLY_TYPES[list_prop[3]]
                itf, _ = _PLY_TYPES[list_prop[4]]
                for _ in range(elem[1]):
                    (count,) = struct.unpack_from("<" + cf, raw, pos)
                    pos += struct.calcsize("<" + cf)
                    idx = struct.unpack_from("<" + itf * count, raw, pos)
                    pos += struct.calcsize("<" + itf * count)
                    for k in range(1, count - 1):
                        faces.append((idx[0], idx[k], idx[k + 1]))
            else:
                raise MeshError(f"unsupported PLY element before face data: {elem[0]}")
    mesh = Mesh(vertices, faces)
    mesh.validate()
    return mesh


def write_ply(path, mesh):
    lines = ["ply", "format binary_little_endian 1.0",
             f"element vertex {len(mesh.vertices)}",
             "property float x", "property float y", "property float z",
             f"element face {len(mesh.faces)}",
             "property list uchar int vertex_indices", "end_header"]
    with open(path, "wb") as f:
        f.write(("\n".join(lines) + "\n").encode("ascii"))
        for v in mesh.vertices:
            f.write(struct.pack("<fff", *v))
        for a, b, c in mesh.faces:
            f.write(struct.pack("<Biii", 3, a, b, c))


def connected_components(mesh):
    """Vertex-sharing components. Returns list of (vertex_set, face_indices)
    sorted by vertex count descending."""
    parent = list(range(len(mesh.vertices)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b, c in mesh.faces:
        ra, rb, rc = find(a), find(b), find(c)
        if ra != rb:
            parent[rb] = ra
        if ra != rc:
            parent[find(c)] = ra
    groups = {}
    for fi, (a, _, _) in enumerate(mesh.faces):
        groups.setdefault(find(a), []).append(fi)
    out = []
    for root, face_ids in groups.items():
        verts = set()
        for fi in face_ids:
            verts.update(mesh.faces[fi])
        out.append((verts, face_ids))
    out.sort(key=lambda g: -len(g[0]))
    return out


def submesh(mesh, face_ids):
    used = sorted({v for fi in face_ids for v in mesh.faces[fi]})
    remap = {old: new for new, old in enumerate(used)}
    vertices = [mesh.vertices[i] for i in used]
    faces = [tuple(remap[v] for v in mesh.faces[fi]) for fi in face_ids]
    return Mesh(vertices, faces)


def read_colmap_cameras(images_txt):
    """{image basename: camera centre (x,y,z) in COLMAP units} from images.txt.

    COLMAP stores world-to-camera [R|t] as quaternion (qw,qx,qy,qz) + t;
    the centre is C = -R^T t.
    """
    centres = {}
    # Pose lines are IMAGE_ID QW..QZ TX..TZ CAMERA_ID NAME; the following
    # POINTS2D line is all-numeric (and may be empty), so detect pose lines
    # by a non-numeric 10th token rather than by line pairing.
    for line in Path(images_txt).read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 10:
            continue
        try:
            float(parts[9])
            continue    # a POINTS2D line
        except ValueError:
            pass
        qw, qx, qy, qz = (float(parts[k]) for k in range(1, 5))
        tx, ty, tz = (float(parts[k]) for k in range(5, 8))
        name = Path(parts[9]).name
        # R^T t with R from the (w,x,y,z) quaternion.
        r = [
            [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
            [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
            [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
        ]
        centre = tuple(-(r[0][k] * tx + r[1][k] * ty + r[2][k] * tz) for k in range(3))
        if all(math.isfinite(c) for c in centre):
            centres[name] = centre
    return centres
