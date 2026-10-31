import {ScanProcessingStore,createScanCleanupRunner} from './scan-processing.js';
import {dirname,isAbsolute,join} from 'node:path';
import {FileSavedProjectStorage} from '@scan-to-make/project';
import {CaptureStore} from './capture-import.js';
import {DetailStillStore} from './detail-stills.js';
import {createCaptureConverter} from './capture-converter.js';
import { startCompanionServer } from './server.js';
import { RemoteAuthStore } from './remote-auth.js';

// Presence is explicit opt-in. Invalid/empty configuration must fail, never fall back.
const directory = process.env.SCAN_TO_MAKE_REMOTE_AUTH_DIR;
const remoteAuth =
  directory === undefined ? undefined : await RemoteAuthStore.open(directory);

const captureDirectory=process.env.SCAN_TO_MAKE_CAPTURE_DIR;
if(captureDirectory!==undefined&&(!remoteAuth||!isAbsolute(captureDirectory)))throw new Error('Capture requires authentication and an absolute private directory');
const storage=captureDirectory===undefined?undefined:new FileSavedProjectStorage(join(captureDirectory,'projects'));
const capture=storage&&captureDirectory?{storage,captures:new CaptureStore(storage,join(captureDirectory,'captures'),createCaptureConverter({
 executable:process.env.SCAN_TO_MAKE_CAPTURE_PYTHON??'python3',temporaryRoot:join(captureDirectory,'workers'),
})),detailStills:new DetailStillStore(storage,join(captureDirectory,'captures'))}:undefined;
const scanTool=process.env.SCAN_TO_MAKE_SCAN_REPAIR_TOOL;
const scanBlender=process.env.SCAN_TO_MAKE_SCAN_BLENDER;
if(scanTool!==undefined||scanBlender!==undefined){
 if(!capture||!captureDirectory||!scanTool||!scanBlender)throw new Error('Scan processing requires authenticated capture storage, tool and Blender paths');
 Object.assign(capture,{scanProcessing:new ScanProcessingStore(capture.storage,capture.captures,join(captureDirectory,'captures'),createScanCleanupRunner({toolPath:scanTool,blender:scanBlender,python:process.env.SCAN_TO_MAKE_CAPTURE_PYTHON??'python3',correctTool:process.env.SCAN_TO_MAKE_SCAN_CORRECT_TOOL??join(dirname(scanTool),'../scan-correct/correct.py'),adapter:process.env.SCAN_TO_MAKE_CORRECTION_ADAPTER as 'scripted'|'anthropic'|'openai'|undefined,model:process.env.SCAN_TO_MAKE_CORRECTION_MODEL,baseUrl:process.env.SCAN_TO_MAKE_CORRECTION_BASE_URL,keyEnv:process.env.SCAN_TO_MAKE_CORRECTION_KEY_ENV}))});
}
// The port variable keeps its original name so existing operator setups still start.
const server = await startCompanionServer({
  capture,
  remoteAuth,
  port:
    process.env.SCAN_TO_MAKE_GENERATION_PORT === undefined
      ? 9077
      : Number(process.env.SCAN_TO_MAKE_GENERATION_PORT),
});
process.stdout.write(
  `${remoteAuth ? 'Private Serve companion' : 'Local companion'} ready at ${
    server.url
  }\n`
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void server.close().catch(() => {
      process.exitCode = 1;
    });
  });
