import {readFile} from 'node:fs/promises';
import {ScanProcessingStore,createScanCleanupRunner} from './scan-processing.js';
import {dirname,isAbsolute,join} from 'node:path';
import {FileSavedProjectStorage} from '@scan-to-make/project';
import {CaptureStore} from './capture-import.js';
import {DetailStillStore} from './detail-stills.js';
import {createCaptureConverter} from './capture-converter.js';
import { startCompanionServer } from './server.js';
import { RemoteAuthStore } from './remote-auth.js';
import { createPrintHandoffServices } from './print-handoff-http.js';
import { readPrinterHandoffConfig } from '@scan-to-make/printer-handoff';
import {startLocalControl} from './local-control.js';
import {createControlDispatcher, companionVersion} from './local-control-services.js';
import type {CaptureServices} from './capture-http.js';

// Presence is explicit opt-in. Invalid/empty configuration must fail, never fall back.
const directory = process.env.SCAN_TO_MAKE_REMOTE_AUTH_DIR;
const remoteAuth =
  directory === undefined ? undefined : await RemoteAuthStore.open(directory);

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
 Object.assign(capture,{scanProcessing:new ScanProcessingStore(capture.storage,capture.captures!,join(captureDirectory,'captures'),createScanCleanupRunner({toolPath:scanTool,blender:scanBlender,python:process.env.SCAN_TO_MAKE_CAPTURE_PYTHON??'python3',correctTool:process.env.SCAN_TO_MAKE_SCAN_CORRECT_TOOL??join(dirname(scanTool),'../scan-correct/correct.py'),adapter:process.env.SCAN_TO_MAKE_CORRECTION_ADAPTER as 'scripted'|'anthropic'|'openai'|undefined,model:process.env.SCAN_TO_MAKE_CORRECTION_MODEL,baseUrl:process.env.SCAN_TO_MAKE_CORRECTION_BASE_URL,keyEnv:process.env.SCAN_TO_MAKE_CORRECTION_KEY_ENV}))});
}
const handoffConfigPath=process.env.SCAN_TO_MAKE_PRINTER_HANDOFF_CONFIG||undefined;
const handoffDirectory=process.env.SCAN_TO_MAKE_PRINTER_HANDOFF_DIR||undefined;
if((handoffConfigPath===undefined)!==(handoffDirectory===undefined))throw new Error('Printer handoff requires both its config path and bundle directory');
if(handoffConfigPath!==undefined&&(!remoteAuth||!isAbsolute(handoffConfigPath)||!isAbsolute(handoffDirectory!)))throw new Error('Printer handoff requires authentication and absolute config and directory paths');
const printHandoff=handoffConfigPath===undefined?undefined:createPrintHandoffServices(await readPrinterHandoffConfig(handoffConfigPath),handoffDirectory!);
// The port variable keeps its original name so existing operator setups still start.
let lanTls;
const certPath = process.env.SCAN_TO_MAKE_LAN_TLS_CERT;
const keyPath = process.env.SCAN_TO_MAKE_LAN_TLS_KEY;
if (certPath !== undefined || keyPath !== undefined) {
  if (!certPath || !keyPath || !isAbsolute(certPath) || !isAbsolute(keyPath)) throw new Error('Absolute LAN TLS certificate and key paths required');
  lanTls = {cert: await readFile(certPath), key: await readFile(keyPath)};
}
const server = await startCompanionServer({
  lanTls,
  capture,
  printHandoff,
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
    dispatch:createControlDispatcher({auth:remoteAuth,companionVersion:await companionVersion(),capture,
      captureDirectory:captureDirectory ? join(captureDirectory,'captures') : undefined,printHandoff}),
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
    void Promise.all([control?.close(),server.close()]).catch(() => {
      process.exitCode = 1;
    });
  });
