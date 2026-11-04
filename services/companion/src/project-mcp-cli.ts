import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';

// The provider harness may hold a key. Never inherit its environment into a
// tool process, and keep the MCP's own credentials out of process arguments.
try {
 const config=JSON.parse(await readFile(process.argv[2]!,'utf8'));
 const child=spawn(config.command,config.args,{env:config.env,stdio:'inherit'});
 child.once('error',()=>{process.exitCode=1;});
 child.once('close',code=>{process.exitCode=code??1;});
} catch {process.exitCode=1;}
