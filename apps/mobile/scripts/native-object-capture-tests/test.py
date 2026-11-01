"""Host lifecycle/store checks. No device or Simulator access in host mode."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
MOBILE = HERE.parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--mutations', action='store_true')
parser.add_argument('--product-app', type=Path)
parser.add_argument('--ui', action='store_true')
parser.add_argument('--simulator')
parser.add_argument('--evidence', type=Path, required=True)
args = parser.parse_args()
os.environ['DEVELOPER_DIR'] = '/Applications/Xcode.app/Contents/Developer'
args.evidence.mkdir(parents=True, exist_ok=True)
subprocess.run([sys.executable, str(HERE / 'retry.py'), '--evidence', str(args.evidence / 'retry')], check=True)
subprocess.run([sys.executable, str(HERE / 'handheld.py'), '--evidence', str(args.evidence / 'handheld')], check=True)
subprocess.run([sys.executable, str(HERE / 'depth-recorder.py'), '--evidence', str(args.evidence / 'depth-recorder')], check=True)
with tempfile.TemporaryDirectory(prefix='native-object-capture-tests-') as directory:
    binary = str(Path(directory) / 'lifecycle')
    sdk = subprocess.check_output(['xcrun', '--sdk', 'macosx', '--show-sdk-path'], text=True).strip()
    sources = [MOBILE / 'modules/object-capture/ios/NativeCaptureDraftStore.swift',
               MOBILE / 'modules/object-capture/ios/NativeCaptureCoordinator.swift',
               HERE / 'LifecycleAndDraftTests.swift']
    with (args.evidence / 'compile.log').open('w') as log:
        subprocess.run(['xcrun', 'swiftc', '-sdk', sdk, '-target', 'arm64-apple-macos15',
                        *map(str, sources), '-o', binary], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
    with (args.evidence / 'results.log').open('w') as log:
        subprocess.run([binary], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=30)

# Compile the actual production lifecycle method bodies against controlled SDK streams.
sample = MOBILE / 'modules/object-capture/GuidedCaptureSample/GuidedCaptureSample'
source = (sample / 'AppDataModel.swift').read_text()
markers = ['    enum ModelState', '    private func finishEmbedded(', '    func stopEmbeddedCapture()',
           '    func beginCapture()', '    func stopCapture(', '    private func finishStopIfTerminal(',
           '    private func markStopStillPending(', '    func setShowOverlaySheets(',
           '    func cancelReconstruction()', '    private func beginReconstruction(',
           '    private func finishReconstruction(', '    private func reset()',
           '    private func onStateChanged(', '    private func performStateTransition(']
methods = []
for marker in markers:
    start = source.index(marker); end = source.index('{', start) + 1; depth = 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}'); end += 1
    methods.append(source[start:end])
fixture = (HERE / 'LifecycleAndDraftTests.swift').read_text().replace('// MODEL_METHODS', '\n'.join(methods))
fixture = fixture.replace('// MODEL_FILTER', (sample / 'UntilProcessingCompleteFilter.swift').read_text().replace('import RealityKit', ''))
(args.evidence / 'model-extraction.json').write_text(json.dumps({m:hashlib.sha256(s.encode()).hexdigest() for m,s in zip(markers,methods)}, indent=2)+'\n')
model = args.evidence / 'ModelFixture.swift'; model.write_text(fixture)
with tempfile.TemporaryDirectory(prefix='native-model-tests-') as directory:
    binary = str(Path(directory) / 'model')
    with (args.evidence / 'model-compile.log').open('w') as log:
        subprocess.run(['xcrun','swiftc','-sdk',sdk,'-target','arm64-apple-macos15','-D','MODEL_FIXTURE','-parse-as-library',str(model),'-o',binary],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=120)
    with (args.evidence / 'model-results.log').open('w') as log:
        subprocess.run([binary],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=30)

if args.mutations:
    outcomes = []
    store_source = (MOBILE / 'modules/object-capture/ios/NativeCaptureDraftStore.swift').read_text()
    owner_source = (MOBILE / 'modules/object-capture/ios/NativeCaptureCoordinator.swift').read_text()
    # Only private temporary copies are mutated; production sources stay untouched.
    variants = [
        ('early-owner-release', owner_source.replace('        engine.stop()', '        engine.stop(); self.engine = nil; self.activeRunID = nil'), store_source, 'Started before terminal'),
        ('follow-output-symlink', owner_source, store_source.replace(' | O_NOFOLLOW', ''), 'Accepted symlink output directory'),
    ]
    for name, owner_bytes, store_bytes, expected in variants:
        with tempfile.TemporaryDirectory(prefix='native-mutation-') as directory:
            directory = Path(directory)
            owner_file = directory / 'Owner.swift'; owner_file.write_text(owner_bytes)
            store_file = directory / 'Store.swift'; store_file.write_text(store_bytes)
            binary = directory / 'check'
            with (args.evidence / (name+'-compile.log')).open('w') as log:
                subprocess.run(['xcrun','swiftc','-sdk',sdk,'-target','arm64-apple-macos15',str(owner_file),str(store_file),str(HERE / 'LifecycleAndDraftTests.swift'),'-o',str(binary)],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=120)
            result = subprocess.run([str(binary)],capture_output=True,text=True,timeout=30)
            (args.evidence / (name+'-red.log')).write_text(result.stdout+result.stderr)
            assert result.returncode != 0 and expected in result.stdout+result.stderr, name+' was not caught'
            outcomes.append({'mutation':name,'caught':True,'exitCode':result.returncode})
    (args.evidence / 'mutation-results.json').write_text(json.dumps(outcomes,indent=2)+'\n')

if args.ui:
    if not args.simulator: parser.error('--ui requires an explicitly owned --simulator')
    project = args.evidence / 'ui-fixture'
    app = project / 'App'; tests = project / 'Tests'
    app.mkdir(parents=True, exist_ok=True); tests.mkdir(parents=True, exist_ok=True)
    (app / 'ModelFixture.swift').write_text(fixture)
    (app / 'MockCaptureApp.swift').write_text((HERE / 'MockCaptureApp.swift').read_text())
    (app / 'NativeCaptureDraftStore.swift').write_text((MOBILE / 'modules/object-capture/ios/NativeCaptureDraftStore.swift').read_text())
    (app / 'NativeCaptureCoordinator.swift').write_text((MOBILE / 'modules/object-capture/ios/NativeCaptureCoordinator.swift').read_text().split('#if canImport(UIKit)')[0])
    (app / 'NativeCaptureHostView.swift').write_text((MOBILE / 'modules/object-capture/ios/NativeCaptureHostView.swift').read_text())
    for name in ['ReconstructionPrimaryView.swift', 'ProgressBarView.swift']:
        (app / name).write_text((sample / 'Views' / name).read_text().replace('import RealityKit', ''))
    (tests / 'CaptureFlowUITests.swift').write_text((HERE / 'CaptureFlowUITests.swift').read_text())
    spec = {
        'name':'NativeCaptureFixture',
        'settings':{'base':{'IPHONEOS_DEPLOYMENT_TARGET':'27.0','SWIFT_VERSION':'5.0','CODE_SIGNING_ALLOWED':'NO', 'SWIFT_ACTIVE_COMPILATION_CONDITIONS':'MODEL_FIXTURE UI_FIXTURE'}},
        'targets':{
            'NativeCaptureFixture':{'type':'application','platform':'iOS','sources':['App'],'settings':{'base':{'PRODUCT_BUNDLE_IDENTIFIER':'com.scantomake.nativecapturefixture','GENERATE_INFOPLIST_FILE':'YES','INFOPLIST_KEY_UILaunchScreen_Generation':'YES','INFOPLIST_KEY_UIApplicationSceneManifest_Generation':'YES'}}},
            'NativeCaptureUITests':{'type':'bundle.ui-testing','platform':'iOS','sources':['Tests'],'dependencies':[{'target':'NativeCaptureFixture'}],'settings':{'base':{'PRODUCT_BUNDLE_IDENTIFIER':'com.scantomake.nativecapturefixture.tests','GENERATE_INFOPLIST_FILE':'YES'}}}},
        'schemes':{'NativeCaptureFixture':{'build':{'targets':{'NativeCaptureFixture':'all'}},'test':{'targets':['NativeCaptureUITests']}}}}
    if args.product_app:
        spec['settings']['base']['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] += ' PRODUCT_FIXTURE'
        subprocess.run(['xcrun','simctl','uninstall',args.simulator,'com.scantomake'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        subprocess.run(['xcrun','simctl','install',args.simulator,str(args.product_app)],check=True,timeout=60)
    (project / 'project.json').write_text(json.dumps(spec, indent=2)+'\n')
    subprocess.run(['xcodegen','generate','--spec',str(project / 'project.json')],check=True,timeout=30)
    subprocess.run(['xcrun','simctl','uninstall',args.simulator,'com.scantomake.nativecapturefixture'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    with (args.evidence / 'ui-test.log').open('w') as log:
        subprocess.run(['xcodebuild','-project',str(project / 'NativeCaptureFixture.xcodeproj'),'-scheme','NativeCaptureFixture',
                        '-destination','platform=iOS Simulator,id='+args.simulator,'-derivedDataPath',str(args.evidence / 'UIDerivedData'),
                        '-resultBundlePath',str(args.evidence / 'ui-result.xcresult'),'-parallel-testing-enabled','NO',
                        '-collect-test-diagnostics','never','CODE_SIGNING_ALLOWED=NO','test',
                        *(['-only-testing:NativeCaptureUITests/CaptureFlowUITests/testOrdinaryAppNativeBridgeAndFilesFallback'] if args.product_app else [])],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=240)
