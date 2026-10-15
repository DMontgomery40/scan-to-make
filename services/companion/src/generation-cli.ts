import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {z} from 'zod';
import {PreparedJobStore} from './prepared-jobs.js';
import {isAbsolute,join} from 'node:path';
import {FileSavedProjectStorage} from '@scan-to-make/project';
import {CaptureStore} from './capture-import.js';
import {createCaptureConverter} from './capture-converter.js';
import { startGenerationServer } from './generation.js';
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
}))}:undefined;
// Only a host operator chooses the executable. Remote envelopes cannot select it.
const inspectorFile=process.env.SCAN_TO_MAKE_PREPARED_MCP_CONFIG;
if(inspectorFile!==undefined){
 if(!capture||!captureDirectory||!isAbsolute(inspectorFile))throw new Error('Prepared jobs require authenticated storage and an absolute private inspector configuration');
 const file=await open(inspectorFile,constants.O_RDONLY|constants.O_NOFOLLOW);
 let configuration;
 try {
  const stat=await file.stat();
  if(!stat.isFile()||stat.size>65536||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw new Error('Inspector configuration must be a private regular file');
  const bytes=Buffer.alloc(65537);let length=0;
  while(length<bytes.length){const result=await file.read(bytes,length,bytes.length-length,null);if(!result.bytesRead)break;length+=result.bytesRead;}
  if(length>65536)throw new Error('Inspector configuration exceeds byte limit');
  const path=z.string().refine(isAbsolute);
  configuration=z.strictObject({command:path,args:z.array(z.string()).max(256).optional(),cwd:path.optional(),env:z.record(z.string(),z.string()).optional()})
   .parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length))));
 } finally {await file.close();}
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
