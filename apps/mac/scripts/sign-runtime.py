"""Sign nested Mach-O binaries before Xcode signs the containing app."""
import pathlib, subprocess, sys
root, identity, entitlements, bundle_identifier = sys.argv[1:]
for path in pathlib.Path(root).rglob('*'):
    if path.is_symlink() or not path.is_file():
        continue
    with path.open('rb') as handle:
        magic = handle.read(4)
    if magic not in [b'\xfe\xed\xfa\xce', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xcf\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca']:
        continue
    args = ['/usr/bin/codesign', '--force', '--options', 'runtime', '--timestamp', '--sign', identity]
    if path.name == 'node':
        # Do not retain a generic/ad-hoc Node identifier shared with Homebrew.
        # The nested helper has a stable identity within this app's signature.
        args += ['--identifier', bundle_identifier + '.node', '--entitlements', entitlements]
    subprocess.run(args + [str(path)], check=True)
