import {test} from 'node:test';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('cleanup supervisor cancels detached workers on cancellation and companion death',async()=>{
 const path=relative=>fileURLToPath(new URL(relative,import.meta.url));
 await promisify(execFile)(process.env.CAPTURE_TEST_PYTHON??'python3',[path('./fixtures/cleanup-supervisor-test.py'),path('../python/scan_job.py'),'-v'],{timeout:20000});
});

test('Linux cleanup works without the optional proc children interface',{skip:process.platform!=='linux'},async()=>{
 const path=relative=>fileURLToPath(new URL(relative,import.meta.url));
 await promisify(execFile)(process.env.CAPTURE_TEST_PYTHON??'python3',[path('./fixtures/cleanup-supervisor-test.py'),path('../python/scan_job.py'),'--without-children','-v'],{timeout:20000});
});

test('cleanup command leaves startup/export headroom above its worker budget',async t=>{
 const {mkdtemp,rm,writeFile,mkdir}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const assert=await import('node:assert/strict');
 const {createScanCleanupRunner}=await import('../dist/scan-cleanup-runner.js');
 const root=await mkdtemp(join(tmpdir(),'cleanup-budget-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const tool=join(root,'budget.py');await writeFile(tool,'import sys,time,json\ntime.sleep(1.2)\nprint(json.dumps(sys.argv))\n');
 const runner=createScanCleanupRunner({blender:'/unused/blender',toolPath:tool,correctTool:tool,timeoutMs:1000});
 assert.equal(runner.jobTimeoutMs,1800000);await mkdir(join(root,'imported'));
 const args=JSON.parse(await runner.cleanup.run('advise',{source:'unused',imported:join(root,'imported'),repaired:root,advice:root,corrected:root,stills:[],signal:new AbortController().signal}));
 assert.equal(args[args.indexOf('--max-seconds')+1],'1');
});
