#!/usr/bin/env python3
"""Tests use a fake BambuStudio bundle and a fake sandbox-exec; no real slicer runs here."""
import json
import os
import plistlib
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import producer  # noqa: E402
from producer import ProducerError, produce, resolve_preset, sha256_file  # noqa: E402

REAL_RESULT = Path(__file__).resolve().parent / "fixtures" / "bambustudio-02.08.02.61-result.json"

FAKE_SLICER = r'''#!{py}
import json, os, sys, time
MODE = {mode!r}
PIDFILE = {pidfile!r}
a = sys.argv[1:]
open(PIDFILE, "w").write(str(os.getpid()))
def opt(k): return a[a.index(k) + 1]
out, settings = opt("--outputdir"), opt("--export-settings")
assert "--export-3mf" not in a
if MODE == "nonzero":
    print("slicer: fatal"); sys.exit(3)
if MODE == "sleep":
    time.sleep(30)
if MODE == "close-ignore-term":
    import signal
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    os.close(1); os.close(2)
    time.sleep(30)
inputs = os.path.join(os.path.dirname(out), "inputs")
if MODE == "mutate-preset":
    p = os.path.join(inputs, "process.json"); os.chmod(p, 0o644); open(p, "a").write(" ")
if MODE == "mutate-model":
    p = os.path.join(inputs, "model.stl"); os.chmod(p, 0o644); open(p, "ab").write(b"x")
if MODE == "mutate-bundle":
    here = os.path.dirname(os.path.abspath(__file__))
    open(os.path.join(here, "..", "Resources", "profiles", "BBL", "process", "0.20mm.json"), "a").write(" ")
if MODE == "big-output":
    open(os.path.join(out, "plate_1.gcode"), "w").write("G1\n" * 2000); sys.exit(0)
if MODE != "missing-gcode":
    with open(os.path.join(out, "plate_1.gcode"), "w") as f:
        f.write("; HEADER_BLOCK_START\n; env=" + ",".join(sorted(os.environ)) + "\nG28\n")
if MODE != "missing-settings":
    with open(settings, "w") as f:
        f.write("not json" if MODE == "bad-settings" else json.dumps({{"printer_model": "fake", "argv": a}}))
if MODE == "result-fixture":
    import shutil
    shutil.copyfile({fixture!r}, os.path.join(out, "result.json"))
if MODE in ("result-json", "result-bad"):
    with open(os.path.join(out, "result.json"), "w") as f:
        json.dump({{"return_code": 0 if MODE == "result-json" else 1, "error_string": ""}}, f)
if MODE == "extra-3mf":
    open(os.path.join(out, "plate_1.3mf"), "w").write("x")
print("slicer: ok")
'''

FAKE_SANDBOX = r'''#!{py}
import os, sys
assert sys.argv[1] == "-f"
prof = open(sys.argv[2]).read()
for rule in ("(deny network*)", "(deny mach-lookup)"):
    if rule not in prof:
        sys.exit(97)
open(os.path.join(os.path.dirname(sys.argv[2]), "sandbox-used"), "w").write("1")
os.execv(sys.argv[3], sys.argv[3:])
'''


def write_exe(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.replace("{py}", sys.executable) if "{py}" in text else text)
    path.chmod(0o755)


def make_bundle(root, mode="ok", version="02.08.02.61", pidfile=None):
    b = root / "BambuStudio.app"
    c = b / "Contents"
    (c / "MacOS").mkdir(parents=True, exist_ok=True)
    (c / "Info.plist").write_bytes(plistlib.dumps({"CFBundleShortVersionString": version, "CFBundleVersion": version}))
    write_exe(c / "MacOS" / "BambuStudio", FAKE_SLICER.format(py=sys.executable, mode=mode, fixture=str(REAL_RESULT),
                                                                    pidfile=str(pidfile or root / "pid")))
    prof = c / "Resources" / "profiles"
    (prof / "BBL" / "machine").mkdir(parents=True, exist_ok=True)
    (prof / "BBL" / "process").mkdir(parents=True, exist_ok=True)
    (prof / "BBL" / "filament").mkdir(parents=True, exist_ok=True)
    (prof / "BBL.json").write_text('{"name": "BBL"}')
    (prof / "BBL" / "cli_config.json").write_text('{"machine_limits": {}}')
    j = lambda p, d: p.write_text(json.dumps(d))  # noqa: E731
    j(prof / "BBL/machine/fdm_machine_common.json", {"a": 1, "b": 1, "printer_technology": "FFF"})
    j(prof / "BBL/machine/start_gcode.json", {"machine_start_gcode": "G28"})
    j(prof / "BBL/machine/A1 0.4.json", {"inherits": "fdm_machine_common", "include": ["start_gcode"], "b": 2})
    j(prof / "BBL/process/0.20mm.json", {"layer_height": "0.2"})
    j(prof / "BBL/filament/PLA.json", {"filament_type": ["PLA"]})
    return b


def stl_binary(normal=(0.0, 0.0, 1.0)):
    tri = struct.pack("<12fH", *normal, 0, 0, 0, 10, 0, 0, 0, 10, 0, 0)
    return b"\0" * 80 + struct.pack("<I", 1) + tri


class FakeSandbox:
    """Test-only double for PlatformSandbox (wraps the fake sandbox-exec script)."""
    def __init__(self, path):
        self.path = path

    def describe(self):
        return {"kind": "test-double", "path": "<fake>"}

    def check(self):
        if not Path(self.path).is_file():
            raise ProducerError("sandbox", "network sandbox unavailable: fake missing")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.sandbox = self.root / "bin" / "sandbox-exec"
        write_exe(self.sandbox, FAKE_SANDBOX)
        self.model = self.root / "part.stl"
        self.model.write_bytes(stl_binary())
        self.out = self.root / "published"

    def tearDown(self):
        self.tmp.cleanup()

    def run_produce(self, mode="ok", **kw):
        bundle = kw.pop("bundle", None) or make_bundle(self.root / mode, mode)
        args = dict(machine="A1 0.4", process="0.20mm", filament="PLA", bundle=bundle,
                    _sandbox=FakeSandbox(self.sandbox), scratch_parent=self.root, timeout=5)
        args.update(kw)
        return produce(self.model, self.out, **args)

    def assertNothingPublished(self):
        self.assertFalse(self.out.exists())
        self.assertEqual([p.name for p in self.root.iterdir() if p.name.startswith((".published", "slicer-producer-"))], [])


class SuccessTests(Base):
    def test_publishes_with_bound_digests(self):
        m = self.run_produce()
        self.assertEqual(sorted(p.name for p in self.out.iterdir()),
                         ["exported-settings.json", "manifest.json", "plate_1.gcode", "slicer.log"])
        on_disk = json.loads((self.out / "manifest.json").read_text())
        self.assertEqual(on_disk, m)
        self.assertEqual(m["outputs"]["gcode"]["sha256"], sha256_file(self.out / "plate_1.gcode"))
        self.assertEqual(m["outputs"]["exportedSettings"]["sha256"], sha256_file(self.out / "exported-settings.json"))
        self.assertEqual(m["input"]["sha256"], sha256_file(self.model))
        bundle = self.root / "ok" / "BambuStudio.app"
        self.assertEqual(m["slicer"]["binary"]["sha256"], sha256_file(bundle / "Contents/MacOS/BambuStudio"))
        self.assertEqual(m["slicer"]["version"], "02.08.02.61")
        self.assertEqual([r["path"] for r in m["slicer"]["boundResources"]],
                         ["Contents/Resources/profiles/BBL.json", "Contents/Resources/profiles/BBL/cli_config.json"])
        srcs = [s["path"] for s in m["presets"]["machine"]["sources"]]
        self.assertEqual(len(srcs), 3)
        for s in m["presets"]["machine"]["sources"]:
            self.assertEqual(s["sha256"], sha256_file(bundle / s["path"]))

    def test_no_settings_digest_claim_and_no_abs_scratch(self):
        m = self.run_produce()
        text = (self.out / "manifest.json").read_text()
        self.assertNotIn("slicerSettingsSha256", text)
        self.assertNotIn("slicer-producer-", text)  # scratch paths normalized
        self.assertIn("<scratch>", " ".join(m["invocation"]["argv"]))

    def test_sandbox_used_env_sanitized_and_argv_shape(self):
        m = self.run_produce()
        argv = m["invocation"]["argv"]
        self.assertEqual(argv[:2], [str(self.sandbox), "-f"])
        self.assertEqual(m["invocation"]["sandbox"]["kind"], "test-double")
        for flag in ("--datadir", "--load-settings", "--load-filaments", "--export-settings", "--outputdir"):
            self.assertIn(flag, argv)
        self.assertNotIn("--export-3mf", argv)
        env_line = (self.out / "plate_1.gcode").read_text().splitlines()[1]
        env = set(env_line.split("=", 1)[1].split(",")) - {"PWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING", "LC_CTYPE"}
        self.assertEqual(env, {"HOME", "LANG", "PATH", "TMPDIR"})
        self.assertEqual(m["invocation"]["environmentKeys"], ["HOME", "LANG", "PATH", "TMPDIR"])

    def test_flattening_order_and_content(self):
        flat, sources = resolve_preset(make_bundle(self.root / "f"), "machine", "A1 0.4")
        self.assertEqual(flat, {"a": 1, "b": 2, "printer_technology": "FFF", "machine_start_gcode": "G28",
                                "name": "A1 0.4"})
        self.assertNotIn("inherits", flat)

    def test_profile_denies_network(self):
        prof = producer.sandbox_profile(self.root)
        for rule in ("(deny network*)", "(deny mach-lookup)", "(deny signal)", "(deny file-write* (require-not"):
            self.assertIn(rule, prof)

    def test_ascii_stl_accepted(self):
        self.model.write_text("solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\n"
                              "vertex 0 1 0\nendloop\nendfacet\nendsolid x\n")
        self.assertEqual(self.run_produce()["input"]["format"], "ascii-stl")


class FailClosedTests(Base):
    def assertFails(self, stage, msg, mode="ok", **kw):
        with self.assertRaises(ProducerError) as cm:
            self.run_produce(mode, **kw)
        self.assertEqual(cm.exception.stage, stage, str(cm.exception))
        self.assertIn(msg, cm.exception.message)
        self.assertNothingPublished()
        return cm.exception

    def test_nonzero_exit(self):
        e = self.assertFails("slicer", "exit code 3", "nonzero")
        self.assertIn("slicer: fatal", e.evidence["logTail"])

    def test_missing_gcode(self):
        self.assertFails("outputs", "expected ['exported-settings.json', 'plate_1.gcode']", "missing-gcode")

    def test_missing_settings_export(self):
        self.assertFails("outputs", "got ['plate_1.gcode']", "missing-settings")

    def test_invalid_settings_export(self):
        self.assertFails("outputs", "not valid JSON", "bad-settings")

    def test_unexpected_extra_output(self):
        self.assertFails("outputs", "plate_1.3mf", "extra-3mf")

    def test_timeout(self):
        self.assertFails("slicer", "timed out", "sleep", timeout=1)

    def test_network_sandbox_missing(self):
        self.assertFails("sandbox", "network sandbox unavailable",
                         _sandbox=FakeSandbox(self.root / "nope" / "sandbox-exec"))

    def test_preset_symlink_outside_bundle(self):
        b = make_bundle(self.root / "sym")
        evil = self.root / "evil.json"
        evil.write_text('{"layer_height": "9"}')
        (b / "Contents/Resources/profiles/BBL/process/evil.json").symlink_to(evil)
        self.assertFails("preset", "outside the bundle", bundle=b, process="evil")

    def test_preset_path_traversal_name(self):
        self.assertFails("preset", "invalid preset name", process="../machine/A1 0.4")

    def test_parent_outside_bundle_via_inherits(self):
        b = make_bundle(self.root / "inh")
        (b / "Contents/Resources/profiles/BBL/process/child.json").write_text('{"inherits": "../../../../x"}')
        self.assertFails("preset", "invalid preset name", bundle=b, process="child")

    def test_missing_preset_and_cycle(self):
        self.assertFails("preset", "not in bundle", filament="Nope")
        b = make_bundle(self.root / "cyc")
        p = b / "Contents/Resources/profiles/BBL/process"
        (p / "x.json").write_text('{"inherits": "y"}')
        (p / "y.json").write_text('{"inherits": "x"}')
        self.assertFails("preset", "inheritance cycle", bundle=b, process="x")

    def test_version_mismatch(self):
        b = make_bundle(self.root / "ver", version="02.09.00.00")
        self.assertFails("bundle", "!= expected", bundle=b)

    def test_binary_pin_mismatch(self):
        self.assertFails("bundle", "!= pinned", expected_binary_sha256="0" * 64)

    def test_missing_bound_resource(self):
        b = make_bundle(self.root / "res")
        (b / "Contents/Resources/profiles/BBL/cli_config.json").unlink()
        self.assertFails("bundle", "cli_config.json", bundle=b)

    def test_zero_normal_binary_stl_rejected(self):
        self.model.write_bytes(stl_binary((0.0, 0.0, 0.0)))
        self.assertFails("input", "not unit length")

    def test_not_an_stl(self):
        self.model.write_bytes(b"hello")
        self.assertFails("input", "not a valid")

    def test_existing_output_not_overwritten(self):
        self.out.mkdir()
        (self.out / "keep").write_text("x")
        with self.assertRaises(ProducerError) as cm:
            self.run_produce()
        self.assertEqual(cm.exception.stage, "publish")
        self.assertEqual([p.name for p in self.out.iterdir()], ["keep"])

    def test_cli_exit_2_with_json_error(self):
        b = make_bundle(self.root / "cli", "nonzero")
        r = subprocess.run([sys.executable, str(Path(producer.__file__)), str(self.model), "--out", str(self.out),
                            "--machine", "A1 0.4", "--process", "0.20mm", "--filament", "PLA", "--bundle", str(b),
                            "--timeout", "5"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        # Production CLI always uses the platform sandbox; on non-macOS it refuses before running.
        expect = "slicer" if sys.platform == "darwin" else "sandbox"
        self.assertEqual(json.loads(r.stderr)["error"]["stage"], expect)
        self.assertFalse(self.out.exists())


class ReviewFixTests(Base):
    """One focused regression per bounded-review finding."""

    def fails(self, stage, msg, mode="ok", **kw):
        with self.assertRaises(ProducerError) as cm:
            self.run_produce(mode, **kw)
        self.assertEqual(cm.exception.stage, stage, str(cm.exception))
        self.assertIn(msg, cm.exception.message)
        return cm.exception

    # 1. real CLI receipt
    def test_fix1_result_json_accepted_and_bound(self):
        m = self.run_produce("result-json")
        self.assertEqual(m["outputs"]["cliResult"]["sha256"], sha256_file(self.out / "result.json"))

    def test_fix1_real_bambustudio_result_json_fixture_accepted(self):
        # Unchanged result.json from an installed BambuStudio 02.08.02.61 sandboxed run.
        raw = REAL_RESULT.read_bytes()
        self.assertEqual(json.loads(raw)["return_code"], 0)
        m = self.run_produce("result-fixture")
        self.assertEqual((self.out / "result.json").read_bytes(), raw)
        self.assertEqual(m["outputs"]["cliResult"], {"file": "result.json", "sha256": sha256_file(REAL_RESULT),
                                                     "bytes": len(raw)})

    def test_fix1_result_json_nonzero_return_code_rejected(self):
        self.fails("outputs", "return_code 1", "result-bad")
        self.assertFalse(self.out.exists())

    # 2. no sandbox injection in production
    def test_fix2_cli_has_no_sandbox_override(self):
        r = subprocess.run([sys.executable, str(Path(producer.__file__)), str(self.model), "--out", str(self.out),
                            "--machine", "m", "--process", "p", "--filament", "f",
                            "--sandbox-exec", str(self.sandbox)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertIn("unrecognized arguments: --sandbox-exec", r.stderr)

    @unittest.skipIf(sys.platform == "darwin", "platform refusal is checked on non-macOS hosts")
    def test_fix2_default_sandbox_refuses_unsupported_platform(self):
        with self.assertRaises(ProducerError) as cm:
            produce(self.model, self.out, "A1 0.4", "0.20mm", "PLA", bundle=make_bundle(self.root / "p"))
        self.assertEqual(cm.exception.stage, "sandbox")
        self.assertIn("unsupported platform", cm.exception.message)
        self.assertFalse(self.out.exists())

    def test_fix2_platform_sandbox_is_fixed_trusted_path(self):
        self.assertEqual(producer.PlatformSandbox().path, "/usr/bin/sandbox-exec")

    # 3. deadline holds after pipe EOF; TERM then KILL
    def test_fix3_deadline_after_eof_with_term_ignored(self):
        import time
        pid = self.root / "close-ignore-term" / "pid"
        t0 = time.monotonic()
        self.fails("slicer", "timed out", "close-ignore-term", timeout=0.5)
        self.assertLess(time.monotonic() - t0, 0.5 + producer.TERM_GRACE_S + 2.5)
        with self.assertRaises(ProcessLookupError):
            os.kill(int(pid.read_text()), 0)
        self.assertFalse(self.out.exists())

    # 4. budgets
    def test_fix4_input_budget_before_read(self):
        self.fails("limits", "input model exceeds 10 bytes", limits=producer.Limits(input_bytes=10))

    def test_fix4_preset_file_count_depth_budgets(self):
        self.fails("limits", "machine preset", limits=producer.Limits(preset_file_bytes=10))
        self.fails("limits", "more than 2 files", limits=producer.Limits(preset_files=2))
        self.fails("limits", "deeper than 1", limits=producer.Limits(preset_depth=1))

    def test_fix4_output_budget_monitored(self):
        self.fails("limits", "outputs exceed", "big-output", limits=producer.Limits(output_bytes=1000))
        self.assertFalse(self.out.exists())

    def test_fix4_timeout_bounds(self):
        self.fails("limits", "timeout must be", timeout=0)
        self.fails("limits", "timeout must be", timeout=producer.MAX_TIMEOUT_S + 1)

    # 5. sealed identities
    def test_fix5_expected_input_digest_and_size(self):
        self.fails("input", "sha256 does not match", expected_input_sha256="0" * 64)
        self.fails("input", "expected 1", expected_input_bytes=1)
        m = self.run_produce(expected_input_sha256=sha256_file(self.model),
                             expected_input_bytes=self.model.stat().st_size)
        self.assertTrue(m["input"]["expectedDigestChecked"])

    def test_fix5_mutated_flattened_preset_rejected(self):
        self.fails("seal", "flattened process preset changed", "mutate-preset")
        self.assertFalse(self.out.exists())

    def test_fix5_mutated_scratch_model_rejected(self):
        self.fails("seal", "scratch input changed", "mutate-model")

    def test_fix5_mutated_bundle_preset_source_rejected(self):
        self.fails("seal", "bundled preset source changed", "mutate-bundle")

    # 6. exclusive publish
    def test_fix6_destination_created_during_publish_is_not_replaced(self):
        real = producer._rename_noreplace

        def racing(src, dst):
            os.mkdir(dst)  # attacker/concurrent run creates an empty destination first
            real(src, dst)

        producer._rename_noreplace = racing
        try:
            self.fails("publish", "exclusive publish failed")
        finally:
            producer._rename_noreplace = real
        self.assertEqual(list(self.out.iterdir()), [])  # untouched empty dir, nothing replaced
        self.assertEqual([p for p in self.root.iterdir() if p.name.startswith(".published")], [])

    def test_fix6_rename_noreplace_refuses_existing_empty_dir(self):
        a, b = self.root / "a", self.root / "b"
        a.mkdir()
        b.mkdir()
        ino = b.stat().st_ino
        with self.assertRaises(ProducerError):
            producer._rename_noreplace(a, b)
        self.assertEqual(b.stat().st_ino, ino)
        self.assertTrue(a.exists())


if __name__ == "__main__":
    unittest.main()
