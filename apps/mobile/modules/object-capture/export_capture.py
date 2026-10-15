#!/usr/bin/env python3
"""Package a retained capture without transforming images, model bytes or scale."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile


def export_capture(folder: Path, destination: Path):
    folder = folder.resolve(strict=True)
    destination = destination.resolve()
    if destination.is_relative_to(folder):
        raise ValueError('Export must be outside the source capture')
    manifest_path = folder / 'evaluation.json'
    if manifest_path.is_symlink():
        raise ValueError('Symlinks are not accepted')
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('formatVersion') != '0.1':
        raise ValueError('Unsupported evaluation format')
    if manifest.get('scaleMethod') != 'native-unrescaled':
        raise ValueError('This export only preserves native unrescaled captures')
    files = [manifest_path]
    for name in ('Images', 'Models'):
        directory = folder / name
        if directory.is_symlink() or not directory.is_dir():
            raise ValueError(f'Missing real {name} directory')
        for path in sorted(directory.rglob('*')):
            if path.is_symlink():
                raise ValueError('Symlinks are not accepted')
            if path.is_file():
                files.append(path)
    if not any(p.parent.name == 'Images' for p in files):
        raise ValueError('Capture has no images')
    inventory = []
    # Exclusive creation prevents overwriting earlier evidence.
    try:
        with destination.open('xb') as stream:
            with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_STORED) as archive:
                for path in files:
                    data = path.read_bytes()
                    relative = str(path.relative_to(folder))
                    archive.writestr(relative, data)
                    inventory.append({'path': relative, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
                archive.writestr('inventory.json', json.dumps({
                    'formatVersion': '0.1', 'files': inventory,
                    'scaleMethod': 'native-unrescaled', 'depthMetadataVerified': False,
                    'metricAccuracy': 'unverified', 'completeObjectVerified': False,
                    'missingOrGuessedRegions': 'unassessed', 'physicalFitVerified': False,
                }, indent=2))
    except FileExistsError:
        raise
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    return inventory


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('capture', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    inventory = export_capture(args.capture, args.output)
    print(json.dumps({'fileCount': len(inventory), 'archiveSha256': hashlib.sha256(args.output.read_bytes()).hexdigest(), 'accuracy': 'unverified'}))
