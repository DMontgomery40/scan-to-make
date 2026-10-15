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

FAKE_SLICER = r'''#!{py}
import json, os, sys, time
MODE = {mode!r}
a = sys.argv[1:]
def opt(k): return a[a.index(k) + 1]
out, settings = opt("--outputdir"), opt("--export-settings")
assert "--export-3mf" not in a
if MODE == "nonzero":
    print("slicer: fatal"); sys.exit(3)
if MODE == "sleep":
    time.sleep(30)
if MODE != "missing-gcode":
    with open(os.path.join(out, "plate_1.gcode"), "w") as f:
        f.write("; HEADER_BLOCK_START\n; env=" + ",".join(sorted(os.environ)) + "\nG28\n")
if MODE != "missing-settings":
    with open(settings, "w") as f:
        f.write("not json" if MODE == "bad-settings" else json.dumps({{"printer_model": "fake", "argv": a}}))
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


def make_bundle(root, mode="ok", version="02.08.02.61"):
    b = root / "BambuStudio.app"
    c = b / "Contents"
    (c / "MacOS").mkdir(parents=True, exist_ok=True)
    (c / "Info.plist").write_bytes(plistlib.dumps({"CFBundleShortVersionString": version, "CFBundleVersion": version}))
    write_exe(c / "MacOS" / "BambuStudio", FAKE_SLICER.format(py=sys.executable, mode=mode))
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
                    sandbox_exec=self.sandbox, scratch_parent=self.root, timeout=5)
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
        self.assertFails("outputs", "expected exactly", "missing-gcode")

    def test_missing_settings_export(self):
        self.assertFails("outputs", "expected exactly", "missing-settings")

    def test_invalid_settings_export(self):
        self.assertFails("outputs", "not valid JSON", "bad-settings")

    def test_unexpected_extra_output(self):
        self.assertFails("outputs", "plate_1.3mf", "extra-3mf")

    def test_timeout(self):
        self.assertFails("slicer", "timed out", "sleep", timeout=1)

    def test_network_sandbox_missing(self):
        self.assertFails("sandbox", "network sandbox unavailable", sandbox_exec=self.root / "nope" / "sandbox-exec")

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
                            "--sandbox-exec", str(self.sandbox), "--timeout", "5"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertEqual(json.loads(r.stderr)["error"]["stage"], "slicer")
        self.assertFalse(self.out.exists())


if __name__ == "__main__":
    unittest.main()
