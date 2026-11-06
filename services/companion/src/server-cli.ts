import {reportsCompletion} from './objects/completion-intent.js';
import { randomUUID } from 'node:crypto';
import {ModelSizeStore} from './model-size.js';
import {createModelSizeRunner,installedBambuProcess} from './model-size-runner.js';
import {readFile} from 'node:fs/promises';
import {ScanProcessingStore,createScanCleanupRunner} from './scan-processing.js';
import {dirname,isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FileSavedProjectStorage} from '@scan-to-make/project';
import {CaptureStore} from './capture-import.js';
import {DetailStillStore} from './detail-stills.js';
import {createCaptureConverter} from './capture-converter.js';
import { startCompanionServer } from './server.js';
import { instanceName } from './bonjour.js';
import { computerName, discoverAddresses, localHostName, macDisplayName } from './lan-addresses.js';
import { RemoteAuthStore } from './remote-auth.js';
import { createPrintHandoffServices, type PrintHandoffServices } from './print-handoff-http.js';
import { remoteDestinationsFor } from './remote-mcp-http.js';
import { PrinterMcpClient, PrinterSessionPool, readPrinterHandoffConfig } from '@scan-to-make/printer-handoff';
import { PrinterDirectory } from './printing/directory.js';
import { CameraFrames } from './printing/camera.js';
import { CompanionSettingsStore } from './settings.js';
import { EventLog } from './events/log.js';
import { projectTitle, sizeText } from './events/words.js';
import { LiveActivityTokenStore } from './devices/live-activity-tokens.js';
import { DevicePresence } from './devices/presence.js';
import { pruneLegacyDevices } from './devices/legacy.js';
import { McpOverrides, McpUpdater } from './printing/mcp-updates.js';
import { PrintGate } from './printing/print-gate.js';
import { hostEnvironment } from './printing/mcp-install.js';
import { IcloudEnrolment } from './icloud-enrolment.js';
import {startLocalControl} from './local-control.js';
import {createControlDispatcher, companionVersion} from './local-control-services.js';
import type {CaptureServices} from './capture-http.js';
import {RuntimeSettings} from './runtime-settings.js';
import {ModelAccessService} from './model-access.js';
import {createPrinterCheck} from './printer-check.js';
import {ObjectStore} from './objects/store.js';
import {ObjectService} from './objects/service.js';
import {generateTitle} from './objects/title.js';
import {PassTimings} from './touchup/stages.js';
import {printerStlSize} from './objects/stl-size.js';
import {runTouchup, acquireBlenderLock} from './touchup/touchup.js';
import {readBlenderAddonStatus, listening, BLENDER_MCP_PORT} from './touchup/blender.js';
import {BlenderAddonRepair} from './touchup/addon-repair.js';
import {ConfiguredAddonInstaller} from './touchup/addon-installer.js';
import {loadPrinterCatalog,type PrinterCatalog} from './objects/printers.js';
import {PrinterSetup,findMcpFolders} from './printing/setup.js';
import {homedir} from 'node:os';

// Presence is explicit opt-in. Invalid/empty configuration must fail, never fall back.
const directory = process.env.SCAN_TO_MAKE_REMOTE_AUTH_DIR;
const remoteAuth =
  directory === undefined ? undefined : await RemoteAuthStore.open(directory);
// Invalid model preferences must not take the paired phone API offline.
const modelAccess = remoteAuth ? await ModelAccessService.open(remoteAuth.directory,undefined,{legacyClaude:!!process.env.SCAN_TO_MAKE_CLAUDE_PATH}).catch(() => undefined) : undefined;

const captureDirectory=process.env.SCAN_TO_MAKE_CAPTURE_DIR;
if(captureDirectory!==undefined&&(!remoteAuth||!isAbsolute(captureDirectory)))throw new Error('Capture requires authentication and an absolute private directory');
const storage=captureDirectory===undefined?undefined:new FileSavedProjectStorage(join(captureDirectory,'projects'));
const capture:CaptureServices|undefined=storage&&captureDirectory?{storage,captures:new CaptureStore(storage,join(captureDirectory,'captures'),createCaptureConverter({
 executable:process.env.SCAN_TO_MAKE_CAPTURE_PYTHON??'python3',temporaryRoot:join(captureDirectory,'workers'),
})),detailStills:new DetailStillStore(storage,join(captureDirectory,'captures'))}:undefined;
const scanTool=process.env.SCAN_TO_MAKE_SCAN_REPAIR_TOOL;
const scanBlender=process.env.SCAN_TO_MAKE_SCAN_BLENDER;
if(scanTool!==undefined||scanBlender!==undefined){
 if(!capture||!captureDirectory||!scanTool||!scanBlender)throw new Error('Scan processing requires authenticated capture storage, tool and Blender paths');
 Object.assign(capture,{scanProcessing:new ScanProcessingStore(capture.storage,capture.captures!,join(captureDirectory,'captures'),createScanCleanupRunner({toolPath:scanTool,blender:scanBlender,python:process.env.SCAN_TO_MAKE_CAPTURE_PYTHON??'python3',correctTool:process.env.SCAN_TO_MAKE_SCAN_CORRECT_TOOL??join(dirname(scanTool),'../scan-correct/correct.py'),adapter:process.env.SCAN_TO_MAKE_CORRECTION_ADAPTER as 'scripted'|'anthropic'|'openai'|undefined,model:process.env.SCAN_TO_MAKE_CORRECTION_MODEL,baseUrl:process.env.SCAN_TO_MAKE_CORRECTION_BASE_URL,keyEnv:process.env.SCAN_TO_MAKE_CORRECTION_KEY_ENV,printable:{},
  // The saved selection, including phone changes, is snapshotted when cleanup is admitted.
  selectAI:()=>modelAccess?.cleanupSnapshot()??{access:{kind:'none'}},
  ai:{access:{kind:'none'},cli:fileURLToPath(new URL('./ai-tweak-cli.js',import.meta.url)),judgeTool:process.env.SCAN_TO_MAKE_AI_JUDGE_TOOL??join(dirname(scanTool),'../ai-tweak-judge')}}))});
}
const handoffConfigPath=process.env.SCAN_TO_MAKE_PRINTER_HANDOFF_CONFIG||undefined;
const handoffDirectory=process.env.SCAN_TO_MAKE_PRINTER_HANDOFF_DIR||undefined;
if((handoffConfigPath===undefined)!==(handoffDirectory===undefined))throw new Error('Printer handoff requires both its config path and bundle directory');
if(handoffConfigPath!==undefined&&(!remoteAuth||!isAbsolute(handoffConfigPath)||!isAbsolute(handoffDirectory!)))throw new Error('Printer handoff requires authentication and absolute config and directory paths');
const handoffConfig=handoffConfigPath===undefined?undefined:await readPrinterHandoffConfig(handoffConfigPath);
let mcpUpdates:McpUpdater|undefined;
let blenderAddon:BlenderAddonRepair|undefined;
// PRD §8.10: every process started from the Mac's own profile runs the version an Update installed.
const runningHandoff=()=>handoffConfig&&mcpUpdates?mcpUpdates.effective('current',handoffConfig):handoffConfig;
const printerCheck=handoffConfig===undefined?undefined:createPrinterCheck(()=>runningHandoff()!);
// PRD §8.3: one long-lived MCP session per printer destination, shared by every call to it.
const printerPool=new PrinterSessionPool();
let printerDirectory:PrinterDirectory|undefined;
const onConnect=(destinationId:string)=>(catalog:import('@scan-to-make/printer-handoff').PrinterToolCatalog)=>printerDirectory?.connected(destinationId,catalog);
const printHandoff=handoffConfig===undefined?undefined:createPrintHandoffServices(handoffConfig,handoffDirectory!,{pool:printerPool,destinationId:'current',onConnect:onConnect('current')});
// PRD §8.10: a print and an update of its printer's MCP never overlap (the phone's handoff route prints on `current`).
const printGate=new PrintGate();
if(printHandoff)printHandoff.admit=()=>printGate.hold('current');
// docs/design/remote-mcp.md: `/v1/mcp` reaches every configured destination through its own shared session and relay.
// It reads the live destination map below (Add, Remove and Complete Settings change it in place).
if(printHandoff)printHandoff.remoteRelays=()=>[...(printerDestinations?.values()??[])].map(services=>services.relay);
// Objects keep the user's printer MCP; each model pass snapshots the saved AI selection.
const claudePath=process.env.SCAN_TO_MAKE_CLAUDE_PATH||undefined;
if(claudePath!==undefined&&!isAbsolute(claudePath))throw new Error('SCAN_TO_MAKE_CLAUDE_PATH must be absolute');
let objects:ObjectService|undefined;
// Events about the Mac rather than a project (mcp.update.*) have no projectId. Both apps decode them now
// (#210, #211); SCAN_TO_MAKE_PROJECTLESS_EVENTS=0 turns them off.
const projectlessEventsFlag=process.env.SCAN_TO_MAKE_PROJECTLESS_EVENTS;
if(projectlessEventsFlag!==undefined&&projectlessEventsFlag!=='0'&&projectlessEventsFlag!=='1')throw new Error('SCAN_TO_MAKE_PROJECTLESS_EVENTS must be 0 or 1 when set');
const projectlessEvents=projectlessEventsFlag!=='0';
// The app's data root (~/Library/Application Support/Scan to Make), the parent of the auth directory.
const dataRoot=remoteAuth?dirname(remoteAuth.directory):join(process.cwd(),'.counterpart');
const companionSettings=new CompanionSettingsStore(join(dataRoot,'settings.json'));
// PRD §8.7: every user-visible change is one event, with its words, in <data root>/events.ndjson.
let objectStoreForEvents:ObjectStore|undefined;
const eventLog=remoteAuth?await new EventLog(join(dataRoot,'events.ndjson'),{context:async draft=>{
  // An event about the Mac (mcp.update.*) has no project; its words come from the draft.
  if(!draft.projectId)return {title:'Counterpart'};
  const object=await objectStoreForEvents?.get(draft.projectId).catch(()=>undefined);
  if(!object)return {title:'Your project'};
  const size=sizeText(object.current?.sizeMm);
  return {title:projectTitle(object),...(size?{size}:{}),...(object.question?.closeup?{question:`Can you take a close-up of ${object.question.closeup}?`}:{}),
    ...(object.failure?{reason:object.failure}:{})};
}}).open():undefined;
const runtimeSettings=remoteAuth&&eventLog?new RuntimeSettings({modelAccess,emit:async draft=>{await eventLog.append(draft);}}):undefined;
const liveActivityTokens=remoteAuth?new LiveActivityTokenStore(join(dataRoot,'live-activity-tokens.json')):undefined;
const presence=remoteAuth?new DevicePresence(join(remoteAuth.directory,'device-presence.json')):undefined;
// Audit M4: legacy device rows (paired before stable identity) unused for 14 days are removed; checked at start and every 6 h.
if(remoteAuth&&presence){
  const prune=()=>void pruneLegacyDevices(remoteAuth,presence,{...(liveActivityTokens?{tokens:liveActivityTokens}:{})}).catch(()=>undefined);
  prune();
  setInterval(prune,6*60*60*1000).unref();
}
// PRD §8.10 and Settings → Printers: the updater (Update, Download) and printer setup are there with or without a
// printer yet; the catalog, its sessions and the busy check join them once printing is set up below.
let printerCatalog:PrinterCatalog|undefined;
let printerDestinations:Map<string,ReturnType<typeof createPrintHandoffServices>>|undefined;
let printerBusy:((id:string)=>Promise<boolean>)|undefined;
const printerEnv=hostEnvironment(dataRoot);
const mcpLabels:Record<string,string>={'bambu-printer-mcp':'bambu-printer-mcp','mcp-3d-printer-server':'mcp-3D-printer-server'};
if(remoteAuth)mcpUpdates=new McpUpdater({
  catalog:()=>printerCatalog,
  destinations:()=>printerCatalog?printerCatalog.destinations.map(destination=>({id:destination.id,config:printerCatalog!.resolve(destination.id)!})):[],
  env:printerEnv,overrides:new McpOverrides(join(dataRoot,'printers','overrides.json')),
  session:id=>{
    const services=printerDestinations;
    if(!services)return undefined;
    // A non-selected profile still needs its own session for an explicit move and connection verification.
    if(!services.has(id)){
      const config=printerCatalog?.entries().find(entry=>entry.id===id)?.config;
      if(config&&handoffDirectory)services.set(id,createPrintHandoffServices(config,handoffDirectory,{pool:printerPool,destinationId:id,onConnect:onConnect(id)}));
    }
    return services.get(id)?.runner.session;
  },
  // A project printing there, or the printer itself printing (the phone's handoff prints have no project).
  busy:async id=>printerBusy?await printerBusy(id):false,
  runningVersion:id=>printerDirectory?.capabilities(id)?.server.version,node:process.execPath,gate:printGate,
  ...(eventLog&&projectlessEvents?{emit:async event=>{await eventLog.append({id:randomUUID(),type:event.type,data:event.data,detail:{package:mcpLabels[event.package]??event.package,...(event.reason?{reason:event.reason}:{})}});}}:{}),
});
const printerProfiles=join(dataRoot,'printers','profiles.json');
/** After Add, Remove or a Printer MCP choice: the catalog reads every source again (in place), new printers get
 * their services, and a removed one's MCP session closes. */
const reloadPrinters=async()=>{
  const catalog=printerCatalog, services=printerDestinations;
  if(!catalog||!services||!printHandoff)return;
  const before=new Set(catalog.entries().map(entry=>entry.id));
  await catalog.reload();
  for(const destination of catalog.destinations)if(!services.has(destination.id)){
    // `current` keeps the phone handoff route's services: its pooled session answers through that relay, so a second
    // relay would never see the MCP's questions. Any destination starts with its saved Update override, as at start.
    services.set(destination.id,destination.id==='current'?printHandoff:createPrintHandoffServices(catalog.resolve(destination.id)!,handoffDirectory!,{pool:printerPool,destinationId:destination.id,onConnect:onConnect(destination.id)}));
    await mcpUpdates?.applyOverride(destination.id);
  }
  const now=new Set(catalog.entries().map(entry=>entry.id));
  for(const id of before)if(!now.has(id)&&id!=='current'){await services.get(id)?.runner.session?.close().catch(()=>undefined);services.delete(id);}
};
const printerSetup=mcpUpdates?new PrinterSetup({env:printerEnv,gate:printGate,configs:()=>printerCatalog?.entries()??[],
  effective:(id,config)=>mcpUpdates!.effective(id,config),download:pkg=>mcpUpdates!.download(pkg),
  latestVersion:(pkg,options)=>mcpUpdates!.latestVersion(pkg,options),folders:()=>findMcpFolders(homedir()),
  node:process.execPath,profilesPath:printerProfiles,catalog:()=>printerCatalog,reload:reloadPrinters,
  // Complete Settings changed its .env: the MCP reads it again on a fresh start (with any Update's override).
  // Its services are rebuilt with the catalog's new config (the recorded model, passed as bambu_model), keeping the
  // pooled session and its confirmation relay.
  restart:async id=>{
    const config=printerCatalog?.resolve(id), old=printerDestinations?.get(id);
    if(!config||!old)return;
    await old.runner.session?.restart(mcpUpdates!.effective(id,config));
    if(id!=='current')printerDestinations!.set(id,createPrintHandoffServices(config,handoffDirectory!,{pool:printerPool,destinationId:id,onConnect:onConnect(id),relay:old.relay as import('@scan-to-make/printer-handoff').InMemoryElicitationRelay}));
  },
  busy:async id=>printGate.held(id)||printGate.held(printerCatalog?.canonical(id)??id)||(printerBusy?await printerBusy(id):false)}):undefined;
// docs/design/remote-mcp.md: every configured printer and its services whenever printer handoff is configured, with
// or without objects, so `/v1/mcp/<id>` reaches each one; the objects setup reuses them. Reload and Complete Settings
// replace entries in this map in place, and `/v1/mcp` reads it live.
if(handoffConfig&&printHandoff){
  const services=printHandoff;
  printerCatalog=await loadPrinterCatalog(handoffConfig,{profilesPath:printerProfiles,
    placeholderEntryPoint:process.env.SCAN_TO_MAKE_DEFAULT_PRINTER_ENTRY});
  const catalog=printerCatalog;
  // `current` is the Mac app's own config and keeps the phone handoff route's services.
  printerDestinations=new Map(catalog.destinations.map(destination=>{
    const config=catalog.resolve(destination.id)!;
    return [destination.id,destination.id==='current'?services:createPrintHandoffServices(config,handoffDirectory!,{pool:printerPool,destinationId:destination.id,onConnect:onConnect(destination.id)})] as const;
  }));
  // PRD §8.10: Update updates the install each printer runs, between prints. The physical printer's own report is
  // checked with or without objects (a remote `/v1/mcp` print has no project); objects add their project check below.
  const live=printerDestinations, directory=new PrinterDirectory(catalog,id=>live.get(id)?.runner.session);
  printerDirectory=directory;
  printerBusy=id=>directory.printing(id);
  if(mcpUpdates)directory.useVersions(mcpUpdates);
}
if(handoffConfig&&printHandoff&&captureDirectory){
  const objectStore=new ObjectStore(join(captureDirectory,'objects'));
  objectStoreForEvents=objectStore;
  // Dispatched prints keep printing: ObjectService.resume() picks their monitors back up.
  await objectStore.recoverInterrupted({keepPrinting:true});
  const catalog=printerCatalog!, destinations=printerDestinations!;
  objects=new ObjectService({store:objectStore,runTouchup:input=>{if(!input.worker)throw Error('AI settings are unavailable. Open AI Settings on your Mac and retry.');return runTouchup(input);},modelAccess,requireModelAccess:true,claudePath:claudePath??'',handoff:handoffConfig,runningHandoff:()=>runningHandoff()!,printerCatalog:catalog,printers:printerDirectory,
    stlInfo:path=>printerStlSize(runningHandoff()!,path),
    print:{services:printHandoff,destinations},
    settings:companionSettings,runtimeSettings,camera:new CameraFrames(),printGate,
    passTimings:new PassTimings(join(dataRoot,'pass-timings.json')),
    titleFor:async request=>modelAccess?generateTitle(request,'',{worker:modelAccess.projectWorker()}):undefined,
    reportsCompletion:async note=>{if(!modelAccess)throw Error('AI settings are unavailable on this Mac');return reportsCompletion(note,'',modelAccess.projectWorker());},
    ...(eventLog?{events:{emit:async draft=>{await eventLog.append(draft);}}}:{})});
  await companionSettings.load();
  // A project printing there counts too.
  const service=objects, directory=printerDirectory!;
  printerBusy=async id=>await service.printerBusy(id)||await directory.printing(id);
  await mcpUpdates!.applyOverrides();
  const addonInstaller=new ConfiguredAddonInstaller(()=>runningHandoff()!,hostEnvironment(dataRoot));
  blenderAddon=new BlenderAddonRepair({gate:printGate,workRoot:dataRoot,listening:()=>listening(BLENDER_MCP_PORT),
    inspect:version=>addonInstaller.inspect(version),stage:directory=>addonInstaller.stage(directory),
    lock:()=>acquireBlenderLock(undefined,{signal:AbortSignal.timeout(10_000)}),
    probe:async()=>{
      const client=new PrinterMcpClient(runningHandoff()!);
      const signal=AbortSignal.timeout(15_000);
      try{await client.connect(signal);return await readBlenderAddonStatus(client,signal);}finally{await client.close().catch(()=>{});}
    }});
  await objects.resume();
}
// The objects setup applies saved MCP overrides itself; otherwise apply them here, so every session (the phone's and
// `/v1/mcp`'s) starts the version an Update chose.
if(mcpUpdates){if(!objects)await mcpUpdates.applyOverrides();mcpUpdates.start();}
if(capture?.scanProcessing&&captureDirectory)capture.modelSize=new ModelSizeStore(capture.storage,capture.scanProcessing,join(captureDirectory,'captures'),
 createModelSizeRunner(async()=>{const running=runningHandoff();return running?.backend==='bambu-printer-mcp'?running.process:installedBambuProcess();}));
// The port variable keeps its original name so existing operator setups still start.
let lanTls;
const certPath = process.env.SCAN_TO_MAKE_LAN_TLS_CERT;
const keyPath = process.env.SCAN_TO_MAKE_LAN_TLS_KEY;
if (certPath !== undefined || keyPath !== undefined) {
  if (!certPath || !keyPath || !isAbsolute(certPath) || !isAbsolute(keyPath)) throw new Error('Absolute LAN TLS certificate and key paths required');
  lanTls = {cert: await readFile(certPath), key: await readFile(keyPath)};
}
// Pairing v2 (MAC-5): also answer on the Mac's other addresses. Off until v2 links are minted.
const allAddresses = process.env.SCAN_TO_MAKE_LAN_ALL_ADDRESSES;
if (allAddresses !== undefined && allAddresses !== '1') throw new Error('SCAN_TO_MAKE_LAN_ALL_ADDRESSES must be 1 when set');
// Nearby pairing (MAC-5): Bonjour advert, 6-digit code and Allow. Needs the v2 addresses,
// and the Mac app's Allow card, so it is off until both are in place.
const nearbyPairing = process.env.SCAN_TO_MAKE_NEARBY_PAIRING;
if (nearbyPairing !== undefined && (nearbyPairing !== '1' || allAddresses !== '1'))
  throw new Error('SCAN_TO_MAKE_NEARBY_PAIRING must be 1 when set, with SCAN_TO_MAKE_LAN_ALL_ADDRESSES=1');
// Linux has no Computer Name unless the user set a pretty hostname: the host name names the advert there.
const macName = allAddresses === '1' ? computerName() ?? (process.platform === 'linux' ? macDisplayName() : undefined) : undefined;
// The Mac's name for people ("Mac mini"): /healthz and status.get.
const displayName = macDisplayName();
// PRD §5.10: a phone on the owner's Apple Account enrols with a token the Mac app publishes to their private CloudKit.
// CloudKit enrolment needs the signed Mac app to publish the token; no other host offers it.
const icloud = remoteAuth?.transport === 'lan' && process.platform === 'darwin' ? new IcloudEnrolment(join(remoteAuth.directory, 'mac-id')) : undefined;
const server = await startCompanionServer({
  lanTls,
  ...(displayName ? { name: displayName } : {}),
  ...(allAddresses === '1' ? { lanAddresses: () => discoverAddresses(), localName: localHostName() } : {}),
  ...(nearbyPairing === '1' ? { nearby: { name: macName ?? 'Scan to Make' } } : {}),
  capture,
  printHandoff,
  ...(printHandoff ? {remoteMcp: {
    bundleRoot: handoffDirectory!,
    // The gate is held for the destination whose session actually serves the call (a duplicate's winner, as above).
    admit: (id: string) => printGate.hold(printerCatalog?.canonical(id) ?? id),
    // Each id is served by its live winner, read on every request like the gate's key above.
    destinations: () => remoteDestinationsFor(printerDestinations ?? new Map(), id => printerCatalog?.canonical(id), printHandoff),
  }} : {}),
  ...(objects ? {objects} : {}),
  ...(eventLog ? {events: eventLog} : {}),
  ...(liveActivityTokens ? {liveActivityTokens} : {}),
  ...(presence ? {presence} : {}),
  ...(mcpUpdates ? {mcpUpdates} : {}),
  ...(printerSetup ? {printerSetup} : {}),
  ...(blenderAddon ? {blenderAddon} : {}),
  ...(icloud ? {icloud} : {}),
  remoteAuth,
  port:
    process.env.SCAN_TO_MAKE_GENERATION_PORT === undefined
      ? undefined
      : Number(process.env.SCAN_TO_MAKE_GENERATION_PORT),
});
let control: Awaited<ReturnType<typeof startLocalControl>> | undefined;
try {
  if (remoteAuth) control = await startLocalControl({
    // The auth directory is private even when its state/volume parent is not.
    path:process.env.SCAN_TO_MAKE_CONTROL_SOCKET ?? join(remoteAuth.directory,'control.sock'),
    dispatch:createControlDispatcher({auth:remoteAuth,modelAccess,runtimeSettings,printerCheck,companionVersion:await companionVersion(),...(displayName?{name:displayName}:{}),capture,
      captureDirectory:captureDirectory ? join(captureDirectory,'captures') : undefined,printHandoff,
      ...(objects ? {objects} : {}),
      ...(eventLog ? {events: eventLog} : {}),
      ...(liveActivityTokens ? {liveActivityTokens} : {}),
      ...(presence ? {presence} : {}),
      ...(mcpUpdates ? {mcpUpdates} : {}),
      ...(printerSetup ? {printerSetup} : {}),
  ...(blenderAddon ? {blenderAddon} : {}),
      // With every address answering, the Mac's QR is a v2 link from the live list.
      ...(allAddresses === '1' && server.publicKeySha256 ? {pairingLink:() => ({addresses:server.addresses(),publicKeySha256:server.publicKeySha256!,
        ...(macName ? {name:instanceName(macName)} : {})})} : {}),
      ...(server.nearby ? {nearby:server.nearby} : {}),
      ...(icloud && server.publicKeySha256 ? {icloudToken:async () => {
        const issued = await icloud.token();
        return {token:issued.token,expiresAt:new Date(issued.expiresAt).toISOString(),macId:issued.macId,spkiSha256:server.publicKeySha256!,addresses:server.addressList()};
      }} : {})}),
  });
  else if (process.env.SCAN_TO_MAKE_CONTROL_SOCKET !== undefined) throw new Error('Local control requires an auth store');
} catch {
  await server.close();
  throw new Error('Local control startup failed');
}
process.stdout.write(
  `${remoteAuth?.transport === 'lan' ? 'Paired LAN companion' : remoteAuth ? 'Private Serve companion' : 'Local companion'} ready at ${
    server.url
  }\n`
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    modelAccess?.close();
    // Wake every waiting events.wait and /v1/events first, so shutdown never waits out a long poll.
    eventLog?.close();
    void Promise.all([printerCheck?.close(),control?.close(),server.close()]).then(()=>printerPool.close()).catch(() => {
      process.exitCode = 1;
    });
  });
