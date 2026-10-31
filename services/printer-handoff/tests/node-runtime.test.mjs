import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {appOwnedPrinterProcess} from '../dist/node-runtime.js';
import {PrinterMcpClient} from '../dist/index.js';

test('bundled Node replaces a legacy absolute runtime without changing printer configuration',async()=>{
  const original={command:'/opt/homebrew/opt/node@24/bin/node',args:['/private/backend/dist/index.js'],cwd:'/private/backend',env:{PRINTER_HOST:'printer.local',PATH:'/opt/homebrew/bin',TOKEN:'test-only'}};
  const before=structuredClone(original);
  const selected=await appOwnedPrinterProcess(original,'/Applications/Scan to Make.app/Contents/Resources/Payload/node/bin/node');
  assert.equal(selected.command,'/Applications/Scan to Make.app/Contents/Resources/Payload/node/bin/node');
  assert.deepEqual(selected.args,original.args);assert.equal(selected.cwd,original.cwd);
  assert.equal(selected.env.TOKEN,'test-only');assert.equal(selected.env.PRINTER_HOST,'printer.local');
  assert.equal(selected.env.PATH,'/Applications/Scan to Make.app/Contents/Resources/Payload/node/bin:/opt/homebrew/bin');
  assert.deepEqual(original,before);
  assert.deepEqual(await appOwnedPrinterProcess(original,undefined),original);
});

test('npm bin symlinks use the pinned runtime; native app workers remain executable',async t=>{
  const root=await mkdtemp(join(tmpdir(),'stm-node-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const entry=join(root,'entry.js'),bin=join(root,'bambu-printer-mcp');
  await writeFile(entry,'#!/usr/bin/env node\n');await symlink(entry,bin);
  const result=await appOwnedPrinterProcess({command:bin,args:['--stdio']},process.execPath);
  assert.equal(result.command,process.execPath);assert.deepEqual(result.args,[bin,'--stdio']);
  const native={command:'/usr/bin/env',args:['-i','/Applications/Scan to Make.app/Contents/MacOS/Scan to Make','--printer-worker','serve']};
  assert.deepEqual((await appOwnedPrinterProcess(native,process.execPath)).args,native.args);
  await assert.rejects(appOwnedPrinterProcess(native,'node'));
});

test('real MCP connection uses bundled runtime even when legacy node is absent',async t=>{
  const root=await mkdtemp(join(tmpdir(),'stm-node-child-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const fixture=fileURLToPath(new URL('./fixtures/fixture-printer-server.mjs',import.meta.url));
  const prior=process.env.SCAN_TO_MAKE_PRINTER_NODE;
  process.env.SCAN_TO_MAKE_PRINTER_NODE=process.execPath;
  t.after(()=>{if(prior===undefined)delete process.env.SCAN_TO_MAKE_PRINTER_NODE;else process.env.SCAN_TO_MAKE_PRINTER_NODE=prior;});
  const client=new PrinterMcpClient({backend:'bambu-printer-mcp',process:{command:'/absent/homebrew/bin/node',args:[fixture,'bambu',join(root,'calls')],cwd:root,env:{PATH:dirname(process.execPath)}}});
  try{const catalog=await client.connect();assert(catalog.tools.some(tool=>tool.name==='print_3mf'));}finally{await client.close();}
});
