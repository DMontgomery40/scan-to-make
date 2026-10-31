# SPDX-License-Identifier: GPL-3.0-or-later
import json
import os
import time
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ContractTests(unittest.TestCase):
    def test_cli_lists_only_bounded_tools(self):
        run = subprocess.run([sys.executable,str(ROOT/'correct.py'),'tools'],capture_output=True,text=True)
        self.assertEqual(run.returncode,0,run.stderr)
        names = {item['name'] for item in json.loads(run.stdout)}
        self.assertTrue({'measure','render','sample_texture','find_features','feature_frame',
                         'classify_regions','symmetrize','convex_hull','remesh','smooth',
                         'scale_to_reference','cut_feature','deviation'} <= names)
        self.assertFalse({'exec','python','bash'} & names)

    def test_network_sandbox_blocks_inet(self):
        with tempfile.TemporaryDirectory() as tmp:
            probe = Path(tmp)/'probe.py'
            probe.write_text("import socket\nfor family in (socket.AF_INET,socket.AF_INET6):\n    try:\n        s=socket.socket(family); s.settimeout(2); s.connect(('127.0.0.1' if family==socket.AF_INET else '::1',9))\n    except PermissionError: pass\n    else: raise AssertionError('network allowed')\n")
            run = subprocess.run([sys.executable,str(ROOT/'sandbox.py'),sys.executable,str(probe)],
                                 capture_output=True,text=True)
            self.assertEqual(run.returncode,0,run.stderr)

    def test_worker_timeout_kills_process_group(self):
        sys.path.insert(0,str(ROOT))
        from host import bounded_process
        with tempfile.TemporaryDirectory() as tmp:
            script=Path(tmp)/'slow.py'
            script.write_text('import time; time.sleep(10)')
            started=time.monotonic()
            with self.assertRaisesRegex(ValueError,'budget exceeded'):
                bounded_process([sys.executable,str(script)],.1,dict(os.environ),tmp)
            self.assertLess(time.monotonic()-started,2)


if __name__ == '__main__':
    unittest.main()
