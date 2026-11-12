import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {X509Certificate} from 'node:crypto';
import {request} from 'node:https';
import {RemoteAuthStore} from '../dist/remote-auth.js';
import {startCompanionServer} from '../dist/server.js';
import {lanFixture,onFreePort} from './support/lan.mjs';
const fixture=t=>lanFixture(t,{prefix:'lan-auth-'});
function wire(url,cert,path,{method='GET',headers={},body}={}) {
 return new Promise((resolve,reject)=>{
  const req=request(new URL(path,url),{method,headers,ca:cert,servername:''},res=>{
   const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));
  });req.on('error',reject);req.end(body);
 });
}
test('existing VPN pairs over direct verified TLS without Serve identity and still requires a device token',async t=>{
 const f=await fixture(t);
 const server=await f.serve();t.after(()=>server.close());
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

test('installer certificate and init-lan CLI agree with the persisted registry and HTTPS listener', async t => {
 const f=await fixture(t);
 const tls=join(f.root,'generated-tls');
 execFileSync('python3',[fileURLToPath(new URL('../../../deploy/companion/generate-lan-tls.py',import.meta.url)),tls,'127.0.0.1']);
 const cert=await readFile(join(tls,'cert.pem')),key=await readFile(join(tls,'key.pem'));
 const cli=fileURLToPath(new URL('../dist/remote-auth-cli.js',import.meta.url));
 // The CLI writes the port into the registry before the companion binds it: a port taken meanwhile is chosen again.
 const server=await onFreePort(async port=>{
  const directory=join(f.root,`cli-auth-${port}`);
  const url=`https://127.0.0.1:${port}`;
  const result=JSON.parse(execFileSync(process.execPath,[cli,'init-lan',directory,url,join(tls,'cert.pem')],{encoding:'utf8'}));
  assert.equal(result.transport,'lan');assert.equal(result.host,`127.0.0.1:${port}`);
  const store=await RemoteAuthStore.open(directory);
  assert.equal(store.transport,'lan');assert.equal(store.baseUrl,url);assert(store.allowsLogin('lan'));
  assert.equal(store.certificateSha256,new X509Certificate(cert).fingerprint256.replaceAll(':','').toLowerCase());
  return startCompanionServer({remoteAuth:store,lanTls:{cert,key}});
 },{first:f.port});t.after(()=>server.close());
 assert.equal((await wire(server.url,cert,'/healthz')).status,401);
 assert.throws(()=>execFileSync(process.execPath,[cli,'init-lan',join(f.root,'mismatch'),'https://127.0.0.2:9077',join(tls,'cert.pem')],{stdio:'pipe'}));
 await assert.rejects(()=>RemoteAuthStore.open(join(f.root,'mismatch')));
});

test('PRD §5.10: a phone enrols with the Mac\'s iCloud token: once, while current, for this Mac only, replacing its own install', async t => {
 const {IcloudEnrolment, ENROLMENT_TOKEN_LIFETIME_MS, ENROLMENT_TOKEN_REPLACE_MS} = await import('../dist/icloud-enrolment.js');
 const {DevicePresence} = await import('../dist/devices/presence.js');
 const f = await fixture(t);
 const clock = {now: Date.now()};
 const icloud = new IcloudEnrolment(join(f.root, 'auth', 'mac-id'), {now: () => clock.now});
 const presence = new DevicePresence(join(f.root, 'auth', 'device-presence.json'));
 const server = await f.serve({icloud, presence}); t.after(() => server.close());
 const install = 'i'.repeat(43);
 const enrol = body => wire(server.url, f.cert, '/v1/pair/icloud', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
 const first = await icloud.token();
 assert.equal((await icloud.token()).token, first.token, 'the same token until it is 5 minutes old');
 assert.match(first.macId, /^[0-9a-f-]{36}$/);
 assert.equal(await new IcloudEnrolment(join(f.root, 'auth', 'mac-id')).macId(), first.macId, 'macId is kept');
 const body = {macId: first.macId, enrolmentToken: first.token, installId: install, deviceName: 'David’s iPhone', model: 'iPhone18,2'};
 // Wrong Mac: refused, and the token is still good.
 assert.equal((await enrol({...body, macId: '00000000-0000-4000-8000-000000000000'})).status, 401);
 const ok = await enrol(body);
 assert.equal(ok.status, 200);
 const credential = JSON.parse(ok.body);
 assert.deepEqual(Object.keys(credential).sort(), ['deviceId', 'expiresAt', 'protocolVersion', 'scopes', 'token']);
 const qr = await f.store.createPairing('lan');
 assert.deepEqual(credential.scopes, (await f.store.listDevices()).find(device => device.deviceId === credential.deviceId).scopes);
 assert.ok(qr.code, 'QR pairing still works beside it');
 assert.equal((await presence.get(credential.deviceId)).model, 'iPhone18,2');
 // Single use.
 assert.equal((await enrol(body)).status, 401);
 // Re-enrolling the same install replaces its record, never adds one.
 clock.now += ENROLMENT_TOKEN_REPLACE_MS;
 const second = await icloud.token();
 assert.notEqual(second.token, first.token);
 const again = JSON.parse((await enrol({...body, enrolmentToken: second.token, deviceName: 'David’s iPhone 17'})).body);
 assert.equal(again.deviceId, credential.deviceId);
 assert.equal((await f.store.listDevices()).filter(device => device.deviceName.startsWith('David’s iPhone')).length, 1);
 // Expired: a token older than 10 minutes is refused.
 const old = await (async () => { clock.now += ENROLMENT_TOKEN_REPLACE_MS; return icloud.token(); })();
 clock.now += ENROLMENT_TOKEN_LIFETIME_MS;
 assert.equal(await icloud.redeem(old.macId, old.token), false, 'expired');
 // Malformed: 400.
 assert.equal((await enrol({...body, enrolmentToken: 'short'})).status, 400);
});

test('failed iCloud enrolment attempts are rate-limited like pairing attempts', async t => {
 const {IcloudEnrolment} = await import('../dist/icloud-enrolment.js');
 const f = await fixture(t);
 const icloud = new IcloudEnrolment(join(f.root, 'auth', 'mac-id'));
 const server = await f.serve({icloud}); t.after(() => server.close());
 const {macId} = await icloud.token();
 const statuses = [];
 for (let i = 0; i < 6; i++) statuses.push((await wire(server.url, f.cert, '/v1/pair/icloud', {method: 'POST', headers: {'content-type': 'application/json'},
  body: JSON.stringify({macId, enrolmentToken: 'x'.repeat(43), installId: 'i'.repeat(43), deviceName: 'Guess'})})).status);
 assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
});
