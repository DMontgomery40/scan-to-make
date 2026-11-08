import assert from 'node:assert/strict';
import {test} from 'node:test';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {request} from 'node:http';
import {RemoteAuthStore} from '../dist/remote-auth.js';
import {tempDir} from './support/temp.mjs';

const display = await import('../dist/pairing-display.js').catch(e => {
  if(e.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw e;
});
async function fixture(t) {
  const root = await tempDir('qr-pair-');
  t.after(()=>rm(root,{recursive:true,force:true}));
  let now=Date.now();
  const store=await RemoteAuthStore.create(join(root,'auth'),{
    host:'companion.example-tail.ts.net',allowedLogins:['alice@example.test'],
  },()=>now);
  const invitation=await store.createPairing('alice@example.test');
  return {store,invitation,advance:ms=>{now+=ms;}};
}
function get(url,headers={},method='GET') {
  return new Promise((resolve,reject)=>{
    const req=request(url,{headers,method},res=>{
      const chunks=[];res.on('data',x=>chunks.push(x));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
    });req.on('error',reject);req.end();
  });
}
test('QR carries agreed versioned deep link while JSON fallback retains original fields',async t=>{
  const {store,invitation,advance}=await fixture(t);
  const link=new URL(invitation.qrPayload);
  assert.equal(link.protocol,'scantomake:');assert.equal(link.hostname,'pair');
  assert.deepEqual([...link.searchParams.keys()],['v','u','c','e']);
  assert.equal(link.searchParams.get('v'),'1');
  assert.equal(link.searchParams.get('u'),invitation.baseUrl);
  assert.equal(link.searchParams.get('c'),invitation.code);
  assert.equal(link.searchParams.get('e'),String(invitation.expiresAt));
  const fallback=JSON.parse(JSON.stringify(invitation));
  assert.equal(fallback.version,1);assert.equal(fallback.code,invitation.code);
  assert.equal(await store.isPairingActive(invitation.code),true);
  advance(300_000);assert.equal(await store.isPairingActive(invitation.code),false);
});
test('QR renders in terminal and localhost page; foreign hosts, browser origins and proxy headers never expose it',async t=>{
  const {store,invitation}=await fixture(t);
  assert.equal(typeof display.renderPairingQr,'function');
  const qr=await display.renderPairingQr(invitation);
  assert.match(qr.svg,/<svg/);assert.match(qr.terminal,/[▄▀█]/);
  const page=await display.startPairingPage(store,invitation);
  t.after(()=>page.close());
  const url=new URL(page.url);
  assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/pair');
  const ok=await get(page.url);
  assert.equal(ok.status,200);assert.match(ok.body,/<svg/);
  assert.equal(ok.headers['cache-control'],'no-store');
  assert.match(ok.headers['content-security-policy'],/default-src 'none'/);
  for(const headers of [
    {host:'attacker.example'}, {host:'localhost:'+url.port},
    {origin:'https://attacker.example'}, {'sec-fetch-site':'cross-site'},
    {'x-forwarded-host':url.host}, {'x-forwarded-for':'127.0.0.1'},
    {'tailscale-user-login':'alice@example.test'}, {'forwarded':'for=127.0.0.1'},
    {referer:'https://attacker.example/'},
  ]) {
    const denied=await get(page.url,headers);
    assert.equal(denied.status,403,JSON.stringify(headers));assert.ok(!denied.body.includes('<svg'));
  }
  assert.equal((await get(page.url,{},'POST')).status,405);
  assert.equal((await get(new URL('/other',page.url))).status,404);
  assert.equal((await get(page.url+'?unexpected=1')).status,404);
});
test('local page clears the QR when invitation is consumed, expired or auth storage unavailable',async t=>{
  for(const reason of ['used','expired','unavailable']) {
    const {store,invitation,advance}=await fixture(t);
    assert.equal(typeof display.startPairingPage,'function');
    const page=await display.startPairingPage(store,invitation);t.after(()=>page.close());
    if(reason==='used') await store.exchange('alice@example.test',{code:invitation.code,deviceName:'test'});
    if(reason==='expired') advance(300_000);
    if(reason==='unavailable') await rm(store.directory,{recursive:true});
    const result=await get(page.url);
    assert.equal(result.status,410);assert.ok(!result.body.includes('<svg'));
    assert.ok(!result.body.includes(invitation.code));
  }
});
