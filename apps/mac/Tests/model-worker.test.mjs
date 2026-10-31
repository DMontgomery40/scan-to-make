import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {cp,mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';

async function fixture(t){
 assert.equal(process.platform,'darwin','This integration test requires the built Mac app');
 assert(process.env.STM_MAC_BUILT_APP,'STM_MAC_BUILT_APP must identify the unsigned CI app');
 const root=await mkdtemp(join(tmpdir(),'stm-worker-app-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const app=join(root,'Fixture.app');await cp(process.env.STM_MAC_BUILT_APP,app,{recursive:true});
 const payload=join(app,'Contents/Resources/Payload');await rm(payload,{recursive:true,force:true});
 await mkdir(join(payload,'node/bin'),{recursive:true});
 await symlink(process.execPath,join(payload,'node/bin/node'));
 const cli=join(payload,'source/services/companion/dist');await mkdir(cli,{recursive:true});
 await writeFile(join(cli,'ai-tweak-cli.js'),`
   const {execFileSync}=require('node:child_process');
   process.on('SIGTERM',()=>{});
   process.stdout.write(JSON.stringify({pid:process.pid,pgid:Number(execFileSync('/bin/ps',['-o','pgid=','-p',String(process.pid)],{encoding:'utf8'}))})+'\\n');
   setInterval(()=>{},1000);
 `);
 return join(app,'Contents/MacOS/Scan to Make');
}

test('compiled signed-entry helper execs Node in its own PID/group; forced shutdown closes stdout',async t=>{
 const executable=await fixture(t),child=spawn(executable,['--model-worker','check'],{env:{},detached:true,stdio:['pipe','pipe','pipe']});
 let workerPid;
 t.after(()=>{for(const pid of [workerPid,child.pid])if(pid){try{process.kill(-pid,'SIGKILL');}catch{}}});
 const closed=once(child,'close');
 child.stdin.end('{"kind":"none"}');
 const ready=await Promise.race([once(child.stdout,'data'),closed.then(()=>{throw Error('helper exited before worker readiness')}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('helper readiness deadline')),5000);timer.unref();})]);
 const row=JSON.parse(ready[0].toString());workerPid=row.pid;
 assert.equal(row.pid,child.pid);assert.equal(row.pgid,child.pid);
 process.kill(-child.pid,'SIGTERM'); // Deliberately ignored by the fixture worker.
 process.kill(-child.pid,'SIGKILL');
 const result=await Promise.race([closed,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('stdout remained open after SIGKILL')),2000);timer.unref();})]);
 assert.equal(result[1],'SIGKILL');
 assert.throws(()=>process.kill(workerPid,0),e=>e.code==='ESRCH');
});

test('compiled helper refuses keyed caller environment before starting any worker',async t=>{
 const executable=await fixture(t);
 for(const variable of ['SCAN_TO_MAKE_CODEX_PATH','SCAN_TO_MAKE_AI_ENDPOINT','HOME']){
  const child=spawn(executable,['--model-worker','check'],{env:{[variable]:'/tmp/attacker'},stdio:['pipe','pipe','pipe']});
  const closed=once(child,'close');let output='';child.stdout.on('data',chunk=>output+=chunk);
  child.stdin.end(JSON.stringify({kind:'api',provider:'openai',model:'gpt-6-astra',keychainRef:'6f3de8c4-83b6-4ad7-9c6f-9b73c7077c73'}));
  assert.equal((await closed)[0],2);assert.equal(output,'');
 }
});
