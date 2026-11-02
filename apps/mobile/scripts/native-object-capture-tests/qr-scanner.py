"""Run production QR controller lifecycle methods against a controlled VisionKit boundary."""
import argparse
from pathlib import Path
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--evidence', type=Path, required=True)
args = parser.parse_args()
args.evidence.mkdir(parents=True, exist_ok=True)
source = (HERE.parents[1] / 'ios/ScanToMake/Pairing/QRScanner.swift').read_text()
methods = []
for marker in ['    func updateUIViewController(', '    static func dismantleUIViewController(',
               '    func makeCoordinator()', '    @MainActor final class Coordinator:']:
    start = source.index(marker)
    end = source.index('{', start) + 1
    depth = 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    methods.append(source[start:end])
fixture = args.evidence / 'QRScannerFixture.swift'
fixture.write_text((HERE / 'QRScannerTests.swift').read_text().replace('// QR_METHODS', '\n'.join(methods)))
with tempfile.TemporaryDirectory(prefix='native-qr-scanner-') as directory:
    binary = str(Path(directory) / 'qr-scanner')
    with (args.evidence / 'compile.log').open('w') as log:
        subprocess.run(['xcrun', 'swiftc', '-parse-as-library', str(fixture), '-o', binary],
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
    with (args.evidence / 'results.log').open('w') as log:
        subprocess.run([binary], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=30)
