#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Supervise a trusted scan CLI, including workers that create new sessions."""
import ctypes
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

stopping = False
def stop(_signal, _frame):
    global stopping
    stopping = True

def children_of(pid):
    if sys.platform == 'linux':
        try:
            return [int(p) for p in Path(f'/proc/{pid}/task/{pid}/children').read_text().split()]
        except FileNotFoundError:
            # Some kernels omit CONFIG_CHECKPOINT_RESTORE's children interface.
            # /proc/<pid>/stat still supplies PPID, including for detached workers.
            children = []
            for entry in Path('/proc').iterdir():
                if not entry.name.isdecimal():
                    continue
                try:
                    text = (entry/'stat').read_text(encoding='utf-8', errors='replace')
                except (FileNotFoundError, ProcessLookupError, PermissionError):
                    continue  # exited processes or other users hidden by procfs
                # comm is parenthesized and may itself contain spaces or ')'.
                fields = text[text.rindex(')')+1:].split()
                if int(fields[1]) == pid:
                    children.append(int(entry.name))
            return children
    # macOS has no /proc or subreaper. The trusted CLIs wait for their workers;
    # stop the CLI before walking so cancellation cannot orphan those workers.
    # libproc's PROC_PPID_ONLY returns bytes (xnu/libsyscall/wrappers/libproc/libproc.c).
    lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    lib.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
    lib.proc_listpids.restype = ctypes.c_int
    buffer = (ctypes.c_int * 4096)()
    size = lib.proc_listpids(6, pid, buffer, ctypes.sizeof(buffer))
    if size < 0 or size >= ctypes.sizeof(buffer):
        raise OSError(ctypes.get_errno(), 'cannot enumerate worker children')
    return [p for p in buffer[:size // ctypes.sizeof(ctypes.c_int)] if p > 0]

def freeze_tree(pid):
    # Freeze parents before walking children, so none can fork past the walk.
    try:
        os.kill(pid, signal.SIGSTOP)
        children = children_of(pid)
    except (ProcessLookupError, FileNotFoundError):
        return []
    result = []
    for child in children:
        result.extend(freeze_tree(child))
    return result + [pid]

def main():
    if sys.platform not in ('linux', 'darwin'):
        raise RuntimeError('Scan cleanup requires a supported POSIX worker host')
    parent = os.getppid()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    # A companion crash must also stop detached Blender/model HTTP descendants.
    if sys.platform == 'linux':
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), 'cannot install parent-death notification')
        # Subreaping keeps orphaned grandchildren in this supervisor's tree.
        if libc.prctl(36, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), 'cannot install child subreaper')
    if os.getppid() != parent or stopping:
        return 2
    child = subprocess.Popen([sys.executable, *sys.argv[1:]], close_fds=True)
    try:
        while child.poll() is None and not stopping and os.getppid() == parent:
            time.sleep(.03)
        return 2 if stopping or os.getppid() != parent else child.returncode
    finally:
        children = children_of(os.getpid())
        for root in children:
            for pid in freeze_tree(int(root)):
                try: os.kill(pid, signal.SIGKILL)
                except ProcessLookupError: pass
        child.wait()
        # Reap adopted workers too; they have all been signalled above.
        while True:
            try: os.waitpid(-1, 0)
            except ChildProcessError: break

if __name__ == '__main__':
    sys.exit(main())
