import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ProjectWorker} from '../touchup/runner.js';

/** Small helpers use the same selection, with no MCP, browser or file tools. */
export async function selectedText(worker:ProjectWorker,prompt:string,schema:unknown,timeoutMs:number):Promise<unknown> {
 const cwd=await mkdtemp(join(tmpdir(),'stm-text-'));
 try {
  const mcpConfigPath=join(cwd,'mcp.json'),mcpConfig={mcpServers:{}};
  await writeFile(mcpConfigPath,JSON.stringify(mcpConfig),{mode:0o600});
  const result=await worker({command:'',cwd,env:{},mcpConfigPath,mcpConfig,args:['-p','--model','claude-sonnet-5-5','--tools','','--strict-mcp-config','--mcp-config',mcpConfigPath,'--disable-slash-commands','--setting-sources','','--settings','{"disableAllHooks":true}','--json-schema',JSON.stringify(schema),'--output-format','stream-json','--verbose',prompt]}, {timeoutMs});
  return result.exitCode===0&&!result.resultEvent?.is_error?result.resultEvent?.structured_output:undefined;
 }finally{await rm(cwd,{recursive:true,force:true});}
}
