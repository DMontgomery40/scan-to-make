import {createServer} from 'node:http';
import {z} from 'zod';
import {DETAIL_STILL_SCHEMA_ID} from '@scan-to-make/contracts/detail-still';
import {SCAN_PROCESSING_SCHEMA_ID} from '@scan-to-make/contracts/scan-processing';

/**
 * Local-dev skeleton for the paid hosted service (docs/hosted-service.md).
 * Loopback only, one health endpoint, no accounts, storage, queue or workers.
 * It reuses the shared contract identities so clients can probe a hosted
 * deployment the same way they probe a companion, and proves the hosted
 * package builds and links against @scan-to-make/contracts unchanged.
 */
export const HostedHealthSchema=z.strictObject({
 status:z.literal('ok'),
 service:z.literal('scan-to-make-hosted'),
 // Same portable generation protocol version the companion health reports.
 protocolVersion:z.literal('0.1.0'),
 contracts:z.array(z.string()).readonly(),
});
export type HostedHealth=z.infer<typeof HostedHealthSchema>;

export function hostedHealth():HostedHealth{
 return HostedHealthSchema.parse({
  status:'ok',
  service:'scan-to-make-hosted',
  protocolVersion:'0.1.0',
  contracts:[DETAIL_STILL_SCHEMA_ID,SCAN_PROCESSING_SCHEMA_ID],
 });
}

export async function startHostedServer(options:{port?:number}={}):Promise<{url:string;close():Promise<void>}>{
 const port=options.port??9079;
 if(!Number.isSafeInteger(port)||port<0||port>65535)throw new Error('Invalid local port');
 let authority='';
 const fail=(response:import('node:http').ServerResponse,status:number,code:string)=>{
  response.statusCode=status;
  response.end(JSON.stringify({error:{code,message:code}}));
 };
 const server=createServer((request,response)=>{
  response.setHeader('Content-Type','application/json');
  response.setHeader('Cache-Control','no-store');
  response.setHeader('Connection','close');
  // Same local boundary posture as the companion listener: exact loopback
  // Host, no browser-origin requests, no CORS, and no forwarded/proxy headers.
  if(
   request.headers.host!==authority||
   request.headers.origin!==undefined||
   request.headers['sec-fetch-site']!==undefined||
   Object.keys(request.headers).some(key=>key.startsWith('x-forwarded-')||key.startsWith('tailscale-'))
  ){fail(response,403,'forbidden');return;}
  if(request.url!=='/healthz'){fail(response,404,'not-found');return;}
  if(request.method!=='GET'){fail(response,405,'method-not-allowed');return;}
  response.end(JSON.stringify(hostedHealth()));
 });
 server.headersTimeout=5000;
 server.requestTimeout=5000;
 server.maxRequestsPerSocket=1;
 await new Promise<void>((resolve,reject)=>{
  server.once('error',reject);
  server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});
 });
 const address=server.address();
 if(!address||typeof address==='string')throw new Error('Local listener has no address');
 authority=`127.0.0.1:${address.port}`;
 let closing:Promise<void>|undefined;
 return {
  url:`http://${authority}`,
  close(){
   if(!closing)closing=(async()=>{
    const stopped=new Promise<void>((resolve,reject)=>server.close(error=>(error?reject(error):resolve())));
    server.closeAllConnections();
    await stopped;
   })();
   return closing;
  },
 };
}
