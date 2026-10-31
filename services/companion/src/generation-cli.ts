import {ScanProcessingStore,createScanRunner} from './scan-processing.js';
import {PreparedJobStore, createPreparedProducer} from './prepared-jobs.js';
import {preparedProducerConfigurationSchema} from './prepared-production.js';
import {preparedPrintabilityConfigurationSchema, type PreparedPrintabilityConfiguration} from './prepared-printability.js';
import {z} from 'zod';
import {isAbsolute,join} from 'node:path';
import {FileSavedProjectStorage} from '@scan-to-make/project';
import {CaptureStore} from './capture-import.js';
import {DetailStillStore} from './detail-stills.js';
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
})),detailStills:new DetailStillStore(storage,join(captureDirectory,'captures'))}:undefined;
const scanTool=process.env.SCAN_TO_MAKE_SCAN_REPAIR_TOOL;
const scanBlender=process.env.SCAN_TO_MAKE_SCAN_BLENDER;
if(scanTool!==undefined||scanBlender!==undefined){
 if(!capture||!captureDirectory||!scanTool||!scanBlender)throw new Error('Scan processing requires authenticated capture storage, tool and Blender paths');
 Object.assign(capture,{scanProcessing:new ScanProcessingStore(capture.storage,capture.captures,join(captureDirectory,'captures'),createScanRunner({toolPath:scanTool,blender:scanBlender,python:process.env.SCAN_TO_MAKE_CAPTURE_PYTHON??'python3'}))});
}
// Only a host operator chooses the executable. Remote envelopes cannot select it.
const inspectorFile=process.env.SCAN_TO_MAKE_PREPARED_MCP_CONFIG;
const productionFile=process.env.SCAN_TO_MAKE_PREPARED_PRODUCTION_CONFIG;
if(inspectorFile!==undefined||productionFile!==undefined){
 if(!capture||!captureDirectory||!inspectorFile||!isAbsolute(inspectorFile))throw new Error('Prepared jobs require authenticated storage and an absolute private inspector configuration');
 const configuration=await readPrivateConfig(inspectorFile,inspectorProcessSchema,'Inspector configuration');
 const options:{inspection:{process:typeof configuration};production?:ReturnType<typeof createPreparedProducer>;printability?:PreparedPrintabilityConfiguration;appProduction?:{selection:unknown;displayName:string}}={inspection:{process:configuration}};
 if(productionFile!==undefined){
  if(!isAbsolute(productionFile))throw new Error('App prepared production requires an absolute private production configuration');
  // Operator-pinned printer profile: phones never choose hardware settings.
  const productionConfiguration=await readPrivateConfig(productionFile,z.strictObject({
   producer:preparedProducerConfigurationSchema,
   printability:preparedPrintabilityConfigurationSchema.optional(),
   selection:z.unknown(),
   displayName:z.string().trim().min(1).max(256),
  }),'Prepared production configuration');
  options.production=createPreparedProducer(productionConfiguration.producer);
  if(productionConfiguration.printability)options.printability=productionConfiguration.printability;
  options.appProduction={selection:productionConfiguration.selection,displayName:productionConfiguration.displayName};
 }
 Object.assign(capture,{preparedJobs:new PreparedJobStore(capture.storage,join(captureDirectory,'prepared-jobs'),options)});
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
