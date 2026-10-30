import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {startHostedServer,hostedHealth} from '../dist/hosted.js';
import {createInMemoryTrialLedger} from '../dist/metering.js';
import {DETAIL_STILL_SCHEMA_ID} from '@scan-to-make/contracts/detail-still';
import {SCAN_PROCESSING_SCHEMA_ID} from '@scan-to-make/contracts/scan-processing';

function wire(server,path,{method='GET',headers={}}={}){
 return new Promise((resolve,reject)=>{
  const req=httpRequest(server.url+path,{method,headers},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);
   res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
  });
  req.on('error',reject);req.end();
 });
}

test('health reports the shared contract identities over loopback HTTP',async t=>{
 const server=await startHostedServer({port:0});t.after(()=>server.close());
 const response=await wire(server,'/healthz');
 assert.equal(response.status,200);
 const health=JSON.parse(response.body);
 assert.deepEqual(health,hostedHealth());
 assert.deepEqual(health.contracts,[DETAIL_STILL_SCHEMA_ID,SCAN_PROCESSING_SCHEMA_ID]);
 assert.equal(health.protocolVersion,'0.1.0');
});

test('unknown routes, wrong methods and browser-origin requests fail closed',async t=>{
 const server=await startHostedServer({port:0});t.after(()=>server.close());
 assert.equal((await wire(server,'/v1/scan-processing')).status,404);
 assert.equal((await wire(server,'/healthz',{method:'POST'})).status,405);
 assert.equal((await wire(server,'/healthz',{headers:{origin:'https://example.test'}})).status,403);
 const failure=JSON.parse((await wire(server,'/nope')).body);
 assert.deepEqual(Object.keys(failure),['error']);
 assert.equal(failure.error.code,'not-found');
});

test('trial ledger enforces per-user, per-unit limits atomically',()=>{
 const ledger=createInMemoryTrialLedger({'scan-processing':2,'ai-correction':1,'design-generation':0,slicing:3});
 assert.deepEqual(ledger.check('alice','scan-processing'),{used:0,limit:2,allowed:true});
 assert.equal(ledger.tryRecord('alice','scan-processing'),true);
 assert.equal(ledger.tryRecord('alice','scan-processing'),true);
 assert.equal(ledger.tryRecord('alice','scan-processing'),false);
 assert.deepEqual(ledger.check('alice','scan-processing'),{used:2,limit:2,allowed:false});
 // Other users and other units are independent budgets.
 assert.equal(ledger.tryRecord('bob','scan-processing'),true);
 assert.equal(ledger.tryRecord('alice','ai-correction'),true);
 assert.equal(ledger.tryRecord('alice','design-generation'),false);
 assert.throws(()=>ledger.check('','scan-processing'));
 assert.throws(()=>createInMemoryTrialLedger({'scan-processing':-1,'ai-correction':0,'design-generation':0,slicing:0}));
});
