"""Bounded real Simulator prepared-file tests. Requires built companion.

Uses a separate disposable app/container, never the product app or physical device.
Uses real prepared-only credentials and protocol inspection fixtures, not slicing proof.
"""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import hashlib

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
BUNDLE = 'com.scantomake.preparedfiletests'
parser = argparse.ArgumentParser()
parser.add_argument('--simulator', required=True, help='Already booted Simulator UUID')
parser.add_argument('--evidence', type=Path, required=True)
parser.add_argument('--produced-fixture', type=Path, help='Retained operator-produced job directory; replay only, no slicer run')
args = parser.parse_args()
args.evidence.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')
python = env.get('SCAN_TO_MAKE_CAPTURE_PYTHON', 'python3')

def run(command, **kwargs):
    return subprocess.run(command, env=env, check=True, timeout=120, **kwargs)

simulators = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', '-j'], env=env))
assert any(d['udid'] == args.simulator and d['state'] == 'Booted'
           for group in simulators['devices'].values() for d in group), 'Target must already be booted'

with tempfile.TemporaryDirectory(prefix='native-prepared-files-') as temp:
    temp = Path(temp)
    with open(args.evidence / 'pairing-validation.log','w') as log:
        run(['xcrun','clang++','-fobjc-arc','-fblocks','-framework','Foundation','-framework','Security','-I',str(HERE),str(HERE / 'pairing-validation.mm'),'-o',str(temp / 'pairing-test')],stdout=log,stderr=subprocess.STDOUT)
        run([str(temp / 'pairing-test')],stdout=log,stderr=subprocess.STDOUT)
    fixture_log = open(temp / 'fixture.log', 'w+')
    fixture = subprocess.Popen(['node', str(REPO / 'apps/mobile/scripts/pairing-fixture/server.mjs')],
                               cwd=REPO, env=dict(env, SCAN_PREPARED_FIXTURE='1', **({'SCAN_PRODUCED_FIXTURE_DIR':str(args.produced_fixture.resolve())} if args.produced_fixture else {})),
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
        prepared = json.loads((fixture_root / 'prepared.json').read_text())
        config = {'runId':run_id,'invitation':invite,'prepared':prepared}
        shutil.copyfile(fixture_root / 'settings.json',args.evidence / 'fixture-settings.json')
        (args.evidence / 'fixture-contract.json').write_text(json.dumps(prepared,indent=2))
        app = temp / 'PreparedFiles.app'
        app.mkdir(mode=0o700)
        (app / 'config.json').write_text(json.dumps(config))
        (app / 'config.json').chmod(0o600)
        with open(app / 'Info.plist','wb') as f:
            plistlib.dump({'CFBundleIdentifier':BUNDLE,'CFBundleExecutable':'PreparedFiles','CFBundleName':'Prepared File Tests','CFBundlePackageType':'APPL','CFBundleVersion':'1','CFBundleShortVersionString':'1.0','MinimumOSVersion':'16.0','UIApplicationSceneManifest':{'UIApplicationSupportsMultipleScenes':False,'UISceneConfigurations':{'UIWindowSceneSessionRoleApplication':[{'UISceneConfigurationName':'Default','UISceneDelegateClassName':'SceneDelegate'}]}},'UIDeviceFamily':[1,2],'LSRequiresIPhoneOS':True,'NSAppTransportSecurity':{'NSAllowsLocalNetworking':True,'NSAllowsArbitraryLoads':True}}, f)
        sdk = subprocess.check_output(['xcrun','--sdk','iphonesimulator','--show-sdk-path'],env=env,text=True).strip()
        entitlements=temp / 'test.entitlements'
        with open(entitlements,'wb') as f:
            plistlib.dump({'application-identifier':'TESTTEAM.'+BUNDLE,'keychain-access-groups':['TESTTEAM.'+BUNDLE],'get-task-allow':True},f)
        with open(args.evidence / 'compile.log','w') as log:
            run(['xcrun','clang++','-fobjc-arc','-fblocks','-target','arm64-apple-ios16.0-simulator','-isysroot',sdk,'-Xlinker','-sectcreate','-Xlinker','__TEXT','-Xlinker','__entitlements','-Xlinker',str(entitlements),'-I',str(HERE),str(HERE / 'runner.mm'),'-o',str(app / 'PreparedFiles'),'-framework','CoreGraphics','-framework','UIKit','-framework','Foundation','-framework','Security'],stdout=log,stderr=subprocess.STDOUT)
        run(['codesign','--force','--sign','-',str(app)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        run(['xcrun','simctl','install',args.simulator,str(app)])
        installed = True
        for phase in (1,2):
          with open(args.evidence / ('runtime-'+str(phase)+'.log'),'w') as log:
            completed = subprocess.run(['xcrun','simctl','launch','--console',args.simulator,BUNDLE],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=75)
        assert completed.returncode == 0, 'Native host failed; see runtime.log'
        container = Path(subprocess.check_output(['xcrun','simctl','get_app_container',args.simulator,BUNDLE,'data'],env=env,text=True).strip())
        result = json.loads((container / 'Documents/results-2.json').read_text())
        assert result['passed'] and len(result['cases']) == len(prepared['jobs']) and result['runId'] == run_id
        first=json.loads((container / 'Documents/results-1.json').read_text())
        assert first['passed'] and first['runId']==run_id and first['phase']==1 and result['phase']==2
        for case in result['cases']:
            exported=(container / 'Documents' / case['exportName']).read_bytes()
            retained=(fixture_root / 'prepared' / case['jobId'] / 'printable.bin').read_bytes()
            assert exported == retained and len(exported)==case['byteLength'] and hashlib.sha256(exported).hexdigest()==case['sha256']
            shutil.copyfile(container / 'Documents' / case['exportName'],args.evidence / case['exportName'])
        result['independentByteComparison']=True
        result['bridgeSha256'] = hashlib.sha256((REPO / 'apps/mobile/modules/local-project-storage/ios/PreparedFileBridge.mm').read_bytes()).hexdigest()
        result['simulator'] = args.simulator
        result['source'] = 'retained produced evidence plus synthetic imported protocol fixtures; no slicing rerun or physical fit claim' if args.produced_fixture else 'synthetic file-inspection protocol fixture; no geometry or slicing provenance'
        (args.evidence / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'passed':True,'cases':len(prepared['jobs']),'evidence':str(args.evidence.resolve()),'restart':True}))
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
