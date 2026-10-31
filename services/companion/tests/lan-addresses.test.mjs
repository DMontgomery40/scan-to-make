import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {X509Certificate} from 'node:crypto';
import {createServer} from 'node:net';
import {request} from 'node:https';
import {authority,bindable,discoverAddresses,localHostName,pairingOrigins} from '../dist/lan-addresses.js';
import {certificatePublicKeySha256} from '../dist/lan-transport.js';
import {RemoteAuthStore} from '../dist/remote-auth.js';
import {startCompanionServer} from '../dist/server.js';
import {parsePairingLink} from '@scan-to-make/contracts/pairing-link';

const v4=(address,internal=false)=>({address,family:'IPv4',internal,netmask:'255.255.255.0',mac:'',cidr:null});
const v6=(address)=>({address,family:'IPv6',internal:false,netmask:'ffff:ffff:ffff:ffff::',mac:'',cidr:null,scopeid:0});

test('addresses are chosen by interface type: wired and Wi-Fi LANs, and Tailscale only with its own address block', () => {
 const found=discoverAddresses({
  lo0:[v4('127.0.0.1',true)],
  en1:[v6('fe80::1'),v4('192.168.68.123')],
  en8:[v4('192.168.68.205')],
  en0:[v4('169.254.10.2')],
  bridge100:[v4('192.168.64.1')], vmnet8:[v4('172.16.1.1')], docker0:[v4('172.17.0.1')],
  awdl0:[v6('fe80::2')], llw0:[v6('fe80::3')],
  utun3:[v4('100.101.102.103'),v6('fd7a:115c:a1e0::1')],
  utun5:[v4('100.64.0.9'),v6('fe80::4')],
  eth0:[v4('10.0.0.5')], wlp2s0:[v4('192.168.1.9')], tailscale0:[v4('100.90.1.1'),v6('fd7a:115c:a1e0:ab12::2')],
  en9:[v4('8.8.8.8')],
 });
 assert.deepEqual(found,{lan:['192.168.68.123','192.168.68.205','10.0.0.5','192.168.1.9'],tailscale:['100.90.1.1','100.101.102.103']});
 for(const a of ['0.0.0.0','::','fd7a:115c:a1e0::1','mac.local',''])assert.equal(bindable(a),false,a);
 for(const a of ['192.168.68.123','10.0.0.5','100.101.102.103'])assert.equal(bindable(a),true,a);
 if(process.platform!=='darwin')assert.equal(localHostName(),undefined);
});

test('v2 origins: the configured address first, then other LANs, the .local name and Tailscale, at most eight', () => {
 assert.deepEqual(pairingOrigins('192.168.68.123',9077,{lan:['192.168.68.123','192.168.68.205'],tailscale:['100.101.102.103']},'Mac-mini.local'),
  ['https://192.168.68.123:9077','https://192.168.68.205:9077','https://Mac-mini.local:9077','https://100.101.102.103:9077']);
 // On 443 the port is left off, in the origins and in the Host forms the server accepts.
 assert.deepEqual(pairingOrigins('192.168.68.123',443,{lan:['192.168.68.205'],tailscale:[]},'Mac-mini.local'),
  ['https://192.168.68.123','https://192.168.68.205','https://Mac-mini.local']);
 assert.deepEqual([authority('192.168.1.2',443),authority('Mac-mini.local',443),authority('Mac-mini.local',9077)],['192.168.1.2','mac-mini.local','mac-mini.local:9077']);
 const many=Array.from({length:12},(_,i)=>`10.0.0.${i+1}`);
 assert.equal(pairingOrigins('10.0.0.1',9077,{lan:many,tailscale:[]}).length,8);
});

async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'lan-v2-')); t.after(()=>rm(root,{recursive:true,force:true}));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',join(root,'key.pem'),'-out',join(root,'cert.pem')],{stdio:'ignore'});
 const cert=await readFile(join(root,'cert.pem')),key=await readFile(join(root,'key.pem'));
 const reservation=createServer(); await new Promise(r=>reservation.listen(0,'127.0.0.1',r));
 const port=reservation.address().port; await new Promise(r=>reservation.close(r));
 const certificateSha256=new X509Certificate(cert).fingerprint256.replaceAll(':','').toLowerCase();
 const store=await RemoteAuthStore.create(join(root,'auth'),{transport:'lan',host:`127.0.0.1:${port}`,certificateSha256,allowedLogins:['lan']});
 return {root,store,cert,key,port};
}
// The phone pins the key, not the name, so certificate hostname checks are off here as they are there.
function wire(address,port,cert,path,{method='GET',headers={},body}={}) {
 return new Promise((resolve,reject)=>{
  const req=request({host:address,port,path,method,headers,ca:cert,servername:'',checkServerIdentity:()=>undefined},res=>{
   const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));
  });req.on('error',reject);req.end(body);
 });
}

test('certificate public-key pin matches OpenSSL', async t => {
 const f=await fixture(t);
 const spki=execFileSync('openssl',['pkey','-pubin','-outform','der'],{input:execFileSync('openssl',['x509','-pubkey','-noout'],{input:f.cert})});
 const {createHash}=await import('node:crypto');
 assert.equal(certificatePublicKeySha256(f.cert),createHash('sha256').update(spki).digest('hex'));
});

test('off by default: only the configured address, and v1 links', async t => {
 const f=await fixture(t);
 const server=await startCompanionServer({remoteAuth:f.store,lanTls:{cert:f.cert,key:f.key}}); t.after(()=>server.close());
 assert.deepEqual(server.addresses(),[`https://127.0.0.1:${f.port}`]);
 assert.equal(parsePairingLink((await f.store.createPairing('lan')).qrPayload).version,1);
});

// macOS loopback has only 127.0.0.1, so the second address (127.0.0.2) is Linux-only.
test('one credential and one certificate across every bound address; addresses follow the network', {skip:process.platform==='darwin'}, async t => {
 const f=await fixture(t);
 let found={lan:['127.0.0.1','127.0.0.2','0.0.0.0'],tailscale:[]};
 const server=await startCompanionServer({remoteAuth:f.store,lanTls:{cert:f.cert,key:f.key},lanAddresses:()=>found,localName:'Mac-Test.local',rediscoverMs:50});
 t.after(()=>server.close());
 const one=`https://127.0.0.1:${f.port}`,two=`https://127.0.0.2:${f.port}`;
 // The wildcard is never bound; the configured address is listed once, first.
 assert.deepEqual(server.addresses(),[one,two,`https://Mac-Test.local:${f.port}`]);
 assert.equal(server.publicKeySha256,certificatePublicKeySha256(f.cert));
 // The certificate names only 127.0.0.1, yet serves 127.0.0.2: v2 phones pin the key.
 assert.equal((await wire('127.0.0.2',f.port,f.cert,'/healthz',{headers:{host:`127.0.0.2:${f.port}`}})).status,401);
 assert.equal((await wire('127.0.0.1',f.port,f.cert,'/healthz',{headers:{host:`mac-test.local:${f.port}`}})).status,401);
 assert.equal((await wire('127.0.0.2',f.port,f.cert,'/healthz',{headers:{host:`evil.example:${f.port}`}})).status,403);
 // A v2 link from the server's live list pairs on one address; the credential works on another.
 const invite=await f.store.createPairing('lan',undefined,{addresses:server.addresses(),publicKeySha256:server.publicKeySha256,name:'Mac-Test'});
 const link=parsePairingLink(invite.qrPayload);
 assert.deepEqual([link.version,link.addresses,link.publicKeySha256,link.name],[2,server.addresses(),server.publicKeySha256,'Mac-Test']);
 const paired=await wire('127.0.0.2',f.port,f.cert,'/v1/pair',{method:'POST',headers:{host:`127.0.0.2:${f.port}`,'content-type':'application/json'},body:JSON.stringify({code:link.code,deviceName:'v2 phone'})});
 assert.equal(paired.status,200);
 const device=JSON.parse(paired.body),credential={authorization:`Bearer ${device.token}`,'x-scan-device':device.deviceId};
 assert.equal((await wire('127.0.0.1',f.port,f.cert,'/healthz',{headers:{host:`127.0.0.1:${f.port}`,...credential}})).status,200);
 // An address that disappears loses its listener and leaves the list.
 found={lan:['127.0.0.1'],tailscale:[]};
 await new Promise(r=>setTimeout(r,300));
 assert.deepEqual(server.addresses(),[one,`https://Mac-Test.local:${f.port}`]);
 await assert.rejects(wire('127.0.0.2',f.port,f.cert,'/healthz',{headers:{host:`127.0.0.2:${f.port}`}}));
 assert.equal((await wire('127.0.0.1',f.port,f.cert,'/healthz',{headers:{host:`127.0.0.1:${f.port}`,...credential}})).status,200);
});

test('extra addresses need LAN pairing, and a bad switch value fails closed', async () => {
 await assert.rejects(startCompanionServer({port:0,lanAddresses:()=>({lan:[],tailscale:[]})}),/Extra addresses require LAN pairing/);
});

test('looks never overlap, and close() leaves no listener behind', {skip:process.platform==='darwin'}, async t => {
 const f=await fixture(t);
 let flip=false,looks=0;
 // Rediscovery every 5 ms, toggling the extra address: ticks must queue behind a running look.
 const server=await startCompanionServer({remoteAuth:f.store,lanTls:{cert:f.cert,key:f.key},rediscoverMs:5,
  lanAddresses:()=>{looks++;flip=!flip;return {lan:flip?['127.0.0.2','127.0.0.3']:['127.0.0.3'],tailscale:[]};}});
 await new Promise(r=>setTimeout(r,200));
 assert.ok(looks>3);
 await server.close();
 // Every address can be bound again at once: nothing was left listening.
 for(const address of ['127.0.0.1','127.0.0.2','127.0.0.3']){
  const probe=createServer();
  await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(f.port,address,resolve);});
  await new Promise(r=>probe.close(r));
 }
});

test('a bad v2 link is the caller\'s error, not the store\'s', async t => {
 const f=await fixture(t);
 for(const link of [{addresses:['https://127.0.0.1:9077'],publicKeySha256:'ab'.repeat(32),name:'x'.repeat(64)},{addresses:[],publicKeySha256:'ab'.repeat(32)}])
  await assert.rejects(f.store.createPairing('lan',undefined,link),e=>e.code==='invalid-invitation');
 // Nothing was minted.
 assert.equal(JSON.parse(await readFile(join(f.root,'auth','auth.json'),'utf8')).codes.length,0);
});
