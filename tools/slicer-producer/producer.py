#!/usr/bin/env python3
"""Operator-only offline G-code producer around the BambuStudio CLI (macOS).

Fail-closed: every run is sandboxed (network and Mach lookup denied); presets come only
from the app bundle (containment-checked, hashed, inheritance flattened into a scratch
dir); outputs are published atomically and only after the slicer exits 0 with exactly
the expected files. There is no degraded or unsandboxed mode.
"""
import argparse
import hashlib
import json
import os
import plistlib
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

SCHEMA = "scan-to-make.slicer-producer/0.1.0"
DEFAULT_BUNDLE = "/Applications/BambuStudio.app"
DEFAULT_SANDBOX_EXEC = "/usr/bin/sandbox-exec"
EXPECTED_VERSION = "02.08.02.61"
VENDOR = "BBL"
KINDS = ("machine", "process", "filament")
# Bundle resources the CLI reads on its own (cli_config.json applies machine limits).
BOUND_RESOURCES = ("Contents/Resources/profiles/BBL.json", "Contents/Resources/profiles/BBL/cli_config.json")
GCODE_NAME, SETTINGS_NAME = "plate_1.gcode", "exported-settings.json"
EXPECTED_OUTPUTS = {GCODE_NAME, SETTINGS_NAME}
ENV_KEYS = ("PATH", "LANG", "TMPDIR", "HOME")
TIMEOUT_S = 45
LOG_LIMIT = 5 * 1024 * 1024
MAX_INPUT_BYTES = 64 * 1024 * 1024
NOT_CLAIMED = ["effective slicer settings digest or equivalence", "determinism across runs",
               "zero attempted network calls (denial is enforced, attempts are not observed)",
               "3MF export", "printability, physical fit, or permission to print"]


class ProducerError(Exception):
    def __init__(self, stage, message, evidence=None):
        super().__init__(f"{stage}: {message}")
        self.stage, self.message, self.evidence = stage, message, evidence or {}


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha256_file(p):
    return sha256_bytes(Path(p).read_bytes())


def _inside(path, root):
    try:
        Path(path).resolve(strict=True).relative_to(Path(root).resolve(strict=True))
        return True
    except (ValueError, FileNotFoundError, OSError):
        return False


# ---------------------------------------------------------------- bundle identity
def bundle_identity(bundle, expected_version=EXPECTED_VERSION, expected_binary_sha256=None):
    bundle = Path(bundle)
    plist = bundle / "Contents" / "Info.plist"
    binary = bundle / "Contents" / "MacOS" / "BambuStudio"
    if not plist.is_file() or not binary.is_file() or not os.access(binary, os.X_OK):
        raise ProducerError("bundle", f"not a BambuStudio bundle: {bundle}")
    if not _inside(binary, bundle):
        raise ProducerError("bundle", "binary resolves outside the bundle")
    info = plistlib.loads(plist.read_bytes())
    version = info.get("CFBundleShortVersionString") or info.get("CFBundleVersion")
    if version != expected_version:
        raise ProducerError("bundle", f"bundle version {version!r} != expected {expected_version!r}")
    digest = sha256_file(binary)
    if expected_binary_sha256 and digest != expected_binary_sha256:
        raise ProducerError("bundle", f"binary sha256 {digest} != pinned {expected_binary_sha256}")
    resources = []
    for rel in BOUND_RESOURCES:
        p = bundle / rel
        if not p.is_file() or not _inside(p, bundle):
            raise ProducerError("bundle", f"bound resource missing or outside bundle: {rel}")
        data = p.read_bytes()
        resources.append({"path": rel, "sha256": sha256_bytes(data), "bytes": len(data)})
    return {"path": str(bundle), "version": version, "build": info.get("CFBundleVersion"),
            "infoPlistSha256": sha256_file(plist),
            "binary": {"path": "Contents/MacOS/BambuStudio", "sha256": digest}, "boundResources": resources}


# ---------------------------------------------------------------- presets
def resolve_preset(bundle, kind, name):
    """Flatten a bundled preset: parents (`inherits`) first, then `include`s, then own keys.
    Every file must resolve inside Contents/Resources/profiles; cycles are rejected."""
    if kind not in KINDS:
        raise ProducerError("preset", f"unknown preset kind {kind!r}")
    root = Path(bundle) / "Contents" / "Resources" / "profiles"
    sources = {}

    def load(n, stack):
        if not isinstance(n, str) or not n or "/" in n or "\\" in n or n.startswith(".") or "\0" in n:
            raise ProducerError("preset", f"invalid preset name {n!r}")
        if n in stack:
            raise ProducerError("preset", f"inheritance cycle: {' -> '.join(stack + (n,))}")
        p = root / VENDOR / kind / f"{n}.json"
        if not p.is_file():
            raise ProducerError("preset", f"{kind} preset not in bundle: {n!r}")
        if not _inside(p, root):
            raise ProducerError("preset", f"{kind} preset resolves outside the bundle: {n!r}")
        data = p.read_bytes()
        sources[str(p.relative_to(bundle))] = {"sha256": sha256_bytes(data), "bytes": len(data)}
        try:
            d = json.loads(data)
        except ValueError as e:
            raise ProducerError("preset", f"invalid JSON in {n!r}: {e}") from None
        if not isinstance(d, dict):
            raise ProducerError("preset", f"preset {n!r} is not an object")
        out = {}
        if d.get("inherits"):
            out.update(load(d["inherits"], stack + (n,)))
        for inc in d.get("include", []) or []:
            out.update(load(inc, stack + (n,)))
        out.update({k: v for k, v in d.items() if k not in ("inherits", "include")})
        return out

    flat = load(name, ())
    flat["name"] = name
    return flat, [{"path": k, **v} for k, v in sorted(sources.items())]


# ---------------------------------------------------------------- input model
def check_stl(data):
    if len(data) > MAX_INPUT_BYTES:
        raise ProducerError("input", f"input {len(data)} bytes exceeds {MAX_INPUT_BYTES}")
    if len(data) >= 84:
        n = struct.unpack_from("<I", data, 80)[0]
        if len(data) == 84 + 50 * n:
            if n == 0:
                raise ProducerError("input", "binary STL has no facets")
            for i in range(n):
                nx, ny, nz = struct.unpack_from("<3f", data, 84 + 50 * i)
                mag = (nx * nx + ny * ny + nz * nz) ** 0.5
                if not 0.99 <= mag <= 1.01:
                    raise ProducerError("input", f"binary STL facet {i} normal is not unit length ({mag:.3g})")
            return "binary-stl"
    head = data[:512].lstrip().lower()
    if head.startswith(b"solid") and b"facet" in data and b"endsolid" in data:
        return "ascii-stl"
    raise ProducerError("input", "input is not a valid binary or ASCII STL")


# ---------------------------------------------------------------- sandbox
def sandbox_profile(scratch):
    s = str(Path(scratch).resolve())
    home = str(Path.home())
    return "\n".join([
        "(version 1)", "(allow default)", "(deny network*)", "(deny mach-lookup)",
        f'(deny file-write* (require-not (subpath "{s}")))',
        f'(deny file-read* (subpath "{home}/Library"))',
        f'(deny file-read* (subpath "{home}/.ssh"))',
        f'(deny file-read* (subpath "{home}/.config"))',
        "(deny signal)", ""])


REQUIRED_PROFILE_RULES = ("(deny network*)", "(deny mach-lookup)", "(deny signal)")


def sandbox_argv(sandbox_exec, profile_path, cmd):
    p = Path(sandbox_exec)
    if not (p.is_file() and os.access(p, os.X_OK)):
        raise ProducerError("sandbox", f"network sandbox unavailable: {sandbox_exec} (no unsandboxed fallback)")
    text = Path(profile_path).read_text()
    missing = [r for r in REQUIRED_PROFILE_RULES if r not in text]
    if missing:
        raise ProducerError("sandbox", f"sandbox profile missing rules {missing}")
    return [str(p), "-f", str(profile_path)] + list(cmd)


def run_bounded(argv, env, log_path, timeout=TIMEOUT_S):
    with open(log_path, "wb") as log:
        proc = subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                start_new_session=True, cwd=env["TMPDIR"])
        written = 0
        timed_out = False
        try:
            import selectors
            import time
            deadline = time.monotonic() + timeout
            sel = selectors.DefaultSelector()
            sel.register(proc.stdout, selectors.EVENT_READ)
            while True:
                left = deadline - time.monotonic()
                if left <= 0:
                    timed_out = True
                    break
                if not sel.select(timeout=min(left, 0.5)):
                    if proc.poll() is not None:
                        break
                    continue
                chunk = os.read(proc.stdout.fileno(), 65536)
                if not chunk:
                    break
                if written < LOG_LIMIT:
                    log.write(chunk[:LOG_LIMIT - written])
                written += len(chunk)
        finally:
            try:
                os.killpg(proc.pid, signal.SIGKILL if timed_out else signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
            code = proc.wait()
    return (None if timed_out else code), written > LOG_LIMIT


# ---------------------------------------------------------------- produce
def produce(model, out_dir, machine, process, filament, bundle=DEFAULT_BUNDLE, sandbox_exec=DEFAULT_SANDBOX_EXEC,
            expected_version=EXPECTED_VERSION, expected_binary_sha256=None, timeout=TIMEOUT_S, scratch_parent=None):
    out_dir = Path(out_dir)
    if out_dir.exists():
        raise ProducerError("publish", f"output directory already exists: {out_dir}")
    if not out_dir.parent.is_dir():
        raise ProducerError("publish", f"output parent missing: {out_dir.parent}")
    ident = bundle_identity(bundle, expected_version, expected_binary_sha256)
    model = Path(model)
    data = model.read_bytes() if model.is_file() else None
    if data is None:
        raise ProducerError("input", f"model not found: {model}")
    kind = check_stl(data)

    scratch = Path(tempfile.mkdtemp(prefix="slicer-producer-", dir=scratch_parent)).resolve()
    try:
        inputs, outputs, datadir, tmp, home = (scratch / n for n in ("inputs", "outputs", "datadir", "tmp", "home"))
        for d in (inputs, outputs, datadir, tmp, home):
            d.mkdir()
        src = inputs / ("model" + model.suffix.lower() if model.suffix else "model.stl")
        src.write_bytes(data)
        if sha256_file(src) != sha256_bytes(data):
            raise ProducerError("input", "scratch copy hash mismatch")
        presets, preset_paths = {}, {}
        for k, n in (("machine", machine), ("process", process), ("filament", filament)):
            flat, sources = resolve_preset(bundle, k, n)
            blob = (json.dumps(flat, indent=2, sort_keys=True) + "\n").encode()
            p = inputs / f"{k}.json"
            p.write_bytes(blob)
            preset_paths[k] = p
            presets[k] = {"name": n, "flattenedSha256": sha256_bytes(blob), "flattenedBytes": len(blob),
                          "sources": sources}
        profile = scratch / "isolation.sb"
        profile.write_text(sandbox_profile(scratch))
        binary = Path(bundle) / "Contents" / "MacOS" / "BambuStudio"
        cmd = [str(binary), "--datadir", str(datadir),
               "--load-settings", f"{preset_paths['machine']};{preset_paths['process']}",
               "--load-filaments", str(preset_paths["filament"]),
               "--arrange", "1", "--orient", "0", "--slice", "0",
               "--outputdir", str(outputs), "--export-settings", str(outputs / SETTINGS_NAME),
               str(src)]
        argv = sandbox_argv(sandbox_exec, profile, cmd)
        env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8", "TMPDIR": str(tmp), "HOME": str(home)}
        log = scratch / "slicer.log"
        code, log_truncated = run_bounded(argv, env, log, timeout)

        def norm(s):
            return s.replace(str(scratch), "<scratch>")
        evidence = {"exitCode": code, "logTruncated": log_truncated,
                    "logTail": norm(log.read_bytes()[-4000:].decode("utf-8", "replace"))}
        if code is None:
            raise ProducerError("slicer", f"timed out after {timeout}s", evidence)
        if code != 0:
            raise ProducerError("slicer", f"exit code {code}", evidence)
        produced = {p.name for p in outputs.iterdir()}
        if produced != EXPECTED_OUTPUTS:
            raise ProducerError("outputs", f"expected exactly {sorted(EXPECTED_OUTPUTS)}, got {sorted(produced)}",
                                evidence)
        for name in EXPECTED_OUTPUTS:
            p = outputs / name
            if p.is_symlink() or not p.is_file() or p.stat().st_size == 0:
                raise ProducerError("outputs", f"{name} missing, empty or not a regular file", evidence)
        try:
            json.loads((outputs / SETTINGS_NAME).read_bytes())
        except ValueError:
            raise ProducerError("outputs", "exported settings are not valid JSON", evidence) from None
        # Re-check bound identities after the run: nothing the run depended on may have changed.
        if bundle_identity(bundle, expected_version, expected_binary_sha256) != ident:
            raise ProducerError("bundle", "bundle identity changed during the run")
        if sha256_file(src) != sha256_bytes(data):
            raise ProducerError("input", "scratch input changed during the run")

        gcode, settings = (outputs / GCODE_NAME).read_bytes(), (outputs / SETTINGS_NAME).read_bytes()
        manifest = {
            "schema": SCHEMA, "operatorOnly": True, "exitCode": 0,
            "slicer": ident,
            "input": {"fileName": model.name, "format": kind, "sha256": sha256_bytes(data), "bytes": len(data)},
            "presets": presets,
            "invocation": {"argv": [norm(a) for a in argv], "environmentKeys": sorted(env),
                           "sandboxProfileSha256": sha256_file(profile), "timeoutSeconds": timeout,
                           "freshDatadir": True},
            "outputs": {"gcode": {"file": GCODE_NAME, "sha256": sha256_bytes(gcode), "bytes": len(gcode)},
                        "exportedSettings": {"file": SETTINGS_NAME, "sha256": sha256_bytes(settings),
                                             "bytes": len(settings),
                                             "note": "observed slicer export artifact, hashed as bytes only"}},
            "logTruncated": log_truncated,
            "notClaimed": NOT_CLAIMED,
        }
        # Atomic publish: stage next to the destination, then a single rename.
        stage = Path(tempfile.mkdtemp(prefix=f".{out_dir.name}.staging-", dir=out_dir.parent))
        try:
            shutil.copyfile(outputs / GCODE_NAME, stage / GCODE_NAME)
            shutil.copyfile(outputs / SETTINGS_NAME, stage / SETTINGS_NAME)
            shutil.copyfile(log, stage / "slicer.log")
            (stage / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
            for name, meta in (("gcode", manifest["outputs"]["gcode"]),
                               ("exportedSettings", manifest["outputs"]["exportedSettings"])):
                if sha256_file(stage / meta["file"]) != meta["sha256"]:
                    raise ProducerError("publish", f"staged {name} hash mismatch")
            os.rename(stage, out_dir)  # fails if out_dir appeared meanwhile
        except BaseException:
            shutil.rmtree(stage, ignore_errors=True)
            raise
        return manifest
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model", help="source STL")
    ap.add_argument("--out", required=True, help="output directory (must not exist; published atomically)")
    ap.add_argument("--machine", required=True, help='bundled machine preset name, e.g. "Bambu Lab A1 0.4 nozzle"')
    ap.add_argument("--process", required=True, help="bundled process preset name")
    ap.add_argument("--filament", required=True, help="bundled filament preset name")
    ap.add_argument("--bundle", default=DEFAULT_BUNDLE)
    ap.add_argument("--sandbox-exec", default=DEFAULT_SANDBOX_EXEC)
    ap.add_argument("--expected-version", default=EXPECTED_VERSION)
    ap.add_argument("--expected-binary-sha256")
    ap.add_argument("--timeout", type=int, default=TIMEOUT_S)
    a = ap.parse_args(argv)
    try:
        m = produce(a.model, a.out, a.machine, a.process, a.filament, a.bundle, a.sandbox_exec,
                    a.expected_version, a.expected_binary_sha256, a.timeout)
    except ProducerError as e:
        sys.stderr.write(json.dumps({"error": {"stage": e.stage, "message": e.message, "evidence": e.evidence}},
                                    indent=2, sort_keys=True) + "\n")
        return 2
    sys.stdout.write(json.dumps({"published": str(a.out), "gcodeSha256": m["outputs"]["gcode"]["sha256"]},
                                sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
