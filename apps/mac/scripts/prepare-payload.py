#!/usr/bin/env python3
"""Build only the source paths and pinned downloads declared in distribution.json."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.parse import urlparse, unquote

MAC = Path(__file__).resolve().parents[1]
REPO = MAC.parents[1]
MANIFEST = json.loads((MAC / 'distribution.json').read_text())
# #826: the app's own npm, from the same Node.js release as its node, so Settings → Printers can install printer
# software on a Mac without Node.js. Run by the node beside it: no PATH, shebang or Node.js install needed.
NPM_LAUNCHER = '''#!/bin/sh
# npm from the same Node.js release as the node beside it, run by that node (Scan to Make, #826).
case $0 in */*) bin=${0%/*} ;; *) bin=. ;; esac
exec "$bin/node" "$bin/../lib/node_modules/npm/bin/npm-cli.js" "$@"
'''


def run(*args, **kwargs):
    subprocess.run([str(a) for a in args], check=True, **kwargs)


def download(component, directory):
    target = directory / unquote(Path(urlparse(component['downloadUrl']).path).name)
    run('curl', '--fail', '--location', '--retry', '3', component['downloadUrl'], '-o', target)
    if hashlib.sha256(target.read_bytes()).hexdigest() != component['sha256']:
        raise ValueError('Downloaded artifact checksum mismatch: ' + component['name'])
    return target


with tempfile.TemporaryDirectory() as temporary:
    work = Path(temporary).resolve()  # npm must not see /var vs /private/var aliases
    payload = work / 'Payload'
    for name, subdirectory in [('Node.js', 'node'), ('CPython standalone', 'python')]:
        component = next(c for c in MANIFEST['components'] if c['name'] == name)
        archive = download(component, work)
        destination = payload / subdirectory
        destination.mkdir(parents=True)
        run('tar', '-xzf', archive, '--strip-components=1', '-C', destination)
    source = payload / 'source'
    source.mkdir()
    archive = os.environ.get('SOURCE_ARCHIVE')
    if not archive:
        archive = str(work / 'source.tar')
        run('git', '-C', REPO, 'archive', '--output=' + archive, 'HEAD', *MANIFEST['sourcePaths'])
    # Also filter supplied archives: they may contain a full companion install.
    # A removed/forbidden worker never re-enters the app through SOURCE_ARCHIVE.
    run('tar', '-xf', archive, '-C', source, *MANIFEST['sourcePaths'])
    for helper in MANIFEST['firstPartyExecutables']:
        package = source / helper['sourcePath']
        run('swift', 'build', '-c', 'release', '--package-path', package, '--product', helper['name'])
        destination = payload / helper['path']
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(package / '.build/release' / helper['name'], destination)
        shutil.rmtree(package / '.build')
    env = dict(os.environ, PATH=str(payload / 'node/bin') + ':' + os.environ['PATH'])
    for package in MANIFEST['npmPackages']:
        run('npm', 'ci', '--ignore-scripts', '--prefix', source / package, env=env)
    run('npm', 'run', 'build', '--prefix', source / 'services/companion', env=env)
    for package in MANIFEST['npmPackages']:
        run('npm', 'prune', '--omit=dev', '--ignore-scripts', '--prefix', source / package, env=env)
    python = payload / 'python/bin/python3'
    for component in MANIFEST['components']:
        if 'pythonPackage' in component:
            wheel = download(component, work)
            run(python, '-m', 'pip', 'install', '--no-deps', '--no-index', wheel)
    # Build tools are not runtime dependencies. Remove their vendored closures, except npm, which installs and
    # updates printer software (#826): kept unmodified from the checksum-verified Node.js archive.
    shutil.rmtree(payload / 'node/lib/node_modules/corepack')
    for name in ['npm', 'npx', 'corepack']:
        (payload / 'node/bin' / name).unlink(missing_ok=True)
    node_component = next(c for c in MANIFEST['components'] if c['name'] == 'Node.js')
    npm_version = json.loads((payload / 'node/lib/node_modules/npm/package.json').read_text())['version']
    if npm_version != node_component['npmVersion']:
        raise ValueError(f"The Node.js archive's npm is {npm_version}, not the pinned {node_component['npmVersion']}")
    launcher = payload / 'node/bin/npm'
    launcher.write_text(NPM_LAUNCHER)
    launcher.chmod(0o755)
    # It runs with nothing on PATH, the way a Mac without Node.js runs it.
    answered = subprocess.run([launcher, '--version'], check=True, capture_output=True, text=True,
                              env={'PATH': '', 'HOME': str(work)}).stdout.strip()
    if answered != npm_version:
        raise ValueError(f'The bundled npm answered {answered!r}, not {npm_version}')
    site = payload / 'python/lib/python3.12/site-packages'
    for path in site.glob('pip*'):
        if path.is_dir(): shutil.rmtree(path)
        else: path.unlink()
    shutil.rmtree(payload / 'python/lib/python3.12/ensurepip')
    for path in (payload / 'python/bin').glob('pip*'): path.unlink()
    run(python, '-m', 'compileall', '-q', '--invalidation-mode', 'unchecked-hash',
        '-o', '0', '-o', '1', '-o', '2', '-s', payload, payload / 'python/lib', source / 'tools')
    # Bind readiness to the actual supplied source archive and pinned runtime
    # manifest, including when SOURCE_ARCHIVE differs from this checkout's HEAD.
    identity = hashlib.sha256(Path(archive).read_bytes())
    identity.update(json.dumps(MANIFEST, sort_keys=True).encode())
    (payload / 'BUILD-ID').write_text('mac-' + identity.hexdigest() + '\n')
    run(source / 'tools/linux-reconstruct/linux-reconstruct', 'check', '--mode', 'qualify',
        env={'HOME': str(work), 'PATH': '/usr/bin:/bin'})
    run(python, REPO / 'tools/licence-audit/mac_distribution.py', '--repo-root', REPO, '--payload', payload)
    if (MAC / 'Payload').exists(): shutil.rmtree(MAC / 'Payload')
    shutil.move(str(payload), MAC / 'Payload')
