"""Synthetic subprocess fixture: no Blender, network or personal data."""
import os
from pathlib import Path
import subprocess
import sys
import time

mode = os.environ.get('SCAN_RUNNER_FIXTURE', 'wait')
if mode == 'logs':
    sys.stdout.write('x' * (2 * 1024 * 1024))
    sys.stdout.flush()
elif mode == 'disk':
    output = Path(sys.argv[sys.argv.index('--out') + 1])
    with (output / 'oversized').open('wb') as file:
        file.truncate(161 * 1024 * 1024)
else:
    marker = Path(sys.argv[sys.argv.index('--out') + 1]) / 'descendant-survived'
    subprocess.Popen([sys.executable, '-c', 'import time,pathlib,sys;time.sleep(.6);pathlib.Path(sys.argv[1]).write_text("alive")', str(marker)])
time.sleep(20)
