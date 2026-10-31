import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {access,lstat,mkdir,mkdtemp,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import {PrinterMcpClient,type PrinterMcpProcess} from '@scan-to-make/printer-handoff';
import {downloadArtifact,type DownloadArtifact} from './dependencies-download.js';

export const dependencyIds=['bambu-printer-mcp','mcp-3d-printer-server','blender','slicer','ffmpeg'] as const;
export type DependencyId=typeof dependencyIds[number];
type ManagedId=Exclude<DependencyId,'slicer'|'ffmpeg'>;
export interface DependencyItem {
 id:DependencyId;state:'Ready'|'Downloading'|'Missing'|'Failed';required:boolean;version?:string;
 bytesReceived?:number;totalBytes?:number;executablePath?:string;failureCode?:string;installURL?:string;
}
export interface DependencyContext {backend?:'bambu-printer-mcp'|'mcp-3d-printer-server';model?:string}
export interface DependencySnapshot {items:DependencyItem[];environment:Record<string,string>}
const run=promisify(execFile);
const relativePath=z.string().refine(s=>!isAbsolute(s)&&s.split('/').every(p=>p!=='.'&&p!=='..'&&p!==''));
const download=z.object({url:z.string().url(),integrity:z.string().regex(/^sha(?:256|512)-[A-Za-z0-9+/]+=*$/),maxBytes:z.number().int().positive(),entryPoint:relativePath});
const catalogSchema=z.object({version:z.literal(1),
 'bambu-printer-mcp':download.extend({version:z.string().regex(/^\d+\.\d+\.\d+$/)}),
 'mcp-3d-printer-server':z.object({version:z.string().regex(/^\d+\.\d+\.\d+$/),lockfile:relativePath,lockfileSha256:z.string().regex(/^[a-f0-9]{64}$/),entryPoint:relativePath}),
 blender:z.object({version:z.string().regex(/^\d+\.\d+\.\d+$/),platforms:z.record(z.string(),download)}),
});
const managed=(id:string):id is ManagedId=>['bambu-printer-mcp','mcp-3d-printer-server','blender'].includes(id);
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const rtsp=new Set(['x1','x1c','x1carbon','x1e','p2s','h2','h2s','h2d','h2c','h2dpro','x2d']);
interface Options {catalogDirectory?:string;python?:string;env?:NodeJS.ProcessEnv;platform?:string;arch?:string}
async function privateDirectory(path:string){
 await mkdir(path,{recursive:true,mode:0o700});const s=await lstat(path);
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw Error('Dependency directory must be private');
}
async function executable(path:string){try{await access(path,constants.X_OK);return (await lstat(path)).isFile()||(await lstat(path)).isSymbolicLink();}catch{return false;}}

/** Installs unmodified external processes. No caller-selected downloads, destinations or shell commands. */
export class DependencyManager {
 private readonly running=new Map<ManagedId,Promise<void>>();
 private readonly states=new Map<ManagedId,DependencyItem>();
 private readonly abort=new AbortController();
 private readonly catalogDirectory:string;
 private readonly env:NodeJS.ProcessEnv;
 private readonly platform:string;
 private readonly arch:string;
 private readonly python:string;
 private catalog!:z.infer<typeof catalogSchema>;
 private catalogPin='';
 private constructor(private readonly root:string,options:Options){
  this.catalogDirectory=options.catalogDirectory??fileURLToPath(new URL('../../../deploy/dependencies/',import.meta.url));
  this.env=options.env??process.env;this.platform=options.platform??process.platform;this.arch=options.arch??process.arch;
  this.python=options.python??this.env.SCAN_TO_MAKE_CAPTURE_PYTHON??'python3';
 }
 static async open(root:string,options:Options={}){
  const self=new DependencyManager(root,options);await privateDirectory(root);await privateDirectory(join(root,'cache'));
  const bytes=await readFile(join(self.catalogDirectory,'catalog.json'));self.catalog=catalogSchema.parse(JSON.parse(bytes.toString()));self.catalogPin=hash(bytes);
  for(const id of ['bambu-printer-mcp','mcp-3d-printer-server','blender'] as const){
   try{
    const state=z.object({state:z.enum(['Downloading','Failed','Ready']),failureCode:z.string().optional()}).parse(JSON.parse(await readFile(join(root,id+'.json'),'utf8')));
    if(state.state==='Failed')self.states.set(id,{id,required:true,state:'Failed',failureCode:state.failureCode??'installation-failed'});
    if(state.state==='Downloading')void self.install(id).catch(()=>{});
   }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')self.states.set(id,{id,required:true,state:'Failed',failureCode:'installation-state-invalid'});}
  }
  return self;
 }
 private destination(id:ManagedId){return join(this.root,id,this.catalog[id].version+'-'+this.catalogPin.slice(0,12));}
 private entry(id:ManagedId){return id==='blender'?this.catalog.blender.platforms[`${this.platform}-${this.arch}`]?.entryPoint:this.catalog[id].entryPoint;}
 private async ready(id:ManagedId):Promise<DependencyItem|undefined>{
  const entry=this.entry(id);if(!entry)return;
  const dir=this.destination(id);
  try{
   if((await lstat(dir)).isSymbolicLink())return;
   const receipt=JSON.parse(await readFile(join(dir,'installation.json'),'utf8'));
   const path=join(dir,entry);const info=await lstat(path);
   if(receipt.catalogPin!==this.catalogPin||!info.isFile())return;
   return {id,state:'Ready',required:true,version:this.catalog[id].version,executablePath:path};
  }catch{return;}
 }
 private async find(names:string[],extra:string[]=[]){
  for(const path of [...extra,...(this.env.PATH??'').split(':').filter(isAbsolute).flatMap(dir=>names.map(name=>join(dir,name)))])if(await executable(path))return path;
 }
 private async detectedBlender():Promise<DependencyItem|undefined>{
  const path=await this.find(['blender'],[this.env.SCAN_TO_MAKE_SCAN_BLENDER,this.env.BLENDER,'/Applications/Blender.app/Contents/MacOS/Blender',...(this.env.HOME?[join(this.env.HOME,'Applications/Blender.app/Contents/MacOS/Blender')]:[])].filter((p):p is string=>!!p));
  if(path)try{
   const {stdout}=await run(path,['--version'],{timeout:5000,maxBuffer:65536,env:this.env});const match=/^Blender (5\.\d+\.\d+)/m.exec(stdout);
   if(match)return {id:'blender',state:'Ready',required:true,version:match[1],executablePath:path};
  }catch{/* An unsupported or broken installed binary does not block the pinned download. */}
 }
 async get(context:DependencyContext={}):Promise<DependencySnapshot>{
  const items:DependencyItem[]=[],environment:Record<string,string>={};
  for(const id of ['bambu-printer-mcp','mcp-3d-printer-server','blender'] as const){
   const item=this.states.get(id)??await this.ready(id)??(id==='blender'?await this.detectedBlender():undefined)??{id,state:'Missing' as const,required:true,version:this.catalog[id].version};
   items.push({...item,required:id!=='mcp-3d-printer-server'||context.backend==='mcp-3d-printer-server'});
   if(id==='blender'&&item.state==='Ready'&&item.executablePath)environment.BLENDER=item.executablePath;
  }
  // Prefer the explicitly configured pair. Defaults pair each discovered app with
  // its matching type; never let a backend silently select the FULU default.
  let slicer: {path:string;type:string}|undefined;
  if(this.env.SLICER_PATH&&this.env.SLICER_TYPE&&await executable(this.env.SLICER_PATH))slicer={path:this.env.SLICER_PATH,type:this.env.SLICER_TYPE};
  for(const [app,exe,type] of [['BambuStudio','BambuStudio','bambustudio'],['OrcaSlicer','OrcaSlicer','orcaslicer'],['PrusaSlicer','PrusaSlicer','prusaslicer']] as const){
   if(slicer)break;
   const path=await this.find([exe,exe.toLowerCase()],['/Applications',...(this.env.HOME?[join(this.env.HOME,'Applications')]:[])].map(dir=>join(dir,app+'.app/Contents/MacOS',exe)));
   if(path)slicer={path,type};
  }
  items.push({id:'slicer',required:!!context.backend,state:slicer?'Ready':'Missing',...(slicer?{executablePath:slicer.path}:{}),installURL:'https://github.com/OrcaSlicer/OrcaSlicer/releases'});
  if(slicer){environment.SLICER_TYPE=slicer.type;environment.SLICER_PATH=slicer.path;}
  const ffmpeg=await this.find(['ffmpeg'],this.env.FFMPEG_PATH?[this.env.FFMPEG_PATH]:[]);
  const needsCamera=context.backend==='bambu-printer-mcp'&&rtsp.has((context.model??'').toLowerCase());
  items.push({id:'ffmpeg',required:needsCamera,state:ffmpeg?'Ready':'Missing',...(ffmpeg?{executablePath:ffmpeg}:{}),installURL:'https://ffmpeg.org/download.html'});
  if(ffmpeg&&needsCamera)environment.FFMPEG_PATH=ffmpeg;
  return {items,environment};
 }
 private async save(id:ManagedId,item:DependencyItem){
  const path=join(this.root,id+'.json'),tmp=path+'.'+randomUUID();
  await writeFile(tmp,JSON.stringify({state:item.state,...(item.failureCode?{failureCode:item.failureCode}:{})}),{flag:'wx',mode:0o600});await rename(tmp,path);
 }
 async install(id:string):Promise<{item:DependencyItem}>{
  if(!managed(id))throw Error('Unknown downloadable dependency');this.abort.signal.throwIfAborted();
  const active=this.running.get(id);
  if(active&&this.states.get(id)?.state!=='Downloading')await active;
  const current=this.states.get(id);if(current?.state==='Downloading')return {item:{...current}};
  const ready=await this.ready(id)??(id==='blender'?await this.detectedBlender():undefined);if(ready)return {item:ready};
  // Detection performs I/O: another caller may have started while it awaited.
  const started=this.states.get(id);if(started?.state==='Downloading')return {item:{...started}};
  const item:DependencyItem={id,state:'Downloading',required:true,version:this.catalog[id].version,bytesReceived:0};this.states.set(id,item);
  // Install is accepted immediately. Persistence and activation errors become a
  // polled Failed state, not an unhandled background rejection.
  const task=this.perform(id,item).catch(async e=>{
   if(this.abort.signal.aborted)return; // persisted Downloading resumes next launch
   const code=e instanceof Error&&e.message.includes('integrity')?'integrity-mismatch':e instanceof Error&&e.message==='unsupported-platform'?'unsupported-platform':'installation-failed';
   const failed:DependencyItem={id,state:'Failed',required:true,version:this.catalog[id].version,failureCode:code};this.states.set(id,failed);await this.save(id,failed).catch(()=>{});
  }).finally(()=>this.running.delete(id));
  this.running.set(id,task);return {item:{...item}};
 }
 async retry(id:string){return this.install(id);}
 private async perform(id:ManagedId,item:DependencyItem){
  await this.save(id,item);const entry=this.entry(id);if(!entry)throw Error('unsupported-platform');
  const parent=join(this.root,id);await privateDirectory(parent);const stage=await mkdtemp(join(parent,'.install-'));
  let completedBytes=0;
  const fetch=async(artifact:DownloadArtifact)=>{
   const path=join(this.root,'cache',hash(artifact.url+'\n'+artifact.integrity));
   await downloadArtifact(artifact,path,{signal:this.abort.signal,onProgress:(done,total)=>{item.bytesReceived=completedBytes+done;item.totalBytes=total===undefined?undefined:completedBytes+total;}});
   completedBytes=item.bytesReceived??completedBytes;return path;
  };
  const extract=async(kind:string,archive:string,dest:string)=>{await run(this.python,[join(this.catalogDirectory,'extract.py'),kind,archive,dest],{timeout:120000,maxBuffer:65536,env:this.env});};
  try{
   if(id==='bambu-printer-mcp')await extract('zip',await fetch(this.catalog[id]),stage);
   else if(id==='mcp-3d-printer-server'){
    const spec=this.catalog[id],bytes=await readFile(join(this.catalogDirectory,spec.lockfile));
    if(hash(bytes)!==spec.lockfileSha256)throw Error('Lockfile integrity mismatch');
    const lock=JSON.parse(bytes.toString());
    for(const [path,raw] of Object.entries(lock.packages)){
     if(path==='')continue;
     if(!/^(?:node_modules\/(?:@[^/]+\/)?[^/]+\/)*node_modules\/(?:@[^/]+\/)?[^/]+$/.test(path)||path.split('/').some(s=>s==='..'||s==='.'))throw Error('Invalid dependency path');
     const p=z.object({resolved:z.string().startsWith('https://registry.npmjs.org/'),integrity:z.string(),hasInstallScript:z.literal(false).optional()}).parse(raw);
     await extract('tgz',await fetch({url:p.resolved,integrity:p.integrity,maxBytes:64*1024*1024}),join(stage,path));
    }
    await writeFile(join(stage,'package-lock.json'),bytes,{mode:0o600});
   }else{
    const artifact=this.catalog.blender.platforms[`${this.platform}-${this.arch}`]!;
    await run('/bin/bash',[join(this.catalogDirectory,'../companion/download-blender.sh'),stage,await fetch(artifact)],{timeout:300000,maxBuffer:65536,env:this.env});
   }
   this.abort.signal.throwIfAborted();
   const path=join(stage,entry);if(!(await lstat(path)).isFile())throw Error('Dependency executable missing');
   if(id==='blender'){
    const {stdout}=await run(path,['--version'],{timeout:10000,maxBuffer:65536,env:this.env});if(!stdout.startsWith('Blender '+this.catalog.blender.version))throw Error('Wrong Blender version');
   }else{
    const temp=join(stage,'.startup');await mkdir(temp,{mode:0o700});
    const client=new PrinterMcpClient({backend:id,process:{command:process.execPath,args:[path],cwd:temp,env:{HOME:temp,TMPDIR:temp,TEMP_DIR:temp,MCP_TRANSPORT:'stdio',BAMBU_MODEL:'',PRINTER_HOST:'',BAMBU_TOKEN:'',BAMBU_SERIAL:''}},timeouts:{connectMs:15000}});
    try{const catalog=await client.connect(this.abort.signal);if(catalog.server.version!==this.catalog[id].version||!client.hasTool('get_printer_status')||!client.hasTool('slice_stl'))throw Error('Invalid MCP installation');}
    finally{await client.close();await rm(temp,{recursive:true,force:true});}
   }
   await writeFile(join(stage,'installation.json'),JSON.stringify({catalogPin:this.catalogPin,version:this.catalog[id].version}),{flag:'wx',mode:0o600});
   this.abort.signal.throwIfAborted();
   // Publish once. An interrupted stage is never considered Ready.
   await rename(stage,this.destination(id));const ready=await this.ready(id);if(!ready)throw Error('Installation activation failed');
   await this.save(id,ready);this.states.delete(id);
  }finally{await rm(stage,{recursive:true,force:true});}
 }
 async processFor(backend:'bambu-printer-mcp'|'mcp-3d-printer-server'):Promise<PrinterMcpProcess|undefined>{
  const item=await this.ready(backend);if(!item?.executablePath)return;
  const snapshot=await this.get({backend});return {command:process.execPath,args:[item.executablePath],env:snapshot.environment};
 }
 async close(){this.abort.abort();await Promise.all(this.running.values());}
}
