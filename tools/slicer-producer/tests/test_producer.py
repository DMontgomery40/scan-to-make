#!/usr/bin/env python3
"""Tests use a fake BambuStudio bundle and a fake sandbox-exec, plus a real BambuStudio run on macOS."""
import json
import os
import plistlib
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import producer  # noqa: E402
from producer import ProducerError, produce, resolve_preset, sha256_file  # noqa: E402

REAL_RESULT = Path(__file__).resolve().parent / "fixtures" / "bambustudio-02.08.02.61-result.json"

FAKE_SLICER = r'''#!{py}
import json, os, sys, time, zipfile
MODE = {mode!r}
PIDFILE = {pidfile!r}
a = sys.argv[1:]
open(PIDFILE, "w").write(str(os.getpid()))
def opt(k): return a[a.index(k) + 1]
out, settings, three_mf = opt("--outputdir"), opt("--export-settings"), opt("--export-3mf")
assert three_mf.endswith(".3mf") and not three_mf.lower().endswith(".gcode.3mf")
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
gcode_text = "; HEADER_BLOCK_START\n; env=" + ",".join(sorted(os.environ)) + "\nG28\n"
if MODE != "missing-gcode":
    with open(os.path.join(out, "plate_1.gcode"), "w") as f:
        f.write(gcode_text)
if MODE != "missing-3mf":
    tmf_path = os.path.join(out, three_mf)
    if MODE == "corrupt-3mf":
        open(tmf_path, "wb").write(b"not-a-zip")
    else:
        with zipfile.ZipFile(tmf_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("[Content_Types].xml", "<Types/>")
            if MODE != "missing-3d-model":
                zf.writestr("3D/3dmodel.model", "<model unit='millimeter'/>")
            if MODE != "unsliced-3mf":
                zf.writestr("Metadata/plate_1.gcode", "G28 ; tampered\n" if MODE == "tampered-plate-gcode" else gcode_text)
                zf.writestr("Metadata/plate_1.json", "not-json" if MODE == "bad-plate-json" else '{{"plate_index": 1}}')
                zf.writestr("Metadata/slice_info.config", "<config><plate/></config>")
            if MODE == "unsafe-3mf-member":
                zf.writestr("../escape.txt", "nope")
if MODE != "missing-settings":
    if MODE == "echo-presets":
        mp, pp = opt("--load-settings").split(";")
        merged = dict(json.load(open(mp)))
        merged.update(json.load(open(pp)))
        with open(settings, "w") as f:
            json.dump(merged, f)
    else:
        with open(settings, "w") as f:
            f.write("not json" if MODE == "bad-settings" else json.dumps({{"printer_model": "fake", "argv": a}}))
if MODE == "result-fixture":
    import shutil
    shutil.copyfile({fixture!r}, os.path.join(out, "result.json"))
if MODE in ("result-json", "result-bad"):
    with open(os.path.join(out, "result.json"), "w") as f:
        json.dump({{"return_code": 0 if MODE == "result-json" else 1, "error_string": ""}}, f)
if MODE == "extra-3mf":
    open(os.path.join(out, "plate_1.gcode.3mf"), "w").write("x")
print("slicer: ok")
'''

FAKE_SANDBOX = r'''#!{py}
import os, re, sys
assert sys.argv[1] == "-f"
prof = open(sys.argv[2]).read()
for rule in ("(deny network*)", "(deny mach-lookup)", "(deny signal)"):
    if rule not in prof:
        sys.exit(97)
if re.search(r"\(\s*allow\s+mach-lookup\s*\)", prof):
    sys.exit(98)
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
    def test_publishes_with_bound_digests_and_sliced_3mf(self):
        m = self.run_produce()
        self.assertEqual(sorted(p.name for p in self.out.iterdir()),
                         ["exported-settings.json", "manifest.json", "plate_1.gcode", "sliced-plate.3mf", "slicer.log"])
        on_disk = json.loads((self.out / "manifest.json").read_text())
        self.assertEqual(on_disk, m)
        self.assertEqual(m["outputs"]["gcode"]["sha256"], sha256_file(self.out / "plate_1.gcode"))
        self.assertEqual(m["outputs"]["threeMf"]["file"], "sliced-plate.3mf")
        self.assertFalse(m["outputs"]["threeMf"]["file"].endswith(".gcode.3mf"))
        self.assertEqual(m["outputs"]["threeMf"]["mediaType"], "model/3mf")
        self.assertEqual(m["outputs"]["threeMf"]["sha256"], sha256_file(self.out / "sliced-plate.3mf"))
        self.assertEqual(m["outputs"]["threeMf"]["plateGcodeInternalPath"], "Metadata/plate_1.gcode")
        self.assertEqual(m["outputs"]["threeMf"]["plateGcodeSha256"], m["outputs"]["gcode"]["sha256"])
        with zipfile.ZipFile(self.out / "sliced-plate.3mf") as zf:
            self.assertEqual(zf.read("Metadata/plate_1.gcode"), (self.out / "plate_1.gcode").read_bytes())
            self.assertIn("Metadata/plate_1.json", zf.namelist())
            self.assertIn("Metadata/slice_info.config", zf.namelist())
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
        for flag in ("--datadir", "--load-settings", "--load-filaments", "--export-settings", "--export-3mf", "--outputdir"):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("--export-3mf") + 1], "sliced-plate.3mf")
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
        self.assertFails("outputs", "expected ['exported-settings.json', 'plate_1.gcode', 'sliced-plate.3mf']", "missing-gcode")

    def test_missing_settings_export(self):
        self.assertFails("outputs", "got ['plate_1.gcode', 'sliced-plate.3mf']", "missing-settings")

    def test_invalid_settings_export(self):
        self.assertFails("outputs", "not valid JSON", "bad-settings")

    def test_unexpected_extra_output(self):
        self.assertFails("outputs", "plate_1.gcode.3mf", "extra-3mf")

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

    # 7. explicit preset overrides and G-code header summary
    def test_fix7_overrides_written_sealed_and_recorded(self):
        m = self.run_produce("echo-presets", bed_type="textured_plate", nozzle_type="hardened_steel",
                             enable_support=True)
        self.assertEqual(m["overrides"], {
            "bedType": "textured_plate",
            "bedTypeLabel": "Textured PEI Plate",
            "nozzleType": "hardened_steel",
            "enableSupport": True,
        })
        exported = json.loads((self.out / "exported-settings.json").read_text())
        self.assertEqual(exported["curr_bed_type"], "Textured PEI Plate")
        self.assertEqual(exported["nozzle_type"], ["hardened_steel"])
        self.assertEqual(exported["enable_support"], "1")

    def test_fix7_invalid_overrides_rejected(self):
        self.fails("preset", "unsupported bed_type", bed_type="supertack_plate")
        self.fails("preset", "unsupported nozzle_type", nozzle_type="diamond")
        self.fails("preset", "enable_support", enable_support="yes")

    def test_fix7_gcode_summary_parses_bambustudio_header(self):
        sample = (
            "; HEADER_BLOCK_START\n"
            "; BambuStudio 02.08.02.61\n"
            "; model printing time: 1h 2m 3s; total estimated time: 1h 8m 15s\n"
            "; total layer number: 102\n"
            "; total filament length [mm] : 1237.75\n"
            "; total filament volume [cm^3] : 2977.14\n"
            "; total filament weight [g] : 3.75\n"
            "; filament_density: 1.26\n"
            "; filament_diameter: 1.75\n"
            "; max_z_height: 20.40\n"
            "; HEADER_BLOCK_END\n"
            "; CONFIG_BLOCK_START\n"
            "; curr_bed_type = Textured PEI Plate\n"
            "; nozzle_type = hardened_steel,hardened_steel\n"
            "; enable_support = 0\n"
            "; CONFIG_BLOCK_END\n"
            "G28\n"
        ).encode()
        s = producer.parse_gcode_summary(sample)
        self.assertEqual(s["modelPrintTime"], "1h 2m 3s")
        self.assertEqual(s["modelPrintSeconds"], 3723)
        self.assertEqual(s["estimatedPrintTime"], "1h 8m 15s")
        self.assertEqual(s["estimatedPrintSeconds"], 4095)
        self.assertEqual(s["layerCount"], 102)
        self.assertEqual(s["filamentLengthMm"], 1237.75)
        self.assertEqual(s["filamentWeightG"], 3.75)
        self.assertAlmostEqual(s["filamentVolumeCm3"], 2.97714, places=5)
        self.assertEqual(s["bedType"], "Textured PEI Plate")
        self.assertEqual(s["nozzleType"], "hardened_steel,hardened_steel")
        self.assertIs(s["enableSupport"], False)


def watertight_box_stl(size=12.0):
    v = [
        (0.0, 0.0, 0.0), (size, 0.0, 0.0), (size, size, 0.0), (0.0, size, 0.0),
        (0.0, 0.0, size), (size, 0.0, size), (size, size, size), (0.0, size, size),
    ]
    faces = [
        ((0.0, 0.0, -1.0), 0, 2, 1), ((0.0, 0.0, -1.0), 0, 3, 2),
        ((0.0, 0.0, 1.0), 4, 5, 6), ((0.0, 0.0, 1.0), 4, 6, 7),
        ((0.0, -1.0, 0.0), 0, 1, 5), ((0.0, -1.0, 0.0), 0, 5, 4),
        ((0.0, 1.0, 0.0), 3, 6, 2), ((0.0, 1.0, 0.0), 3, 7, 6),
        ((-1.0, 0.0, 0.0), 0, 4, 7), ((-1.0, 0.0, 0.0), 0, 7, 3),
        ((1.0, 0.0, 0.0), 1, 2, 6), ((1.0, 0.0, 0.0), 1, 6, 5),
    ]
    return b"\0" * 80 + struct.pack("<I", len(faces)) + b"".join(
        struct.pack("<12fH", *n, *v[a], *v[b], *v[c], 0) for n, a, b, c in faces
    )


class ThreeMfVerificationTests(Base):
    """KAN-101: sliced `.3mf` project export, `.gcode.3mf` refusal, and plate-holding verification."""

    def assertFails(self, stage, msg, mode="ok", **kw):
        with self.assertRaises(ProducerError) as cm:
            self.run_produce(mode, **kw)
        self.assertEqual(cm.exception.stage, stage, str(cm.exception))
        self.assertIn(msg, cm.exception.message)
        self.assertNothingPublished()

    def test_custom_valid_three_mf_name_published_and_sealed(self):
        m = self.run_produce(three_mf_name="part-project.3mf")
        self.assertTrue((self.out / "part-project.3mf").is_file())
        self.assertEqual(m["outputs"]["threeMf"]["file"], "part-project.3mf")
        self.assertEqual(m["outputs"]["threeMf"]["sha256"], sha256_file(self.out / "part-project.3mf"))

    def test_gcode_3mf_and_unsafe_names_rejected_before_slicing(self):
        for bad in ("plate_1.gcode.3mf", "Stand.GCODE.3MF", "a.gcode.3mf"):
            with self.subTest(bad=bad):
                self.assertFails("input", ".gcode.3mf", three_mf_name=bad)
        for bad in ("", "part.zip", "part.3MF", ".hidden.3mf", "../escape.3mf", "sub/part.3mf", "manifest.json"):
            with self.subTest(bad=bad):
                self.assertFails("input", "3MF output name", three_mf_name=bad)

    def test_missing_corrupt_unsliced_or_tampered_3mf_rejected(self):
        self.assertFails("outputs", "sliced-plate.3mf", "missing-3mf")
        self.assertFails("outputs", "not a valid ZIP archive", "corrupt-3mf")
        self.assertFails("outputs", "missing sliced-plate entries", "unsliced-3mf")
        self.assertFails("outputs", "3D/*.model", "missing-3d-model")
        self.assertFails("outputs", "Metadata/plate_1.json is not valid JSON", "bad-plate-json")
        self.assertFails("outputs", "Metadata/plate_1.gcode sha256", "tampered-plate-gcode")
        self.assertFails("outputs", "unsafe member path", "unsafe-3mf-member")

    @unittest.skipUnless(
        sys.platform == "darwin" and Path("/Applications/BambuStudio.app/Contents/MacOS/BambuStudio").is_file(),
        "Real sandboxed BambuStudio 3MF export runs on macOS hosts with /Applications/BambuStudio.app installed",
    )
    def test_real_bambustudio_exports_sliced_3mf_holding_plate(self):
        box = self.root / "synthetic-box.stl"
        box.write_bytes(watertight_box_stl(16.0))
        out = self.root / "real-3mf-out"
        m = produce(
            box,
            out,
            machine="Bambu Lab P1S 0.4 nozzle",
            process="0.20mm Standard @BBL X1C",
            filament="Bambu PLA Basic @BBL P1S 0.4 nozzle",
            bed_type="textured_plate",
            nozzle_type="hardened_steel",
            enable_support=False,
            expected_input_sha256=sha256_file(box),
            expected_input_bytes=box.stat().st_size,
            timeout=60,
        )
        tmf = out / "sliced-plate.3mf"
        gcode_path = out / "plate_1.gcode"
        self.assertTrue(tmf.is_file() and not tmf.name.endswith(".gcode.3mf"))
        self.assertEqual(m["outputs"]["threeMf"]["sha256"], sha256_file(tmf))
        self.assertEqual(m["outputs"]["threeMf"]["plateGcodeSha256"], sha256_file(gcode_path))
        with zipfile.ZipFile(tmf) as zf:
            names = set(zf.namelist())
            self.assertIn("Metadata/plate_1.gcode", names)
            self.assertIn("Metadata/plate_1.json", names)
            self.assertIn("Metadata/slice_info.config", names)
            embedded_gcode = zf.read("Metadata/plate_1.gcode")
            self.assertEqual(embedded_gcode, gcode_path.read_bytes())
            self.assertIn(b"M620", embedded_gcode)


if __name__ == "__main__":
    unittest.main()
