"""Bounded real Simulator detail-still and scan-processing bridge tests.

Requires built companion. Uses a separate disposable app/container. Uses real
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
import tempfile
import time
import uuid
import hashlib

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
BUNDLE = 'com.scantomake.stillsprocessingtests'
parser = argparse.ArgumentParser()
parser.add_argument('--simulator', required=True, help='Already booted Simulator UUID')
parser.add_argument('--evidence', type=Path, required=True)
args = parser.parse_args()
args.evidence.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')

def run(command, **kwargs):
    return subprocess.run(command, env=env, check=True, timeout=120, **kwargs)

simulators = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', '-j'], env=env))
assert any(d['udid'] == args.simulator and d['state'] == 'Booted'
           for group in simulators['devices'].values() for d in group), 'Target must already be booted'

with tempfile.TemporaryDirectory(prefix='native-stills-processing-') as temp:
    temp = Path(temp)
    fixture_log = open(temp / 'fixture.log', 'w+')
    fixture = subprocess.Popen(['node', str(REPO / 'apps/mobile/scripts/pairing-fixture/server.mjs')],
                               cwd=REPO, env=dict(env, SCAN_STILLS_PROCESSING_FIXTURE='1'),
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
        media = json.loads((fixture_root / 'stills-processing.json').read_text())
        config = {'runId':run_id,'invitation':invite,'media':media}
        (args.evidence / 'fixture-contract.json').write_text(json.dumps(media,indent=2))
        app = temp / 'StillsProcessing.app'
        app.mkdir(mode=0o700)
        (app / 'config.json').write_text(json.dumps(config))
        (app / 'config.json').chmod(0o600)
        with open(app / 'Info.plist','wb') as f:
            plistlib.dump({'CFBundleIdentifier':BUNDLE,'CFBundleExecutable':'StillsProcessing','CFBundleName':'Stills Processing Tests','CFBundlePackageType':'APPL','CFBundleVersion':'1','CFBundleShortVersionString':'1.0','MinimumOSVersion':'16.0','UIApplicationSceneManifest':{'UIApplicationSupportsMultipleScenes':False,'UISceneConfigurations':{'UIWindowSceneSessionRoleApplication':[{'UISceneConfigurationName':'Default','UISceneDelegateClassName':'SceneDelegate'}]}},'UIDeviceFamily':[1,2],'LSRequiresIPhoneOS':True,'NSAppTransportSecurity':{'NSAllowsLocalNetworking':True,'NSAllowsArbitraryLoads':True}}, f)
        sdk = subprocess.check_output(['xcrun','--sdk','iphonesimulator','--show-sdk-path'],env=env,text=True).strip()
        entitlements=temp / 'test.entitlements'
        with open(entitlements,'wb') as f:
            plistlib.dump({'application-identifier':'TESTTEAM.'+BUNDLE,'keychain-access-groups':['TESTTEAM.'+BUNDLE],'get-task-allow':True},f)
        with open(args.evidence / 'compile.log','w') as log:
            run(['xcrun','clang++','-fobjc-arc','-fblocks','-target','arm64-apple-ios16.0-simulator','-isysroot',sdk,'-Xlinker','-sectcreate','-Xlinker','__TEXT','-Xlinker','__entitlements','-Xlinker',str(entitlements),'-I',str(HERE),str(HERE / 'runner.mm'),'-o',str(app / 'StillsProcessing'),'-framework','CoreGraphics','-framework','UIKit','-framework','Foundation','-framework','Security','-framework','QuickLook','-framework','UniformTypeIdentifiers','-framework','ImageIO','-framework','PhotosUI','-framework','SceneKit','-framework','ModelIO'],stdout=log,stderr=subprocess.STDOUT)
        run(['codesign','--force','--sign','-',str(app)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        run(['xcrun','simctl','install',args.simulator,str(app)])
        installed = True
        for phase in (1,2):
          with open(args.evidence / ('runtime-'+str(phase)+'.log'),'w') as log:
            completed = subprocess.run(['xcrun','simctl','launch','--console',args.simulator,BUNDLE],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=75)
        assert completed.returncode == 0, 'Native host failed; see runtime.log'
        container = Path(subprocess.check_output(['xcrun','simctl','get_app_container',args.simulator,BUNDLE,'data'],env=env,text=True).strip())
        result = json.loads((container / 'Documents/results-2.json').read_text())
        first=json.loads((container / 'Documents/results-1.json').read_text())
        assert result['passed'] and result['runId'] == run_id and result['phase']==2
        assert first['passed'] and first['runId']==run_id and first['phase']==1
        assert first.get('imageUriCacheStates') is True, 'imageUri cache-miss and corrupt-cache states not exercised'
        assert result['jobId'] and first['jobId']==result['jobId']
        assert result['pngSha256']==media['png']['sha256']
        result['bridgeSha256'] = hashlib.sha256((REPO / 'apps/mobile/modules/local-project-storage/ios/StillsProcessingBridge.mm').read_bytes()).hexdigest()
        result['simulator'] = args.simulator
        result['source'] = 'synthetic pairing fixture with fake capture converter and scan runner; native transport proof only, no Blender, geometry or physical fit claim'
        (args.evidence / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'passed':True,'evidence':str(args.evidence.resolve()),'restart':True}))
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
