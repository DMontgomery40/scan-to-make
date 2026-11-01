"""Execute the production SwiftUI retry methods against controlled capture/upload seams."""
import argparse
from pathlib import Path
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
MOBILE = HERE.parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--evidence', type=Path, required=True)
args = parser.parse_args()
args.evidence.mkdir(parents=True, exist_ok=True)
source = (MOBILE / 'ios/ScanToMake/Objects/ObjectsApp.swift').read_text()


def methods(view, names):
    section = source.split('struct ' + view + ': View {', 1)[1].split('\nstruct ', 1)[0]
    result = []
    for name in names:
        marker = '    private func ' + name + '('
        if marker not in section:
            raise ValueError(f'Missing production retry method: {view}.{name}')
        start = section.index(marker)
        end = section.index('{', start) + 1
        depth = 1
        while depth:
            depth += (section[end] == '{') - (section[end] == '}')
            end += 1
        result.append(section[start:end].replace('private func ', 'func ', 1))
    return '\n'.join(result)


fixture = (HERE / 'RetryTests.swift').read_text().replace(
    '// NEW_OBJECT_METHODS', methods('NewObjectView', ['make', 'scan', 'sendSavedCapture']))
fixture = fixture.replace('// OBJECT_DETAIL_METHODS', methods(
    'ObjectDetailView', ['sendSavedCapture', 'finishSending', 'scan', 'resumeSavedCapture']))
fixture_path = args.evidence / 'RetryFixture.swift'
fixture_path.write_text(fixture)
with tempfile.TemporaryDirectory(prefix='native-capture-retry-') as directory:
    binary = str(Path(directory) / 'retry')
    with (args.evidence / 'compile.log').open('w') as log:
        subprocess.run(['xcrun', 'swiftc', '-parse-as-library', str(fixture_path), '-o', binary],
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
    with (args.evidence / 'results.log').open('w') as log:
        subprocess.run([binary], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=30)
