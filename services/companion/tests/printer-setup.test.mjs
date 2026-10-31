import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PrinterSetupService} from '../dist/printer-setup.js';
import {PrinterSetupChoiceSchema,printerRoutes} from '../dist/printer-setup-protocol.js';
import {parsePrinterAdvertisement} from '../dist/printer-discovery.js';
import {probePrinter} from '../dist/printer-setup-probe.js';
import {parseRequest} from '../dist/local-control-protocol.js';

const choice=()=>({kind:'bambu',printer_host:'192.168.1.4',bambu_serial:'EXAMPLE123',bambu_model:'p1s',keychainRef:randomUUID(),connection_mode:'lan_mqtt_ftps'});
const result={status:'connected',camera:'connected',fulu:'unavailable',model:'p1s',firmware:'01.08.05.00'};
const tick=()=>new Promise(r=>setImmediate(r));
async function setup(t,worker=async()=>({exitCode:0,stdout:JSON.stringify(result)})) {
 const root=await mkdtemp(join(tmpdir(),'stm-printer-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const service=await PrinterSetupService.open(root,worker);t.after(()=>service.close());return {root,service};
}
test('first creation races atomically; no keys or connection/camera results survive restart',async t=>{
 const {root,service}=await setup(t); const saved=await service.set(service.get().revision,choice());
 service.startCheck(saved.revision);await tick();assert.equal(service.get().check.state,'connected');
 assert.deepEqual((await PrinterSetupService.open(root)).get().choice,saved.choice);
 assert.equal((await PrinterSetupService.open(root)).get().check,null);
 const bytes=await readFile(join(root,'printer-setup.json'),'utf8');assert(!bytes.includes('connected'));assert(!bytes.includes('BAMBU_TOKEN'));
 assert.equal((await stat(join(root,'printer-setup.json'))).mode&0o777,0o600);
 await rm(join(root,'printer-setup.json'));const owners=await Promise.all(Array.from({length:6},()=>PrinterSetupService.open(root)));
 assert.equal(new Set(owners.map(v=>v.get().revision)).size,1);
 await chmod(join(root,'printer-setup.json'),0o644);await assert.rejects(PrinterSetupService.open(root));
});
test('set serializes CAS and cancelling/skipping invalidates old check',async t=>{
 let finish,signal,calls=0;
 const {service}=await setup(t,(_choice,_args,options)=>{calls++;signal=options.signal;return new Promise(r=>finish=r);});
 const saved=await service.set(service.get().revision,choice());service.startCheck(saved.revision);service.startCheck(saved.revision);assert.equal(calls,1);
 const first=service.set(saved.revision,{kind:'none'}),second=service.set(saved.revision,choice());await first;await assert.rejects(second,e=>e.code==='conflict');
 assert(signal.aborted);finish({exitCode:0,stdout:JSON.stringify(result)});await tick();assert.equal(service.get().check,null);
 assert.equal(service.startCheck(service.get().revision).check.state,'skipped');assert.equal(calls,1);
});
test('failed camera or conflicting observed model cannot report connected',async t=>{
 for (const changed of [{...result,camera:'failed'},{...result,model:'x2d'}]) {
  const {service}=await setup(t,async()=>({exitCode:0,stdout:JSON.stringify(changed)}));await service.set(service.get().revision,choice());service.startCheck(service.get().revision);await tick();assert.equal(service.get().check.state,'failed');
 }
});
test('unknown/invalid telemetry cannot inject logs or credentials into snapshots',async t=>{
 const {service}=await setup(t,async()=>({exitCode:0,stdout:JSON.stringify({...result,error:'SECRET'})}));
 await service.set(service.get().revision,choice());service.startCheck(service.get().revision);await tick();assert.equal(service.get().check.state,'failed');assert(!JSON.stringify(service.get()).includes('SECRET'));
});
test('SSDP trusts sender IP only; bounds/duplicates/unknown models stay safe',()=>{
 const message=(more='')=>Buffer.from('NOTIFY * HTTP/1.1\r\nLocation: 192.168.1.4\r\nUSN: EXAMPLE123\r\nDevModel.bambu.com: C12\r\nDevName.bambu.com: Workshop\r\nDevVersion.bambu.com: 01.08.05.00\r\n'+more+'\r\n');
 assert.deepEqual(parsePrinterAdvertisement(message(),'192.168.1.4'),{printer_host:'192.168.1.4',bambu_serial:'EXAMPLE123',bambu_model:'p1s',name:'Workshop',firmware:'01.08.05.00'});
 for (const ip of ['127.0.0.1','169.254.1.4','8.8.8.8','192.168.1.5']) assert.equal(parsePrinterAdvertisement(message(),ip),undefined);
 assert.equal(parsePrinterAdvertisement(message('Location: 192.168.1.4\r\n'),'192.168.1.4'),undefined);
 assert.equal(parsePrinterAdvertisement(Buffer.alloc(9000),'192.168.1.4'),undefined);
 assert.equal(parsePrinterAdvertisement(Buffer.from(message().toString().replace('C12','FUTURE')),'192.168.1.4').bambu_model,undefined);
});
test('routes use model/firmware, and FULU requires a successful runtime probe',()=>{
 assert.equal(printerRoutes('x2d')[0].connection_mode,'bambu_native');
 assert(!printerRoutes('x2d').some(v=>v.connection_mode==='lan_mqtt_ftps'));
 assert.equal(printerRoutes('p1s','01.08.04.00')[0].developerMode,'not-required');
 assert.equal(printerRoutes('p1s','01.08.05.00')[0].developerMode,'required');
 assert.equal(printerRoutes('p1s')[0].developerMode,'unknown');
 assert(!printerRoutes('p1s').some(v=>v.connection_mode==='bambu_network'));
 assert(printerRoutes('p1s',undefined,true).some(v=>v.connection_mode==='bambu_network'));
});
test('MCP probe calls only status, camera and bridge; keeps raw reports private',async()=>{
 const calls=[],configs=[],closed=[];
 const main={backend:'bambu-printer-mcp',process:{command:'/node',env:{BAMBU_TOKEN:'SECRET'}}},bridge={...main,process:{command:'/node',env:{}}};
 const make=config=>{configs.push(config);return {connect:async()=>{},close:async()=>closed.push(config),callTool:async(name,args)=>{
  calls.push([name,args]);const value=name==='get_printer_status'?{connected:true,status:'IDLE',model:'P1S',raw:{sw_ver:'01.08.05.00',secret:'SECRET'}}
   :name==='camera_snapshot'?{format:'image/jpeg',base64:Buffer.from([255,216,1,2,255,217]).toString('base64')}
   :args.connect?{connected:true,agentReady:true,command:'SECRET'}:{configured:true};return {content:[{type:'text',text:JSON.stringify(value)}]};}};};
 const probed=await probePrinter(main,bridge,make);assert.equal(probed.fulu,'available');assert.equal(probed.camera,'connected');assert(!JSON.stringify(probed).includes('SECRET'));assert.equal(closed.length,2);
 assert.deepEqual(calls.map(v=>v[0]),['get_printer_status','camera_snapshot','bambu_network_bridge_status','bambu_network_bridge_status']);assert.equal(configs[1].process.env.BAMBU_TOKEN,undefined);
});
test('shared choices validate identically; socket methods reject secret/env fields',async()=>{
 const fixtures=JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/printer-setup.json',import.meta.url),'utf8'));
 for (const f of fixtures) assert.equal(PrinterSetupChoiceSchema.safeParse(f.choice).success,f.valid,JSON.stringify(f.choice));
 for (const field of ['bambu_token','env','command','endpoint']) assert.throws(()=>parseRequest({v:1,id:randomUUID(),method:'printerSetup.set',params:{expectedRevision:randomUUID(),choice:{...choice(),[field]:'SECRET'}}}));
});

import {savedPrinterConfig,createConfiguredPrintHandoffServices} from '../dist/printer-setup-handoff.js';
test('configuration leases prevent route changes while a job is running',async t=>{
 const {service}=await setup(t);const saved=await service.set(service.get().revision,choice());
 let entered,release;const ready=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
 const run=service.withConfiguration(async record=>{assert.equal(record.revision,saved.revision);entered();await hold;});
 await ready;await assert.rejects(service.set(saved.revision,{kind:'none'}),e=>e.code==='conflict');
 release();await run;assert.equal((await service.set(saved.revision,{kind:'none'})).choice.kind,'none');
});
test('saved choices drive handoff; explicit skip disables legacy without deleting bundles',async t=>{
 const {root,service}=await setup(t);const legacy={backend:'bambu-printer-mcp',process:{command:'/legacy'}};
 const handoff=createConfiguredPrintHandoffServices(service,'/signed-app',join(root,'bundles'),legacy);
 assert.equal(service.get().configured,false);assert.equal(handoff.available,true);
 const saved=await service.set(service.get().revision,choice());assert.equal(handoff.selection.setupRevision,saved.revision);
 const config=savedPrinterConfig('/signed-app',saved.revision,saved.choice);
 assert.deepEqual(config.process.args.slice(0,4),['-i','/signed-app','--printer-worker','serve']);
 assert.equal(JSON.parse(config.process.args[4]).connection_mode,'lan_mqtt_ftps');
 assert.equal(savedPrinterConfig('/signed-app',saved.revision,{...saved.choice,connection_mode:'bambu_connect'}).dispatch,'handoff');
 const stl=Buffer.from('solid fixture\n'+' facet\n'.repeat(20)+'endsolid fixture\n');
 const bundle=await handoff.store.create({stl,prompt:'fixture',backend:'bambu-printer-mcp',selection:handoff.selection});
 await service.set(saved.revision,{...saved.choice,connection_mode:'bambu_connect'});
 await assert.rejects(handoff.runner.runBundle(handoff.store,bundle.id),e=>sanitizedFailureReason(e)==='printer-setup-changed');
 await service.set(service.get().revision,{kind:'none'});assert.equal(handoff.available,false);assert.equal((await handoff.store.read(bundle.id)).id,bundle.id);
});

import {sendDiscoveryProbes} from '../dist/printer-discovery.js';
import {sanitizedFailureReason} from '../../printer-handoff/dist/index.js';
test('each multicast probe finishes on its selected interface before switching',async()=>{
 let selected;const seen=[];
 const socket={addMembership:()=>{},setMulticastTTL:()=>{},setMulticastInterface:address=>{selected=address;},send:(_packet,port,host,done)=>{
  assert.equal(port,2021);assert.equal(host,'239.255.255.250');setImmediate(()=>{seen.push(selected);done(null);});
 }};
 await sendDiscoveryProbes(socket,['192.168.1.2','10.0.0.2'],()=>true);
 assert.deepEqual(seen,['192.168.1.2','10.0.0.2']);
});
test('legacy confirmation timeout and setup failure codes survive the service wrapper',async t=>{
 const {root,service}=await setup(t);
 const handoff=createConfiguredPrintHandoffServices(service,'/app',join(root,'handoffs'),{backend:'bambu-printer-mcp',process:{command:'/legacy'},timeouts:{elicitationMs:75000}});
 const pending=handoff.relay.request({method:'elicitation/create',params:{mode:'form',message:'fixture',requestedSchema:{type:'object',properties:{}}}});
 const prompt=handoff.relay.pending()[0];assert.equal(prompt.expiresAtMs-prompt.createdAtMs,75000);
 handoff.relay.cancelAll();await pending;
 await service.set(service.get().revision,{kind:'none'});
 await assert.rejects(handoff.runner.runBundle(handoff.store,randomUUID()),e=>sanitizedFailureReason(e)==='printer-not-configured');
});
