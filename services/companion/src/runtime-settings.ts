import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {PhoneAIChangeSchema} from '@scan-to-make/contracts/counterpart';
import type {EventDraft} from './printing/monitor.js';
import {ControlFailure} from './local-control-protocol.js';
import type {ModelAccessService} from './model-access.js';

type FusionReport = {installed:boolean; configured:boolean; running:boolean};
type FusionCompletion = {requestId:string; ok:boolean; message?:string};
const reportSchema=z.strictObject({installed:z.boolean(),configured:z.boolean(),running:z.boolean()});
const completionSchema=z.strictObject({requestId:z.uuid(),ok:z.boolean(),message:z.string().max(500).optional()});

/** Runtime observations stay out of settings.json. GUI work is claimed through the private local Mac control socket. */
export class RuntimeSettings {
  private report?:FusionReport & {at:number};
  private pending?:{id:string; at:number; claimedBy?:string};
  private result?:{ok:boolean; message?:string};
  private readonly now:()=>number;
  constructor(private readonly deps:{modelAccess?:ModelAccessService;emit:(event:EventDraft)=>Promise<void>;now?:()=>number}) {
    this.now=deps.now??Date.now;
    deps.modelAccess?.onChange(()=>{void deps.emit({id:randomUUID(),type:'settings.changed',data:{keys:['ai']}}).catch(()=>{});});
  }
  snapshot() {
    const snapshot=this.deps.modelAccess?.get();
    // Explicit allowlist: even a Keychain reference never reaches a phone.
    const choice=snapshot?.choice;
    const ai=snapshot&&choice?{scope:'model-jobs' as const,revision:snapshot.revision,choice:{kind:choice.kind,
      ...('provider' in choice?{provider:choice.provider}:{}),...('model' in choice?{model:choice.model}:{}),
      ...('url' in choice?{url:choice.url}:{})},check:snapshot.check}:undefined;
    return {...(ai?{ai}:{}),fusion:this.fusion()};
  }
  async setAI(raw:unknown) {
    const input=PhoneAIChangeSchema.parse(raw);
    if(!this.deps.modelAccess)throw new ControlFailure('unavailable','Open AI settings on your Mac to configure model access.');
    await this.deps.modelAccess.set(input.expectedRevision,input.choice);
  }
  testAI(revision:string) {
    if(!this.deps.modelAccess)throw new ControlFailure('unavailable','Open AI settings on your Mac to configure model access.');
    this.deps.modelAccess.startCheck(z.uuid().parse(revision));
  }
  /** Fusion's Set Up is waiting for the Mac or running on it (`fusion.state` reads `setting-up`). */
  fusionSettingUp():boolean { this.expire(); return !!this.pending; }
  private expire() {
    if(this.pending&&this.now()-this.pending.at>600_000){this.pending=undefined;this.result={ok:false,message:'Fusion setup timed out. Check Counterpart on your Mac, then try again.'};}
  }
  private fusion() {
    this.expire();
    if(this.pending)return {state:'setting-up',message:'Setting up Fusion on your Mac…'};
    if(!this.report||this.now()-this.report.at>90_000)return {state:'unavailable',message:'Open Counterpart on your Mac to check Fusion setup.'};
    if(!this.report.installed)return {state:'unavailable',message:'Install Autodesk Fusion on your Mac first.'};
    if(this.result?.ok)return {state:'connected',message:'Fusion connected during the last setup check. It must stay open while designing.'};
    if(this.result)return {state:'not-set-up',message:this.result.message??'Fusion setup did not finish. Check Counterpart on your Mac, then try again.'};
    if(!this.report.configured)return {state:'not-set-up',message:'Set up the Fusion add-in on your Mac.'};
    return {state:'not-running',message:this.report.running?'Fusion is set up and running. Its connection has not been checked.':'Fusion is set up. Open it on your Mac before designing.'};
  }
  async reportFusion(raw:FusionReport) {
    const before=this.fusion();
    const report=reportSchema.parse(raw);
    this.report={...report,at:this.now()};
    if((!report.installed||!report.configured||!report.running)&&this.result?.ok)this.result=undefined;
    const after=this.fusion();
    if(before.state!==after.state||before.message!==after.message)
      await this.deps.emit({id:randomUUID(),type:'settings.changed',data:{keys:['fusion']}});
    return {};
  }
  async requestFusion() {
    this.expire();
    if(this.pending)return;
    if(!this.report?.installed||this.now()-this.report.at>90_000)throw new ControlFailure('unavailable','Open Counterpart and install Fusion on your Mac before setting it up.');
    const request={id:randomUUID(),at:this.now(),claimedBy:undefined as string|undefined};this.pending=request;this.result=undefined;
    try{await this.deps.emit({id:randomUUID(),type:'settings.changed',data:{keys:['fusion']}});}
    catch(error){if(this.pending===request&&!request.claimedBy)this.pending=undefined;throw error;}
  }
  claimFusion(claimantId:string) {
    z.uuid().parse(claimantId);
    this.expire();
    if(!this.pending||(this.pending.claimedBy&&this.pending.claimedBy!==claimantId))return {};
    this.pending.claimedBy=claimantId;
    return {requestId:this.pending.id};
  }
  async completeFusion(raw:FusionCompletion) {
    this.expire();const input=completionSchema.parse(raw);
    if(!this.pending?.claimedBy||input.requestId!==this.pending.id)throw new ControlFailure('conflict');
    this.pending=undefined;this.result={ok:input.ok,...(input.message?{message:input.message}:{})};
    if(this.report)this.report.at=this.now();
    await this.deps.emit({id:randomUUID(),type:'settings.changed',data:{keys:['fusion']}});
    return {};
  }
}
