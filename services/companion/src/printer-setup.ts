import {constants} from 'node:fs';
import {lstat,open,rename,rm,link} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ControlFailure} from './local-control-protocol.js';
import {PrinterSetupChoiceSchema,PrinterSetupRecordSchema,type PrinterSetupCheck,type PrinterSetupRecord,PrinterProbeSchema,printerRoutes} from './printer-setup-protocol.js';
import {createBoundWorker} from './model-access-worker.js';

async function writeRecord(path:string,record:PrinterSetupRecord,createOnly=false) {
  const temporary = path+'.'+randomUUID();
  try {
    const file = await open(temporary,'wx',0o600);
    try { await file.writeFile(JSON.stringify(record)+'\n'); await file.sync(); } finally { await file.close(); }
    // Publishing a hard link is atomic and exclusive: concurrent initialization
    // cannot replace another owner's complete record with a fresh default.
    if (createOnly) await link(temporary,path);
    else await rename(temporary,path);
  } finally { await rm(temporary,{force:true}); }
}

/** Single companion owner; choice writes are atomic and serialized with CAS.
 * Connection results are deliberately ephemeral and bound to the exact revision. */
export class PrinterSetupService {
  private check?:PrinterSetupCheck;
  private controller?:AbortController;
  private leases=0;
  private writes:Promise<unknown> = Promise.resolve();
  private constructor(private path:string,private record:PrinterSetupRecord,private worker:ReturnType<typeof createBoundWorker>) {}
  static async open(directory:string,worker = createBoundWorker(process.env.SCAN_TO_MAKE_PRINTER_WORKER,'--printer-worker')):Promise<PrinterSetupService> {
    const parent = await lstat(directory);
    if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()) throw new Error('Printer setup requires private storage');
    const path = join(directory,'printer-setup.json');
    let record:PrinterSetupRecord;
    try {
      const file = await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 16384 || (info.mode & 0o077) !== 0 || info.uid !== parent.uid) throw new Error('Invalid printer setup storage');
        record = PrinterSetupRecordSchema.parse(JSON.parse(await file.readFile('utf8')));
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      record = {version:1,revision:randomUUID(),configured:false,choice:{kind:'none'}};
      try { await writeRecord(path,record,true); }
      catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === 'EEXIST') return PrinterSetupService.open(directory,worker);
        throw failure;
      }
    }
    return new PrinterSetupService(path,record,worker);
  }
  get() { return structuredClone({revision:this.record.revision,configured:this.record.configured,choice:this.record.choice,check:this.check ?? null,routes:this.record.choice.kind==='bambu' ? printerRoutes(this.record.choice.bambu_model,this.check?.result?.firmware,this.check?.result?.fulu==='available') : []}); }
  async set(expectedRevision:string,raw:unknown) {
    const choice = PrinterSetupChoiceSchema.parse(raw);
    const operation = this.writes.then(async () => {
      if (this.leases || expectedRevision.toLowerCase() !== this.record.revision) throw new ControlFailure('conflict');
      const record:PrinterSetupRecord = {version:1,revision:randomUUID(),configured:true,choice};
      await writeRecord(this.path,record);
      this.controller?.abort(); this.controller = undefined; this.check = undefined;
      this.record = record;
      return this.get();
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
  async withConfiguration<T>(run:(record:PrinterSetupRecord)=>Promise<T>):Promise<T> {
    // Serialize acquisition with writes; once leased, edits refuse rather than
    // changing a printer midway through slicing or confirmation.
    let record!:PrinterSetupRecord;
    const acquire=this.writes.then(()=>{this.leases++;record=structuredClone(this.record);});
    this.writes=acquire.catch(()=>{});
    await acquire;
    try {return await run(record);} finally {this.leases--;}
  }
  startCheck(revision:string) {
    if (revision.toLowerCase() !== this.record.revision) throw new ControlFailure('conflict');
    if (this.check?.state === 'checking') return this.get();
    const check:PrinterSetupCheck = {id:randomUUID(),revision:this.record.revision,state:this.record.choice.kind === 'none' ? 'skipped' : 'checking'};
    this.check = check;
    if (check.state === 'skipped') return this.get();
    const controller = new AbortController(); this.controller = controller;
    void this.worker(structuredClone(this.record.choice),['check'],{signal:controller.signal,timeoutMs:80000}).then(resultData => {
      if (this.check !== check || controller.signal.aborted) return;
      const result = PrinterProbeSchema.parse(JSON.parse(resultData.stdout));
      check.result = result;
      const choice = this.record.choice;
      check.state = resultData.exitCode === 0 && result.status==='connected' && result.camera!=='failed'
        && !(choice.kind==='bambu' && choice.connection_mode==='bambu_network' && result.fulu!=='available')
        && !(choice.kind==='bambu' && result.model && result.model!==choice.bambu_model) ? 'connected' : 'failed';
    }).catch(() => { if (this.check === check && !controller.signal.aborted) check.state = 'failed'; });
    return this.get();
  }
  close() { this.controller?.abort(); }
}
