import {PreparedJobStore} from './prepared-jobs.js';
import {isAbsolute,join} from 'node:path';
import {FileSavedProjectStorage} from '@scan-to-make/project';
import {CaptureStore} from './capture-import.js';
import {createCaptureConverter} from './capture-converter.js';
import { startGenerationServer } from './generation.js';
import { RemoteAuthStore } from './remote-auth.js';
import {readPrivateConfig,inspectorProcessSchema} from './private-config.js';

// Presence is explicit opt-in. Invalid/empty configuration must fail, never fall back.
const directory = process.env.SCAN_TO_MAKE_REMOTE_AUTH_DIR;
const remoteAuth =
  directory === undefined ? undefined : await RemoteAuthStore.open(directory);

const captureDirectory=process.env.SCAN_TO_MAKE_CAPTURE_DIR;
if(captureDirectory!==undefined&&(!remoteAuth||!isAbsolute(captureDirectory)))throw new Error('Capture requires authentication and an absolute private directory');
const storage=captureDirectory===undefined?undefined:new FileSavedProjectStorage(join(captureDirectory,'projects'));
const capture=storage&&captureDirectory?{storage,captures:new CaptureStore(storage,join(captureDirectory,'captures'),createCaptureConverter({
 executable:process.env.SCAN_TO_MAKE_CAPTURE_PYTHON??'python3',temporaryRoot:join(captureDirectory,'workers'),
}))}:undefined;
// Only a host operator chooses the executable. Remote envelopes cannot select it.
const inspectorFile=process.env.SCAN_TO_MAKE_PREPARED_MCP_CONFIG;
if(inspectorFile!==undefined){
 if(!capture||!captureDirectory||!isAbsolute(inspectorFile))throw new Error('Prepared jobs require authenticated storage and an absolute private inspector configuration');
 const configuration=await readPrivateConfig(inspectorFile,inspectorProcessSchema,'Inspector configuration');
 Object.assign(capture,{preparedJobs:new PreparedJobStore(capture.storage,join(captureDirectory,'prepared-jobs'),{inspection:{process:configuration}})});
}
const server = await startGenerationServer({
  capture,
  remoteAuth,
  port:
    process.env.SCAN_TO_MAKE_GENERATION_PORT === undefined
      ? 9077
      : Number(process.env.SCAN_TO_MAKE_GENERATION_PORT),
});
process.stdout.write(
  `${remoteAuth ? 'Private Serve generation' : 'Local generation'} ready at ${
    server.url
  }\n`
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void server.close().catch(() => {
      process.exitCode = 1;
    });
  });
