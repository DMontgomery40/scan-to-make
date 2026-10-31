import {open} from 'node:fs/promises';
import {basename,dirname,isAbsolute} from 'node:path';
import type {PrinterMcpProcess} from './config.js';

/** A signed Mac agent supplies this pin after loading its retained env. Never
 * rewrite the operator file or discard its printer settings/working directory.
 * Other hosts leave it unset. Native signed app helpers keep their own entry. */
export async function appOwnedPrinterProcess(config:PrinterMcpProcess,nodeExecutable=process.env.SCAN_TO_MAKE_PRINTER_NODE):Promise<PrinterMcpProcess> {
  if(nodeExecutable===undefined)return config;
  if(!isAbsolute(nodeExecutable))throw new Error('Printer runtime must be absolute');
  let command=config.command,args=[...(config.args??[])];
  if(['node','nodejs'].includes(basename(command)))command=nodeExecutable;
  else {
    // npm installs bin symlinks to Node scripts. Read only their shebang, never
    // execute a shell wrapper or substitute Node for a native helper.
    const file=await open(command,'r').catch(()=>undefined);
    if(file)try{
      if((await file.stat()).isFile()){
        const buffer=Buffer.alloc(256);const {bytesRead}=await file.read(buffer,0,buffer.length,0);
        const first=buffer.toString('utf8',0,bytesRead).split('\n',1)[0]!;
        if(/^#!\s*(?:\/usr\/bin\/env\s+node|\S*\/node)\s*$/.test(first)){
          args=[command,...args];command=nodeExecutable;
        }
      }
    }finally{await file.close();}
  }
  return {...config,command,args,env:{...config.env,PATH:dirname(nodeExecutable)+':'+(config.env?.PATH??process.env.PATH??'/usr/bin:/bin')}};
}
