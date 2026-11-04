"""Strict version-1 schemas for linux-reconstruct sidecars.

capture-camera.json (kind "capture-camera", version 1) is written by the
Android capture app next to the photos. It is deliberately NOT the iOS
capture-frames format: every frame is bound to one saved image by basename
and SHA-256, intrinsics are CPU-image values already adjusted to the saved
image's orientation and pixel size, and the camera centre is in metres in
the ARCore world frame (Y-up, gravity aligned).

capture-measurement.json (kind "capture-measurement", version 1) is written
by the companion after the person answers the scale question in the app. It
is strict numeric JSON bound to the cached unscaled mesh by SHA-256 and to
one named axis extent from the needs-scale receipt. No prose is interpreted.
"""
import hashlib
import json
import math
import re
from pathlib import Path

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
BASENAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
TRACKING_STATES = ("tracking", "limited", "not-tracking")
ANCHOR_SOURCES = ("arcore-anchor", "user-tap", "depth-centroid")
AXES = ("x", "y", "z")

CAMERA_FRAME_KEYS = {"image", "sha256", "width", "height", "fx", "fy", "cx", "cy",
                     "timestampMs", "tracking", "center"}
CAMERA_TOP_KEYS = {"version", "kind", "frames", "objectAnchor"}
ANCHOR_KEYS = {"center", "radiusM", "confidence", "source"}
MEASUREMENT_KEYS = {"version", "kind", "meshSha256", "axis", "extentMm"}
REGION_KEYS = {"version", "kind", "previewMeshSha256", "selection"}
REGION_TYPES = ("suggested", "component", "crop")


class SchemaError(ValueError):
    """Actionable, caller-visible validation failure."""


def _finite_number(value, what):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise SchemaError(f"{what} must be a finite number")
    return float(value)


def _vec3(value, what):
    if not isinstance(value, list) or len(value) != 3:
        raise SchemaError(f"{what} must be an array of 3 numbers")
    return tuple(_finite_number(v, f"{what}[{i}]") for i, v in enumerate(value))


def _load_strict(path, what):
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as e:
        raise SchemaError(f"cannot read {what}: {e.strerror or e}") from e
    if len(text) > 16 * 1024 * 1024:
        raise SchemaError(f"{what} is too large")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise SchemaError(f"{what} is not valid JSON: {e}") from e
    if not isinstance(data, dict):
        raise SchemaError(f"{what} must be a JSON object")
    return data


def image_dimensions(path):
    """(width, height) of a JPEG or PNG from its header; no decode."""
    data = Path(path).read_bytes()[: 1024 * 1024]
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24 and data[12:16] == b"IHDR":
        return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    if data[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                height = int.from_bytes(data[i + 5:i + 7], "big")
                width = int.from_bytes(data[i + 7:i + 9], "big")
                return width, height
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD9:
                i += 2
                continue
            seg_len = int.from_bytes(data[i + 2:i + 4], "big")
            if seg_len < 2:
                break
            i += 2 + seg_len
    raise SchemaError(f"unsupported or unreadable image: {Path(path).name}")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


class CameraFrame:
    __slots__ = ("image", "sha256", "width", "height", "fx", "fy", "cx", "cy",
                 "timestamp_ms", "tracking", "center")

    def __init__(self, raw, index):
        what = f"frames[{index}]"
        if not isinstance(raw, dict):
            raise SchemaError(f"{what} must be an object")
        unknown = set(raw) - CAMERA_FRAME_KEYS
        if unknown:
            raise SchemaError(f"{what} has unknown keys: {sorted(unknown)}")
        missing = CAMERA_FRAME_KEYS - set(raw)
        if missing:
            raise SchemaError(f"{what} is missing keys: {sorted(missing)}")
        image = raw["image"]
        if not isinstance(image, str) or not BASENAME_RE.match(image) or "/" in image or "\\" in image:
            raise SchemaError(f"{what}.image must be a safe image basename")
        self.image = image
        if not isinstance(raw["sha256"], str) or not SHA256_RE.match(raw["sha256"]):
            raise SchemaError(f"{what}.sha256 must be 64 lowercase hex characters")
        self.sha256 = raw["sha256"]
        for key in ("width", "height"):
            v = raw[key]
            if isinstance(v, bool) or not isinstance(v, int) or not (16 <= v <= 32768):
                raise SchemaError(f"{what}.{key} must be an integer in [16, 32768]")
            setattr(self, key, v)
        self.fx = _finite_number(raw["fx"], f"{what}.fx")
        self.fy = _finite_number(raw["fy"], f"{what}.fy")
        self.cx = _finite_number(raw["cx"], f"{what}.cx")
        self.cy = _finite_number(raw["cy"], f"{what}.cy")
        # Intrinsics are for the saved image: focal lengths in pixels must be
        # plausible for its size and the principal point inside (with margin).
        diag = math.hypot(self.width, self.height)
        if not (0.05 * diag <= self.fx <= 20 * diag and 0.05 * diag <= self.fy <= 20 * diag):
            raise SchemaError(f"{what} focal lengths are implausible for the saved image size")
        if not (-0.25 * self.width <= self.cx <= 1.25 * self.width
                and -0.25 * self.height <= self.cy <= 1.25 * self.height):
            raise SchemaError(f"{what} principal point is outside the saved image")
        ts = raw["timestampMs"]
        if isinstance(ts, bool) or not isinstance(ts, int) or ts < 0:
            raise SchemaError(f"{what}.timestampMs must be a non-negative integer")
        self.timestamp_ms = ts
        if raw["tracking"] not in TRACKING_STATES:
            raise SchemaError(f"{what}.tracking must be one of {TRACKING_STATES}")
        self.tracking = raw["tracking"]
        self.center = _vec3(raw["center"], f"{what}.center")
        if max(abs(c) for c in self.center) > 1000.0:
            raise SchemaError(f"{what}.center is implausibly far from the session origin")


class CameraMetadata:
    def __init__(self, frames, anchor):
        self.frames = frames            # list[CameraFrame]
        self.anchor = anchor            # dict or None

    def tracking_frames(self):
        return [f for f in self.frames if f.tracking == "tracking"]


def load_camera_metadata(path, photos):
    """Validate capture-camera.json against the actual photo files.

    photos: {basename: Path}. Every frame must bind to a real photo whose
    SHA-256 and pixel dimensions match exactly. Duplicate images, duplicate
    timestamps with identical centres, and frames for missing photos are
    rejected. Returns CameraMetadata.
    """
    data = _load_strict(path, "camera metadata")
    unknown = set(data) - CAMERA_TOP_KEYS
    if unknown:
        raise SchemaError(f"camera metadata has unknown keys: {sorted(unknown)}")
    if data.get("version") != 1 or data.get("kind") != "capture-camera":
        raise SchemaError('camera metadata must be {"version":1,"kind":"capture-camera"}')
    raw_frames = data.get("frames")
    if not isinstance(raw_frames, list) or not raw_frames:
        raise SchemaError("camera metadata frames must be a non-empty array")
    if len(raw_frames) > 10000:
        raise SchemaError("camera metadata has too many frames")
    frames, seen = [], set()
    for i, raw in enumerate(raw_frames):
        frame = CameraFrame(raw, i)
        if frame.image in seen:
            raise SchemaError(f"duplicate camera frame for {frame.image}")
        seen.add(frame.image)
        photo = photos.get(frame.image)
        if photo is None:
            raise SchemaError(f"camera frame names a photo that is not in the capture: {frame.image}")
        if sha256_file(photo) != frame.sha256:
            raise SchemaError(f"camera frame SHA-256 does not match the saved photo: {frame.image}")
        if image_dimensions(photo) != (frame.width, frame.height):
            raise SchemaError(f"camera frame dimensions do not match the saved photo: {frame.image}")
        frames.append(frame)
    anchor = data.get("objectAnchor")
    if anchor is not None:
        if not isinstance(anchor, dict) or set(anchor) != ANCHOR_KEYS:
            raise SchemaError(f"objectAnchor must have exactly the keys {sorted(ANCHOR_KEYS)}")
        centre = _vec3(anchor["center"], "objectAnchor.center")
        radius = _finite_number(anchor["radiusM"], "objectAnchor.radiusM")
        confidence = _finite_number(anchor["confidence"], "objectAnchor.confidence")
        if not (0.01 <= radius <= 5.0):
            raise SchemaError("objectAnchor.radiusM must be in [0.01, 5] metres")
        if not (0.0 <= confidence <= 1.0):
            raise SchemaError("objectAnchor.confidence must be in [0, 1]")
        if anchor["source"] not in ANCHOR_SOURCES:
            raise SchemaError(f"objectAnchor.source must be one of {ANCHOR_SOURCES}")
        anchor = {"center": centre, "radiusM": radius, "confidence": confidence,
                  "source": anchor["source"]}
    return CameraMetadata(frames, anchor)


def load_measurement(path, mesh_sha256, extents):
    """Validate capture-measurement.json against the cached unscaled mesh.

    extents: {"x": units, "y": units, "z": units} of the selected component.
    Returns (axis, extent_mm, scale_m_per_unit).
    """
    data = _load_strict(path, "measurement")
    if set(data) != MEASUREMENT_KEYS:
        raise SchemaError(f"measurement must have exactly the keys {sorted(MEASUREMENT_KEYS)}")
    if data["version"] != 1 or data["kind"] != "capture-measurement":
        raise SchemaError('measurement must be {"version":1,"kind":"capture-measurement"}')
    if not isinstance(data["meshSha256"], str) or not SHA256_RE.match(data["meshSha256"]):
        raise SchemaError("measurement.meshSha256 must be 64 lowercase hex characters")
    if data["meshSha256"] != mesh_sha256:
        raise SchemaError("measurement was made against a different mesh; rebuild the preview and measure again")
    axis = data["axis"]
    if axis not in AXES:
        raise SchemaError(f"measurement.axis must be one of {AXES} (the axes named in the scale preview)")
    extent_mm = _finite_number(data["extentMm"], "measurement.extentMm")
    if not (1.0 <= extent_mm <= 10000.0):
        raise SchemaError("measurement.extentMm must be in [1, 10000] millimetres")
    extent_units = extents[axis]
    if not (math.isfinite(extent_units) and extent_units > 0):
        raise SchemaError(f"the preview extent on axis {axis} is degenerate")
    return axis, extent_mm, (extent_mm / 1000.0) / extent_units


def load_object_region(path, preview_sha256, component_count, bounds_lo, bounds_hi):
    """Validate capture-object-region.json against the exact preview mesh.

    This is the person's explicit statement of which part of the preview is
    the intended object. It is distinct from a measurement: it carries no
    scale claim. Coordinates are preview-mesh (reconstruction) coordinates.
    Returns one of:
      {"type": "suggested"}
      {"type": "component", "index": int}
      {"type": "crop", "min": (x,y,z), "max": (x,y,z)}
    """
    data = _load_strict(path, "object region")
    if set(data) != REGION_KEYS:
        raise SchemaError(f"object region must have exactly the keys {sorted(REGION_KEYS)}")
    if data["version"] != 1 or data["kind"] != "capture-object-region":
        raise SchemaError('object region must be {"version":1,"kind":"capture-object-region"}')
    if not isinstance(data["previewMeshSha256"], str) \
            or not SHA256_RE.match(data["previewMeshSha256"]):
        raise SchemaError("objectRegion.previewMeshSha256 must be 64 lowercase hex characters")
    if data["previewMeshSha256"] != preview_sha256:
        raise SchemaError("object region was confirmed against a different preview; "
                          "show the current preview and confirm again")
    selection = data["selection"]
    if not isinstance(selection, dict) or selection.get("type") not in REGION_TYPES:
        raise SchemaError(f"objectRegion.selection.type must be one of {REGION_TYPES}")
    kind = selection["type"]
    if kind == "suggested":
        if set(selection) != {"type"}:
            raise SchemaError("a 'suggested' selection takes no other keys")
        return {"type": "suggested"}
    if kind == "component":
        if set(selection) != {"type", "index"}:
            raise SchemaError("a 'component' selection is exactly {type, index}")
        index = selection["index"]
        if isinstance(index, bool) or not isinstance(index, int) \
                or not (0 <= index < component_count):
            raise SchemaError(f"component index must be an integer in [0, {component_count})")
        return {"type": "component", "index": index}
    if set(selection) != {"type", "min", "max"}:
        raise SchemaError("a 'crop' selection is exactly {type, min, max}")
    lo = _vec3(selection["min"], "selection.min")
    hi = _vec3(selection["max"], "selection.max")
    for i, axis in enumerate("xyz"):
        if not lo[i] < hi[i]:
            raise SchemaError(f"crop min must be below max on axis {axis}")
        if hi[i] < bounds_lo[i] or lo[i] > bounds_hi[i]:
            raise SchemaError("crop box does not intersect the preview mesh")
    return {"type": "crop", "min": lo, "max": hi}
