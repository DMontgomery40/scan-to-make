#!/usr/bin/env python3
"""Install independent cleanup workers from a committed checkout, outside the Mac app."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

SOURCE_PATHS = ('tools/scan-repair', 'tools/scan-correct', 'tools/ai-tweak-judge',
                'tools/capture-mesh-convert')


def run(*args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def validate_destination(destination):
    if any(part.suffix.lower() == '.app' for part in (destination, *destination.parents)):
        raise ValueError('Independent workers must be outside every app bundle')


def extract_source(repo, revision, destination):
    """Git archive excludes dirty files, credentials, caches and the app's payload."""
    archive = destination / 'source.tar'
    run('git', '-C', repo, 'archive', '--format=tar', '--output=' + str(archive), revision, *SOURCE_PATHS)
    with tarfile.open(archive) as source:
        for member in source.getmembers():
            path = (destination / member.name).resolve()
            if not path.is_relative_to(destination.resolve()) or not (member.isfile() or member.isdir()):
                raise ValueError('Source archive contains a link or unsupported path')
        source.extractall(destination, filter='data')


def env_value(value):
    if '\n' in value or '\r' in value:
        raise ValueError('Worker paths must not contain newlines')
    for quote in ("'", '"', '`'):
        if quote not in value:
            return quote + value + quote
    raise ValueError('Worker path contains every supported dotenv quote')


def read_environment(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('companion.env must be an existing regular file; open Counterpart on this Mac first')
    original = path.read_bytes()
    # Appending inside an unfinished multiline value would swallow the overrides.
    quote = None
    for line in original.decode().splitlines():
        if quote:
            if quote in line:
                quote = None
            continue
        assignment = re.match(r'^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)', line)
        if assignment:
            value = assignment[1]
            if value and value[0] in "'\"`" and value[0] not in value[1:]:
                quote = value[0]
    if quote:
        raise ValueError('companion.env has an unfinished quote; it has not been changed')
    return original


def attach_environment(path, paths):
    """Append path overrides; retain every existing credential byte without evaluating it."""
    original = read_environment(path)
    block = '\n# Independent Counterpart cleanup worker paths\n'
    block += ''.join(key + '=' + env_value(value) + '\n' for key, value in paths.items())
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.workers-env-', delete=False) as output:
            temporary = Path(output.name)
            output.write(original + block.encode())
            output.flush()
            os.fsync(output.fileno())
        if path.is_symlink() or path.read_bytes() != original:
            raise ValueError('companion.env changed during setup; it has not been replaced')
        temporary.replace(path)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def qualify(destination, python, blender):
    """Use existing synthetic qualification; no provider, printer or user project is contacted."""
    env = {**os.environ, 'BLENDER': str(blender), 'PYTHONDONTWRITEBYTECODE': '1'}
    probe = run(python, '-c',
        'import json; from pxr import Usd; from PIL import Image; import pillow_heif; '
        'print(json.dumps({"usd":Usd.GetVersion(),"pillow":Image.__version__,"pillowHeif":pillow_heif.__version__}))',
        capture_output=True, text=True, env=env)
    versions = json.loads(probe.stdout)
    tests = destination / 'tools/scan-correct/tests'
    # Fail on skips: installation must really decode HEIC and qualify the native worker.
    command = ('import sys,unittest; suite=unittest.defaultTestLoader.discover(sys.argv[1],pattern=sys.argv[2]); '
               'result=unittest.TextTestRunner(verbosity=2).run(suite); '
               'sys.exit(0 if result.wasSuccessful() and result.testsRun and not result.skipped else 1)')
    for pattern in ('test_still_images.py', 'test_sandbox.py', 'test_native_cleanup.py'):
        run(python, '-c', command, tests, pattern, env=env)
    return versions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--revision', required=True, help='Release commit or tag; resolved and recorded as a commit SHA')
    parser.add_argument('--python', type=Path, default=Path(sys.executable), help='Existing Python 3.12 executable')
    parser.add_argument('--blender', type=Path, required=True, help='Existing Blender 5.0.1 executable')
    parser.add_argument('--root', type=Path, default=Path.home() / 'Library/Application Support/Counterpart Workers')
    parser.add_argument('--env-file', type=Path, help='Optionally attach to the existing app companion.env after qualification')
    args = parser.parse_args()
    if sys.version_info < (3, 12):
        raise ValueError('Run this installer with Python 3.12 or later')
    if sys.platform != 'darwin':
        raise ValueError('This installation command requires macOS; source/config tests also run on Linux')
    os.umask(0o077)
    repo, root, python, blender = (path.expanduser().resolve() for path in
                                 (args.source, args.root, args.python, args.blender))
    validate_destination(root)
    if args.env_file:
        read_environment(args.env_file.expanduser().absolute())
    revision = run('git', '-C', repo, 'rev-parse', '--verify', '--end-of-options',
                   args.revision + '^{commit}', capture_output=True, text=True).stdout.strip()
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('Could not resolve an exact source commit')
    run(python, '-c', 'import sys; assert sys.version_info[:2] == (3,12), "Python 3.12 is required"')
    version = run(blender, '--version', capture_output=True, text=True).stdout.splitlines()[0]
    if version != 'Blender 5.0.1':
        raise ValueError('Select existing Blender 5.0.1; no Blender is installed or replaced by this helper')
    destination = root / revision
    # Existing installs are immutable: never remove or rewrite another working venv.
    destination.mkdir(parents=True, exist_ok=False, mode=0o700)
    try:
        extract_source(repo, revision, destination)
        run(python, '-m', 'venv', destination / '.venv')
        worker_python = destination / '.venv/bin/python3'
        env = {key: value for key, value in os.environ.items() if not key.startswith('PIP_')}
        env['PIP_CONFIG_FILE'] = os.devnull
        run(worker_python, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir',
            '--only-binary=:all:', '--index-url', 'https://pypi.org/simple',
            '--report', destination / 'python-install.json',
            '-r', destination / 'tools/capture-mesh-convert/requirements.txt',
            '-r', destination / 'tools/scan-correct/requirements.txt',
            '-r', destination / 'tools/ai-tweak-judge/requirements.txt', env=env)
        versions = qualify(destination, worker_python, blender)
        paths = {
            'SCAN_TO_MAKE_CAPTURE_PYTHON': str(worker_python),
            'SCAN_TO_MAKE_SCAN_REPAIR_TOOL': str(destination / 'tools/scan-repair/repair.py'),
            'SCAN_TO_MAKE_SCAN_CORRECT_TOOL': str(destination / 'tools/scan-correct/correct.py'),
            'SCAN_TO_MAKE_AI_JUDGE_TOOL': str(destination / 'tools/ai-tweak-judge'),
            'SCAN_TO_MAKE_SCAN_BLENDER': str(blender), 'BLENDER': str(blender),
        }
        (destination / 'workers.env').write_text(''.join(key + '=' + env_value(value) + '\n' for key, value in paths.items()))
        receipt = {'sourceRevision': revision, 'sourceArchiveSha256': hashlib.sha256(
            (destination / 'source.tar').read_bytes()).hexdigest(), 'blender': str(blender),
            'blenderVersion': version, 'pythonPackages': versions, 'paths': paths}
        (destination / 'installation.json').write_text(json.dumps(receipt, indent=2) + '\n')
        if args.env_file:
            attach_environment(args.env_file.expanduser().absolute(), paths)
    except BaseException:
        shutil.rmtree(destination)
        raise
    print('Qualified independent workers: ' + str(destination))
    if args.env_file:
        print('Attached worker paths. Restart Counterpart when no job is running to load them.')
    else:
        print('No app settings changed. Worker paths: ' + str(destination / 'workers.env'))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print('Worker installation failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
