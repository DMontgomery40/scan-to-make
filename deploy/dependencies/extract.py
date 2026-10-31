#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Extract a digest-verified MCP distribution; retain its source and licences."""
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import tarfile
import zipfile


def extract(kind, archive, destination):
    root = Path(destination)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Invalid destination')
    seen, size, count = set(), 0, 0

    def target(name, length, mode, directory=False):
        nonlocal size, count
        parts = PurePosixPath(name).parts
        if not parts or name.startswith('/') or '\\' in name or '..' in parts:
            raise ValueError('Unsafe archive path')
        if kind == 'tgz':
            if parts[0] != 'package':
                raise ValueError('Unexpected npm archive root')
            parts = parts[1:]
            if not parts and directory:
                return None
        if not parts or stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise ValueError('Unsupported archive member')
        path = root.joinpath(*parts)
        size += length; count += 1
        if length < 0 or size > 512 * 1024 * 1024 or count > 100000:
            raise ValueError('Archive exceeds extraction limits')
        if path in seen:
            raise ValueError('Duplicate archive member')
        seen.add(path)
        # Even a pre-existing symlink in the private stage is not followed.
        for parent in [path, *path.parents]:
            if parent == root.parent:
                break
            if parent.is_symlink():
                raise ValueError('Archive destination contains a symlink')
        if directory:
            path.mkdir(mode=0o700, parents=True, exist_ok=True)
            return None
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        return path

    def write(path, source, length, mode):
        with path.open('xb') as out:
            remaining = length
            while remaining:
                data = source.read(min(remaining, 1024 * 1024))
                if not data:
                    raise ValueError('Truncated archive member')
                out.write(data); remaining -= len(data)
            if source.read(1):
                raise ValueError('Archive member exceeds declared length')
        path.chmod(0o700 if mode & 0o111 else 0o600)

    if kind == 'zip':
        with zipfile.ZipFile(archive) as handle:
            for member in handle.infolist():
                mode = member.external_attr >> 16
                path = target(member.filename, member.file_size, mode, member.is_dir())
                if path:
                    with handle.open(member) as source:
                        write(path, source, member.file_size, mode)
    elif kind == 'tgz':
        with tarfile.open(archive, 'r:gz') as handle:
            for member in handle:
                if not (member.isdir() or member.isfile()):
                    raise ValueError('Archive links and special files are not supported')
                path = target(member.name, member.size, member.mode, member.isdir())
                if path:
                    with handle.extractfile(member) as source:
                        write(path, source, member.size, member.mode)
    else:
        raise ValueError('Unsupported archive format')


if __name__ == '__main__':
    os.umask(0o077)
    extract(*sys.argv[1:])
