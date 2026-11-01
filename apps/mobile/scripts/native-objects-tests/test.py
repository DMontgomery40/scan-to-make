"""Host handheld transport checks or bounded real Simulator objects tests (KAN-204).

Host mode uses temporary local files and controlled HTTP completions, without a Simulator.
Simulator mode requires a built companion and uses a separate disposable app/container. Uses real
capture-scoped credentials
against the synthetic pairing fixture (fake converter and scan runner), so
this proves the native transport, not conversion, Blender or physical fit.
"""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import hashlib

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
BUNDLE = 'com.scantomake.objectstests'
parser = argparse.ArgumentParser()
parser.add_argument('--simulator', help='Already booted Simulator UUID')
parser.add_argument('--host', action='store_true', help='Exercise actual handheld file methods with controlled local transport; no Simulator')
parser.add_argument('--evidence', type=Path, required=True)
args = parser.parse_args()
args.evidence.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')

def run(command, **kwargs):
    return subprocess.run(command, env=env, check=True, timeout=120, **kwargs)

if args.host:
    source = (REPO / 'apps/mobile/modules/local-project-storage/ios/ObjectsBridge.mm').read_text()
    def extract(marker, text=source):
        start = text.index(marker)
        end = text.index('{', start) + 1
        depth = 1
        while depth:
            depth += (text[end] == '{') - (text[end] == '}')
            end += 1
        return text[start:end]
    swift_source = (REPO / 'apps/mobile/ios/ScanToMake/Objects/ObjectsApp.swift').read_text()
    connection = swift_source.split('@MainActor final class MacConnection {', 1)[1].split('\nstruct ChosenPhoto', 1)[0]
    swift_fixture = (HERE / 'HandheldManifestTests.swift').read_text()
    swift_markers = {
        '// MAC_ERROR': ('struct MacError:', swift_source),
        '// PROMISE': ('@MainActor private func promise(', swift_source),
        '// REQUIRE': ('private func require<T>(', connection),
        '// START': ('func start(', connection),
        '// SEND_HANDHELD': ('func sendHandheld(', connection),
    }
    for placeholder, (marker, text) in swift_markers.items():
        swift_fixture = swift_fixture.replace(placeholder, extract(marker, text))
    manifest_marker = 'private struct HandheldManifest:'
    swift_fixture = swift_fixture.replace('// CAPTURE_MANIFEST', extract(manifest_marker, connection) if manifest_marker in connection else '')
    swift_path = args.evidence / 'HandheldManifestFixture.swift'
    swift_path.write_text(swift_fixture)
    with tempfile.TemporaryDirectory(prefix='native-handheld-manifest-') as directory:
        binary = str(Path(directory) / 'check')
        with (args.evidence / 'swift-compile.log').open('w') as log:
            run(['xcrun', 'swiftc', '-parse-as-library', str(swift_path), '-o', binary], stdout=log, stderr=subprocess.STDOUT)
        with (args.evidence / 'swift-runtime.log').open('w') as log:
            run([binary], stdout=log, stderr=subprocess.STDOUT)
    markers = {
        '// HOST_MATCHES': 'static BOOL STMObjectsMatches(',
        '// HOST_PATH': 'static NSString *STMObjectsPath(',
        '// HOST_MESSAGE': 'static NSString *STMObjectsMessage(',
        '// HOST_UPLOAD': '- (void)upload:',
        '// HOST_EXISTING': '- (void)existing:',
        '// HOST_SEND_FILES': '- (void)sendFiles:',
        '// HOST_SEND_HANDHELD': 'RCT_REMAP_METHOD(sendHandheld,',
        '// HOST_CALL': 'RCT_REMAP_METHOD(call,',
    }
    fixture = (HERE / 'runner.mm').read_text()
    hashes = {}
    for placeholder, marker in markers.items():
        method = extract(marker)
        fixture = fixture.replace(placeholder, method)
        hashes[marker] = hashlib.sha256(method.encode()).hexdigest()
    (args.evidence / 'production-methods.json').write_text(json.dumps(hashes, indent=2) + '\n')
    fixture_path = args.evidence / 'HostFixture.mm'
    fixture_path.write_text(fixture)
    with tempfile.TemporaryDirectory(prefix='native-objects-host-') as directory:
        binary = str(Path(directory) / 'check')
        sdk = subprocess.check_output(['xcrun','--sdk','macosx','--show-sdk-path'],env=env,text=True).strip()
        with (args.evidence / 'compile.log').open('w') as log:
            run(['xcrun','clang++','-fobjc-arc','-fblocks','-DSTM_OBJECTS_HOST=1','-isysroot',sdk,
                 '-I',str(HERE),str(fixture_path),'-framework','Foundation','-o',binary],stdout=log,stderr=subprocess.STDOUT)
        with (args.evidence / 'runtime.log').open('w') as log:
            run([binary],stdout=log,stderr=subprocess.STDOUT)
    # Also compile the unchanged full bridge through the existing native harness imports.
    sdk = subprocess.check_output(['xcrun','--sdk','iphonesimulator','--show-sdk-path'],env=env,text=True).strip()
    with (args.evidence / 'bridge-syntax.log').open('w') as log:
        run(['xcrun','clang++','-fsyntax-only','-fobjc-arc','-fblocks','-target','arm64-apple-ios17.0-simulator',
             '-isysroot',sdk,'-I',str(HERE),str(HERE / 'runner.mm')],stdout=log,stderr=subprocess.STDOUT)
    result = {'passed':True,'mode':'host-controlled-transport','bridgeSha256':hashlib.sha256(source.encode()).hexdigest(),
              'source':'Actual native handheld upload methods; controlled Foundation HTTP/path boundaries, no real network or camera'}
    (args.evidence / 'results.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))
    raise SystemExit(0)

if not args.simulator:
    parser.error('--simulator is required unless --host is used')

# Existing Simulator/CI invocations also retain the new handheld transport regression checks.
run([sys.executable, str(Path(__file__).resolve()), '--host', '--evidence', str(args.evidence / 'host')])

simulators = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', '-j'], env=env))
assert any(d['udid'] == args.simulator and d['state'] == 'Booted'
           for group in simulators['devices'].values() for d in group), 'Target must already be booted'

with tempfile.TemporaryDirectory(prefix='native-objects-') as temp:
    temp = Path(temp)
    fixture_log = open(temp / 'fixture.log', 'w+')
    fixture = subprocess.Popen(['node', str(REPO / 'apps/mobile/scripts/pairing-fixture/server.mjs')],
                               cwd=REPO, env=dict(env, SCAN_OBJECTS_FIXTURE='1'),
                               stdout=fixture_log, stderr=subprocess.STDOUT)
    fixture_root = None
    installed = False
    try:
        for _ in range(100):
            fixture_log.seek(0)
            lines = fixture_log.read().splitlines()
            if lines:
                try:
                    info = json.loads(lines[0])
                    fixture_root = Path(info['directory'])
                    break
                except (ValueError, KeyError):
                    raise RuntimeError('Fixture failed to start; inspect private temporary log')
            if fixture.poll() is not None:
                raise RuntimeError('Fixture exited before startup')
            time.sleep(.05)
        assert fixture_root, 'Fixture startup timed out'
        invite = json.loads((fixture_root / 'invitation.json').read_text())
        run_id = str(uuid.uuid4())
        objects = json.loads((fixture_root / 'objects.json').read_text())
        config = {'runId':run_id,'invitation':invite,'objects':objects}
        app = temp / 'Objects.app'
        app.mkdir(mode=0o700)
        (app / 'config.json').write_text(json.dumps(config))
        (app / 'config.json').chmod(0o600)
        with open(app / 'Info.plist','wb') as f:
            plistlib.dump({'CFBundleIdentifier':BUNDLE,'CFBundleExecutable':'Objects','CFBundleName':'Objects Tests','CFBundlePackageType':'APPL','CFBundleVersion':'1','CFBundleShortVersionString':'1.0','MinimumOSVersion':'17.0','UIApplicationSceneManifest':{'UIApplicationSupportsMultipleScenes':False,'UISceneConfigurations':{'UIWindowSceneSessionRoleApplication':[{'UISceneConfigurationName':'Default','UISceneDelegateClassName':'SceneDelegate'}]}},'UIDeviceFamily':[1,2],'LSRequiresIPhoneOS':True,'NSAppTransportSecurity':{'NSAllowsLocalNetworking':True,'NSAllowsArbitraryLoads':True}}, f)
        sdk = subprocess.check_output(['xcrun','--sdk','iphonesimulator','--show-sdk-path'],env=env,text=True).strip()
        entitlements=temp / 'test.entitlements'
        with open(entitlements,'wb') as f:
            plistlib.dump({'application-identifier':'TESTTEAM.'+BUNDLE,'keychain-access-groups':['TESTTEAM.'+BUNDLE],'get-task-allow':True},f)
        with open(args.evidence / 'compile.log','w') as log:
            run(['xcrun','clang++','-fobjc-arc','-fblocks','-target','arm64-apple-ios17.0-simulator','-isysroot',sdk,'-Xlinker','-sectcreate','-Xlinker','__TEXT','-Xlinker','__entitlements','-Xlinker',str(entitlements),'-I',str(HERE),str(HERE / 'runner.mm'),'-o',str(app / 'Objects'),'-framework','CoreGraphics','-framework','UIKit','-framework','Foundation','-framework','Security','-framework','QuickLook','-framework','UniformTypeIdentifiers','-framework','ImageIO','-framework','PhotosUI','-framework','SceneKit','-framework','ModelIO'],stdout=log,stderr=subprocess.STDOUT)
        run(['codesign','--force','--sign','-',str(app)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        run(['xcrun','simctl','install',args.simulator,str(app)])
        installed = True
        with open(args.evidence / 'runtime.log','w') as log:
            completed = subprocess.run(['xcrun','simctl','launch','--console',args.simulator,BUNDLE],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=90)
        log_text = (args.evidence / 'runtime.log').read_text(errors='replace')
        failures = [line for line in log_text.splitlines() if line.startswith('FAIL ')]
        assert completed.returncode == 0 and 'NATIVE_OBJECTS_PASS' in log_text and not failures, (failures[0] if failures else 'Native host failed; see runtime.log')
        container = Path(subprocess.check_output(['xcrun','simctl','get_app_container',args.simulator,BUNDLE,'data'],env=env,text=True).strip())
        result = json.loads((container / 'Documents/results.json').read_text())
        assert result['passed'] and result['runId'] == run_id
        first_pass = json.loads((fixture_root / 'pass-1.json').read_text())
        assert first_pass == {'scan': 1, 'photos': 24, 'note': None}, first_pass
        second_pass = json.loads((fixture_root / 'pass-2.json').read_text())
        assert second_pass['scan'] == 1 and second_pass['note'] == 'make it 2 mm thicker', second_pass
        result['bridgeSha256'] = hashlib.sha256((REPO / 'apps/mobile/modules/local-project-storage/ios/ObjectsBridge.mm').read_bytes()).hexdigest()
        result['simulator'] = args.simulator
        result['passes'] = [first_pass, second_pass]
        result['source'] = 'pairing fixture with the real object service and a fixture touch-up; native transport proof only, no Claude, Blender or printing claim'
        (args.evidence / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'passed':True,'evidence':str(args.evidence.resolve())}))
    finally:
        if installed:
            subprocess.run(['xcrun','simctl','terminate',args.simulator,BUNDLE],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            subprocess.run(['xcrun','simctl','launch','--console',args.simulator,BUNDLE,'--cleanup'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
            subprocess.run(['xcrun','simctl','uninstall',args.simulator,BUNDLE],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        fixture.terminate()
        try:
            fixture.wait(timeout=10)
        except subprocess.TimeoutExpired:
            fixture.kill()
            fixture.wait()
        fixture_log.close()
        if fixture_root:
            shutil.rmtree(fixture_root)
