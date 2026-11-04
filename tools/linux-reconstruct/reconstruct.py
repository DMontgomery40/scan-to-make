#!/usr/bin/env python3
"""Linux photo reconstruction: COLMAP (CPU sparse) -> OpenMVS (CPU dense
mesh) -> metric USDZ, with scale proven by camera-centre alignment or an
explicit user measurement. Unscaled geometry never leaves the private work
directory: without a proven scale the run ends `needs-scale` (exit 4) with a
versioned receipt the companion turns into an in-app question, and a later
run with --measurement finishes scale+export from cache without replaying
reconstruction.

CLI (parity with tools/mac-reconstruct):
  linux-reconstruct samples <photosDir> <output.usdz> full --save-masks <masksDir>
      [--camera-metadata <capture-camera.json>]
      [--object-region <capture-object-region.json>]
      [--measurement <capture-measurement.json>] [--work-dir <path>]

NDJSON on stdout, one object per line: {"stage": ..., "progress": 0..1},
{"error": ..., "code": ...}, {"needsObjectRegion": {...}},
{"needsScale": {...}}, {"done": "<output>"}.
Exit 0 success (only after the output is atomically in place),
5 needs-object-region (which part is the object is unconfirmed; independent
of scale), 4 needs-scale, 2 actionable error. Tool logs stay private and
bounded in the work dir. The work dir is bound to one capture key.
"""
import argparse
import hashlib
import json
import math
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mesh as mesh_mod
import scale as scale_mod
import schemas
import usd_export

TOOL_VERSION = "1.2.0"
RECEIPT_VERSION = 1
PHOTO_SUFFIXES = {".jpg", ".jpeg", ".png"}
MIN_PHOTOS, MAX_PHOTOS = 8, 300
MAX_PHOTO_BYTES = 64 * 1024 * 1024
MAX_CAPTURE_BYTES = 2 * 1024 * 1024 * 1024
MAX_WORK_BYTES = 20 * 1024 * 1024 * 1024
LOG_TAIL_BYTES = 256 * 1024
EXHAUSTIVE_MATCH_LIMIT = 80
REGISTRATION_MIN_FRACTION = 0.6
REGISTRATION_MIN_COUNT = 8
COMPONENT_MIN_FRACTION = 0.4        # largest component share of mesh vertices
COMPONENT_SIGNIFICANT = 0.02        # components above this share count
COMPONENT_MAX_SIGNIFICANT = 20

STAGE_TIMEOUTS = {  # seconds; overridable per stage via env for testing
    "features": 1800, "matching": 1800, "mapping": 3600,
    "undistorting": 900, "interfacing": 600, "densifying": 3600,
    "meshing": 1800, "converting": 300,
}


class RunError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Cancelled(Exception):
    pass


_child = None          # currently running owned subprocess (own session)
_cancelled = False


def _on_signal(signum, _frame):
    global _cancelled
    _cancelled = True
    _kill_child()


def _kill_child():
    child = _child
    if child is None or child.poll() is not None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def stage(name, progress=None, **extra):
    event = {"stage": name}
    if progress is not None:
        event["progress"] = round(progress, 4)
    event.update(extra)
    emit(event)


def threads():
    return max(1, min(8, int(os.environ.get("SCAN_TO_MAKE_RECONSTRUCT_THREADS") or 0)
                      or min(8, os.cpu_count() or 1)))


def stage_timeout(name):
    override = os.environ.get(f"SCAN_TO_MAKE_RECONSTRUCT_TIMEOUT_{name.upper()}")
    return int(override) if override else STAGE_TIMEOUTS[name]


def find_colmap():
    return os.environ.get("SCAN_TO_MAKE_COLMAP") or shutil.which("colmap")


def find_openmvs(name):
    directory = os.environ.get("SCAN_TO_MAKE_OPENMVS_DIR")
    if directory:
        candidate = Path(directory) / name
        if candidate.exists():
            return str(candidate)
        raise RunError("tool-missing", f"{name} not found in SCAN_TO_MAKE_OPENMVS_DIR")
    return shutil.which(name)


def run_tool(name, argv, work, timeout_name):
    """Run one owned tool in its own session; logs bounded files, not stdout."""
    global _child
    if _cancelled:
        raise Cancelled()
    log_dir = work / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"{name}.log"
    started = time.monotonic()
    with open(log_path, "ab") as log:
        log.write(("$ " + " ".join(argv) + "\n").encode())
        log.flush()
        try:
            _child = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT,
                                      stdin=subprocess.DEVNULL, start_new_session=True)
        except FileNotFoundError as e:
            raise RunError("tool-missing", f"required tool is not installed: {argv[0]}") from e
        try:
            code = _child.wait(timeout=stage_timeout(timeout_name))
        except subprocess.TimeoutExpired:
            _kill_child()
            raise RunError("stage-timeout",
                           f"{name} exceeded its time bound; the capture may be too large for this computer") from None
        finally:
            _child = None
    if _cancelled:
        raise Cancelled()
    if code != 0:
        tail = log_path.read_bytes()[-2048:].decode("utf-8", "replace").strip().splitlines()
        hint = tail[-1][:300] if tail else ""
        raise RunError("stage-failed", f"{name} failed (exit {code}){': ' + hint if hint else ''}")
    return round(time.monotonic() - started, 2)


def dir_bytes(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def check_disk(work):
    if dir_bytes(work) > MAX_WORK_BYTES:
        raise RunError("workspace-too-large",
                       "reconstruction workspace exceeded its size bound; free disk space and retry")


def inventory_photos(photos_dir):
    photos_dir = Path(photos_dir)
    if not photos_dir.is_dir():
        raise RunError("photos-missing", f"photos directory does not exist: {photos_dir}")
    photos = {}
    total = 0
    for entry in sorted(photos_dir.iterdir(), key=lambda p: p.name):
        if entry.is_symlink() or not entry.is_file():
            continue
        if entry.suffix.lower() not in PHOTO_SUFFIXES:
            continue
        size = entry.stat().st_size
        if size > MAX_PHOTO_BYTES:
            raise RunError("photo-too-large", f"photo is implausibly large: {entry.name}")
        total += size
        photos[entry.name] = entry
    if total > MAX_CAPTURE_BYTES:
        raise RunError("capture-too-large", "the capture exceeds the 2 GiB bound")
    if len(photos) < MIN_PHOTOS:
        raise RunError("too-few-photos",
                       f"rebuilding from photos needs at least {MIN_PHOTOS} photos; found {len(photos)}")
    if len(photos) > MAX_PHOTOS:
        raise RunError("too-many-photos",
                       f"rebuilding from photos supports at most {MAX_PHOTOS} photos; found {len(photos)}")
    return photos


def capture_key(photos, camera_sha):
    h = hashlib.sha256()
    for name in sorted(photos):
        h.update(name.encode())
        h.update(schemas.sha256_file(photos[name]).encode())
    if camera_sha:
        h.update(camera_sha.encode())
    return h.hexdigest()[:24]


def stage_done(work, name, marker_paths, capture_key_value):
    # A stage counts only if it was produced for this exact capture. An
    # explicit --work-dir reused for different photos/metadata must never
    # silently inherit stale geometry (the key file in main also refuses).
    marker = work / f".stage-{name}.json"
    if not marker.exists() or not all(Path(p).exists() for p in marker_paths):
        return False
    try:
        return json.loads(marker.read_text(encoding="utf-8")).get("captureKey") == capture_key_value
    except (OSError, json.JSONDecodeError):
        return False


def mark_stage(work, name, seconds, capture_key_value):
    (work / f".stage-{name}.json").write_text(
        json.dumps({"seconds": seconds, "toolVersion": TOOL_VERSION,
                    "captureKey": capture_key_value}), encoding="utf-8")


def run_pipeline(photos_dir, work, timings, capture_key_value):
    photos_dir = str(Path(photos_dir).resolve())
    """COLMAP sparse -> undistort -> OpenMVS dense mesh. Cached per stage.
    Returns (mesh_ply_path, colmap_centres {basename: centre}, registered, total).
    """
    colmap = find_colmap()
    if not colmap:
        raise RunError("tool-missing", "COLMAP is not installed on this computer")
    for tool in ("InterfaceCOLMAP", "DensifyPointCloud", "ReconstructMesh"):
        if not find_openmvs(tool):
            raise RunError("tool-missing", f"OpenMVS tool is not installed: {tool}")
    db = work / "database.db"
    sparse = work / "sparse"
    dense = work / "dense"
    n_threads = str(threads())
    photos = sorted(p.name for p in Path(photos_dir).iterdir()
                    if p.suffix.lower() in PHOTO_SUFFIXES and p.is_file())

    if not stage_done(work, "features", [db], capture_key_value):
        stage("features", 0.05)
        timings["features"] = run_tool("colmap-features", [
            colmap, "feature_extractor", "--database_path", str(db),
            "--image_path", str(photos_dir),
            "--ImageReader.single_camera", "1",
            "--ImageReader.camera_model", "OPENCV",
            "--SiftExtraction.use_gpu", "0",
            "--SiftExtraction.num_threads", n_threads,
            "--SiftExtraction.max_image_size", "2000",
            "--SiftExtraction.max_num_features", "8192",
        ], work, "features")
        mark_stage(work, "features", timings["features"], capture_key_value)
    if not stage_done(work, "matching", [db], capture_key_value):
        stage("matching", 0.2)
        if len(photos) <= EXHAUSTIVE_MATCH_LIMIT:
            argv = [colmap, "exhaustive_matcher", "--database_path", str(db),
                    "--SiftMatching.use_gpu", "0", "--SiftMatching.num_threads", n_threads]
        else:  # capture order is walking order: neighbours overlap most
            argv = [colmap, "sequential_matcher", "--database_path", str(db),
                    "--SiftMatching.use_gpu", "0", "--SiftMatching.num_threads", n_threads,
                    "--SequentialMatching.overlap", "15",
                    "--SequentialMatching.loop_detection", "0"]
        timings["matching"] = run_tool("colmap-matching", argv, work, "matching")
        mark_stage(work, "matching", timings["matching"], capture_key_value)
    model = sparse / "0"
    images_txt = work / "images.txt"
    if not stage_done(work, "mapping", [images_txt], capture_key_value):
        if sparse.exists():
            shutil.rmtree(sparse)
        sparse.mkdir(parents=True)
        stage("mapping", 0.35)
        timings["mapping"] = run_tool("colmap-mapper", [
            colmap, "mapper", "--database_path", str(db),
            "--image_path", str(photos_dir), "--output_path", str(sparse),
            "--Mapper.num_threads", n_threads,
            "--Mapper.min_num_matches", "15",
        ], work, "mapping")
        models = sorted((p for p in sparse.iterdir() if p.is_dir()), key=lambda p: p.name)
        if not models:
            raise RunError("reconstruction-failed",
                           "the photos could not be aligned into one model; "
                           "retake with more overlap and steadier motion")
        # Largest model wins (most registered images).
        def model_images(m):
            out_dir = work / f"model-{m.name}"
            out_dir.mkdir(parents=True, exist_ok=True)   # COLMAP requires it to exist
            run_tool("colmap-convert", [colmap, "model_converter", "--input_path", str(m),
                                        "--output_path", str(out_dir),
                                        "--output_type", "TXT"], work, "converting")
            return mesh_mod.read_colmap_cameras(work / f"model-{m.name}" / "images.txt")
        best, best_centres = None, {}
        for m in models:
            centres = model_images(m)
            if len(centres) > len(best_centres):
                best, best_centres = m, centres
        model = best
        shutil.copyfile(work / f"model-{best.name}" / "images.txt", images_txt)
        (work / "model-name.txt").write_text(best.name, encoding="utf-8")
        mark_stage(work, "mapping", timings["mapping"], capture_key_value)
    else:
        model = sparse / (work / "model-name.txt").read_text(encoding="utf-8").strip()
    centres = mesh_mod.read_colmap_cameras(images_txt)
    registered, total = len(centres), len(photos)
    if registered < max(REGISTRATION_MIN_COUNT, math.ceil(REGISTRATION_MIN_FRACTION * total)):
        raise RunError("reconstruction-failed",
                       f"only {registered} of {total} photos could be aligned; "
                       "retake with more overlap and steadier motion")
    check_disk(work)

    scene = work / "scene.mvs"
    if not stage_done(work, "interface", [scene], capture_key_value):
        if dense.exists():
            shutil.rmtree(dense)
        stage("undistorting", 0.5)
        timings["undistorting"] = run_tool("colmap-undistort", [
            colmap, "image_undistorter", "--image_path", str(photos_dir),
            "--input_path", str(model), "--output_path", str(dense),
            "--output_type", "COLMAP", "--max_image_size", "2000",
        ], work, "undistorting")
        stage("interfacing", 0.55)
        timings["interfacing"] = run_tool("openmvs-interface", [
            find_openmvs("InterfaceCOLMAP"), "-i", str(dense), "-o", str(scene),
            "-w", str(work), "--max-threads", n_threads, "-v", "2",
        ], work, "interfacing")
        mark_stage(work, "interface", timings.get("interfacing", 0), capture_key_value)
    dense_scene = work / "scene_dense.mvs"
    if not stage_done(work, "densify", [dense_scene], capture_key_value):
        stage("densifying", 0.7)
        timings["densifying"] = run_tool("openmvs-densify", [
            find_openmvs("DensifyPointCloud"), "-i", str(scene), "-o", str(dense_scene),
            "-w", str(work), "--max-threads", n_threads,
            "--resolution-level", "1", "--number-views", "8", "-v", "2",
        ], work, "densifying")
        mark_stage(work, "densify", timings["densifying"], capture_key_value)
        check_disk(work)
    mesh_mvs = work / "scene_mesh.mvs"
    mesh_ply = work / "scene_mesh.ply"
    if not stage_done(work, "mesh", [mesh_ply], capture_key_value):
        stage("meshing", 0.85)
        timings["meshing"] = run_tool("openmvs-mesh", [
            find_openmvs("ReconstructMesh"), "-i", str(dense_scene), "-o", str(mesh_mvs),
            "-w", str(work), "--max-threads", n_threads,
            "--export-type", "ply", "-v", "2",
        ], work, "meshing")
        if not mesh_ply.exists():
            candidates = sorted(work.glob("*.ply"), key=lambda p: -p.stat().st_size)
            if not candidates:
                raise RunError("stage-failed", "mesh reconstruction produced no PLY")
            shutil.copyfile(candidates[0], mesh_ply)
        mark_stage(work, "mesh", timings["meshing"], capture_key_value)
    return mesh_ply, centres, registered, total


def component_stats(mesh_obj, components):
    total = len(mesh_obj.vertices)
    stats = []
    for i, (verts, face_ids) in enumerate(components):
        sub = mesh_mod.submesh(mesh_obj, face_ids)
        lo, hi, ext = sub.extents()
        stats.append({"index": i, "vertices": len(verts), "faces": len(face_ids),
                      "share": round(len(verts) / total, 4),
                      "boundsMin": [round(v, 6) for v in lo],
                      "boundsMax": [round(v, 6) for v in hi],
                      "extents": {a: round(ext[a], 6) for a in ("x", "y", "z")}})
    return stats


def suggested_selection(mesh_obj, components, anchor_metric, to_metric):
    """The tool's best guess at the object, for the person to confirm or
    replace. Never applied automatically: a largest component may be the
    table, and an anchor sphere includes the support surface inside it, so
    no confidence is claimed for either. Returns (kind, face_ids or None,
    report) where kind is "anchor-region" or "component".
    """
    total_vertices = len(mesh_obj.vertices)
    shares = [len(v) / total_vertices for v, _ in components]
    significant = sum(1 for s in shares if s >= COMPONENT_SIGNIFICANT)
    report = {"components": len(components), "significantComponents": significant,
              "largestShare": round(shares[0], 4) if shares else 0.0,
              "fragmented": bool(not components or shares[0] < COMPONENT_MIN_FRACTION
                                 or significant > COMPONENT_MAX_SIGNIFICANT)}
    if anchor_metric is not None and to_metric is not None:
        centre_m, radius_m = anchor_metric["center"], anchor_metric["radiusM"] * 1.15
        metric = [to_metric(v) for v in mesh_obj.vertices]
        region_faces = [fi for fi, face in enumerate(mesh_obj.faces)
                        if all(math.dist(metric[vi], centre_m) <= radius_m for vi in face)]
        if len(region_faces) >= 100:
            region = mesh_mod.submesh(mesh_obj, region_faces)
            largest = mesh_mod.connected_components(region)[0]
            report.update({"type": "anchor-region", "anchorRadiusM": round(radius_m, 4),
                           "regionFaceFraction": round(len(region_faces) / len(mesh_obj.faces), 4),
                           "reason": "anchor region includes any support surface inside "
                                     "the recorded radius; confirm or crop tighter"})
            return "anchor-region", (region, largest[1]), report
        report["anchorRegionEmpty"] = True
    report.update({"type": "component", "index": 0,
                   "reason": "largest piece of the reconstruction; it may be the "
                             "table or floor rather than the object"})
    return "component", None, report


def apply_selection(mesh_obj, components, selection, anchor_metric, to_metric):
    """Apply the person's confirmed selection. Returns (submesh, report)."""
    kind = selection["type"]
    if kind == "suggested":
        sugg_kind, payload, report = suggested_selection(
            mesh_obj, components, anchor_metric, to_metric)
        if sugg_kind == "anchor-region":
            region, face_ids = payload
            chosen = mesh_mod.submesh(region, face_ids)
        else:
            if not components:
                raise RunError("needs-object-region", "the reconstruction has no geometry to confirm")
            chosen = mesh_mod.submesh(mesh_obj, components[0][1])
        report.update({"method": f"user-confirmed-suggested-{sugg_kind}",
                       "confirmedByUser": True})
        return chosen, report
    if kind == "component":
        chosen = mesh_mod.submesh(mesh_obj, components[selection["index"]][1])
        return chosen, {"method": "user-component", "index": selection["index"],
                        "confirmedByUser": True,
                        "components": len(components)}
    # crop: faces fully inside the confirmed box (preview coordinates),
    # then the largest piece of what remains.
    lo, hi = selection["min"], selection["max"]
    inside = [all(lo[i] <= v[i] <= hi[i] for i in range(3)) for v in mesh_obj.vertices]
    face_ids = [fi for fi, face in enumerate(mesh_obj.faces)
                if all(inside[vi] for vi in face)]
    if len(face_ids) < 4:
        raise RunError("object-region-invalid",
                       "the confirmed crop contains almost no geometry; "
                       "show the preview and choose the object region again")
    cropped = mesh_mod.submesh(mesh_obj, face_ids)
    largest = mesh_mod.connected_components(cropped)[0]
    chosen = mesh_mod.submesh(cropped, largest[1])
    return chosen, {"method": "user-crop", "confirmedByUser": True,
                    "cropMin": list(lo), "cropMax": list(hi),
                    "croppedFaceFraction": round(len(face_ids) / len(mesh_obj.faces), 4),
                    "components": len(components)}


def write_json_atomic(path, obj):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def finish_from_mesh(raw_mesh, fit, anchor, options, work, output, receipt, timings, started, key):
    """Object-region gate, scale gate and metric export for one raw mesh.
    Shared by the COLMAP/OpenMVS pipeline (samples) and qualification of an
    externally rebuilt mesh (qualify, e.g. Apple PhotogrammetrySession
    output on a Mac host). Returns an exit code; raises RunError/Cancelled.
    """
    to_metric = None
    if fit and fit["ok"]:
        s, r, t = fit["scaleMPerUnit"], fit["rotation"], tuple(fit["translation"])
        to_metric = lambda p: scale_mod.apply_similarity(s, r, t, p)

    # Object-identity gate. Nothing the tool computes proves which part
    # of the reconstruction is the intended object: the largest piece may
    # be the table and an anchor sphere includes its support surface.
    # Export therefore requires the person's explicit confirmation,
    # bound by hash to the exact preview mesh. This gate is independent
    # of scale: a proven camera fit does not bypass it, and a
    # measurement alone does not satisfy it.
    preview_path = work / "preview.ply"
    mesh_mod.write_ply(preview_path, raw_mesh)
    preview_sha = schemas.sha256_file(preview_path)
    preview_stl = work / "preview.stl"
    mesh_mod.write_stl(preview_stl, raw_mesh)
    components = mesh_mod.connected_components(raw_mesh)
    plo, phi, _pext = raw_mesh.extents()
    region_source = options.object_region
    applied_path = work / "object-region.json"
    if region_source is None and applied_path.exists():
        region_source = str(applied_path)   # confirmed in an earlier run
    if region_source is None:
        sugg_kind, payload, sugg = suggested_selection(
            raw_mesh, components, anchor, to_metric)
        if sugg_kind == "anchor-region":
            sugg_mesh = mesh_mod.submesh(payload[0], payload[1])
        elif components:
            sugg_mesh = mesh_mod.submesh(raw_mesh, components[0][1])
        else:
            sugg_mesh = raw_mesh
        _slo, _shi, sugg_ext = sugg_mesh.extents()
        sugg["extents"] = {a: round(sugg_ext[a], 6) for a in ("x", "y", "z")}
        if to_metric is not None:
            metric_pts = [to_metric(v) for v in sugg_mesh.vertices]
            sugg["extentsM"] = {
                a: round(max(p[i] for p in metric_pts) - min(p[i] for p in metric_pts), 6)
                for i, a in enumerate(("x", "y", "z"))}
        region_receipt = {
            "version": RECEIPT_VERSION, "kind": "needs-object-region",
            "toolVersion": TOOL_VERSION, "captureKey": key,
            "previewMesh": str(preview_path),
            "previewStl": str(preview_stl),
            "previewMeshSha256": preview_sha,
            "units": "reconstruction units; multiply by scaleMPerUnit when "
                     "scaleKnown (axes are the reconstruction axes)",
            "boundsMin": [round(v, 6) for v in plo],
            "boundsMax": [round(v, 6) for v in phi],
            "vertices": len(raw_mesh.vertices), "faces": len(raw_mesh.faces),
            "components": component_stats(raw_mesh, components),
            "suggestion": sugg,
            "scaleKnown": bool(fit and fit["ok"]),
            "scaleMPerUnit": fit["scaleMPerUnit"] if fit and fit["ok"] else None,
            "cameraScaleFit": receipt.get("cameraScaleFit"),
            "confirm": "answer with capture-object-region v1: "
                       "{version:1, kind:'capture-object-region', previewMeshSha256, "
                       "selection:{type:'suggested'} | {type:'component', index:<int>} "
                       "| {type:'crop', min:[x,y,z], max:[x,y,z]}} in preview coordinates; "
                       "then rerun with --object-region <file> (it is remembered in the "
                       "work directory, so a later --measurement resume does not repeat it)",
        }
        receipt.update({"status": "needs-object-region", "scale": None,
                        "objectSelection": {"method": "unconfirmed",
                                            "suggestion": sugg},
                        "timingsSeconds": timings,
                        "elapsedSeconds": round(time.monotonic() - started, 2)})
        needs_path = work / "needs-object-region.json"
        write_json_atomic(needs_path, region_receipt)
        write_json_atomic(work / "receipt.json", receipt)
        emit({"needsObjectRegion": {"receipt": str(needs_path),
                                    "previewMeshSha256": preview_sha,
                                    "previewMesh": str(preview_path),
                                    "previewStl": str(preview_stl),
                                    "boundsMin": region_receipt["boundsMin"],
                                    "boundsMax": region_receipt["boundsMax"],
                                    "components": region_receipt["components"],
                                    "scaleKnown": region_receipt["scaleKnown"],
                                    "scaleMPerUnit": region_receipt["scaleMPerUnit"],
                                    "suggestion": sugg}})
        return 5
    try:
        region = schemas.load_object_region(
            region_source, preview_sha, len(components), plo, phi)
    except schemas.SchemaError as e:
        raise RunError("object-region-invalid", str(e)) from e
    if options.object_region:   # remember the confirmation for resumes
        tmp_copy = applied_path.with_suffix(".json.tmp")
        tmp_copy.write_bytes(Path(options.object_region).read_bytes())
        os.replace(tmp_copy, applied_path)
    selected, selection = apply_selection(
        raw_mesh, components, region, anchor, to_metric)
    selected.validate()
    receipt["objectSelection"] = selection

    # Cache the selected unscaled mesh; measurement binds to its hash.
    selected_path = work / "selected-unscaled.ply"
    mesh_mod.write_ply(selected_path, selected)
    mesh_sha = schemas.sha256_file(selected_path)
    selected_stl = work / "selected-unscaled.stl"
    mesh_mod.write_stl(selected_stl, selected)
    lo, hi, extents = selected.extents()

    scale_report = None
    transform = None     # point -> metres
    up_provenance = "unverified: reconstruction frame kept; app must confirm orientation"
    if fit and fit["ok"]:
        s = fit["scaleMPerUnit"]
        transform = to_metric
        up_provenance = "arcore-world: similarity rotation maps to the capture's Y-up frame"
        scale_report = {"method": "camera-centre-similarity", "scaleMPerUnit": s}
    elif options.measurement:
        try:
            axis, extent_mm, s = schemas.load_measurement(
                options.measurement, mesh_sha, extents)
        except schemas.SchemaError as e:
            raise RunError("measurement-invalid", str(e)) from e
        transform = lambda p: (s * p[0], s * p[1], s * p[2])
        # A measurement states a size only. Object identity comes from
        # the capture-object-region confirmation above, never from here.
        scale_report = {"method": "user-measurement", "scaleMPerUnit": s,
                        "axis": axis, "extentMm": extent_mm}
    if transform is None:
        preview = {
            "version": RECEIPT_VERSION, "kind": "needs-scale",
            "toolVersion": TOOL_VERSION, "captureKey": key,
            "meshSha256": mesh_sha,
            "previewMesh": str(selected_path),
            "previewStl": str(selected_stl),
            "units": "arbitrary reconstruction units (NOT metres)",
            "extents": {a: round(extents[a], 6) for a in ("x", "y", "z")},
            "boundsMin": [round(v, 6) for v in lo],
            "boundsMax": [round(v, 6) for v in hi],
            "vertices": len(selected.vertices), "faces": len(selected.faces),
            "objectSelection": selection,
            "cameraScaleFit": receipt.get("cameraScaleFit"),
            "measure": "answer with capture-measurement v1: "
                       "{version:1, kind:'capture-measurement', meshSha256, "
                       "axis:'x'|'y'|'z', extentMm:<number>} for one extent above",
        }
        receipt.update({"status": "needs-scale", "scale": None,
                        "timingsSeconds": timings,
                        "elapsedSeconds": round(time.monotonic() - started, 2)})
        needs_path = work / "needs-scale.json"
        write_json_atomic(needs_path, preview)
        write_json_atomic(work / "receipt.json", receipt)
        emit({"needsScale": {"receipt": str(needs_path), "meshSha256": mesh_sha,
                             "extents": preview["extents"],
                             "boundsMin": preview["boundsMin"],
                             "boundsMax": preview["boundsMax"],
                             "previewMesh": str(selected_path),
                             "previewStl": str(selected_stl)}})
        return 4

    stage("exporting", 0.95)
    metres = mesh_mod.Mesh([transform(v) for v in selected.vertices],
                           list(selected.faces))
    # Recentre: footprint centre at origin, lowest point at y=0. Scale
    # and orientation are untouched; only translation changes.
    mlo, mhi, mext = metres.extents()
    cx, cz = (mlo[0] + mhi[0]) / 2, (mlo[2] + mhi[2]) / 2
    metres.vertices = [(x - cx, y - mlo[1], z - cz) for x, y, z in metres.vertices]
    if metres.signed_volume() < 0:   # outward winding for right-handed USD
        metres.faces = [(a, c, b) for a, b, c in metres.faces]
    metres.validate()
    _lo, _hi, extents_m = metres.extents()
    if max(extents_m.values()) > 10.0 or min(extents_m.values()) <= 0:
        raise RunError("scale-implausible",
                       "the scaled object would be over 10 m or degenerate; "
                       "check the measurement and try again")
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp_usdz = output.with_suffix(".tmp.usdz")
    tmp_usdc = work / "export.usdc"
    try:
        usd_export.export_usdz(metres, tmp_usdc, tmp_usdz)
        os.replace(tmp_usdz, output)   # atomic publish; done only after this
    finally:
        tmp_usdz.unlink(missing_ok=True)
    scale_report["extentsM"] = {a: round(extents_m[a], 6) for a in ("x", "y", "z")}
    scale_report["upAxisProvenance"] = up_provenance
    receipt.update({"status": "done", "scale": scale_report,
                    "outputSha256": schemas.sha256_file(output),
                    "outputMeshSha256": mesh_sha,
                    "timingsSeconds": timings,
                    "elapsedSeconds": round(time.monotonic() - started, 2)})
    write_json_atomic(work / "receipt.json", receipt)
    write_json_atomic(output.with_suffix(".receipt.json"), receipt)
    emit({"done": str(output)})
    return 0


def _tool_version(argv):
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=15)
        text = (proc.stdout + proc.stderr).strip().splitlines()
        return text[0][:200] if text else ""
    except (OSError, subprocess.TimeoutExpired):
        return None


def check_main(args):
    """Bounded readiness evidence: one JSON line, exit 0 only when the
    closure actually runs. `samples` also launches COLMAP/OpenMVS --help;
    `qualify` needs only the USD runtime (Apple did the reconstruction)."""
    report = {"ok": False, "tool": "linux-reconstruct", "toolVersion": TOOL_VERSION,
              "mode": args.mode, "versions": {}}
    try:
        # The exact USD modules qualification/export load (usd_export._load_pxr),
        # not merely the pxr package shell.
        from pxr import Gf, Usd, UsdGeom, UsdUtils, Vt  # noqa: F401
        report["versions"]["python"] = ".".join(str(v) for v in sys.version_info[:3])
        report["versions"]["usd"] = "Gf,Usd,UsdGeom,UsdUtils,Vt importable"
    except ImportError as e:
        report["error"] = f"USD runtime unavailable: {e}"
        emit(report)
        return 2
    if args.mode == "samples":
        colmap = find_colmap()
        version = _tool_version([colmap, "help"]) if colmap else None
        if not version or "COLMAP" not in version:
            report["error"] = "COLMAP is not runnable"
            emit(report)
            return 2
        report["versions"]["colmap"] = version
        for tool in ("InterfaceCOLMAP", "DensifyPointCloud", "ReconstructMesh"):
            try:
                binary = find_openmvs(tool)
            except RunError:
                binary = None
            version = _tool_version([binary, "--help"]) if binary else None
            if not version or "OpenMVS" not in version:
                report["error"] = f"{tool} is not runnable"
                emit(report)
                return 2
            report["versions"][tool] = version
    report["ok"] = True
    emit(report)
    return 0


def qualify_main(args):
    """Qualify an externally rebuilt USDZ (e.g. Apple PhotogrammetrySession
    output for an Android capture on a Mac host).

    The source mesh's units are NOT trusted: Apple gives this host no camera
    centres to fit ARCore poses against, so camera metadata is not accepted
    here and scale can only come from an explicit measurement. Object
    identity and scale go through the same gates as the photo pipeline.
    """
    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)
    started = time.monotonic()
    timings = {}
    receipt = {"version": RECEIPT_VERSION, "tool": "linux-reconstruct",
               "toolVersion": TOOL_VERSION, "status": "failed", "mode": "qualify"}
    work = None
    try:
        source = Path(args.input).resolve()
        output = Path(args.output).resolve()
        if output.suffix.lower() != ".usdz":
            raise RunError("bad-arguments", "output must be a .usdz path")
        if not source.is_file():
            raise RunError("input-missing", f"input model does not exist: {source}")
        if source.stat().st_size > MAX_CAPTURE_BYTES:
            raise RunError("input-too-large", "the input model exceeds the size bound")
        stage("inventory", 0.01)
        key = "qualify-" + schemas.sha256_file(source)[:24]
        work = Path(args.work_dir).resolve() if args.work_dir else \
            output.parent / ".linux-reconstruct-work" / key
        work.mkdir(parents=True, exist_ok=True)
        os.chmod(work, 0o700)
        key_file = work / "capture-key.json"
        if key_file.exists():
            try:
                stored = json.loads(key_file.read_text(encoding="utf-8")).get("captureKey")
            except (OSError, json.JSONDecodeError, AttributeError):
                stored = None
            if stored != key:
                raise RunError("work-dir-mismatch",
                               "this work directory belongs to a different model; "
                               "use a new work directory")
        else:
            write_json_atomic(key_file, {"captureKey": key})
        receipt.update({"captureKey": key, "sourceSha256": schemas.sha256_file(source),
                        "source": "external-usdz (units untrusted)"})
        vertices, faces = usd_export.read_usdz_mesh(source)
        raw_mesh = mesh_mod.Mesh(vertices, faces)
        raw_mesh.validate()
        return finish_from_mesh(raw_mesh, None, None, args, work, output,
                                receipt, timings, started, key)
    except Cancelled:
        emit({"error": "cancelled", "code": "cancelled"})
        return 2
    except RunError as e:
        receipt.update({"status": "failed", "error": str(e), "code": e.code,
                        "timingsSeconds": timings,
                        "elapsedSeconds": round(time.monotonic() - started, 2)})
        if work is not None:
            try:
                write_json_atomic(work / "receipt.json", receipt)
            except OSError:
                pass
        emit({"error": str(e), "code": e.code})
        return 2
    except (mesh_mod.MeshError, RuntimeError, OSError) as e:
        emit({"error": str(e)[:500], "code": "failed"})
        return 2


def main(argv=None):
    parser = argparse.ArgumentParser(prog="linux-reconstruct")
    parser.add_argument("--version", action="version", version=f"linux-reconstruct {TOOL_VERSION}")
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check")
    check.add_argument("--mode", choices=("samples", "qualify"), default="samples")
    qualify = sub.add_parser("qualify")
    qualify.add_argument("input")
    qualify.add_argument("output")
    qualify.add_argument("--object-region")
    qualify.add_argument("--measurement")
    qualify.add_argument("--work-dir")
    samples = sub.add_parser("samples")
    samples.add_argument("photos_dir")
    samples.add_argument("output")
    samples.add_argument("quality")   # parity with mac-reconstruct; only "full"
    samples.add_argument("--save-masks", required=True)
    samples.add_argument("--camera-metadata")
    samples.add_argument("--object-region")
    samples.add_argument("--measurement")
    samples.add_argument("--work-dir")
    args = parser.parse_args(argv)
    if args.command == "check":
        return check_main(args)
    if args.command == "qualify":
        return qualify_main(args)

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)
    started = time.monotonic()
    timings = {}
    receipt = {"version": RECEIPT_VERSION, "tool": "linux-reconstruct",
               "toolVersion": TOOL_VERSION, "status": "failed"}
    work = None
    try:
        if args.quality != "full":
            raise RunError("bad-arguments", f"unsupported quality: {args.quality} (only 'full')")
        output = Path(args.output).resolve()
        if output.suffix.lower() != ".usdz":
            raise RunError("bad-arguments", "output must be a .usdz path")
        stage("inventory", 0.01)
        photos = inventory_photos(args.photos_dir)
        camera = None
        camera_sha = None
        if args.camera_metadata:
            try:
                camera = schemas.load_camera_metadata(args.camera_metadata, photos)
            except schemas.SchemaError as e:
                raise RunError("camera-metadata-invalid", str(e)) from e
            camera_sha = schemas.sha256_file(args.camera_metadata)
        key = capture_key(photos, camera_sha)
        work = Path(args.work_dir).resolve() if args.work_dir else \
            output.parent / ".linux-reconstruct-work" / key
        work.mkdir(parents=True, exist_ok=True)
        os.chmod(work, 0o700)
        # The work directory is bound to one capture. Reusing it for
        # different photos/metadata is refused rather than deleting or
        # silently inheriting another capture's stages.
        key_file = work / "capture-key.json"
        if key_file.exists():
            try:
                stored = json.loads(key_file.read_text(encoding="utf-8")).get("captureKey")
            except (OSError, json.JSONDecodeError, AttributeError):
                stored = None
            if stored != key:
                raise RunError("work-dir-mismatch",
                               "this work directory belongs to a different capture; "
                               "use a new work directory for these photos")
        else:
            write_json_atomic(key_file, {"captureKey": key})
        masks_dir = Path(args.save_masks)
        masks_dir.mkdir(parents=True, exist_ok=True)
        receipt.update({"photos": len(photos), "captureKey": key,
                        "masks": "none: the Linux pipeline does not segment photos; "
                                 "the masks directory is kept for CLI parity"})
        if camera:
            receipt["cameraFrames"] = len(camera.frames)
            receipt["cameraTrackingFrames"] = len(camera.tracking_frames())

        mesh_ply, centres, registered, total = run_pipeline(
            args.photos_dir, work, timings, key)
        receipt["registration"] = {"registered": registered, "total": total}

        # Camera-centre scale fit (only tracking frames COLMAP registered).
        fit = None
        if camera:
            paired_src, paired_dst = [], []
            tracking = {f.image: f for f in camera.tracking_frames()}
            for name in sorted(set(centres) & set(tracking)):
                paired_src.append(centres[name])
                paired_dst.append(tracking[name].center)
            # Duplicate centres (paused capture) add no geometry; drop exact dupes.
            seen, src_u, dst_u = set(), [], []
            for s, d in zip(paired_src, paired_dst):
                k = (round(d[0], 6), round(d[1], 6), round(d[2], 6))
                if k not in seen:
                    seen.add(k)
                    src_u.append(s)
                    dst_u.append(d)
            fit = scale_mod.fit_camera_scale(src_u, dst_u, len(tracking))
            receipt["cameraScaleFit"] = {k: v for k, v in fit.items()
                                         if k not in ("rotation", "translation")}

        raw_mesh = mesh_mod.read_ply(mesh_ply)
        anchor = camera.anchor if camera else None
        return finish_from_mesh(raw_mesh, fit, anchor, args, work, output, receipt, timings, started, key)
    except Cancelled:
        emit({"error": "cancelled", "code": "cancelled"})
        return 2
    except RunError as e:
        receipt.update({"status": "failed", "error": str(e), "code": e.code,
                        "timingsSeconds": timings,
                        "elapsedSeconds": round(time.monotonic() - started, 2)})
        if work is not None:
            try:
                write_json_atomic(work / "receipt.json", receipt)
            except OSError:
                pass
        emit({"error": str(e), "code": e.code})
        return 2
    except (mesh_mod.MeshError, RuntimeError, OSError) as e:
        emit({"error": str(e)[:500], "code": "failed"})
        return 2


if __name__ == "__main__":
    sys.exit(main())
