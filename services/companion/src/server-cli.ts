import { randomUUID } from 'node:crypto';
import {ModelSizeStore} from './model-size.js';
import {createModelSizeRunner,installedBambuProcess} from './model-size-runner.js';
import {readFile} from 'node:fs/promises';
import {ScanProcessingStore,createScanCleanupRunner} from './scan-processing.js';
import {dirname,isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {modelAccessFromEnv} from './ai-tweak.js';
import {FileSavedProjectStorage} from '@scan-to-make/project';
import {CaptureStore} from './capture-import.js';
import {DetailStillStore} from './detail-stills.js';
import {createCaptureConverter} from './capture-converter.js';
import { startCompanionServer } from './server.js';
import { instanceName } from './bonjour.js';
import { computerName, discoverAddresses, localHostName } from './lan-addresses.js';
import { RemoteAuthStore } from './remote-auth.js';
import { createPrintHandoffServices } from './print-handoff-http.js';
import { PrinterSessionPool, readPrinterHandoffConfig } from '@scan-to-make/printer-handoff';
import { PrinterDirectory } from './printing/directory.js';
import { CameraFrames } from './printing/camera.js';
import { CompanionSettingsStore } from './settings.js';
import { EventLog } from './events/log.js';
import { projectTitle, sizeText } from './events/words.js';
import { LiveActivityTokenStore } from './devices/live-activity-tokens.js';
import { DevicePresence } from './devices/presence.js';
import { pruneLegacyDevices } from './devices/legacy.js';
import { McpOverrides, McpUpdater } from './printing/mcp-updates.js';
import { hostEnvironment } from './printing/mcp-install.js';
import {startLocalControl} from './local-control.js';
import {createControlDispatcher, companionVersion} from './local-control-services.js';
import type {CaptureServices} from './capture-http.js';
import {ModelAccessService} from './model-access.js';
import {createPrinterCheck} from './printer-check.js';
import {ObjectStore} from './objects/store.js';
import {ObjectService} from './objects/service.js';
import {judgePlate} from './objects/bedcheck.js';
import {generateTitle} from './objects/title.js';
import {PassTimings} from './touchup/stages.js';
import {printerStlSize} from './objects/stl-size.js';
import {runTouchup} from './touchup/touchup.js';
import {loadPrinterCatalog} from './objects/printers.js';

// Presence is explicit opt-in. Invalid/empty configuration must fail, never fall back.
const directory = process.env.SCAN_TO_MAKE_REMOTE_AUTH_DIR;
const remoteAuth =
  directory === undefined ? undefined : await RemoteAuthStore.open(directory);
// Invalid model preferences must not take the paired phone API offline.
const modelAccess = remoteAuth ? await ModelAccessService.open(remoteAuth.directory).catch(() => undefined) : undefined;

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
  // KAN-184: with SCAN_TO_MAKE_AI_ACCESS set, the correct stage is David's one-sentence AI step and its visual pick.
  ai:{access:modelAccessFromEnv(process.env),cli:fileURLToPath(new URL('./ai-tweak-cli.js',import.meta.url)),judgeTool:process.env.SCAN_TO_MAKE_AI_JUDGE_TOOL??join(dirname(scanTool),'../ai-tweak-judge')}}))});
}
const handoffConfigPath=process.env.SCAN_TO_MAKE_PRINTER_HANDOFF_CONFIG||undefined;
const handoffDirectory=process.env.SCAN_TO_MAKE_PRINTER_HANDOFF_DIR||undefined;
if((handoffConfigPath===undefined)!==(handoffDirectory===undefined))throw new Error('Printer handoff requires both its config path and bundle directory');
if(handoffConfigPath!==undefined&&(!remoteAuth||!isAbsolute(handoffConfigPath)||!isAbsolute(handoffDirectory!)))throw new Error('Printer handoff requires authentication and absolute config and directory paths');
const handoffConfig=handoffConfigPath===undefined?undefined:await readPrinterHandoffConfig(handoffConfigPath);
const printerCheck=handoffConfig===undefined?undefined:createPrinterCheck(handoffConfig);
// PRD §8.3: one long-lived MCP session per printer destination, shared by every call to it.
const printerPool=new PrinterSessionPool();
let printerDirectory:PrinterDirectory|undefined;
const onConnect=(destinationId:string)=>(catalog:import('@scan-to-make/printer-handoff').PrinterToolCatalog)=>printerDirectory?.connected(destinationId,catalog);
const printHandoff=handoffConfig===undefined?undefined:createPrintHandoffServices(handoffConfig,handoffDirectory!,{pool:printerPool,destinationId:'current',onConnect:onConnect('current')});
// Objects: the touch-up runs through the user's own printer MCP and their own Claude login. Needs both.
const claudePath=process.env.SCAN_TO_MAKE_CLAUDE_PATH||undefined;
if(claudePath!==undefined&&!isAbsolute(claudePath))throw new Error('SCAN_TO_MAKE_CLAUDE_PATH must be absolute');
let objects:ObjectService|undefined;
let mcpUpdates:McpUpdater|undefined;
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
const liveActivityTokens=remoteAuth?new LiveActivityTokenStore(join(dataRoot,'live-activity-tokens.json')):undefined;
const presence=remoteAuth?new DevicePresence(join(remoteAuth.directory,'device-presence.json')):undefined;
// Audit M4: legacy device rows (paired before stable identity) unused for 14 days are removed; checked at start and every 6 h.
if(remoteAuth&&presence){
  const prune=()=>void pruneLegacyDevices(remoteAuth,presence,{...(liveActivityTokens?{tokens:liveActivityTokens}:{})}).catch(()=>undefined);
  prune();
  setInterval(prune,6*60*60*1000).unref();
}
if(handoffConfig&&printHandoff&&captureDirectory&&claudePath){
  const objectStore=new ObjectStore(join(captureDirectory,'objects'));
  objectStoreForEvents=objectStore;
  // Dispatched prints keep printing: ObjectService.resume() picks their monitors back up.
  await objectStore.recoverInterrupted({keepPrinting:true});
  const printerCatalog=await loadPrinterCatalog(handoffConfig);
  // `current` is the Mac app's own config and keeps the phone handoff route's services.
  const destinations=new Map(printerCatalog.destinations.map(destination=>{
    const config=printerCatalog.resolve(destination.id)!;
    return [destination.id,destination.id==='current'?printHandoff:createPrintHandoffServices(config,handoffDirectory!,{pool:printerPool,destinationId:destination.id,onConnect:onConnect(destination.id)})] as const;
  }));
  printerDirectory=new PrinterDirectory(printerCatalog,id=>destinations.get(id)?.runner.session);
  objects=new ObjectService({store:objectStore,runTouchup:input=>runTouchup(input),claudePath,handoff:handoffConfig,printerCatalog,printers:printerDirectory,
    stlInfo:path=>printerStlSize(handoffConfig,path),
    print:{services:printHandoff,destinations,judgePlate:photo=>judgePlate(photo,claudePath)},
    settings:companionSettings,camera:new CameraFrames(),
    passTimings:new PassTimings(join(dataRoot,'pass-timings.json')),titleFor:request=>generateTitle(request,claudePath),
    ...(eventLog?{events:{emit:async draft=>{await eventLog.append(draft);}}}:{})});
  await companionSettings.load();
  // PRD §8.10: Update updates the install each printer runs, between prints.
  const service=objects, directory=printerDirectory;
  const labels:Record<string,string>={'bambu-printer-mcp':'bambu-printer-mcp','mcp-3d-printer-server':'mcp-3D-printer-server'};
  mcpUpdates=new McpUpdater({
    destinations:()=>printerCatalog.destinations.map(destination=>({id:destination.id,config:printerCatalog.resolve(destination.id)!})),
    env:hostEnvironment(dataRoot),overrides:new McpOverrides(join(dataRoot,'printers','overrides.json')),
    session:id=>destinations.get(id)?.runner.session,busy:id=>service.printerBusy(id),
    runningVersion:id=>directory.capabilities(id)?.server.version,node:process.execPath,
    ...(eventLog&&projectlessEvents?{emit:async event=>{await eventLog.append({id:randomUUID(),type:event.type,data:event.data,detail:{package:labels[event.package]??event.package}});}}:{}),
  });
  printerDirectory.useVersions(mcpUpdates);
  await mcpUpdates.applyOverrides();
  mcpUpdates.start();
  await objects.resume();
}
if(capture?.scanProcessing&&captureDirectory)capture.modelSize=new ModelSizeStore(capture.storage,capture.scanProcessing,join(captureDirectory,'captures'),
 createModelSizeRunner(async()=>handoffConfig?.backend==='bambu-printer-mcp'?handoffConfig.process:installedBambuProcess()));
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
const macName = allAddresses === '1' ? computerName() : undefined;
const server = await startCompanionServer({
  lanTls,
  ...(allAddresses === '1' ? { lanAddresses: () => discoverAddresses(), localName: localHostName() } : {}),
  ...(nearbyPairing === '1' ? { nearby: { name: macName ?? 'Scan to Make' } } : {}),
  capture,
  printHandoff,
  ...(objects ? {objects} : {}),
  ...(eventLog ? {events: eventLog} : {}),
  ...(liveActivityTokens ? {liveActivityTokens} : {}),
  ...(presence ? {presence} : {}),
  ...(mcpUpdates ? {mcpUpdates} : {}),
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
    dispatch:createControlDispatcher({auth:remoteAuth,modelAccess,printerCheck,companionVersion:await companionVersion(),capture,
      captureDirectory:captureDirectory ? join(captureDirectory,'captures') : undefined,printHandoff,
      ...(objects ? {objects} : {}),
      ...(eventLog ? {events: eventLog} : {}),
      ...(liveActivityTokens ? {liveActivityTokens} : {}),
      ...(presence ? {presence} : {}),
      ...(mcpUpdates ? {mcpUpdates} : {}),
      // With every address answering, the Mac's QR is a v2 link from the live list.
      ...(allAddresses === '1' && server.publicKeySha256 ? {pairingLink:() => ({addresses:server.addresses(),publicKeySha256:server.publicKeySha256!,
        ...(macName ? {name:instanceName(macName)} : {})})} : {}),
      ...(server.nearby ? {nearby:server.nearby} : {})}),
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
