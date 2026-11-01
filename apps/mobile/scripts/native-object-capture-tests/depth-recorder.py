"""Run generic recorder checks; optionally add private calibrated sensor fixtures."""
import argparse
from pathlib import Path
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--evidence', type=Path, required=True)
parser.add_argument('--observed-photo', action='append', default=[])
args = parser.parse_args()
args.evidence.mkdir(parents=True, exist_ok=True)
source = HERE.parents[1] / 'ios/ScanToMake/Objects/HandheldDepthRecorder.swift'
with tempfile.TemporaryDirectory(prefix='handheld-depth-recorder-') as work:
    binary = str(Path(work) / 'tests')
    with (args.evidence / 'host-compile.log').open('w') as log:
        subprocess.run(['xcrun', 'swiftc', str(source), str(HERE / 'HandheldDepthRecorderTests.swift'), '-o', binary],
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
    with (args.evidence / 'host-results.log').open('w') as log:
        print('Generic checks (no private input)', file=log, flush=True)
        subprocess.run([binary], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        for number, fixture in enumerate(args.observed_photo):
            print(f'Fixture {number + 1}', file=log, flush=True)
            subprocess.run([binary, fixture], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
    sdk = subprocess.check_output(['xcrun', '--sdk', 'iphoneos', '--show-sdk-path'], text=True).strip()
    with (args.evidence / 'ios-typecheck.log').open('w') as log:
        subprocess.run(['xcrun', '--sdk', 'iphoneos', 'swiftc', '-typecheck', '-target', 'arm64-apple-ios16.0',
                        '-sdk', sdk, str(source)], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
print(f'PASS generic recorder checks and iOS typecheck; {len(args.observed_photo)} optional retained fixtures. Evidence: {args.evidence}')
