#!/usr/bin/env python3
"""Build the Linux packages' Python (#856) from apps/mac/distribution.json's `linux` side.

    prepare-python.py MANIFEST LICENSES OUT_PYTHON WORK

MANIFEST and LICENSES are distribution.json and apps/mac/Licenses from the committed snapshot being packaged.
OUT_PYTHON (absent or empty) becomes Payload/python: the pinned CPython standalone, checked against its SHA-256,
with the pinned Pillow and OpenUSD wheels installed from their checked files only (no index, no dependencies), then
pip, Tcl/Tk, Berkeley DB and tests removed, the notices copied into python/licenses, and bytecode compiled. The host
points SCAN_TO_MAKE_CAPTURE_PYTHON at its bin/python3 (tools/linux-host/src/paths.rs, bundled_python), so a scan
reaches the code engine with no `pip install`. check-python.py audits the result. Runs with the build machine's python3.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
from urllib.parse import unquote, urlparse


def run(*args, **kwargs):
    subprocess.run([str(a) for a in args], check=True, **kwargs)


def fetch(url, sha256, directory):
    target = directory / unquote(Path(urlparse(url).path).name)
    if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == sha256:
        return target
    run('curl', '--fail', '--location', '--retry', '3', '--retry-all-errors', '--silent', '--show-error', url, '-o', target)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    if digest != sha256:
        raise SystemExit(f'Checksum mismatch for {target.name}: {digest}')
    return target


def linux_side(manifest, arch):
    linux = manifest['linux']
    if arch in linux.get('unsupportedArchitectures', {}):
        raise SystemExit(f'No bundled Python for {arch}: ' + linux['unsupportedArchitectures'][arch])
    components = {c['name']: c for c in manifest['components']}
    python = dict(components[linux['python']['component']], **linux['python']['architectures'][arch])
    packages = [dict(components[p['component']], **p['architectures'][arch]) for p in linux['pythonPackages']]
    return linux, python, packages


def main():
    if len(sys.argv) != 5:
        raise SystemExit(__doc__)
    manifest_path, licences, out, work = (Path(a).absolute() for a in sys.argv[1:])
    manifest = json.loads(manifest_path.read_text())
    linux, python, packages = linux_side(manifest, platform.machine())
    if out.exists() and any(out.iterdir()):
        raise SystemExit(f'OUT_PYTHON must be absent or empty: {out}')
    out.mkdir(parents=True, exist_ok=True)
    downloads = work / 'python-downloads'
    downloads.mkdir(parents=True, exist_ok=True)
    archive = fetch(python['downloadUrl'], python['sha256'], downloads)
    run('tar', '-xzf', archive, '--strip-components=1', '-C', out)
    interpreter = out / 'bin/python3'
    clean = {'PATH': '/usr/bin:/bin', 'HOME': str(work), 'PYTHONNOUSERSITE': '1'}
    for package in packages:
        wheel = fetch(package['downloadUrl'], package['sha256'], downloads)
        run(interpreter, '-I', '-m', 'pip', 'install', '--no-deps', '--no-index', '--no-compile',
            '--disable-pip-version-check', '--no-warn-script-location', wheel, env=clean, stdout=subprocess.DEVNULL)
    # The interpreter itself, not a link to it (the host runs bin/python3); it is statically linked, so libpython goes.
    (out / 'bin/python3').unlink()
    (out / 'bin/python3.12').rename(out / 'bin/python3')
    for pattern in linux['python']['removed']['paths']:
        for path in out.glob(pattern):
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            else:
                path.unlink()
    # Copies, not links: Tauri's bundler drops directory links and materialize-resources.py turns executable file
    # links into shell launchers. None should be left after the removals; a new one is copied, never kept.
    for path in sorted(out.rglob('*')):
        if path.is_symlink():
            target = path.resolve(strict=True)
            if not target.is_relative_to(out.resolve()) or target.is_dir():
                raise SystemExit(f'Unexpected link in the Python tree: {path.relative_to(out)}')
            path.unlink()
            shutil.copy2(target, path)
    notices = out / 'licenses'
    notices.mkdir()
    omitted = set(linux['python'].get('omittedNotices', []))
    for component in [python, *packages]:
        for notice in component['notices']:
            if notice['path'] in omitted:
                continue
            source = licences / Path(notice['path']).relative_to('Licenses')
            shutil.copy2(source, notices / Path(notice['path']).name)
    # Bytecode beside the sources, valid without timestamps: the package is read-only once installed. Plain level
    # only: the companion never runs Python with -O, and the optimised copies would add about 21 MB.
    run(interpreter, '-I', '-m', 'compileall', '-q', '--invalidation-mode', 'unchecked-hash',
        '-o', '0', '-s', out, out / 'lib', env=clean)
    run(sys.executable, Path(__file__).with_name('check-python.py'), manifest_path, out)
    print(f"Python: CPython {python['version']}, " + ', '.join(f"{p['name']} {p['version']}" for p in packages))
    return 0


if __name__ == '__main__':
    sys.exit(main())
