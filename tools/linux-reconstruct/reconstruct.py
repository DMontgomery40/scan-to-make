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
      [--camera-metadata <capture-camera.json>] [--measurement <capture-measurement.json>]
      [--work-dir <path>]

NDJSON on stdout, one object per line: {"stage": ..., "progress": 0..1},
{"error": ..., "code": ...}, {"needsScale": {...}}, {"done": "<output>"}.
Exit 0 success (only after the output is atomically in place), 4 needs-scale,
2 actionable error. Tool logs stay private and bounded in the work dir.
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

TOOL_VERSION = "1.0.0"
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


def stage_done(work, name, marker_paths):
    marker = work / f".stage-{name}.json"
    return marker.exists() and all(Path(p).exists() for p in marker_paths)


def mark_stage(work, name, seconds):
    (work / f".stage-{name}.json").write_text(
        json.dumps({"seconds": seconds, "toolVersion": TOOL_VERSION}), encoding="utf-8")


def run_pipeline(photos_dir, work, timings):
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

    if not stage_done(work, "features", [db]):
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
        mark_stage(work, "features", timings["features"])
    if not stage_done(work, "matching", [db]):
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
        mark_stage(work, "matching", timings["matching"])
    model = sparse / "0"
    images_txt = work / "images.txt"
    if not stage_done(work, "mapping", [images_txt]):
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
        mark_stage(work, "mapping", timings["mapping"])
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
    if not stage_done(work, "interface", [scene]):
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
        mark_stage(work, "interface", timings.get("interfacing", 0))
    dense_scene = work / "scene_dense.mvs"
    if not stage_done(work, "densify", [dense_scene]):
        stage("densifying", 0.7)
        timings["densifying"] = run_tool("openmvs-densify", [
            find_openmvs("DensifyPointCloud"), "-i", str(scene), "-o", str(dense_scene),
            "-w", str(work), "--max-threads", n_threads,
            "--resolution-level", "1", "--number-views", "8", "-v", "2",
        ], work, "densifying")
        mark_stage(work, "densify", timings["densifying"])
        check_disk(work)
    mesh_mvs = work / "scene_mesh.mvs"
    mesh_ply = work / "scene_mesh.ply"
    if not stage_done(work, "mesh", [mesh_ply]):
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
        mark_stage(work, "mesh", timings["meshing"])
    return mesh_ply, centres, registered, total


def select_object(mesh_obj, anchor_metric, to_metric):
    """Pick the object component. With a proven similarity and a capture-time
    object anchor, the component overlapping the anchor sphere wins. Without
    an anchor, the largest component is used only when the mesh is not
    fragmented; its identity as the object (not the table) is confirmed by
    the person in the app against the preview before any measurement binds.
    """
    components = mesh_mod.connected_components(mesh_obj)
    total_vertices = len(mesh_obj.vertices)
    shares = [len(v) / total_vertices for v, _ in components]
    significant = sum(1 for s in shares if s >= COMPONENT_SIGNIFICANT)
    report = {"components": len(components), "significantComponents": significant,
              "largestShare": round(shares[0], 4) if shares else 0.0}
    if anchor_metric is not None and to_metric is not None:
        # The anchor is a recorded object region (centre + radius at capture
        # time), not a guess: keep faces inside it, then the largest piece.
        # An object standing on a table is one component with the table, so
        # component choice alone cannot separate them.
        centre_m, radius_m = anchor_metric["center"], anchor_metric["radiusM"] * 1.15
        metric = [to_metric(v) for v in mesh_obj.vertices]
        region_faces = [fi for fi, face in enumerate(mesh_obj.faces)
                        if all(math.dist(metric[vi], centre_m) <= radius_m for vi in face)]
        if len(region_faces) < 100:
            raise RunError("needs-object-region",
                           "no reconstructed part matches the marked object position; "
                           "retake the capture or mark the object region in the app")
        region = mesh_mod.submesh(mesh_obj, region_faces)
        region_components = mesh_mod.connected_components(region)
        chosen = mesh_mod.submesh(region, region_components[0][1])
        report.update({"method": "object-anchor-region",
                       "anchorRadiusM": round(radius_m, 4),
                       "regionFaceFraction": round(len(region_faces) / len(mesh_obj.faces), 4),
                       "selectedShare": round(len(chosen.vertices) / total_vertices, 4)})
        return chosen, report
    if not components or shares[0] < COMPONENT_MIN_FRACTION or significant > COMPONENT_MAX_SIGNIFICANT:
        raise RunError("needs-object-region",
                       "the reconstruction is fragmented into many pieces and no object "
                       "position was recorded; mark the object region in the app or retake closer")
    report.update({"method": "largest-component-unverified",
                   "selectedShare": round(shares[0], 4)})
    return mesh_mod.submesh(mesh_obj, components[0][1]), report


def write_json_atomic(path, obj):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="linux-reconstruct")
    sub = parser.add_subparsers(dest="command", required=True)
    samples = sub.add_parser("samples")
    samples.add_argument("photos_dir")
    samples.add_argument("output")
    samples.add_argument("quality")   # parity with mac-reconstruct; only "full"
    samples.add_argument("--save-masks", required=True)
    samples.add_argument("--camera-metadata")
    samples.add_argument("--measurement")
    samples.add_argument("--work-dir")
    args = parser.parse_args(argv)

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
        masks_dir = Path(args.save_masks)
        masks_dir.mkdir(parents=True, exist_ok=True)
        receipt.update({"photos": len(photos), "captureKey": key,
                        "masks": "none: the Linux pipeline does not segment photos; "
                                 "the masks directory is kept for CLI parity"})
        if camera:
            receipt["cameraFrames"] = len(camera.frames)
            receipt["cameraTrackingFrames"] = len(camera.tracking_frames())

        mesh_ply, centres, registered, total = run_pipeline(args.photos_dir, work, timings)
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
        to_metric = None
        if fit and fit["ok"]:
            s, r, t = fit["scaleMPerUnit"], fit["rotation"], tuple(fit["translation"])
            to_metric = lambda p: scale_mod.apply_similarity(s, r, t, p)
        anchor = camera.anchor if camera else None
        selected, selection = select_object(raw_mesh, anchor, to_metric)
        receipt["objectSelection"] = selection

        # Cache the selected unscaled mesh; measurement binds to its hash.
        selected_path = work / "selected-unscaled.ply"
        mesh_mod.write_ply(selected_path, selected)
        mesh_sha = schemas.sha256_file(selected_path)
        lo, hi, extents = selected.extents()

        scale_report = None
        transform = None     # point -> metres
        up_provenance = "unverified: reconstruction frame kept; app must confirm orientation"
        if fit and fit["ok"]:
            s = fit["scaleMPerUnit"]
            transform = to_metric
            up_provenance = "arcore-world: similarity rotation maps to the capture's Y-up frame"
            scale_report = {"method": "camera-centre-similarity", "scaleMPerUnit": s}
        elif args.measurement:
            try:
                axis, extent_mm, s = schemas.load_measurement(
                    args.measurement, mesh_sha, extents)
            except schemas.SchemaError as e:
                raise RunError("measurement-invalid", str(e)) from e
            transform = lambda p: (s * p[0], s * p[1], s * p[2])
            # The measurement was answered against the preview of exactly
            # this component, so the person has confirmed it is the object.
            scale_report = {"method": "user-measurement", "scaleMPerUnit": s,
                            "axis": axis, "extentMm": extent_mm,
                            "objectConfirmedByUser": True}
        if transform is None:
            preview = {
                "version": RECEIPT_VERSION, "kind": "needs-scale",
                "toolVersion": TOOL_VERSION, "captureKey": key,
                "meshSha256": mesh_sha,
                "previewMesh": str(selected_path),
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
                                 "previewMesh": str(selected_path)}})
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
