import test from 'node:test';
import assert from 'node:assert/strict';
import {boundPrinterArguments,redactPrinterSecrets} from '../dist/bound-mcp.js';
const binding={host:'192.168.1.4',model:'p1s',type:'bambu',connectionMode:'bambu_network'};
test('saved route is injected and caller destination/executable/credential/route overrides are refused',()=>{
 assert.deepEqual(boundPrinterArguments(binding,'print_3mf',{three_mf_path:'/work/checked.3mf',bambu_model:'p1s'}),{three_mf_path:'/work/checked.3mf',bambu_model:'p1s',connection_mode:'bambu_network',connection_type:'lan'});
 for(const [name,args] of [['camera_snapshot',{host:'attacker'}],['camera_snapshot',{ffmpeg_path:'/evil'}],['print_3mf',{bambu_token:'evil'}],['print_3mf',{connection_mode:'lan_mqtt_ftps'}],['slice_stl',{slicer_path:'/evil'}],['slice_stl',{bambu_model:'x2d'}],['bambu_network_call',{method:'net.start_print'}],['blender_mcp_call',{tool:'execute_blender_code'}]]) assert.throws(()=>boundPrinterArguments(binding,name,args));
});
test('other brand requests are bound to the saved API host/type/port too',()=>{
 const other={host:'printer.local',type:'klipper',port:'7125'};
 assert.deepEqual(boundPrinterArguments(other,'upload_gcode',{host:other.host,type:other.type,port:other.port,print:true}),{host:other.host,type:other.type,port:other.port,print:true});
 for(const args of [{host:'elsewhere'},{type:'octoprint'},{port:'80'},{api_key:'override'}]) assert.throws(()=>boundPrinterArguments(other,'upload_gcode',args));
});
test('successful telemetry, JSON text and errors cannot return the stored access code',()=>{
 const secret='fixture-code';
 const value={content:[{type:'text',text:JSON.stringify({raw:{url:`rtsps://bblp:${secret}@printer/stream`}})}],structuredContent:{error:secret}};
 const clean=redactPrinterSecrets(value,[secret]);assert(!JSON.stringify(clean).includes(secret));assert.equal(JSON.parse(clean.content[0].text).raw.url,'rtsps://bblp:[redacted]@printer/stream');
});

import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {PrinterMcpClient,InMemoryElicitationRelay} from '../dist/index.js';
test('stdio proxy forwards the real MCP confirmation and saved connection mode',async t=>{
 const root=await mkdtemp(join(tmpdir(),'stm-bound-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const log=join(root,'calls.jsonl');await writeFile(log,'');
 const upstream={backend:'bambu-printer-mcp',process:{command:process.execPath,args:[fileURLToPath(new URL('./fixtures/fixture-printer-server.mjs',import.meta.url)),'bambu',log],cwd:root},timeouts:{connectMs:5000,toolMs:5000,elicitationMs:5000}};
 const config={...upstream,process:{command:process.execPath,args:[fileURLToPath(new URL('./fixtures/bound-printer-server.mjs',import.meta.url)),JSON.stringify(upstream),JSON.stringify(binding)],cwd:root}};
 for(const answer of ['decline','accept']) {
  const relay=new InMemoryElicitationRelay({timeoutMs:5000});let asked=0;
  relay.subscribe(prompt=>{asked++;assert.match(prompt.message,/bed-clearance/);setImmediate(()=>relay.respond(prompt.id,answer==='accept'?{action:'accept',content:{confirmed:true}}:{action:'decline'}));});
  const client=new PrinterMcpClient(config,{relay});t.after(()=>client.close());
  const catalog=await client.connect();assert(catalog.tools.some(t=>t.name==='print_3mf'));
  const call=client.callTool('print_3mf',{three_mf_path:join(root,'checked.3mf'),bambu_model:'p1s'});
  if(answer==='decline') assert.equal((await call).isError,true);else assert.notEqual((await call).isError,true);
  assert.equal(asked,1);await client.close();
 }
 const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(calls.filter(v=>v.tool==='print_3mf').length,2);
 assert(calls.filter(v=>v.tool==='print_3mf').every(v=>v.arguments.connection_mode==='bambu_network'&&v.arguments.connection_type==='lan'));
 assert.deepEqual(calls.filter(v=>v.elicitation).map(v=>v.elicitation.action),['decline','accept']);
});
