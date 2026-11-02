import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {CameraFrames, CameraUnavailableError} from '../dist/printing/camera.js';
import {createObjectRoutes} from '../dist/objects/http.js';
const jpeg = Buffer.from([255,216,255,1,2,3]);
function fixture(t, streaming=true) {
  let clock=100000, startedAt='first', seq=1, holds=0;
  const calls=[];
  const properties={host:{},bambu_model:{},fps:{},idle_timeout_ms:{},since_seq:{},wait_ms:{},max_width:{},max_bytes:{},changed_only:{},min_change:{},timeout_ms:{}};
  const session={config:{backend:'mcp-3d-printer-server',selection:{host:'printer.local',model:'p1s'}},
    async connect(){},hold(){holds++;return()=>holds--;},hasTool:name=>name==='camera_snapshot'||(streaming && ['camera_stream_start','camera_frame','camera_stream_stop'].includes(name)),
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

test('long-lived watchers share the MCP read and cancellation releases only the departing viewer',async t=>{
  const f=fixture(t),a=new AbortController(),b=new AbortController();
  const first=f.camera.watch('p',f.session,{size:'full',signal:a.signal});
  const second=f.camera.watch('p',f.session,{size:'full',signal:b.signal});
  const [one,two]=await Promise.all([first.next(),second.next()]);
  assert.equal(one.value.stream,true);assert.equal(two.value,one.value);assert.equal(f.holds,1);
  a.abort();await first.return();assert.equal(f.holds,1,'the other viewer retains the source session');
  b.abort();await second.return();assert.equal(f.holds,0);
});

test('long-lived delivery rejects an older MCP before starting any camera',async t=>{
  const f=fixture(t,false),controller=new AbortController();
  const stream=f.camera.watch('p',f.session,{signal:controller.signal});
  await assert.rejects(stream.next(),error=>error.reason==='not-supported');
  assert.equal(f.calls.length,0);assert.equal(f.holds,0);
});

test('HTTP streaming declares its format, sends incremental bounded lines, and cancels its watcher on disconnect',async t=>{
  let stopped=false,authorized=0;
  const routes=createObjectRoutes({async printerCameraStream(id,options){return (async function*(){try{yield {bytes:jpeg,capturedAt:'2026-11-02T12:00:00Z',seq:7,stream:true};await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));}finally{stopped=true;}})();}});
  const server=createServer((req,res)=>{void routes.handle(req,res,async()=>{authorized++;},name=>req.headers[name]);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const controller=new AbortController();
  const reply=await fetch(`http://127.0.0.1:${server.address().port}/v1/objects/printers/p/camera.jpg?stream=1&size=full`,{signal:controller.signal});
  assert.match(reply.headers.get('content-type'),/application\/x-ndjson/);assert.equal(reply.headers.get('x-camera-protocol'),'1');
  const reader=reply.body.getReader();const chunk=await reader.read();const frame=JSON.parse(Buffer.from(chunk.value).toString().trim());
  assert.equal(frame.v,1);assert.equal(frame.seq,7);assert.deepEqual(Buffer.from(frame.base64,'base64'),jpeg);
  controller.abort();
  for(let i=0;i<100&&!stopped;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(stopped,true);assert.ok(authorized>0);
});


test('HTTP unsupported streaming remains a404 JSON reply before camera stream headers',async t=>{
  const routes=createObjectRoutes({async printerCameraStream(){return (async function*(){throw new CameraUnavailableError('not-supported');})();}});
  const server=createServer((req,res)=>{void routes.handle(req,res,async()=>{},name=>req.headers[name]);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const reply=await fetch(`http://127.0.0.1:${server.address().port}/v1/objects/printers/p/camera.jpg?stream=1`);
  assert.equal(reply.status,404);assert.match(reply.headers.get('content-type'),/application\/json/);
  assert.equal((await reply.json()).error.code,'not-supported');assert.equal(reply.headers.get('x-camera-protocol'),null);
});

test('departing viewer cancels immediately without aborting another shared long poll', {timeout:6000},async t=>{
  const f=fixture(t),a=new AbortController(),b=new AbortController();
  const first=f.camera.watch('p',f.session,{size:'full',signal:a.signal}),second=f.camera.watch('p',f.session,{size:'full',signal:b.signal});
  await Promise.all([first.next(),second.next()]);
  const original=f.session.call;let pendingSignal;
  f.session.call=async(name,args,options)=>{
    if(name!=='camera_frame')return original(name,args,options);
    pendingSignal=options.signal;
    return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
  };
  const x=first.next(),y=second.next();
  for(let i=0;i<500&&!pendingSignal;i++)await new Promise(r=>setTimeout(r,5));
  assert.ok(pendingSignal);
  a.abort();await assert.rejects(x);assert.equal(pendingSignal.aborted,false);assert.equal(f.holds,1);
  f.camera.close();await assert.rejects(y);assert.equal(pendingSignal.aborted,true);assert.equal(f.holds,0,'shutdown releases the last viewer once');
});


test('an open HTTP camera stops before another frame when authorization is revoked',async t=>{
  let authorized=0,stopped=false;
  const routes=createObjectRoutes({async printerCameraStream(){return (async function*(){try{yield {bytes:jpeg,capturedAt:'2026-11-02T12:00:00Z',seq:1};await new Promise(r=>setTimeout(r,10));yield {bytes:jpeg,capturedAt:'2026-11-02T12:00:01Z',seq:2};}finally{stopped=true;}})();}});
  const server=createServer((req,res)=>{void routes.handle(req,res,async()=>{if(++authorized>2)throw new Error('revoked');},name=>req.headers[name]);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const reply=await fetch(`http://127.0.0.1:${server.address().port}/v1/objects/printers/p/camera.jpg?stream=1`);
  const lines=(await reply.text()).trim().split('\n');
  assert.equal(lines.length,1);assert.equal(JSON.parse(lines[0]).seq,1);assert.equal(stopped,true);assert.equal(authorized,3);
});


test('explicit runtime capability refusal keeps working snapshots without starting a stream', async t => {
  const f = fixture(t), hasTool = f.session.hasTool, call = f.session.call;
  f.session.catalog = {};
  f.session.hasTool = name => name === 'counterpart_printer_info' || hasTool(name);
  let reads = 0;
  f.session.call = async (name, args, options) => {
    if (name !== 'counterpart_printer_info') return call(name, args, options);
    reads++;
    assert.equal(options.timeoutMs,10000); assert.ok(options.signal instanceof AbortSignal);
    return {structuredContent: {contract:'counterpart/1',server:{name:'generic',version:'2'},printer:{kind:'octoprint',host:'printer.local'},
      capabilities:{progress:true,layers:true,camera:'http-snapshot',cameraStream:false,filaments:'single',pause:true,resume:true,cancel:true,print3mf:false,gcode:true}}};
  };
  const iterator = f.camera.watch('p', f.session, {signal:new AbortController().signal});
  await assert.rejects(iterator.next(), error => error.reason === 'not-supported');
  const frame = await f.camera.frame('p', f.session, {view:true});
  assert.deepEqual(frame.bytes,jpeg); assert.equal(frame.stream,undefined);
  assert.deepEqual(f.calls.map(c=>c.name),['camera_snapshot']); assert.equal(reads,1);
  f.session.catalog = {};
  await f.camera.frame('p', f.session, {view:true,fresh:true});
  assert.equal(reads,2,'a new connection rechecks its runtime');
});

test('structured unsupported start falls back but real source failures do not', async t => {
  for (const status of ['not-supported','unavailable']) {
    const f = fixture(t), call = f.session.call;
    f.session.catalog = {};
    f.session.call = async (name,args,options) => name === 'camera_stream_start'
      ? {structuredContent:{status,reason:status==='not-supported'?'runtime':'auth'}} : call(name,args,options);
    await assert.rejects(f.camera.watch('p',f.session,{signal:new AbortController().signal}).next(),
      error => error.reason === (status==='not-supported'?'not-supported':'unreachable'));
    if (status==='not-supported') {
      assert.deepEqual((await f.camera.frame('p',f.session,{view:true})).bytes,jpeg);
      assert.equal(f.calls.at(-1).name,'camera_snapshot');
    } else {
      await assert.rejects(f.camera.frame('p',f.session,{view:true}), error=>error.reason==='unreachable');
      assert.equal(f.calls.length,0,'authentication failures never invoke snapshot fallback');
    }
  }
});


test('capability lookup failures do not become sticky unsupported or trigger snapshots', async t => {
  const f=fixture(t),hasTool=f.session.hasTool;
  f.session.hasTool=name=>name==='counterpart_printer_info'||hasTool(name);
  let reads=0;
  f.session.call=async name=>{assert.equal(name,'counterpart_printer_info');reads++;throw Error('connection failed');};
  await assert.rejects(f.camera.watch('p',f.session,{signal:new AbortController().signal}).next(),error=>error.reason==='unreachable');
  await assert.rejects(f.camera.frame('p',f.session,{view:true}),error=>error.reason==='unreachable');
  assert.equal(reads,2,'the next request can recover from a temporary discovery error');
});


test('immediate unchanged MCP replies remain paced while a viewer is waiting', {timeout:6000}, async t => {
  const f=fixture(t), call=f.session.call, controller=new AbortController();
  let frames=0;
  f.session.call=async(name,args,options)=>{
    if(name==='camera_frame') {
      frames++;
      if(frames>3) throw Error('unpaced repeated reads');
    }
    return call(name,args,options);
  };
  const viewer=f.camera.watch('p',f.session,{size:'full',signal:controller.signal});
  await viewer.next();
  const pending=viewer.next();
  pending.catch(()=>{});
  await new Promise(resolve=>setTimeout(resolve,2250));
  assert.equal(frames,2,'one read per cadence even when the MCP returns unchanged immediately');
  controller.abort(); await assert.rejects(pending); assert.equal(f.holds,0);
});
