#!/usr/bin/env node
// Real HTTPS acceptance: no forwarded-header fixtures or TLS verification bypass.
import assert from 'node:assert/strict';
import {createHash, randomUUID, X509Certificate} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {request} from 'node:https';
import {checkServerIdentity} from 'node:tls';
import {isLanAuthority} from '../../services/companion/dist/lan-transport.js';

const [invitationFile, captureFile, outputDirectory] = process.argv.slice(2);
if (!invitationFile || !captureFile || !outputDirectory || process.argv.length !== 5) {
  console.error('Usage: node capture-smoke.mjs <private-invitation.json> <capture.usdz> <new-private-output-directory>');
  process.exit(2);
}
process.umask(0o077);
const output = resolve(outputDirectory);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const invitation = JSON.parse(await readFile(invitationFile,'utf8'));
  const base = new URL(invitation.baseUrl);
  assert.equal(base.protocol,'https:');
  const pin=invitation.certificateSha256;
  let ca;
  if(pin !== undefined) {
    assert.match(pin,/^[a-f0-9]{64}$/);assert.ok(isLanAuthority(base.host));
    ca=await readFile(process.env.SCAN_TO_MAKE_LAN_TLS_CERT);
    assert.equal(new X509Certificate(ca).fingerprint256.replaceAll(':','').toLowerCase(),pin);
  } else assert.match(base.hostname,/\.ts\.net$/);
  assert.equal(base.origin,invitation.baseUrl);
  assert.equal(invitation.version,1);
  assert.match(invitation.code,/^[A-Za-z0-9_-]{32}$/);
  assert.ok(Number.isSafeInteger(invitation.expiresAt) && invitation.expiresAt > Date.now(),'Invitation expired');
  const capture = await readFile(captureFile);
  assert.ok(capture.length > 0 && capture.length <= 32*1024*1024,'Capture exceeds import limit');
  await mkdir(output,{mode:0o700}); // Refuse to overwrite any earlier acceptance run.
  let credential;
  async function wire(path, expected, {method='GET',headers={},body}={}) {
    // Only explicitly rejected reads are retried. POSTs are never replayed.
    for(let attempt=0;attempt<20;attempt++) {
      const response = await new Promise((resolve,reject)=>{
        const req=request(new URL(path,base), {
          method,ca,timeout:300_000,
          checkServerIdentity:(host,cert)=>{
            const failure=checkServerIdentity(host,cert);
            if(failure) return failure;
            if(pin && cert.fingerprint256?.replaceAll(':','').toLowerCase()!==pin) return new Error('Certificate pin mismatch');
          },
          headers:{...(credential ? {authorization:`Bearer ${credential.token}`,'x-scan-device':credential.deviceId} : {}),...headers},
        },res=>{
          const chunks=[];let length=0;
          res.on('data',part=>{length+=part.length;if(length>65*1024*1024)res.destroy(new Error('Response too large'));else chunks.push(part);});
          res.on('error',reject);
          res.on('end',()=>{
            const bytes=Buffer.concat(chunks),responseHeaders=new Headers();
            for(const [name,value] of Object.entries(res.headers)) if(value!==undefined) responseHeaders.set(name,String(value));
            resolve({status:res.statusCode,headers:responseHeaders,arrayBuffer:async()=>bytes,json:async()=>JSON.parse(bytes)});
          });
        });
        req.on('timeout',()=>req.destroy(new Error('HTTP timeout')));req.on('error',reject);req.end(body);
      });
      if(response.status===429 && method==='GET') { await response.arrayBuffer(); await delay(250); continue; }
      assert.equal(response.status,expected,`${method} ${path.split('?')[0]} returned HTTP ${response.status}`);
      return response;
    }
    throw new Error('Companion remained busy');
  }
  credential=await (await wire('/v1/pair',200,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:invitation.code,deviceName:'Companion capture smoke'})})).json();
  await writeFile(join(output,'device.json'),JSON.stringify(credential),{mode:0o600,flag:'wx'});
  await wire('/healthz',200);
  const projectId=`smoke-${randomUUID()}`;
  const project={formatVersion:'0.2.0',id:projectId,revision:1,brief:{object:'Captured object',context:'Companion acceptance',addition:'Inspect cleanup'},fit:null,preview:null,acceptedArtifact:null};
  const projectPath=`/v1/saved-projects/${projectId}`;
  const saved=await wire(projectPath,201,{method:'PUT',headers:{'content-type':'application/json','if-none-match':'*'},body:JSON.stringify(project)});
  const etag=saved.headers.get('etag');assert.ok(etag);await saved.arrayBuffer();
  const headers={'if-match':etag};
  const imported=await (await wire(`${projectPath}/captures?projectRevision=1`,201,{method:'POST',headers:{...headers,'content-type':'model/vnd.usdz+zip'},body:capture})).json();
  const capturePath=`${projectPath}/captures/${imported.captureId}`;
  const original=await wire(`${capturePath}/artifacts/original?projectRevision=1`,200,{headers});
  const originalBytes=Buffer.from(await original.arrayBuffer());
  assert.equal(sha(originalBytes),sha(capture));
  assert.equal(original.headers.get('x-content-sha256'),sha(capture));
  const created=await (await wire(`${capturePath}/scan-processing?projectRevision=1`,202,{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}'})).json();
  let job=created.job;
  const jobPath=`${capturePath}/scan-processing/${job.jobId}`;
  const deadline=Date.now()+660_000;
  while(job.status==='queued'||job.status==='running') {
    assert.ok(Date.now()<deadline,'Processing exceeded acceptance deadline');
    await delay(1500);
    job=(await (await wire(`${jobPath}?projectRevision=1`,200,{headers})).json()).job;
  }
  await writeFile(join(output,'job.json'),JSON.stringify(job,null,2),{mode:0o600,flag:'wx'});
  assert.equal(job.status,'succeeded');
  for(const kind of ['repair','measure','render']) assert.equal(job.stages.find(s=>s.kind===kind)?.status,'succeeded',kind);
  assert.equal(job.measuredPrincipalExtentsMm.length,3);
  assert.ok(job.measuredPrincipalExtentsMm.every(n=>Number.isFinite(n)&&n>0));
  const names=['repaired.stl','repaired.obj','report.json','pos_x.png','pos_y.png','pos_z.png','neg_x.png','neg_y.png','neg_z.png','iso_pp.png','iso_np.png','iso_nn.png','iso_pn.png'];
  for(const name of names) {
    const response=await wire(`${jobPath}/artifacts/${name}?projectRevision=1`,200,{headers});
    const bytes=Buffer.from(await response.arrayBuffer());
    const identity=job.artifacts[name];assert.ok(identity);
    assert.equal(bytes.length,identity.byteLength);
    assert.equal(sha(bytes),identity.sha256);
    assert.equal(response.headers.get('x-content-sha256'),identity.sha256);
    assert.equal(Number(response.headers.get('content-length')),bytes.length);
    if(name.endsWith('.png')) assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    await writeFile(join(output,name),bytes,{mode:0o600,flag:'wx'});
  }
  const summary={deviceId:credential.deviceId,projectId,captureId:imported.captureId,jobId:job.jobId,sourceSha256:sha(capture),measuredPrincipalExtentsMm:job.measuredPrincipalExtentsMm,verifiedArtifacts:names.length};
  await writeFile(join(output,'summary.json'),JSON.stringify(summary,null,2),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify(summary,null,2));
} catch(error) {
  // Never log an HTTP request, invitation, token or URL on failures.
  console.error(`Capture smoke failed (${error?.code ?? error?.name ?? 'error'}). Private partial results: ${output}`);
  process.exitCode=1;
}
