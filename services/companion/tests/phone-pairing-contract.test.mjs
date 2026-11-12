import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {request} from 'node:https';
import {startCompanionServer} from '../dist/server.js';
import {lanFixture} from './support/lan.mjs';
const fixture=t=>lanFixture(t,{prefix:'lan-auth-'});
function wire(url,cert,path,{method='GET',headers={},body}={}) {
 return new Promise((resolve,reject)=>{
  const req=request(new URL(path,url),{method,headers,ca:cert,servername:''},res=>{
   const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));
  });req.on('error',reject);req.end(body);
 });
}
// The iPhone app (packages/CounterpartKit, Swift) ports this parser rule for rule and is held to the same
// answers by packages/contracts/fixtures/pairing-link-vectors.json, which this file checks against the parser.
async function phonePairingParser() {
 const {parsePairingLink}=await import('@scan-to-make/contracts/pairing-link');
 return text=>parsePairingLink(text,Date.now());
}
for(const command of ['pair-capture','pair-capture-and-printer-handoff'])test(`${command} CLI QR with certificate f is accepted by the current phone parser and pairs over HTTPS`,async t=>{
 const f=await fixture(t),parse=await phonePairingParser();
 const cli=fileURLToPath(new URL('../dist/remote-auth-cli.js',import.meta.url));
 const server=await f.serve();t.after(()=>server.close()); // first: the store and port are final once it listens
 const invite=JSON.parse(execFileSync(process.execPath,[cli,command,f.authDir],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
 assert.equal(new URL(invite.qrPayload).searchParams.get('f'),f.certificateSha256);
 const parsed=parse(invite.qrPayload);
 assert.equal(parsed.baseUrl,f.store.baseUrl);assert.equal(parsed.code,invite.code);
 assert.equal(parsed.certificateSha256,f.certificateSha256);
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
 assert.deepEqual({...parse(v2)},{version:2,expiresAt:invite.expiresAt,code:invite.code,addresses,publicKeySha256:'ab'.repeat(32),name:"David's Mac mini"});
 assert.throws(()=>parse(v2.replace('v=2','v=3')),error=>error.code==='unsupported-invitation');
});
test('the shared pairing-link vectors are exactly what the parser answers',async()=>{
 const {parsePairingLink}=await import('@scan-to-make/contracts/pairing-link');
 const vectors=JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/pairing-link-vectors.json',import.meta.url),'utf8'));
 assert.ok(vectors.cases.length>100);
 for(const item of vectors.cases){
  let answer;
  try{answer={parsed:parsePairingLink(item.link,item.now)};}catch(error){answer={error:error.code};}
  assert.deepEqual(answer,item.parsed?{parsed:item.parsed}:{error:item.error},item.link);
 }
});

test('every phone HTTP response logs one bounded secret-free completion, including auth refusal', async t => {
 const f=await fixture(t);
 const server=await f.serve();
 t.after(()=>server.close());
 const logs=[], original=console.info;
 console.info=line=>logs.push(line);
 t.after(()=>{console.info=original;});
 const invite=await f.store.createPairing('lan');
 const issued=await f.store.exchange('lan',{code:invite.code,deviceName:'Trace phone'});
 const headers={authorization:`Bearer ${issued.token}`,'x-scan-device':issued.deviceId};
 assert.equal((await wire(f.store.baseUrl,f.cert,'/healthz',{headers})).status,200);
 assert.equal((await wire(f.store.baseUrl,f.cert,'/healthz',{headers:{...headers,authorization:`Bearer ${'x'.repeat(43)}`}})).status,401);
 const rows=logs.map(line=>JSON.parse(line));
 assert.equal(rows.length,2);
 assert.deepEqual(rows.map(row=>row.status),[200,401]);
 assert.ok(rows.every(row=>row.event==='phone.http'&&row.route==='health'&&row.device===issued.deviceId.slice(-6)&&row.ms>=0&&row.bytes>0));
 assert.equal(rows[1].refusal,'unauthorized');
 assert.ok(logs.every(line=>line.length<512&&!line.includes(issued.token)&&!line.includes(issued.deviceId)&&!line.includes(invite.code)));
});
test('a port taken between choosing it and the companion binding it is chosen again, and the pairing host follows (#690)',async t=>{
 const f=await fixture(t),parse=await phonePairingParser();
 const {createServer}=await import('node:net');
 // The other Node version's job, listening on port 0, is handed this fixture's port in the gap.
 const thief=createServer();await new Promise(r=>thief.listen(f.port,'127.0.0.1',r));t.after(()=>new Promise(r=>thief.close(r)));
 const taken=f.port;
 const server=await f.serve();t.after(()=>server.close());
 assert.notEqual(f.port,taken);
 assert.equal(server.url,`https://127.0.0.1:${f.port}`);assert.equal(f.store.baseUrl,server.url);
 const invite=await f.store.createPairing('lan');
 const paired=await wire(parse(invite.qrPayload).baseUrl,f.cert,'/v1/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:invite.code,deviceName:'Moved port'})});
 assert.equal(paired.status,200);
});
