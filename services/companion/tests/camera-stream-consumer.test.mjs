import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {CameraFrames} from '../dist/printing/camera.js';
import {createObjectRoutes} from '../dist/objects/http.js';
const jpeg = Buffer.from([255,216,255,1,2,3]);
function fixture(t, streaming=true) {
  let clock=100000, startedAt='first', seq=1, holds=0;
  const calls=[];
  const properties={host:{},bambu_model:{},fps:{},idle_timeout_ms:{},since_seq:{},wait_ms:{},max_width:{},max_bytes:{},changed_only:{},min_change:{},timeout_ms:{}};
  const session={config:{backend:'mcp-3d-printer-server',selection:{host:'printer.local',model:'p1s'}},
    async connect(){},hold(){holds++;return()=>holds--;},hasTool:name=>name==='camera_snapshot'||streaming,
    getTool:()=>({inputSchema:{properties}}),async call(name,args){calls.push({name,args});
      return {structuredContent:name==='camera_stream_start'?{status:'running',startedAt}:name==='camera_snapshot'?{base64:jpeg.toString('base64')}:args.since_seq===seq?{status:'unchanged',seq}:{status:'frame',seq,base64:jpeg.toString('base64'),capturedAt:'2026-11-02T12:00:00Z'}};
    }};
  const camera=new CameraFrames({now:()=>clock});t.after(()=>camera.close());
  return {camera,session,calls,advance:()=>clock+=4000,restart:()=>{startedAt='second';seq=1;},get holds(){return holds;}};
}
test('camera viewers discover streaming, share requests, and retain unchanged frames without snapshots',async t=>{
  const f=fixture(t);
  const [a,b]=await Promise.all([f.camera.frame('p',f.session,{view:true,size:'card'}),f.camera.frame('p',f.session,{view:true,size:'card'})]);
  assert.equal(a.stream,true);assert.equal(a,b);
  assert.deepEqual(f.calls.map(c=>c.name),['camera_stream_start','camera_frame']);
  assert.equal(f.calls[1].args.max_width,300);assert.equal(f.calls[1].args.max_bytes,20000);assert.equal(f.calls[1].args.host,'printer.local');
  f.advance();
  const same=await f.camera.frame('p',f.session,{view:true,size:'card',fresh:true});
  assert.equal(same,a);assert.equal(f.calls.at(-1).args.since_seq,1);
  const full=await f.camera.frame('p',f.session,{view:true,size:'full'});
  assert.equal(full.stream,true);assert.equal(f.calls.at(-1).args.max_width,1200);assert.equal(f.calls.at(-1).args.max_bytes,42000);
  assert.equal(f.holds,1);
  f.camera.close();assert.equal(f.holds,0);
});
test('a restarted MCP stream resets old cursors and non-view snapshots never open a stream',async t=>{
  const f=fixture(t);
  await f.camera.frame('p',f.session,{view:true,size:'full'});
  f.restart();f.advance();
  await f.camera.frame('p',f.session,{view:true,size:'full',fresh:true});
  assert.equal(f.calls.at(-1).args.since_seq,0);
  await f.camera.frame('p',f.session,{fresh:true});
  assert.equal(f.calls.at(-1).name,'camera_snapshot');
});
test('published MCPs without stream tools preserve snapshot fallback',async t=>{
  const f=fixture(t,false);
  const frame=await f.camera.frame('p',f.session,{view:true,size:'full'});
  assert.deepEqual(frame.bytes,jpeg);assert.equal(frame.stream,undefined);
  assert.deepEqual(f.calls.map(c=>c.name),['camera_snapshot']);
});
test('camera HTTP routes carry size selection and return304 without repeating an unchanged JPEG',async t=>{
  const sizes=[];
  const routes=createObjectRoutes({async printerCamera(id,options){sizes.push(options?.size);return {bytes:jpeg,capturedAt:'2026-11-02T12:00:00Z',stream:true};}});
  const server=createServer((req,res)=>{void routes.handle(req,res,async()=>{},name=>req.headers[name]);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const url=`http://127.0.0.1:${server.address().port}/v1/objects/printers/p/camera.jpg?size=full`;
  const first=await fetch(url);assert.equal(first.status,200);assert.equal(first.headers.get('x-camera-stream'),'1');
  const etag=first.headers.get('etag');assert.ok(etag);assert.deepEqual(Buffer.from(await first.arrayBuffer()),jpeg);
  const second=await fetch(url,{headers:{'if-none-match':etag}});assert.equal(second.status,304);assert.equal((await second.arrayBuffer()).byteLength,0);
  assert.deepEqual(sizes,['full','full']);
});
