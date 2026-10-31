import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseEnv} from 'node:util';
import {serveBoundPrinter,type PrinterHandoffConfig} from '@scan-to-make/printer-handoff';
import {PrinterSetupChoiceSchema} from './printer-setup-protocol.js';
import {probePrinter} from './printer-setup-probe.js';

// Only the signed helper resolves paths, immutable choice and Keychain data.
// An empty private working directory prevents backend dotenv auto-discovery.
process.umask(0o077);
const root=await mkdtemp(join(tmpdir(),'stm-printer-worker-'));
try {
  const server=process.env.STM_PRINTER_SERVER;
  if (!server?.startsWith('/')) throw new Error('Unavailable');
  const choice=PrinterSetupChoiceSchema.parse(JSON.parse(process.env.STM_PRINTER_CHOICE!));
  if(choice.kind==='none') throw new Error('Unavailable');
  const env:Record<string,string>={};
  for (const key of ['HOME','PATH','TMPDIR','MCP_TRANSPORT','PRINTER_HOST','PRINTER_PORT','PRINTER_TYPE','BAMBU_SERIAL','BAMBU_MODEL','BAMBU_TOKEN','API_KEY','SLICER_PATH','SLICER_TYPE','BLENDER_MCP_COMMAND','BLENDER_MCP_ARGS']) {
    if (process.env[key]!==undefined) env[key]=process.env[key]!;
  }
  const backend=choice.kind==='bambu'?'bambu-printer-mcp':'mcp-3d-printer-server';
  const config:PrinterHandoffConfig={backend,process:{command:process.execPath,args:[server],cwd:root,env},timeouts:{connectMs:10000}};
  let fulu:PrinterHandoffConfig|undefined;
  if (backend==='bambu-printer-mcp') {
    // Existing operator-installed bridge; no request may supply a command.
    let command:string|undefined;
    try {command=parseEnv(await readFile(join(process.env.STM_PRINTER_STATE!,'companion.env'),'utf8')).BAMBU_NETWORK_BRIDGE_COMMAND;} catch { /* No runtime. */ }
    const clean=Object.fromEntries(['HOME','PATH','TMPDIR','MCP_TRANSPORT'].flatMap(key=>env[key]?[[key,env[key]!]]:[]));
    if (command) {clean.BAMBU_NETWORK_BRIDGE_COMMAND=command;env.BAMBU_NETWORK_BRIDGE_COMMAND=command;}
    fulu={...config,process:{...config.process,env:clean}};
  }
  if(process.argv[2]==='serve') {
    const session=await serveBoundPrinter(config,{host:choice.printer_host,
      ...(choice.kind==='bambu'?{type:'bambu',model:choice.bambu_model,connectionMode:choice.connection_mode}:{type:choice.printer_type,port:choice.printer_port})});
    for(const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>{void session.close();});
    await session.closed;
  } else if(process.argv[2]==='check') {
    process.stdout.write(JSON.stringify(await probePrinter(config,fulu))+'\n');
  } else throw new Error('Unavailable');
} catch {process.exitCode=1;}
finally {await rm(root,{recursive:true,force:true});}
