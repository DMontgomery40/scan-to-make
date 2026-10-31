import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {FileSavedProjectStorage} from '@scan-to-make/project';
import {createSavedProjects} from '@scan-to-make/contracts/saved-project';
import {SCAN_VIEW_NAMES} from '@scan-to-make/contracts/scan-processing';
import {CaptureStore} from '../../dist/capture-import.js';
import {ScanProcessingStore} from '../../dist/scan-processing.js';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const cube=Buffer.from('v 0 0 0\nv .06 0 0\nv .06 .04 0\nv 0 .04 0\nv 0 0 .02\nv .06 0 .02\nv .06 .04 .02\nv 0 .04 .02\nf 1 4 3 2\nf 5 6 7 8\nf 1 2 6 5\nf 2 3 7 6\nf 3 4 8 7\nf 4 1 5 8\n');
export const png=Buffer.from([137,80,78,71,13,10,26,10,0]);
export const fakeRunner={async run(stage,input,output){await mkdir(output,{recursive:true});if(stage==='repair'){await writeFile(join(output,'repaired.obj'),cube);await writeFile(join(output,'repaired.stl'),'synthetic stl');await writeFile(join(output,'report.json'),'{}');}if(stage==='render')for(const n of SCAN_VIEW_NAMES)await writeFile(join(output,n),png);return Buffer.from(JSON.stringify({principalExtentsMm:[62.9,48.7,21.7]}));}};
export async function fixture(t,runner=fakeRunner,timeout=600000){
 const root=await mkdtemp(join(tmpdir(),'scan-processing-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const storage=new FileSavedProjectStorage(join(root,'projects'));
 const projects=createSavedProjects(storage);await projects.create({id:'test',brief:{object:'Box',context:'Desk',addition:'Holder'}});
 const converter={async convert(original){return {derived:cube,report:Buffer.from(JSON.stringify({tool:'capture-mesh-convert',toolVersion:'0.3.0',source:{sha256:sha(original),bytes:original.length},output:{sha256:sha(cube),bytes:cube.length,format:'obj'},metersPerUnit:1,unitsAuthored:true,upAxis:'Y',metricQualified:true,metricQualifiedReason:null,outputBasis:{coordinates:'world',units:'native stage units (unrescaled)',metersPerUnit:1,upAxis:'Y'},contributingLayers:[{identifier:'synthetic.usdc',sha256:'a'.repeat(64),bytes:30}],unsupportedFeatures:[],provesCompleteCapture:false,provesPhysicalFit:false}))};}};
 const captures=new CaptureStore(storage,join(root,'captures'),converter);
 const {captureId}=await captures.importCapture({projectId:'test',projectRevision:0,source:Buffer.from('synthetic source')});
 const store=new ScanProcessingStore(storage,captures,join(root,'captures'),runner,timeout);t.after(()=>store.close());
 return {root,storage,projects,captures,store,input:{projectId:'test',projectRevision:0,captureId}};
}
