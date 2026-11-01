"""Host checks for actual streaming readiness and owner finish/drain methods; no camera access."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--evidence', type=Path, required=True)
args = parser.parse_args()
args.evidence.mkdir(parents=True, exist_ok=True)
source = (HERE.parents[1] / 'ios/ScanToMake/Objects/HandheldCapture.swift').read_text()
def extract(marker):
    start = source.index(marker)
    end = source.index('{', start) + 1
    depth = 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]

markers = {
    '// DIAGNOSTIC_OPTIONS': 'enum HandheldDiagnosticOptions {',
    '// CAPTURE_ARCHIVE': 'enum HandheldCaptureArchive {',
    '// QUALITY_POLICY': 'enum HandheldCaptureQuality {',
    '// CAMERA_PHASE': 'enum Phase: Equatable {',
    '// CAN_START': 'var canStart: Bool {',
    '// CAN_RECORD_AGAIN': 'var canRecordAgain: Bool {',
    '// RECORD_AGAIN': 'func recordAgain() async {',
    '// RETAIN_SUMMARY': 'private func retain(',
    '// PAUSE_CAPTURE': 'func pause() async {',
    '// CAPTURE_FAILED': 'private func captureFailed(',
    '// WATCHDOG_CALLBACK': 'Task { @MainActor in\n                        guard let self, self.phase == .capturing',
    '// FINISH_CAPTURE': 'func finish() async -> Bool {',
    '// CLOSE_CAPTURE': 'func close() {',
    '// VIEW_APPEAR_TASK': '.task {',
}
fixture = (HERE / 'HandheldQualityTests.swift').read_text()
methods = {placeholder: extract(marker) for placeholder, marker in markers.items()}
for placeholder, method in methods.items():
    if placeholder == '// VIEW_APPEAR_TASK': method = method.replace('.task ', 'func appear() async ', 1)
    fixture = fixture.replace(placeholder, method.replace('private func ', 'func ', 1))
recorder_source = (HERE.parents[1] / 'ios/ScanToMake/Objects/HandheldDepthRecorder.swift').read_text()
callback_start = recorder_source.index('    func dataOutputSynchronizer(')
callback_end = recorder_source.index('        guard recording else { return }', callback_start)
callback_prefix = recorder_source[callback_start:callback_end] + '    }'
fixture = fixture.replace('// RECORDER_CALLBACK_PREFIX', callback_prefix)
(args.evidence / 'production-methods.json').write_text(json.dumps({
    markers[key]: hashlib.sha256(value.encode()).hexdigest() for key, value in methods.items()
} | {'recorder pre-recording callback': hashlib.sha256(callback_prefix.encode()).hexdigest()}, indent=2) + '\n')
fixture_path = args.evidence / 'HandheldQualityFixture.swift'
fixture_path.write_text(fixture)
with tempfile.TemporaryDirectory(prefix='native-handheld-quality-') as directory:
    binary = str(Path(directory) / 'quality')
    with (args.evidence / 'compile.log').open('w') as log:
        subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-parse-as-library', str(fixture_path), '-o', binary],
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
    with (args.evidence / 'results.log').open('w') as log:
        subprocess.run([binary], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=30)
