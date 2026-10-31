# SPDX-License-Identifier: MIT
"""Exercise a kernel without the optional proc children interface."""
from pathlib import Path
import runpy
import sys

read_text = Path.read_text
def without_children(path, *args, **kwargs):
    if str(path).startswith('/proc/') and path.name == 'children':
        raise FileNotFoundError(str(path))
    return read_text(path, *args, **kwargs)
Path.read_text = without_children
runpy.run_path(sys.argv.pop(1), run_name='__main__')
