import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir,cp,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {DependencyManager} from '../dist/dependencies.js';

const sources=fileURLToPath(new URL('../../../deploy/dependencies/',import.meta.url));
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'stm-deps-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const catalogDirectory=join(root,'catalog');await cp(sources,catalogDirectory,{recursive:true,filter:p=>!p.includes('node_modules')});
 const script=`import readline from 'node:readline';
 for await(const line of readline.createInterface({input:process.stdin})) {
  const q=JSON.parse(line); if(q.id===undefined)continue;
  const result=q.method==='initialize'?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'bambu-printer-mcp',version:'1.1.42'}}:q.method==='tools/list'?{tools:['get_printer_status','slice_stl','get_stl_info'].map(name=>({name,inputSchema:{type:'object',properties:{}}}))}:null;
  if(result===null)process.exit(90);
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
 }`;
 await writeFile(join(root,'worker.mjs'),script);
 execFileSync('python3',['-c',`import zipfile,sys\nwith zipfile.ZipFile(sys.argv[2],'w') as z:\n z.write(sys.argv[1],'dist/index.mjs')\n z.writestr('LICENSE','retained')`,join(root,'worker.mjs'),join(root,'bundle.zip')]);
 const bytes=await readFile(join(root,'bundle.zip'));let requests=0,bad=false;
 const server=createServer((_req,res)=>{requests++;res.end(bad?Buffer.from('corrupt'):bytes);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 const catalog=JSON.parse(await readFile(join(catalogDirectory,'catalog.json'),'utf8'));
 Object.assign(catalog['bambu-printer-mcp'],{url:`http://127.0.0.1:${server.address().port}`,integrity:'sha256-'+createHash('sha256').update(bytes).digest('base64'),entryPoint:'dist/index.mjs'});
 await writeFile(join(catalogDirectory,'catalog.json'),JSON.stringify(catalog));
 const options={catalogDirectory,python:'python3',env:{HOME:root,PATH:'/usr/bin:/bin'},platform:'linux',arch:'x64'};
 const directory=join(root,'managed'),manager=await DependencyManager.open(directory,options);t.after(()=>manager.close());
 return {root,options,directory,manager,get requests(){return requests;},set bad(v){bad=v;}};
}
async function settled(manager){
 const deadline=Date.now()+15000;
 while(Date.now()<deadline){const item=(await manager.get()).items.find(x=>x.id==='bambu-printer-mcp');if(item.state!=='Downloading')return item;await new Promise(r=>setTimeout(r,20));}
 throw Error('Dependency installation did not finish');
}
test('installation validates a real MCP handshake, coalesces starts, retains notices and survives restart',async t=>{
 const f=await fixture(t);assert.equal((await f.manager.get()).items.find(x=>x.id==='bambu-printer-mcp').state,'Missing');
 const starts=await Promise.all([f.manager.install('bambu-printer-mcp'),f.manager.install('bambu-printer-mcp')]);
 assert.equal(starts[0].item.state,'Downloading');assert.equal(starts[1].item.state,'Downloading');
 const item=await settled(f.manager);assert.equal(item.state,'Ready');assert.equal(f.requests,1);
 assert.equal(await readFile(join(item.executablePath,'../../LICENSE'),'utf8'),'retained');
 const again=await DependencyManager.open(f.directory,f.options);t.after(()=>again.close());assert.equal((await again.get()).items.find(x=>x.id==='bambu-printer-mcp').state,'Ready');
});
test('failed integrity yields Failed, and retry can recover without activating corrupt files',async t=>{
 const f=await fixture(t);f.bad=true;await f.manager.install('bambu-printer-mcp');
 const failed=await settled(f.manager);assert.equal(failed.state,'Failed');assert.equal(failed.executablePath,undefined);
 f.bad=false;await f.manager.retry('bambu-printer-mcp');assert.equal((await settled(f.manager)).state,'Ready');
});
test('generic is on demand and ffmpeg is required only for RTSP models',async t=>{
 const {manager}=await fixture(t);
 let r=await manager.get({backend:'bambu-printer-mcp',model:'p1s'});
 assert.equal(r.items.find(x=>x.id==='ffmpeg').required,false);assert.equal(r.items.find(x=>x.id==='mcp-3d-printer-server').required,false);
 r=await manager.get({backend:'bambu-printer-mcp',model:'x1c'});assert.equal(r.items.find(x=>x.id==='ffmpeg').required,true);
 r=await manager.get({backend:'mcp-3d-printer-server'});assert.equal(r.items.find(x=>x.id==='mcp-3d-printer-server').required,true);assert.equal(r.items.find(x=>x.id==='ffmpeg').required,false);
});
test('download requests cannot turn a path or a URL into a dependency',async t=>{
 const {manager}=await fixture(t);
 await assert.rejects(manager.install('../../outside'));await assert.rejects(manager.install('https://example.test/code'));
 await assert.rejects(manager.install('slicer'));
});
