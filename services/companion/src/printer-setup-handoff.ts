import {HandoffBundleStore,InMemoryElicitationRelay,PrinterHandoffRunner,PrinterMcpError,timeoutsFor,type PrinterHandoffConfig} from '@scan-to-make/printer-handoff';
import type {PrintHandoffServices} from './print-handoff-http.js';
import type {PrinterSetupService} from './printer-setup.js';
import type {PrinterSetupChoice} from './printer-setup-protocol.js';

export function savedPrinterConfig(executable:string,revision:string,choice:PrinterSetupChoice):PrinterHandoffConfig|undefined {
  if(choice.kind==='none') return undefined;
  return {backend:choice.kind==='bambu'?'bambu-printer-mcp':'mcp-3d-printer-server',
    // SDK inherits a few login variables by default. Clear those too before
    // entering the signed helper; its environment builder accepts no overrides.
    process:{command:'/usr/bin/env',args:['-i',executable,'--printer-worker','serve',JSON.stringify(choice)]},
    selection:{setupRevision:revision,host:choice.printer_host,
      ...(choice.kind==='bambu'?{model:choice.bambu_model,printerType:'bambu'}:{printerType:choice.printer_type,port:choice.printer_port})},
    dispatch:choice.kind==='bambu'&&choice.connection_mode==='bambu_connect'?'handoff':'print',
    timeouts:{connectMs:30000},
  };
}
/** Existing runner and confirmation relay, with a leased immutable setup.
 * Operator config stays usable until the app explicitly saves a choice. */
export function createConfiguredPrintHandoffServices(setup:PrinterSetupService,executable:string,directory:string,legacy?:PrinterHandoffConfig):PrintHandoffServices {
  const store=new HandoffBundleStore(directory),relay=new InMemoryElicitationRelay({timeoutMs:timeoutsFor(legacy ?? {}).elicitationMs});
  const current=()=>{const s=setup.get();return s.configured?savedPrinterConfig(executable,s.revision,s.choice):legacy;};
  return {store,relay,get available(){return !!current();},get selection(){return current()?.selection;},runner:{
    get backend(){return current()?.backend ?? 'bambu-printer-mcp';},
    runBundle:(_store,id,options)=>setup.withConfiguration(async record=>{
      const config=record.configured?savedPrinterConfig(executable,record.revision,record.choice):legacy;
      if(!config) throw new PrinterMcpError('printer-not-configured');
      const manifest=await store.read(id);
      if(manifest.selection?.setupRevision!==config.selection?.setupRevision) throw new PrinterMcpError('printer-setup-changed');
      return new PrinterHandoffRunner(config,{relay}).runBundle(store,id,options);
    }),
  }};
}
