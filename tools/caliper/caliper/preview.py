"""Render the generated assembled geometry, without a slicer or a live camera."""
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from .design import build, BODY, Params


def render(path: Path, size=1200, params=Params()):
    design = build(params)
    triangles, colours = [], []
    for part in design.card + design.slider:
        mesh = part.solid.to_mesh()
        vertices = np.asarray(mesh.vert_properties)[:, :3].copy()
        if part in design.slider:
            vertices[:, 0] += 18
        faces = vertices[np.asarray(mesh.tri_verts)]
        triangles.extend(faces)
        colours.extend([((240, 191, 42) if part.role == BODY else (34, 38, 43))] * len(faces))
    faces = np.asarray(triangles)
    # An almost overhead view keeps the measurement marks legible.
    angle = np.radians(12)
    rotation = np.array([[1, 0, 0], [0, np.cos(angle), -np.sin(angle)], [0, np.sin(angle), np.cos(angle)]])
    faces = faces @ rotation.T
    xy = faces[:, :, :2]
    low, high = xy.min(axis=(0, 1)), xy.max(axis=(0, 1))
    scale = (size - 80) / max(high - low)
    width, height = np.ceil((high - low) * scale + 80).astype(int)
    pixels = (xy - low) * scale + 40
    pixels[:, :, 1] = height - pixels[:, :, 1]
    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    depth = np.full((height, width), -np.inf)
    for i, points in enumerate(pixels):
        left, top = np.maximum(np.floor(points.min(axis=0)).astype(int), 0)
        right, bottom = np.minimum(np.ceil(points.max(axis=0)).astype(int), [width - 1, height - 1])
        a, b, c = points
        denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(denominator) < 1e-8:
            continue
        y, x = np.mgrid[top:bottom+1, left:right+1] + .5
        u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / denominator
        v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / denominator
        w = 1 - u - v
        z = u * faces[i, 0, 2] + v * faces[i, 1, 2] + w * faces[i, 2, 2]
        region = depth[top:bottom+1, left:right+1]
        mask = (u >= 0) & (v >= 0) & (w >= 0) & (z > region)
        normal = np.cross(faces[i, 1] - faces[i, 0], faces[i, 2] - faces[i, 0])
        length = np.linalg.norm(normal)
        light = .65 + .35 * abs(normal[2] / length) if length else 1
        region[mask] = z[mask]
        rgba[top:bottom+1, left:right+1][mask] = tuple(round(c * light) for c in colours[i]) + (255,)
    image = Image.fromarray(rgba)
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)

if __name__ == '__main__':
    import sys
    render(Path(sys.argv[1]))
