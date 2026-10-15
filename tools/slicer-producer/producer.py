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
EXPECTED_VERSION = "02.08.02.61"
VENDOR = "BBL"
KINDS = ("machine", "process", "filament")
# Bundle resources the CLI reads on its own (cli_config.json applies machine limits).
BOUND_RESOURCES = ("Contents/Resources/profiles/BBL.json", "Contents/Resources/profiles/BBL/cli_config.json")
GCODE_NAME, SETTINGS_NAME, RESULT_NAME = "plate_1.gcode", "exported-settings.json", "result.json"
REQUIRED_OUTPUTS = {GCODE_NAME, SETTINGS_NAME}
OPTIONAL_OUTPUTS = {RESULT_NAME}  # CLI receipt; validated when present
ENV_KEYS = ("PATH", "LANG", "TMPDIR", "HOME")
TIMEOUT_S = 45
MAX_TIMEOUT_S = 600
TERM_GRACE_S = 2.0
TRUSTED_SANDBOX_EXEC = "/usr/bin/sandbox-exec"


class Limits:
    """Byte/count budgets. Tests inject smaller values; the CLI uses the defaults."""
    def __init__(self, input_bytes=64 << 20, preset_file_bytes=1 << 20, preset_files=64, preset_depth=16,
                 resource_bytes=4 << 20, plist_bytes=1 << 20, output_bytes=512 << 20, settings_bytes=8 << 20,
                 result_bytes=1 << 20, log_bytes=5 << 20):
        self.__dict__.update({k: v for k, v in locals().items() if k != "self"})
        for k, v in self.__dict__.items():
            if not (isinstance(v, int) and v > 0):
                raise ProducerError("limits", f"{k} must be a positive integer")
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
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_bounded(path, limit, what):
    """Read at most limit bytes; reject before allocating more (stat check, then limit+1 read)."""
    p = Path(path)
    try:
        with open(p, "rb") as f:
            if os.fstat(f.fileno()).st_size > limit:
                raise ProducerError("limits", f"{what} exceeds {limit} bytes")
            data = f.read(limit + 1)
    except FileNotFoundError:
        raise ProducerError("input", f"{what} not found") from None
    if len(data) > limit:
        raise ProducerError("limits", f"{what} exceeds {limit} bytes")
    return data


def _inside(path, root):
    try:
        Path(path).resolve(strict=True).relative_to(Path(root).resolve(strict=True))
        return True
    except (ValueError, FileNotFoundError, OSError):
        return False


# ---------------------------------------------------------------- bundle identity
def bundle_identity(bundle, expected_version=EXPECTED_VERSION, expected_binary_sha256=None, limits=None):
    limits = limits or Limits()
    bundle = Path(bundle)
    plist = bundle / "Contents" / "Info.plist"
    binary = bundle / "Contents" / "MacOS" / "BambuStudio"
    if not plist.is_file() or not binary.is_file() or not os.access(binary, os.X_OK):
        raise ProducerError("bundle", f"not a BambuStudio bundle: {bundle}")
    if not _inside(binary, bundle):
        raise ProducerError("bundle", "binary resolves outside the bundle")
    plist_bytes = read_bounded(plist, limits.plist_bytes, "Info.plist")
    info = plistlib.loads(plist_bytes)
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
        data = read_bounded(p, limits.resource_bytes, f"bound resource {rel}")
        resources.append({"path": rel, "sha256": sha256_bytes(data), "bytes": len(data)})
    return {"path": str(bundle), "version": version, "build": info.get("CFBundleVersion"),
            "infoPlistSha256": sha256_bytes(plist_bytes),
            "binary": {"path": "Contents/MacOS/BambuStudio", "sha256": digest}, "boundResources": resources}


# ---------------------------------------------------------------- presets
def resolve_preset(bundle, kind, name, limits=None):
    """Flatten a bundled preset: parents (`inherits`) first, then `include`s, then own keys.
    Every file must resolve inside Contents/Resources/profiles; cycles are rejected."""
    if kind not in KINDS:
        raise ProducerError("preset", f"unknown preset kind {kind!r}")
    limits = limits or Limits()
    root = Path(bundle) / "Contents" / "Resources" / "profiles"
    sources = {}
    loads = [0]

    def load(n, stack):
        if not isinstance(n, str) or not n or "/" in n or "\\" in n or n.startswith(".") or "\0" in n:
            raise ProducerError("preset", f"invalid preset name {n!r}")
        if n in stack:
            raise ProducerError("preset", f"inheritance cycle: {' -> '.join(stack + (n,))}")
        if len(stack) >= limits.preset_depth:
            raise ProducerError("limits", f"preset nesting deeper than {limits.preset_depth}")
        loads[0] += 1
        if loads[0] > limits.preset_files:
            raise ProducerError("limits", f"preset resolution reads more than {limits.preset_files} files")
        p = root / VENDOR / kind / f"{n}.json"
        if not p.is_file():
            raise ProducerError("preset", f"{kind} preset not in bundle: {n!r}")
        if not _inside(p, root):
            raise ProducerError("preset", f"{kind} preset resolves outside the bundle: {n!r}")
        data = read_bounded(p, limits.preset_file_bytes, f"{kind} preset {n!r}")
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


class PlatformSandbox:
    """The only production sandbox: macOS /usr/bin/sandbox-exec, root-owned, not group/world writable."""
    path = TRUSTED_SANDBOX_EXEC

    def describe(self):
        return {"kind": "macos-sandbox-exec", "path": self.path}

    def check(self):
        if sys.platform != "darwin":
            raise ProducerError("sandbox", f"unsupported platform {sys.platform!r}: network sandbox unavailable "
                                           "(no unsandboxed fallback)")
        try:
            st = os.stat(self.path)
        except FileNotFoundError:
            raise ProducerError("sandbox", f"network sandbox unavailable: {self.path} missing") from None
        if not os.access(self.path, os.X_OK) or st.st_uid != 0 or st.st_mode & 0o022:
            raise ProducerError("sandbox", f"{self.path} is not a trusted root-owned executable")


def sandbox_argv(sandbox, profile_path, cmd):
    sandbox.check()
    text = Path(profile_path).read_text()
    missing = [r for r in REQUIRED_PROFILE_RULES if r not in text]
    if missing:
        raise ProducerError("sandbox", f"sandbox profile missing rules {missing}")
    return [str(sandbox.path), "-f", str(profile_path)] + list(cmd)


def _dir_bytes(d):
    total = 0
    for root, _dirs, files in os.walk(d):
        for f in files:
            try:
                total += os.lstat(os.path.join(root, f)).st_size
            except FileNotFoundError:
                pass
    return total


def _kill_group(pgid, grace=TERM_GRACE_S):
    """TERM the owned process group, wait up to grace, then KILL."""
    import time
    try:
        os.killpg(pgid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    end = time.monotonic() + grace
    while time.monotonic() < end:
        try:
            os.killpg(pgid, 0)
        except (ProcessLookupError, PermissionError):
            return
        time.sleep(0.05)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def run_bounded(argv, env, log_path, timeout, output_dir, limits):
    """Run with a hard deadline that holds even after the child closes its pipes.
    Returns (exit_code or None on timeout, log_truncated, output_budget_exceeded)."""
    import selectors
    import time
    deadline = time.monotonic() + timeout
    timed_out = over_budget = False
    written = 0
    with open(log_path, "wb") as log:
        proc = subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, start_new_session=True, cwd=env["TMPDIR"])
        sel = selectors.DefaultSelector()
        sel.register(proc.stdout, selectors.EVENT_READ)
        eof = False
        try:
            while True:
                left = deadline - time.monotonic()
                if left <= 0:
                    timed_out = proc.poll() is None
                    break
                if _dir_bytes(output_dir) > limits.output_bytes:
                    over_budget = True
                    break
                if eof:
                    if proc.poll() is not None:
                        break
                    time.sleep(min(left, 0.05))
                    continue
                if sel.select(timeout=min(left, 0.2)):
                    chunk = os.read(proc.stdout.fileno(), 65536)
                    if not chunk:
                        eof = True  # keep enforcing the deadline until the process exits
                        continue
                    if written < limits.log_bytes:
                        log.write(chunk[:limits.log_bytes - written])
                    written += len(chunk)
        finally:
            sel.close()
            proc.stdout.close()
            _kill_group(proc.pid)  # always reap the owned group, TERM then KILL
            try:
                code = proc.wait(timeout=TERM_GRACE_S + 1)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                code = proc.wait()
    return (None if timed_out else code), written > limits.log_bytes, over_budget


def _rename_noreplace(src, dst):
    """Atomic, exclusive directory publish: never replaces an existing destination."""
    import ctypes
    import ctypes.util
    libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
    s_, d_ = os.fsencode(src), os.fsencode(dst)
    if sys.platform == "darwin" and hasattr(libc, "renamex_np"):
        rc = libc.renamex_np(s_, d_, ctypes.c_uint(0x00000004))  # RENAME_EXCL
    elif sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
        rc = libc.renameat2(-100, s_, -100, d_, ctypes.c_uint(1))  # AT_FDCWD, RENAME_NOREPLACE
    else:
        raise ProducerError("publish", "no exclusive rename primitive on this platform")
    if rc != 0:
        err = ctypes.get_errno()
        raise ProducerError("publish", f"exclusive publish failed: {os.strerror(err)}")


# ---------------------------------------------------------------- produce
def produce(model, out_dir, machine, process, filament, bundle=DEFAULT_BUNDLE,
            expected_version=EXPECTED_VERSION, expected_binary_sha256=None, timeout=TIMEOUT_S, scratch_parent=None,
            expected_input_sha256=None, expected_input_bytes=None, limits=None, _sandbox=None):
    """`_sandbox` is a test-only seam; the CLI never sets it, so production always uses PlatformSandbox."""
    limits = limits or Limits()
    sandbox = _sandbox or PlatformSandbox()
    if not (isinstance(timeout, (int, float)) and 0 < timeout <= MAX_TIMEOUT_S):
        raise ProducerError("limits", f"timeout must be in (0, {MAX_TIMEOUT_S}] seconds")
    out_dir = Path(out_dir)
    if out_dir.exists():
        raise ProducerError("publish", f"output directory already exists: {out_dir}")
    if not out_dir.parent.is_dir():
        raise ProducerError("publish", f"output parent missing: {out_dir.parent}")
    sandbox.check()
    ident = bundle_identity(bundle, expected_version, expected_binary_sha256, limits)
    model = Path(model)
    if not model.is_file():
        raise ProducerError("input", f"model not found: {model}")
    data = read_bounded(model, limits.input_bytes, "input model")
    if expected_input_bytes is not None and len(data) != expected_input_bytes:
        raise ProducerError("input", f"input is {len(data)} bytes, expected {expected_input_bytes}")
    if expected_input_sha256 is not None and sha256_bytes(data) != expected_input_sha256:
        raise ProducerError("input", "input sha256 does not match the expected digest")
    kind = check_stl(data)

    scratch = Path(tempfile.mkdtemp(prefix="slicer-producer-", dir=scratch_parent)).resolve()
    try:
        inputs, outputs, datadir, tmp, home = (scratch / n for n in ("inputs", "outputs", "datadir", "tmp", "home"))
        for d in (inputs, outputs, datadir, tmp, home):
            d.mkdir()
        src = inputs / ("model" + model.suffix.lower() if model.suffix else "model.stl")
        src.write_bytes(data)
        src.chmod(0o444)
        if sha256_file(src) != sha256_bytes(data):
            raise ProducerError("input", "scratch copy hash mismatch")
        presets, preset_paths = {}, {}
        for k, n in (("machine", machine), ("process", process), ("filament", filament)):
            flat, sources = resolve_preset(bundle, k, n, limits)
            blob = (json.dumps(flat, indent=2, sort_keys=True) + "\n").encode()
            p = inputs / f"{k}.json"
            p.write_bytes(blob)
            p.chmod(0o444)
            preset_paths[k] = p
            presets[k] = {"name": n, "flattenedSha256": sha256_bytes(blob), "flattenedBytes": len(blob),
                          "sources": sources}
        profile = scratch / "isolation.sb"
        profile.write_text(sandbox_profile(scratch))
        profile.chmod(0o444)
        profile_sha = sha256_file(profile)
        binary = Path(bundle) / "Contents" / "MacOS" / "BambuStudio"
        cmd = [str(binary), "--datadir", str(datadir),
               "--load-settings", f"{preset_paths['machine']};{preset_paths['process']}",
               "--load-filaments", str(preset_paths["filament"]),
               "--arrange", "1", "--orient", "0", "--slice", "0",
               "--outputdir", str(outputs), "--export-settings", str(outputs / SETTINGS_NAME),
               str(src)]
        argv = sandbox_argv(sandbox, profile, cmd)
        env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8", "TMPDIR": str(tmp), "HOME": str(home)}
        log = scratch / "slicer.log"
        code, log_truncated, over_budget = run_bounded(argv, env, log, timeout, outputs, limits)

        def norm(s):
            return s.replace(str(scratch), "<scratch>")
        evidence = {"exitCode": code, "logTruncated": log_truncated,
                    "logTail": norm(log.read_bytes()[-4000:].decode("utf-8", "replace"))}
        if over_budget:
            raise ProducerError("limits", f"outputs exceeded {limits.output_bytes} bytes during the run", evidence)
        if code is None:
            raise ProducerError("slicer", f"timed out after {timeout}s", evidence)
        if code != 0:
            raise ProducerError("slicer", f"exit code {code}", evidence)
        produced = {p.name for p in outputs.iterdir()}
        extra = produced - REQUIRED_OUTPUTS - OPTIONAL_OUTPUTS
        if not REQUIRED_OUTPUTS <= produced or extra:
            raise ProducerError("outputs", f"expected {sorted(REQUIRED_OUTPUTS)} (+ optional "
                                f"{sorted(OPTIONAL_OUTPUTS)}), got {sorted(produced)}", evidence)
        for name in produced:
            p = outputs / name
            if p.is_symlink() or not p.is_file() or p.stat().st_size == 0:
                raise ProducerError("outputs", f"{name} missing, empty or not a regular file", evidence)
        if _dir_bytes(outputs) > limits.output_bytes:
            raise ProducerError("limits", f"outputs exceed {limits.output_bytes} bytes", evidence)
        try:
            json.loads(read_bounded(outputs / SETTINGS_NAME, limits.settings_bytes, "exported settings"))
        except ValueError:
            raise ProducerError("outputs", "exported settings are not valid JSON", evidence) from None
        result_meta = None
        if RESULT_NAME in produced:
            rb = read_bounded(outputs / RESULT_NAME, limits.result_bytes, "result.json")
            try:
                receipt = json.loads(rb)
            except ValueError:
                raise ProducerError("outputs", "result.json is not valid JSON", evidence) from None
            if not isinstance(receipt, dict):
                raise ProducerError("outputs", "result.json is not an object", evidence)
            rc = receipt.get("return_code", 0)
            if rc != 0:
                raise ProducerError("outputs", f"result.json reports return_code {rc!r}", evidence)
            result_meta = {"file": RESULT_NAME, "sha256": sha256_bytes(rb), "bytes": len(rb)}
        # Seal: everything the run used must still have the identity recorded before launch.
        if bundle_identity(bundle, expected_version, expected_binary_sha256, limits) != ident:
            raise ProducerError("seal", "bundle identity changed during the run")
        if sha256_file(src) != sha256_bytes(data):
            raise ProducerError("seal", "scratch input changed during the run")
        for k, meta in presets.items():
            if sha256_file(preset_paths[k]) != meta["flattenedSha256"]:
                raise ProducerError("seal", f"flattened {k} preset changed during the run")
            for srcmeta in meta["sources"]:
                if sha256_file(Path(bundle) / srcmeta["path"]) != srcmeta["sha256"]:
                    raise ProducerError("seal", f"bundled preset source changed during the run: {srcmeta['path']}")
        if sha256_file(profile) != profile_sha:
            raise ProducerError("seal", "sandbox profile changed during the run")

        gcode, settings = (outputs / GCODE_NAME).read_bytes(), (outputs / SETTINGS_NAME).read_bytes()
        manifest = {
            "schema": SCHEMA, "operatorOnly": True, "exitCode": 0,
            "slicer": ident,
            "input": {"fileName": model.name, "format": kind, "sha256": sha256_bytes(data), "bytes": len(data),
                      "expectedDigestChecked": expected_input_sha256 is not None},
            "presets": presets,
            "invocation": {"argv": [norm(a) for a in argv], "environmentKeys": sorted(env),
                           "sandboxProfileSha256": profile_sha,
                           "sandbox": sandbox.describe(), "timeoutSeconds": timeout,
                           "freshDatadir": True},
            "outputs": {"gcode": {"file": GCODE_NAME, "sha256": sha256_bytes(gcode), "bytes": len(gcode)},
                        "exportedSettings": {"file": SETTINGS_NAME, "sha256": sha256_bytes(settings),
                                             "bytes": len(settings),
                                             "note": "observed slicer export artifact, hashed as bytes only"},
                        "cliResult": result_meta},
            "logTruncated": log_truncated,
            "limits": dict(sorted(limits.__dict__.items())),
            "notClaimed": NOT_CLAIMED,
        }
        # Atomic publish: stage next to the destination, then a single rename.
        stage = Path(tempfile.mkdtemp(prefix=f".{out_dir.name}.staging-", dir=out_dir.parent))
        try:
            shutil.copyfile(outputs / GCODE_NAME, stage / GCODE_NAME)
            shutil.copyfile(outputs / SETTINGS_NAME, stage / SETTINGS_NAME)
            shutil.copyfile(log, stage / "slicer.log")
            if result_meta:
                shutil.copyfile(outputs / RESULT_NAME, stage / RESULT_NAME)
            (stage / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
            for name, meta in (("gcode", manifest["outputs"]["gcode"]),
                               ("exportedSettings", manifest["outputs"]["exportedSettings"])):
                if sha256_file(stage / meta["file"]) != meta["sha256"]:
                    raise ProducerError("publish", f"staged {name} hash mismatch")
            _rename_noreplace(stage, out_dir)  # never replaces a destination that appeared meanwhile
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
    ap.add_argument("--expected-version", default=EXPECTED_VERSION)
    ap.add_argument("--expected-binary-sha256")
    ap.add_argument("--timeout", type=int, default=TIMEOUT_S)
    ap.add_argument("--expected-input-sha256", help="reject unless the model bytes have this SHA-256")
    ap.add_argument("--expected-input-bytes", type=int, help="reject unless the model has this byte length")
    a = ap.parse_args(argv)
    try:
        m = produce(a.model, a.out, a.machine, a.process, a.filament, a.bundle,
                    a.expected_version, a.expected_binary_sha256, a.timeout,
                    expected_input_sha256=a.expected_input_sha256, expected_input_bytes=a.expected_input_bytes)
    except ProducerError as e:
        sys.stderr.write(json.dumps({"error": {"stage": e.stage, "message": e.message, "evidence": e.evidence}},
                                    indent=2, sort_keys=True) + "\n")
        return 2
    sys.stdout.write(json.dumps({"published": str(a.out), "gcodeSha256": m["outputs"]["gcode"]["sha256"]},
                                sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
