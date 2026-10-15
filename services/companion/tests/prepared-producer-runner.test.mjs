import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createPreparedProducer} from '../dist/prepared-production.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
const python=process.env.PRODUCER_TEST_PYTHON??'/usr/bin/python3';
const mac={skip:process.platform!=='darwin'};
async function fixture(t,program){
 const root=await mkdtemp(join(tmpdir(),'producer-runner-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const script=join(root,'fixture.py');await writeFile(script,program);
 const config={python,script,expectedScriptSha256:sha(program),bundle:'/isolated/test/bundle',expectedVersion:'fixture',expectedBinarySha256:'b'.repeat(64),machine:'fixture',process:'fixture',filament:'fixture',timeoutSeconds:1};
 return {root,script,config,producer:createPreparedProducer(config)};
}
test('runner refuses unqualified platforms', {skip:process.platform==='darwin'},async()=>{
 const p=createPreparedProducer({python:'/usr/bin/python3',script:'/fixture.py',expectedScriptSha256:'a'.repeat(64),bundle:'/fixture.app',expectedVersion:'fixture',expectedBinarySha256:'b'.repeat(64),machine:'fixture',process:'fixture',filament:'fixture'});
 await assert.rejects(p.produce(Buffer.from('source')),/requires macOS/);
});
test('pinned script and aborted request reject before launch',mac,async t=>{
 const f=await fixture(t,'raise RuntimeError("should not run")\n');await writeFile(f.script,'changed');
 await assert.rejects(f.producer.produce(Buffer.from('source')),/identity mismatch/);
 const c=new AbortController();c.abort();await assert.rejects(f.producer.produce(Buffer.from('source'),c.signal),/cancelled/);
});
for(const [name,program,pattern] of [
 ['nonzero','raise SystemExit(7)\n',/failed/],
 ['missing outputs','pass\n',/ENOENT/],
 ['log overflow','import sys,time\nsys.stdout.write("x"*70000);sys.stdout.flush();time.sleep(20)\n',/log limit/],
])test(`runner rejects ${name} and removes temporary files`,mac,async t=>{
 const f=await fixture(t,program);await assert.rejects(f.producer.produce(Buffer.from('source')),pattern);
});
test('cancel reaps an owned child with closed pipes and ignored TERM, and cleans scratch',mac,async t=>{
 const f=await fixture(t,'');const pidFile=join(f.root,'child.json');
 const program=`import subprocess,sys,time,json,os\np=subprocess.Popen([sys.executable,'-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'],start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nopen(${JSON.stringify(pidFile)},'w').write(json.dumps({'pid':p.pid,'folder':os.getcwd()}))\ntime.sleep(60)\n`;
 await writeFile(f.script,program);const producer=createPreparedProducer({...f.config,expectedScriptSha256:sha(program)});
 const c=new AbortController();const pending=producer.produce(Buffer.from('source'),c.signal);const rejected=assert.rejects(pending,/cancelled/);
 let owned;for(let i=0;i<100;i++){try{owned=JSON.parse(await readFile(pidFile));break;}catch{}await new Promise(r=>setTimeout(r,20));}
 assert.ok(owned,'fixture child launched');c.abort();await rejected;
 assert.throws(()=>process.kill(owned.pid,0),{code:'ESRCH'});await assert.rejects(access(owned.folder),{code:'ENOENT'});
});
test('deadline still holds after worker pipe EOF',mac,async t=>{
 const f=await fixture(t,'import os,time\nos.close(1);os.close(2);time.sleep(60)\n');
 const start=Date.now();await assert.rejects(f.producer.produce(Buffer.from('source')),/timed out/);assert.ok(Date.now()-start<10000);
});
