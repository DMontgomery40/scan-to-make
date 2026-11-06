import type {PrintGate} from '../printing/print-gate.js';

export interface BlenderAddonStatus {
  state: 'unchecked' | 'checking' | 'ready' | 'update-needed' | 'not-running' | 'restart-needed' | 'updating' | 'busy' | 'unavailable' | 'failed';
  message: string;
  canUpdate: boolean;
  protocol?: number;
  expectedProtocol?: number;
}

/**
 * The printer MCP's `blender_mcp_setup` result (bambu-printer-mcp and mcp-3D-printer-server), as far as the app reads
 * it. The MCP inspects and replaces the add-on; the app keeps the shared state, the print gate and the helper lock.
 */
export interface BlenderSetupReport {
  supported: boolean;
  reason?: string;
  expected_protocol?: number;
  listening: boolean;
  live?: {up_to_date?: boolean; protocol_version?: number | null; expected_protocol_version?: number; blender_version?: string | null} | null;
  live_error?: string;
  target?: {path: string; protocol: number | null} | null;
  target_problem?: string;
  /** What the person can do, in the MCP's words, when it can't check or update the add-on (with reason or target_problem). */
  message?: string;
  current?: boolean;
  replaced?: boolean;
}

/** The MCP has no `blender_mcp_setup`: the person updates it, and nothing in the app stands in for it. */
export class BlenderSetupUnavailableError extends Error {
  constructor(readonly packageName: string) { super(`Update ${packageName} in Settings → Printers so Counterpart can check the Blender add-on.`); }
}

interface RepairDependencies {
  gate: PrintGate;
  /** `blender_mcp_setup` on the configured printer MCP: `{update}` replaces the add-on. */
  setup(update: boolean): Promise<BlenderSetupReport>;
  lock(): Promise<() => Promise<void>>;
}
const stopped = 'Blender is set up. Counterpart opens it when cleanup starts.';
const restart = 'The add-on is updated. In Blender, disable and re-enable MCP for Blender, or save your work and restart Blender. Then Check Again.';
const outdated = 'The Blender add-on needs an update before Counterpart can use it.';
/** One companion-owned repair, shared by every client. Settings never launches or closes Blender. */
export class BlenderAddonRepair {
  #status: BlenderAddonStatus = {state:'unchecked',message:'Blender add-on has not been checked. Choose Check Again.',canUpdate:false};
  #running?: Promise<void>;
  #checking?: Promise<void>;
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
    try { this.#status=this.#fromReport(await this.deps.setup(false)); }
    catch (error) { this.#status={state:'unavailable',message:error instanceof Error?error.message:'Blender setup could not be checked.',canUpdate:false}; }
    return this.current();
  }
  #fromReport(report: BlenderSetupReport): BlenderAddonStatus {
    // The MCP says why it can't check or update this add-on; its words are shown as they are, never matched.
    if (!report.supported || !report.target) return {state:'unavailable',message:report.message ?? 'Your printer MCP can’t check the Blender add-on here. Check its Blender setup on your Mac.',canUpdate:false};
    const expectedProtocol=report.live?.expected_protocol_version ?? report.expected_protocol;
    const withProtocols=(status: BlenderAddonStatus): BlenderAddonStatus => ({...status,
      ...(expectedProtocol!==undefined?{expectedProtocol}:{}), ...(report.live?.protocol_version!=null?{protocol:report.live.protocol_version}:{})});
    if (!report.listening) {
      return withProtocols(report.current
        ? {state:'not-running',message:stopped,canUpdate:false}
        : {state:'update-needed',message:outdated,canUpdate:true});
    }
    if (report.live_error) return {state:'unavailable',message:`Blender isn't reachable through your printer MCP: ${report.live_error}`,canUpdate:false};
    if (!report.live) return {state:'unavailable',message:'This Blender bridge does not report add-on compatibility. Check its setup on your Mac.',canUpdate:false};
    if (report.live.up_to_date===true) return withProtocols({state:'ready',message:'Blender add-on is up to date.',canUpdate:false});
    // The file on disk is current but the running Blender still has the old add-on loaded: another update can't help,
    // whoever replaced the file and whenever (a companion restart forgets an earlier update).
    return withProtocols(report.current===true?{state:'restart-needed',message:restart,canUpdate:false}:{state:'update-needed',message:outdated,canUpdate:true});
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
    let release: (()=>Promise<void>) | undefined;
    try {
      release=await this.deps.lock();
      const report=await this.deps.setup(true);
      // Nothing was installed (the bridge or the add-on changed since the check): the MCP's own words.
      if (!report.supported || !report.target) { this.#status=this.#fromReport(report); return; }
      // Replaced now, the running Blender still has the old add-on; stopped, it loads the new one when cleanup opens it.
      this.#status=!report.listening?{state:'not-running',message:stopped,canUpdate:false}
        :report.replaced?{state:'restart-needed',message:restart,canUpdate:false}:this.#fromReport(report);
    } catch {
      this.#status={state:'failed',message:'The Blender add-on could not be updated safely. Your existing add-on was kept. Check disk space and file access, then try again.',canUpdate:true};
    } finally {await release?.().catch(()=>{});}
  }
}
