# SPDX-License-Identifier: GPL-3.0-or-later
"""Real socket operations, usable from Python or Blender (no external traffic)."""
import errno
import json
from pathlib import Path
import socket
import subprocess
import sys


def probe(targets, denied):
    observed = []
    for target in targets:
        family = getattr(socket, target['family'])
        address = target['address']
        for operation in ('tcp', 'udp', 'listen'):
            sock = None
            try:
                kind = socket.SOCK_DGRAM if operation == 'udp' else socket.SOCK_STREAM
                sock = socket.socket(family, kind)
                sock.settimeout(2)
                if operation == 'tcp':
                    sock.connect((address, target['tcp']))
                elif operation == 'udp':
                    sock.sendto(b'synthetic-isolation-probe', (address, target['udp']))
                else:
                    sock.bind((address, 0))
                    sock.listen(1)
            except OSError as exc:
                # A closed listener, missing route or timeout is NOT isolation.
                assert denied and exc.errno in (errno.EPERM, errno.EACCES), (operation, exc)
            else:
                assert not denied, f'{operation} allowed for {address}'
            finally:
                if sock is not None:
                    sock.close()
            observed.append(f"{target['family']}:{operation}")
    return observed


if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else sys.argv[1:]
    config, mode, python, generation = args
    targets = json.loads(Path(config).read_text())
    observed = probe(targets, mode == 'deny')
    if generation == 'parent':
        # A fresh executable must inherit the same restriction.
        subprocess.run([python, __file__, config, mode, python, 'child'], check=True, timeout=15)
    print(json.dumps({'generation': generation, 'mode': mode, 'operations': observed}))
