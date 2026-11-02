import {mkdtemp, lstat, open, readFile, realpath, rename, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {PrintGate} from '../printing/print-gate.js';

export interface BlenderAddonStatus {
  state: 'unchecked' | 'checking' | 'ready' | 'update-needed' | 'not-running' | 'restart-needed' | 'updating' | 'busy' | 'unavailable' | 'failed';
  message: string;
  canUpdate: boolean;
  protocol?: number;
  expectedProtocol?: number;
}
export interface AddonInstallation {target: string; protocol: number; installedProtocol?: number | null}
export interface AddonHandshake {up_to_date?: boolean; protocol_version?: number | null; expected_protocol_version?: number; blender_version?: string | null}
interface RepairDependencies {
  gate: PrintGate;
  workRoot: string;
  inspect(blenderVersion?: string): Promise<AddonInstallation>;
  probe(): Promise<AddonHandshake | undefined>;
  listening(): Promise<boolean>;
  stage(directory: string): Promise<string>;
  lock(): Promise<() => Promise<void>>;
  backup?(path: string, bytes: Buffer): Promise<void>;
}
const stopped = 'Blender is set up. Counterpart opens it when cleanup starts.';
const restart = 'The add-on is updated. In Blender, disable and re-enable MCP for Blender, or save your work and restart Blender. Then Check Again.';

/** One companion-owned repair, shared by both clients. Settings never launches or closes Blender. */
export class BlenderAddonRepair {
  #status: BlenderAddonStatus = {state:'unchecked',message:'Blender add-on has not been checked. Choose Check Again.',canUpdate:false};
  #running?: Promise<void>;
  #checking?: Promise<void>;
  #replaced = false;
  constructor(readonly deps: RepairDependencies) {}
  current(): BlenderAddonStatus { return {...this.#status}; }
  async settled(): Promise<void> { await this.#running; await this.#checking; }
  requestCheck(): BlenderAddonStatus {
    if(this.#running || this.#checking) return this.current();
    this.#status={state:'checking',message:'Checking Blender…',canUpdate:false};
    this.#checking=this.check().then(()=>{}).finally(()=>{this.#checking=undefined;});
    return this.current();
  }
  async check(): Promise<BlenderAddonStatus> {
    if (this.#running) return this.current();
    try {
      if(!await this.deps.listening()) {
        const installed=await this.deps.inspect();
        const current=installed.installedProtocol===installed.protocol;
        this.#status={state:current?'not-running':'update-needed',message:current?stopped:'The Blender add-on needs an update before Counterpart can use it.',canUpdate:!current,expectedProtocol:installed.protocol};
        return this.current();
      }
      const live=await this.deps.probe();
      const installed = await this.deps.inspect(live?.blender_version ?? undefined);
      if (!live) this.#status = {state:'unavailable',message:'This Blender bridge does not report add-on compatibility. Check its setup on your Mac.',canUpdate:false};
      else if (live.up_to_date === true) {
        this.#replaced=false;
        this.#status={state:'ready',message:'Blender add-on is up to date.',canUpdate:false};
      } else {
        const pendingRestart=this.#replaced && installed.installedProtocol===installed.protocol;
        this.#status={state:pendingRestart?'restart-needed':'update-needed',message:pendingRestart?restart:'The Blender add-on needs an update before Counterpart can use it.',canUpdate:!pendingRestart};
      }
      this.#status.expectedProtocol=live?.expected_protocol_version ?? installed.protocol;
      if (live?.protocol_version != null) this.#status.protocol=live.protocol_version;
    } catch (error) {
      this.#status={state:'unavailable',message:error instanceof Error?error.message:'Blender setup could not be checked.',canUpdate:false};
    }
    return this.current();
  }
  update(): BlenderAddonStatus {
    if (this.#running || this.#checking) return this.current();
    if (!this.deps.gate.beginUpdate(['current'])) {
      this.#status={state:'busy',message:'Wait for the current print, design or software update to finish, then try again.',canUpdate:true};
      return this.current();
    }
    this.#status={state:'updating',message:'Updating the Blender add-on…',canUpdate:false};
    this.#running=this.#repair().finally(()=>{this.deps.gate.endUpdate(['current']);this.#running=undefined;});
    return this.current();
  }
  async #repair(): Promise<void> {
    let release: (()=>Promise<void>) | undefined, work: string | undefined;
    let replacedThisAttempt=false;
    try {
      release=await this.deps.lock();
      const live=await this.deps.listening()?await this.deps.probe():undefined;
      const installed=await this.deps.inspect(live?.blender_version ?? undefined);
      const info=await lstat(installed.target);
      if (!info.isFile() || await realpath(installed.target)!==installed.target) throw new Error('The existing Blender add-on is not a regular local file. Repair it in Blender.');
      const before=await readFile(installed.target);
      if (before.length>4*1024*1024 || !isAddon(before)) throw new Error('The existing file is not a recognized Blender MCP add-on. Nothing was replaced.');
      work=await mkdtemp(join(this.deps.workRoot,'blender-addon-'));
      const staged=await this.deps.stage(work);
      if (!(await lstat(staged)).isFile() || !(await realpath(staged)).startsWith((await realpath(work))+'/')) throw new Error('The installer did not produce a regular staged add-on.');
      const bytes=await readFile(staged);
      if (bytes.length>4*1024*1024 || !isAddon(bytes) || protocol(bytes)!==installed.protocol) throw new Error('The staged add-on does not match the configured Blender bridge. Nothing was replaced.');
      const backup=this.deps.backup ?? durableBackup;
      await backup(installed.target,before);
      if (!(await readFile(installed.target)).equals(before)) throw new Error('The Blender add-on changed during repair. Nothing was replaced.');
      const replacement=join(dirname(installed.target),`.counterpart-addon-${randomUUID()}.tmp`);
      try {
        const file=await open(replacement,'wx',info.mode & 0o777);
        try {await file.writeFile(bytes);await file.sync();} finally {await file.close();}
        await rename(replacement,installed.target);
        replacedThisAttempt=true;
        this.#replaced=true;
      } finally {await rm(replacement,{force:true}).catch(()=>{});}
      const running=await this.deps.listening();
      this.#status={state:running?'restart-needed':'not-running',message:running?restart:stopped,canUpdate:false};
    } catch {
      if(replacedThisAttempt) {this.#status={state:'restart-needed',message:restart,canUpdate:false};return;}
      this.#status={state:'failed',message:'The Blender add-on could not be updated safely. Your existing add-on was kept. Check disk space and file access, then try again.',canUpdate:true};
    } finally {if(work)await rm(work,{recursive:true,force:true}).catch(()=>{});await release?.().catch(()=>{});}
  }
}
function isAddon(bytes: Buffer): boolean {return /["']name["']\s*:\s*["'](?:MCP for Blender|Blender MCP)["']/.test(bytes.toString('utf8'));}
function protocol(bytes: Buffer): number | undefined {const n=/ADDON_PROTOCOL_VERSION\s*=\s*(\d+)/.exec(bytes.toString('utf8'));return n?Number(n[1]):undefined;}
async function durableBackup(path: string, bytes: Buffer): Promise<void> {
  const backup=await open(`${path}.counterpart-${randomUUID()}.bak`,'wx',0o600);
  try {await backup.writeFile(bytes);await backup.sync();} finally {await backup.close();}
}
