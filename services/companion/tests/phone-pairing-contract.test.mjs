import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {X509Certificate} from 'node:crypto';
import {createServer} from 'node:net';
import {request} from 'node:https';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {RemoteAuthStore} from '../dist/remote-auth.js';
import {startCompanionServer} from '../dist/server.js';
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'lan-auth-')); t.after(()=>rm(root,{recursive:true,force:true}));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',join(root,'key.pem'),'-out',join(root,'cert.pem')],{stdio:'ignore'});
 const cert=await readFile(join(root,'cert.pem')),key=await readFile(join(root,'key.pem'));
 const reservation=createServer(); await new Promise(r=>reservation.listen(0,'127.0.0.1',r));
 const port=reservation.address().port; await new Promise(r=>reservation.close(r));
 const host=`127.0.0.1:${port}`;
 const certificateSha256=new X509Certificate(cert).fingerprint256.replaceAll(':','').toLowerCase();
 const store=await RemoteAuthStore.create(join(root,'auth'),{transport:'lan',host,certificateSha256,allowedLogins:['lan']});
 return {root,store,cert,key,port,certificateSha256};
}
function wire(url,cert,path,{method='GET',headers={},body}={}) {
 return new Promise((resolve,reject)=>{
  const req=request(new URL(path,url),{method,headers,ca:cert,servername:''},res=>{
   const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));
  });req.on('error',reject);req.end(body);
 });
}
async function phonePairingParser() {
 // Execute the phone's real TypeScript parser; only its unused native bridge is stubbed.
 const modules={},contract=await import('@scan-to-make/contracts/pairing-link');
 for(const name of ['pairing','pairingLink']){
  const source=await readFile(new URL(`../../../apps/mobile/src/companion/${name}.ts`,import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};
  const require=name=>{
   if(name==='react-native')return {NativeModules:{}};
   if(name==='./pairing')return modules.pairing;
   if(name==='@scan-to-make/contracts/pairing-link')return contract;
   throw Error(`Unexpected phone parser dependency: ${name}`);
  };
  runInNewContext(code,{module,exports:module.exports,require},{filename:`${name}.js`});
  modules[name]=module.exports;
 }
 return modules.pairingLink.parsePairingQR;
}
for(const command of ['pair-capture','pair-capture-and-printer-handoff'])test(`${command} CLI QR with certificate f is accepted by the current phone parser and pairs over HTTPS`,async t=>{
 const f=await fixture(t),parse=await phonePairingParser();
 const cli=fileURLToPath(new URL('../dist/remote-auth-cli.js',import.meta.url));
 const invite=JSON.parse(execFileSync(process.execPath,[cli,command,join(f.root,'auth')],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
 assert.equal(new URL(invite.qrPayload).searchParams.get('f'),f.certificateSha256);
 const parsed=parse(invite.qrPayload);
 assert.equal(parsed.baseUrl,f.store.baseUrl);assert.equal(parsed.code,invite.code);
 assert.equal(parsed.certificateSha256,f.certificateSha256);
 const server=await startCompanionServer({remoteAuth:f.store,lanTls:{cert:f.cert,key:f.key}});t.after(()=>server.close());
 const paired=await wire(parsed.baseUrl,f.cert,'/v1/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:parsed.code,deviceName:'Phone parser contract'})});
 assert.equal(paired.status,200);
 const device=JSON.parse(paired.body);
 assert.deepEqual(device.scopes,['generation:health','projects:read','projects:write','captures:read','captures:import',...(command==='pair-capture-and-printer-handoff'?['printer-handoff:use']:[])]);
 if(command==='pair-capture-and-printer-handoff')await f.store.authorize('lan',device.deviceId,device.token,'printer-handoff:use');
 else await assert.rejects(()=>f.store.authorize('lan',device.deviceId,device.token,'printer-handoff:use'));
 assert.equal((await wire(parsed.baseUrl,f.cert,'/healthz',{headers:{authorization:`Bearer ${device.token}`,'x-scan-device':device.deviceId}})).status,200);
 await f.store.revoke(device.deviceId);
 const withoutPin=new URL(invite.qrPayload);withoutPin.searchParams.delete('f');
 assert.throws(()=>parse(withoutPin.href),error=>error.code==='invalid-invitation');
 const badPin=new URL(invite.qrPayload);badPin.searchParams.set('f','invalid');
 assert.throws(()=>parse(badPin.href),error=>error.code==='invalid-invitation');
});
test('the companion still mints v1 byte-for-byte, and the phone reads a v2 link from the shared formatter',async t=>{
 const f=await fixture(t),parse=await phonePairingParser();
 const {formatPairingLink}=await import('@scan-to-make/contracts/pairing-link');
 const invite=await f.store.createPairing('lan');
 const q=new URLSearchParams({v:'1',u:f.store.baseUrl,c:invite.code,e:String(invite.expiresAt)});q.set('f',f.certificateSha256);
 assert.equal(invite.qrPayload,`scantomake://pair?${q}`);
 const addresses=[f.store.baseUrl,'https://davids-mac-mini.local:9077','https://100.101.102.103:9077'];
 const v2=formatPairingLink({version:2,addresses,code:invite.code,expiresAt:invite.expiresAt,publicKeySha256:'ab'.repeat(32),name:"David's Mac mini"});
 assert.deepEqual({...parse(v2)},{baseUrl:addresses[0],code:invite.code,addresses,publicKeySha256:'ab'.repeat(32),name:"David's Mac mini"});
 assert.throws(()=>parse(v2.replace('v=2','v=3')),error=>error.code==='unsupported-invitation');
});
