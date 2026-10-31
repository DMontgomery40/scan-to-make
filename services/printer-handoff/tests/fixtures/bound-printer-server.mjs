import {serveBoundPrinter} from '../../dist/bound-mcp.js';
const [config,binding]=process.argv.slice(2);
const session=await serveBoundPrinter(JSON.parse(config),JSON.parse(binding));
process.once('SIGTERM',()=>{void session.close();});
await session.closed;
