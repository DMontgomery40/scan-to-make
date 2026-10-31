# SPDX-License-Identifier: GPL-3.0-or-later
"""Catch sandbox bypass, lost exec inheritance and missing runtime failures."""
import contextlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import sandbox


@contextlib.contextmanager
def listeners():
    with contextlib.ExitStack() as stack:
        targets = []
        for family, address in ((socket.AF_INET, '127.0.0.1'), (socket.AF_INET6, '::1')):
            tcp = stack.enter_context(socket.socket(family, socket.SOCK_STREAM))
            tcp.bind((address, 0))
            tcp.listen(8)
            udp = stack.enter_context(socket.socket(family, socket.SOCK_DGRAM))
            udp.bind((address, 0))
            targets.append({'family': family.name, 'address': address,
                            'tcp': tcp.getsockname()[1], 'udp': udp.getsockname()[1]})
        yield targets


class NetworkTests(unittest.TestCase):
    def test_network_sandbox_denies_tcp_udp_listen_and_descendants(self):
        with tempfile.TemporaryDirectory() as tmp, listeners() as targets:
            config = Path(tmp, 'targets.json')
            config.write_text(json.dumps(targets))
            args = [sys.executable, str(ROOT/'tests/network_probe.py'), str(config),
                    'allow', sys.executable, 'parent']
            control = subprocess.run(args, capture_output=True, text=True, timeout=30)
            self.assertEqual(control.returncode, 0, control.stdout+control.stderr)
            args[3] = 'deny'
            isolated = subprocess.run([sys.executable, '-I', str(ROOT/'sandbox.py'), *args],
                                      capture_output=True, text=True, timeout=30)
            self.assertEqual(isolated.returncode, 0, isolated.stdout+isolated.stderr)
            receipts = [json.loads(line) for line in isolated.stdout.splitlines()]
            self.assertEqual({entry['generation'] for entry in receipts}, {'parent', 'child'})
            self.assertTrue(all(len(entry['operations']) == 6 for entry in receipts))

    def test_missing_macos_sandbox_does_not_run_payload(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp, 'ran')
            # Simulate a Mac whose deprecated system executable was removed.
            # Keep exec real: an accidental unsandboxed fallback writes marker.
            script = "import sys; sys.path.insert(0,sys.argv[1]); import sandbox; sandbox.sys.platform='darwin'; sandbox.MACOS_SANDBOX='/nonexistent/sandbox-exec'; sandbox.main(sys.argv[2:])"
            result = subprocess.run([sys.executable, '-c', script, str(ROOT), sys.executable,
                                     '-c', 'from pathlib import Path; import sys; Path(sys.argv[1]).touch()', str(marker)],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(marker.exists())

    def test_unknown_platform_rejects_before_execution(self):
        with patch.object(sandbox.sys, 'platform', 'unsupported'):
            with self.assertRaisesRegex(RuntimeError, 'unsupported'):
                sandbox.main([sys.executable, '-c', 'raise AssertionError("ran")'])


@unittest.skipUnless(os.environ.get('BLENDER'), 'set BLENDER=Blender 5.0.1')
class BlenderNetworkTests(unittest.TestCase):
    def test_real_blender_and_child_have_no_network(self):
        with tempfile.TemporaryDirectory() as tmp, listeners() as targets:
            config = Path(tmp, 'targets.json')
            config.write_text(json.dumps(targets))
            run = subprocess.run([sys.executable, '-I', str(ROOT/'sandbox.py'), os.environ['BLENDER'],
                                  '--background', '--factory-startup', '--disable-autoexec',
                                  '--python-exit-code', '1', '--python', str(ROOT/'tests/network_probe.py'),
                                  '--', str(config), 'deny', sys.executable, 'parent'],
                                 capture_output=True, text=True, timeout=60)
            self.assertEqual(run.returncode, 0, run.stdout+run.stderr)
            self.assertIn('"generation": "child"', run.stdout)
            self.assertIn('"generation": "parent"', run.stdout)
