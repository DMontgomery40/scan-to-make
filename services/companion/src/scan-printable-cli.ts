import {readFile} from 'node:fs/promises';
import {runMakePrintable,type MakePrintableOptions} from './scan-printable.js';

// Trusted local worker interface. The job owns the config file; never an HTTP argument.
const controller=new AbortController();
process.once('SIGTERM',()=>controller.abort());process.once('SIGINT',()=>controller.abort());
try{
 if(process.argv.length!==3||!process.argv[2])throw Error('Usage: scan-printable-cli.js /absolute/config.json');
 const config=JSON.parse(await readFile(process.argv[2],'utf8')) as Omit<MakePrintableOptions,'signal'>;
 const result=await runMakePrintable({...config,signal:controller.signal});
 process.stdout.write(JSON.stringify(result)+'\n');
 if(result.status!=='ready')process.exitCode=2;
}catch{
 process.stderr.write('Make-printable did not produce a verified result.\n');process.exitCode=1;
}
