// Liveness only. Acceptance separately pairs and requires authorized health.
import {readFile} from 'node:fs/promises';
import {request} from 'node:https';
import {RemoteAuthStore} from '../../services/companion/dist/remote-auth.js';
const directory = process.env.SCAN_TO_MAKE_REMOTE_AUTH_DIR;
const auth = directory ? await RemoteAuthStore.open(directory) : undefined;
let status, body;
if(auth?.transport === 'lan') {
  const cert = await readFile(process.env.SCAN_TO_MAKE_LAN_TLS_CERT);
  ({status, body} = await new Promise((resolve,reject)=>{
    const req = request(new URL('/healthz',auth.baseUrl), {ca:cert,timeout:3000}, res=>{
      let data='';res.on('data',part=>{data+=part;if(data.length>4096)res.destroy(new Error('Health response too large'));});
      res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(data)});}catch(error){reject(error);}});
    });req.on('timeout',()=>req.destroy(new Error('Health timeout')));req.on('error',reject);req.end();
  }));
} else {
  const port=process.env.SCAN_TO_MAKE_GENERATION_PORT ?? '9077';
  const r=await fetch(`http://127.0.0.1:${port}/healthz`, {signal:AbortSignal.timeout(3000)});
  status=r.status;body=await r.json();
}
const ok=auth?.transport === 'lan' ? status===401 && body.error?.code==='unauthorized'
  : auth ? status===403 && body.error?.code==='forbidden'
  : status===200 && body.status==='ok' && body.protocolVersion==='0.1.0';
if(!ok) process.exit(1);
