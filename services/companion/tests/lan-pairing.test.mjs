import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {X509Certificate} from 'node:crypto';
import {createServer} from 'node:net';
import {request} from 'node:https';
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
test('existing VPN pairs over direct verified TLS without Serve identity and still requires a device token',async t=>{
 const f=await fixture(t);
 const server=await startCompanionServer({remoteAuth:f.store,lanTls:{cert:f.cert,key:f.key}});t.after(()=>server.close());
 assert.equal(server.url,`https://127.0.0.1:${f.port}`);
 const invite=await f.store.createPairing('lan',['generation:health','projects:read','projects:write','captures:read','captures:import']);
 assert.equal(invite.certificateSha256,f.certificateSha256);
 assert.equal(new URL(invite.qrPayload).searchParams.get('f'),f.certificateSha256);
 assert.equal((await wire(server.url,f.cert,'/healthz')).status,401);
 const paired=await wire(server.url,f.cert,'/v1/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:invite.code,deviceName:'VPN phone'})});
 assert.equal(paired.status,200);const device=JSON.parse(paired.body);
 const headers={authorization:`Bearer ${device.token}`,'x-scan-device':device.deviceId};
 assert.equal((await wire(server.url,f.cert,'/healthz',{headers})).status,200);
 for(const bad of [{host:'attacker.example'},{origin:'https://attacker.example'},{'tailscale-user-login':'lan'},{'x-forwarded-host':f.store.host},{forwarded:'for=127.0.0.1'}]) {
  assert.equal((await wire(server.url,f.cert,'/healthz',{headers:{...headers,...bad}})).status,403);
 }
 await f.store.revoke(device.deviceId);
 assert.equal((await wire(server.url,f.cert,'/healthz',{headers})).status,401);
 await assert.rejects(()=>wire(server.url,undefined,'/healthz')); // no trust bypass
});
test('LAN transport refuses plaintext, changed certificate and public/wildcard listener configuration',async t=>{
 const f=await fixture(t);
 await assert.rejects(()=>startCompanionServer({remoteAuth:f.store}),/TLS/);
 const other=await fixture(t);
 await assert.rejects(()=>startCompanionServer({remoteAuth:f.store,lanTls:{cert:other.cert,key:other.key}}),/certificate/i);
 for(const host of ['0.0.0.0:9077','8.8.8.8:9077','user@192.168.1.2:9077','192.168.1.2:0']) {
  await assert.rejects(()=>RemoteAuthStore.create(join(f.root,'bad'),{transport:'lan',host,certificateSha256:f.certificateSha256,allowedLogins:['lan']}));
 }
});
