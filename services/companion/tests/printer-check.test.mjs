import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPrinterCheck} from '../dist/printer-check.js';
const config={backend:'bambu-printer-mcp',process:{command:'/fixture/node'},selection:{model:'p1s',host:'saved-printer.local'}};
const result=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const tick=()=>new Promise(r=>setImmediate(r));

for(const format of ['jpeg','image/jpeg'])test(`diagnostic accepts ${format}, uses saved selection and retains only a redacted receipt`,async()=>{
  const calls=[];let release;const hold=new Promise(r=>{release=r;});let closed=0;
  const jpeg=Buffer.from([255,216,1,2,3,255,217]);
  const check=createPrinterCheck(config,()=>({hasTool:()=>true,connect:async()=>hold,close:async()=>{closed++;},callTool:async(name,args)=>{
    calls.push([name,args]);return result(name==='get_printer_status'?{connected:true,status:'FINISH',private:'secret'}:{format,base64:jpeg.toString('base64')});
  }}));
  assert.deepEqual(check.get(),{state:'idle'});assert.deepEqual(check.get(true),{state:'checking'});
  assert.deepEqual(check.get(true),{state:'checking'});release();await tick();
  assert.deepEqual(calls,[['get_printer_status',{host:'saved-printer.local'}],['camera_snapshot',{host:'saved-printer.local',timeout_ms:8000,bambu_model:'p1s'}]]);
  assert.deepEqual(check.get(),{state:'complete',status:'connected',camera:'connected',cameraBytes:jpeg.length,cameraSha256:createHash('sha256').update(jpeg).digest('hex')});
  assert.equal(closed,1);await check.close();
});
test('generic status passes the retained type, host and port without requesting a Bambu camera',async()=>{
  const calls=[];const check=createPrinterCheck({backend:'mcp-3d-printer-server',process:{command:'/fixture'},selection:{host:'octo.local',printerType:'octoprint',port:'5000'}},()=>({hasTool:()=>true,connect:async()=>{},close:async()=>{},callTool:async(name,args)=>{calls.push([name,args]);return result({state:'Operational'});}}));
  check.get(true);await tick();assert.deepEqual(calls,[['get_printer_status',{host:'octo.local',type:'octoprint',port:'5000'}]]);
  assert.deepEqual(check.get(),{state:'complete',status:'connected',camera:'not-supported'});await check.close();
});
test('failed status never calls camera; camera failure cannot become a successful check',async()=>{
  for(const connected of [false,true]){
    const calls=[];const check=createPrinterCheck(config,()=>({hasTool:()=>true,connect:async()=>{},close:async()=>{},callTool:async name=>{calls.push(name);if(name==='camera_snapshot')throw Error('private token');return result({connected});}}));
    check.get(true);await tick();assert.deepEqual(check.get(),{state:'complete',status:connected?'connected':'failed',camera:'failed'});
    assert.deepEqual(calls,connected?['get_printer_status','camera_snapshot']:['get_printer_status']);await check.close();
  }
});

for(const mode of ['disabled','missing'])test(`camera ${mode} preserves status without opening the camera`,async()=>{
  const calls=[];const check=createPrinterCheck({...config,cameraSnapshot:mode!=='disabled'},()=>({hasTool:()=>mode!=='missing',connect:async()=>{},close:async()=>{},callTool:async name=>{calls.push(name);return result({connected:true});}}));
  check.get(true);await tick();assert.deepEqual(calls,['get_printer_status']);
  assert.deepEqual(check.get(),{state:'complete',status:'connected',camera:'not-supported'});await check.close();
});
