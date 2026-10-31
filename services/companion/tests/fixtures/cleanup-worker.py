# SPDX-License-Identifier: MIT
"""Synthetic trusted CLI that owns a detached worker for lifecycle tests."""
import json
from pathlib import Path
import subprocess
import sys
import time
root = Path(sys.argv[1]); root.mkdir(parents=True, exist_ok=True)
child = subprocess.Popen([sys.executable, '-c', 'import time;from pathlib import Path;time.sleep(1);Path('+repr(str(root/'survived'))+').write_text("orphan")'], start_new_session=True)
(root/'ready.json').write_text(json.dumps({'parent':__import__('os').getpid(),'worker':child.pid}))
try: time.sleep(60)
finally: child.wait()
