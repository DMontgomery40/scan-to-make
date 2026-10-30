import {startHostedServer} from './hosted.js';

// Local development only. This skeleton never deploys anything; see
// docs/hosted-service.md for the production architecture it sketches.
const server=await startHostedServer({
 port:process.env.SCAN_TO_MAKE_HOSTED_PORT===undefined?9079:Number(process.env.SCAN_TO_MAKE_HOSTED_PORT),
});
process.stdout.write(`Hosted skeleton ready at ${server.url}\n`);
for(const signal of ['SIGINT','SIGTERM'] as const)
 process.once(signal,()=>{void server.close().catch(()=>{process.exitCode=1;});});
