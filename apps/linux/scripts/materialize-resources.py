#!/usr/bin/env python3
"""Make a self-contained Tauri resource tree; its bundler omits directory links.

Resolve every internal directory link (including nested npm file dependencies).
Executable file links become relocatable launchers to their original package path:
copying npm-cli.js to bin/npm breaks its relative require('../lib/cli.js').
No links may escape the prepared, app-owned resource tree.
"""
import os
from pathlib import Path
import shlex
import shutil
import sys


def materialize(source: Path, destination: Path):
    source = source.resolve(strict=True)
    destination = destination.absolute()
    if destination.exists() and any(destination.iterdir()):
        raise ValueError('Output must be absent or empty')
    if destination == source or source in destination.parents:
        raise ValueError('Output must be outside the source tree')
    links = []

    def copy(path: Path, out: Path, ancestors: frozenset[Path]):
        resolved = path.resolve(strict=True)
        if not resolved.is_relative_to(source):
            raise ValueError(f'Resource link escapes payload: {path.relative_to(source)}')
        if resolved.is_dir():
            if resolved in ancestors:
                raise ValueError(f'Resource directory link cycle: {path.relative_to(source)}')
            if path.is_symlink():
                links.append(str(path.relative_to(source)))
            out.mkdir(parents=True, exist_ok=True)
            for child in sorted(resolved.iterdir()):
                copy(child, out / child.name, ancestors | {resolved})
            shutil.copystat(resolved, out)
        elif resolved.is_file():
            out.parent.mkdir(parents=True, exist_ok=True)
            if path.is_symlink() and os.access(resolved, os.X_OK):
                target = destination / resolved.relative_to(source)
                relative = os.path.relpath(target, out.parent)
                out.write_text('#!/bin/sh\nexec "$(dirname -- "$0")"/' + shlex.quote(relative) + ' "$@"\n')
                out.chmod(resolved.stat().st_mode & 0o777)
                links.append(str(path.relative_to(source)))
            else:
                shutil.copy2(resolved, out)
        else:
            raise ValueError(f'Resource is not a regular file: {path.relative_to(source)}')

    copy(source, destination, frozenset())
    if any(path.is_symlink() for path in destination.rglob('*')):
        raise ValueError('Materialized resources still contain symbolic links')
    return links


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: materialize-resources.py PREPARED_RESOURCES BUNDLE_RESOURCES')
    for entry in materialize(Path(sys.argv[1]), Path(sys.argv[2])):
        print('Materialized ' + entry)
