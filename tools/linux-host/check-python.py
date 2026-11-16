#!/usr/bin/env python3
"""Audit a Linux package's bundled Python against apps/mac/distribution.json's `linux` side (#856).

    check-python.py MANIFEST PYTHON_DIR

PYTHON_DIR is Payload/python, in a prepared payload or an unpacked .deb or AppImage. It fails unless:
- site-packages holds only the approved wheels, at their pinned versions, with their retained notices;
- the interpreter's own licence and every notice in python/licenses match the pinned hashes;
- nothing the `removed` list names (pip, Tcl/Tk, Berkeley DB, tests) is present;
- the interpreter, run with an empty environment and isolated from user site-packages, imports what the companion's
  converter imports (pxr, PIL) and the standard modules it relies on.
"""
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys
import tempfile


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    manifest = json.loads(Path(sys.argv[1]).read_text())
    root = Path(sys.argv[2]).absolute()
    linux = manifest['linux']
    components = {c['name']: c for c in manifest['components']}
    python = components[linux['python']['component']]
    packages = [(components[p['component']], p) for p in linux['pythonPackages']]
    version = '.'.join(python['version'].split('+')[0].split('.')[:2])
    site = root / f'lib/python{version}/site-packages'
    allowed = {'README.txt'} | {path for c, p in packages for path in c['pythonPaths'] + p['pythonPaths']}
    unexpected = sorted(p.name for p in site.iterdir() if p.name not in allowed)
    if unexpected:
        raise SystemExit('Unapproved bundled Python files: ' + ', '.join(unexpected))
    for component, _ in packages:
        dist = site / f"{component['pythonPackage'].replace('-', '_')}-{component['version']}.dist-info"
        if not dist.is_dir():
            raise SystemExit(f"Missing approved wheel: {component['pythonPackage']} {component['version']}")
        licences = [p for p in dist.rglob('LICENSE*') if p.is_file()]
        if not any(sha256(p) == component['notices'][0]['sha256'] for p in licences):
            raise SystemExit(f"Wheel licence differs from retained notice: {component['name']}")
    runtime = next(n for n in python['notices'] if n['path'] == python['runtimeNotice'])
    if sha256(root / f'lib/python{version}/LICENSE.txt') != runtime['sha256']:
        raise SystemExit('CPython licence differs from retained notice')
    omitted = set(linux['python'].get('omittedNotices', []))
    expected = {Path(n['path']).name: n['sha256'] for c in [python, *(c for c, _ in packages)]
                for n in c['notices'] if n['path'] not in omitted}
    actual = {p.name: sha256(p) for p in (root / 'licenses').iterdir()}
    if actual != expected:
        differing = sorted({name for name, _ in set(actual.items()) ^ set(expected.items())})
        raise SystemExit('python/licenses differs from the retained notices: ' + ', '.join(differing))
    links = sorted(str(p.relative_to(root)) for p in root.rglob('*') if p.is_symlink())
    if links:
        raise SystemExit('Links in the bundled Python: ' + ', '.join(links[:5]))
    present = sorted(str(p.relative_to(root)) for pattern in linux['python']['removed']['paths'] for p in root.glob(pattern))
    if present:
        raise SystemExit('Removed Python parts are present: ' + ', '.join(present))
    probe = ('import json, sys, ssl, sqlite3, lzma, bz2, zlib, ctypes, PIL, PIL.Image\n'
             'from pxr import Usd, UsdGeom, UsdShade, UsdUtils\n'
             'assert all(not p.startswith(sys.argv[1]) for p in sys.path), sys.path\n'
             'print(json.dumps({"python": sys.version.split()[0], "pillow": PIL.__version__, "usd": Usd.GetVersion()}))')
    with tempfile.TemporaryDirectory() as home:
        answered = subprocess.run([root / 'bin/python3', '-I', '-c', probe, home], env={'HOME': home, 'PATH': '/usr/bin:/bin'},
                                  check=True, capture_output=True, text=True).stdout.strip()
    print('Bundled Python (' + platform.machine() + '): ' + answered)
    return 0


if __name__ == '__main__':
    sys.exit(main())
