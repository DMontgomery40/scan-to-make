# SPDX-License-Identifier: MIT
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

supervisor = Path(sys.argv.pop(1)).resolve()
worker = Path(__file__).with_name('cleanup-worker.py')
command = [sys.executable, '-I', str(supervisor)]
if '--without-children' in sys.argv:
    sys.argv.remove('--without-children')
    command = [sys.executable, '-I', str(Path(__file__).with_name('cleanup-no-children.py')), str(supervisor)]
class SupervisorTests(unittest.TestCase):
    def cleanup_workers(self, root):
        if (root/'ready.json').exists():
            for pid in json.loads((root/'ready.json').read_text()).values():
                try: os.kill(pid, signal.SIGKILL)
                except ProcessLookupError: pass

    def ready(self, root):
        for _ in range(200):
            if (root/'ready.json').exists():
                try: return json.loads((root/'ready.json').read_text())
                except json.JSONDecodeError: pass
            time.sleep(.01)
        self.fail('worker never started')

    def test_successful_command_finishes(self):
        subprocess.run([*command, '-c', 'pass'], check=True, timeout=5)

    def test_cancel_reaps_worker_in_new_session(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            proc = subprocess.Popen([*command, str(worker), str(root)], start_new_session=True)
            try:
                self.ready(root); proc.terminate(); proc.wait(timeout=5)
                time.sleep(1.1)
                self.assertFalse((root/'survived').exists())
            finally:
                if proc.poll() is None: proc.kill(); proc.wait()
                self.cleanup_workers(root)

    def test_parent_death_also_reaps_detached_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            code = 'import subprocess,time; subprocess.Popen('+repr([*command, str(worker), str(root)])+',start_new_session=True);time.sleep(60)'
            parent = subprocess.Popen([sys.executable, '-c', code])
            try:
                self.ready(root); parent.kill(); parent.wait(timeout=2)
                time.sleep(1.2)
                self.assertFalse((root/'survived').exists())
            finally:
                if parent.poll() is None: parent.kill(); parent.wait()
                self.cleanup_workers(root)

unittest.main()
