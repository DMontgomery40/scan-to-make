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
APP = MOBILE / 'ios/ScanToMake'


def methods(file, header, names):
    source = (APP / file).read_text()
    section = source.split(header, 1)[1].split('\nstruct ', 1)[0]
    result = []
    for name in names:
        marker = next((m for m in ('    private func ' + name + '(', '    func ' + name + '(') if m in section), None)
        if marker is None:
            raise ValueError(f'Missing production retry method: {header} {name}')
        start = section.index(marker)
        end = section.index('{', start) + 1
        depth = 1
        while depth:
            depth += (section[end] == '{') - (section[end] == '}')
            end += 1
        result.append(section[start:end].replace('private func ', 'func ', 1))
    return '\n'.join(result)


# New attaches a scan and sends in the background; the project page finishes a send cut short;
# MacConnection.sendProject is the one send path both use.
fixture = (HERE / 'RetryTests.swift').read_text().replace(
    '// NEW_OBJECT_METHODS', methods('Screens/NewProjectView.swift', 'struct NewObjectView: View {', ['make', 'scan', 'savedCapture']))
fixture = fixture.replace('// PROJECT_METHODS', methods(
    'Screens/ProjectView.swift', 'struct ProjectView: View {', ['resumeSavedCapture', 'finishSending', 'scan']))
fixture = fixture.replace('// SEND_PROJECT', methods(
    'Platform/MacConnection.swift', '@MainActor final class MacConnection {', ['sendProject']))
fixture_path = args.evidence / 'RetryFixture.swift'
fixture_path.write_text(fixture)
with tempfile.TemporaryDirectory(prefix='native-capture-retry-') as directory:
    binary = str(Path(directory) / 'retry')
    with (args.evidence / 'compile.log').open('w') as log:
        subprocess.run(['xcrun', 'swiftc', '-parse-as-library', str(fixture_path), '-o', binary],
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
    with (args.evidence / 'results.log').open('w') as log:
        subprocess.run([binary], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=30)
