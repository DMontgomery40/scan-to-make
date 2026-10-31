"""Bounded real Simulator bridge fault tests. Requires built companion + pxr Python.

Uses a separate disposable app/container.
The fixture authenticates normal scoped requests; only its response is corrupted.
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
BUNDLE = 'com.scantomake.capturefaulttests'
parser = argparse.ArgumentParser()
parser.add_argument('--adoption-only', action='store_true')
parser.add_argument('--simulator', required=True, help='Already booted Simulator UUID')
parser.add_argument('--evidence', type=Path, required=True)
args = parser.parse_args()
args.evidence.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')
python = env.get('SCAN_TO_MAKE_CAPTURE_PYTHON', 'python3')

def run(command, **kwargs):
    return subprocess.run(command, env=env, check=True, timeout=120, **kwargs)

simulators = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', '-j'], env=env))
assert any(d['udid'] == args.simulator and d['state'] == 'Booted'
           for group in simulators['devices'].values() for d in group), 'Target must already be booted'

if args.adoption_only:
    with tempfile.TemporaryDirectory(prefix='native-adoption-') as temp_name:
        temp = Path(temp_name)
        app = temp / 'CaptureFaults.app'; app.mkdir()
        (app / 'config.json').write_text(json.dumps({'adoptionOnly': True}))
        with (app / 'Info.plist').open('wb') as f:
            plistlib.dump({'CFBundleIdentifier':BUNDLE,'CFBundleExecutable':'CaptureFaults','CFBundleName':'Capture Fault Tests','CFBundlePackageType':'APPL','CFBundleVersion':'1','CFBundleShortVersionString':'1.0','MinimumOSVersion':'18.0','UIApplicationSceneManifest':{'UIApplicationSupportsMultipleScenes':False,'UISceneConfigurations':{'UIWindowSceneSessionRoleApplication':[{'UISceneConfigurationName':'Default','UISceneDelegateClassName':'SceneDelegate'}]}},'UIDeviceFamily':[1,2],'LSRequiresIPhoneOS':True}, f)
        sdk = subprocess.check_output(['xcrun','--sdk','iphonesimulator','--show-sdk-path'],env=env,text=True).strip()
        with (args.evidence / 'compile.log').open('w') as log:
            run(['xcrun','clang++','-fobjc-arc','-fblocks','-target','arm64-apple-ios18.0-simulator','-isysroot',sdk,'-I',str(HERE),str(HERE / 'runner.mm'),'-o',str(app / 'CaptureFaults'),'-framework','CoreGraphics','-framework','UIKit','-framework','Foundation','-framework','QuickLook','-framework','SceneKit','-framework','UniformTypeIdentifiers'],stdout=log,stderr=subprocess.STDOUT)
        run(['codesign','--force','--sign','-',str(app)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        run(['xcrun','simctl','install',args.simulator,str(app)])
        try:
            with (args.evidence / 'runtime.log').open('w') as log:
                run(['xcrun','simctl','launch','--console',args.simulator,BUNDLE],stdout=log,stderr=subprocess.STDOUT)
            container = Path(subprocess.check_output(['xcrun','simctl','get_app_container',args.simulator,BUNDLE,'data'],env=env,text=True).strip())
            result = json.loads((container / 'Documents/results.json').read_text())
            assert result['passed'] and len(result['cases']) == 11
            result['bridgeSha256'] = hashlib.sha256((REPO / 'apps/mobile/modules/local-project-storage/ios/RetainedCaptureBridge.mm').read_bytes()).hexdigest()
            (args.evidence / 'results.json').write_text(json.dumps(result, indent=2)+'\n')
        finally:
            subprocess.run(['xcrun','simctl','terminate',args.simulator,BUNDLE],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            subprocess.run(['xcrun','simctl','uninstall',args.simulator,BUNDLE],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    raise SystemExit(0)

with tempfile.TemporaryDirectory(prefix='native-capture-faults-') as temp:
    temp = Path(temp)
    fixture_log = open(temp / 'fixture.log', 'w+')
    fixture = subprocess.Popen(['node', str(REPO / 'apps/mobile/scripts/pairing-fixture/server.mjs')],
                               cwd=REPO, env=dict(env, SCAN_CAPTURE_FIXTURE='1', SCAN_NATIVE_FAULTS='1'),
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
        base = invite['baseUrl']
        auth = {}
        def request(path, method='GET', body=None, headers=None):
            req = urllib.request.Request(base + path, data=body, method=method, headers={**auth, **(headers or {})})
            with urllib.request.urlopen(req, timeout=30) as res:
                return res.status, dict(res.headers), res.read()
        _, _, body = request('/v1/pair', 'POST', json.dumps({'code': invite['code'], 'deviceName': 'Native fault test'}).encode(), {'Content-Type':'application/json'})
        pairing = json.loads(body)
        pairing['baseUrl'] = base
        auth = {'Authorization': 'Bearer ' + pairing['token'], 'X-Scan-Device':pairing['deviceId']}
        project = {'formatVersion':'0.2.0','id':'nativefaults','revision':0,'brief':{'object':'Box','context':'Fixture','addition':'Holder'},'fit':None,'preview':None,'acceptedArtifact':None}
        status, headers, _ = request('/v1/saved-projects/nativefaults','PUT',json.dumps(project).encode(),{'Content-Type':'application/json','If-None-Match':'*'})
        assert status == 201
        etag = next(v for k,v in headers.items() if k.lower() == 'etag')
        run([python, str(REPO / 'tools/capture-mesh-convert/make_fixtures.py'), str(temp / 'sources')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        status, _, body = request('/v1/saved-projects/nativefaults/captures?projectRevision=0','POST',(temp / 'sources/two_layer.usdz').read_bytes(),{'Content-Type':'model/vnd.usdz+zip','If-Match':etag})
        assert status == 201
        imported = json.loads(body)
        artifact = imported['binding']['capture']['derived']
        # Converter metadata is richer; the native identity intentionally uses only these three fields.
        artifact = {k:artifact[k] for k in ('sha256','byteLength','mediaType')}
        run_id = str(uuid.uuid4())
        config = {'runId':run_id,'pairing':pairing,'faultKey':(fixture_root / 'fault-key').read_text(),'request':{'context':base+'|'+pairing['deviceId'],'method':'GET','path':'/v1/saved-projects/nativefaults/captures/'+imported['captureId']+'/artifacts/derived?projectRevision=0','etag':etag,'artifact':artifact}}
        app = temp / 'CaptureFaults.app'
        app.mkdir(mode=0o700)
        (app / 'config.json').write_text(json.dumps(config))
        (app / 'config.json').chmod(0o600)
        with open(app / 'Info.plist','wb') as f:
            plistlib.dump({'CFBundleIdentifier':BUNDLE,'CFBundleExecutable':'CaptureFaults','CFBundleName':'Capture Fault Tests','CFBundlePackageType':'APPL','CFBundleVersion':'1','CFBundleShortVersionString':'1.0','MinimumOSVersion':'16.0','UIApplicationSceneManifest':{'UIApplicationSupportsMultipleScenes':False,'UISceneConfigurations':{'UIWindowSceneSessionRoleApplication':[{'UISceneConfigurationName':'Default','UISceneDelegateClassName':'SceneDelegate'}]}},'UIDeviceFamily':[1,2],'LSRequiresIPhoneOS':True,'NSAppTransportSecurity':{'NSAllowsLocalNetworking':True,'NSAllowsArbitraryLoads':True}}, f)
        sdk = subprocess.check_output(['xcrun','--sdk','iphonesimulator','--show-sdk-path'],env=env,text=True).strip()
        with open(args.evidence / 'compile.log','w') as log:
            run(['xcrun','clang++','-fobjc-arc','-fblocks','-target','arm64-apple-ios16.0-simulator','-isysroot',sdk,'-I',str(HERE),str(HERE / 'runner.mm'),'-o',str(app / 'CaptureFaults'),'-framework','CoreGraphics','-framework','UIKit','-framework','Foundation','-framework','QuickLook','-framework','SceneKit','-framework','UniformTypeIdentifiers'],stdout=log,stderr=subprocess.STDOUT)
        run(['codesign','--force','--sign','-',str(app)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        run(['xcrun','simctl','install',args.simulator,str(app)])
        installed = True
        with open(args.evidence / 'runtime.log','w') as log:
            completed = subprocess.run(['xcrun','simctl','launch','--console',args.simulator,BUNDLE],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=75)
        assert completed.returncode == 0, 'Native host failed; see runtime.log'
        container = Path(subprocess.check_output(['xcrun','simctl','get_app_container',args.simulator,BUNDLE,'data'],env=env,text=True).strip())
        result = json.loads((container / 'Documents/results.json').read_text())
        assert result['passed'] and len(result['cases']) == 5 and result['runId'] == run_id
        result['bridgeSha256'] = hashlib.sha256((REPO / 'apps/mobile/modules/local-project-storage/ios/RetainedCaptureBridge.mm').read_bytes()).hexdigest()
        result['simulator'] = args.simulator
        result['source'] = 'synthetic two_layer.usdz through authenticated companion conversion'
        (args.evidence / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'passed':True,'cases':5,'evidence':str(args.evidence.resolve()),'fixturePatchesBridge':False}))
    finally:
        if installed:
            subprocess.run(['xcrun','simctl','terminate',args.simulator,BUNDLE],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
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
