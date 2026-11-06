import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {zipSync,strToU8} from 'fflate';
import {HandoffBundleStore,PrinterHandoffRunner,inspectModelFile,readModelFile} from '../dist/index.js';
import {platesResult} from './support/plates-tool.mjs';
const model=(sliced=false)=>Buffer.from(zipSync({'[Content_Types].xml':strToU8('<Types/>'),'3D/3dmodel.model':strToU8('<model><metadata name="Title">Original</metadata><metadata name="Designer">Designer</metadata><resources><object id="1"><mesh/></object></resources><build><item objectid="1"/></build></model>'),'Metadata/model_settings.config':strToU8('<config><plate><metadata key="plater_id" value="2"/><metadata key="plater_name" value="Selected"/></plate></config>'),...(sliced?{'Metadata/plate_2.gcode':strToU8('; estimated printing time (normal mode) = 1m\nG1 X1')}:{})}));
const INFO={contract:'counterpart/1',server:{name:'x',version:'1'},printer:{kind:'bambu',host:'h'},capabilities:{progress:true,layers:true,camera:'none',filaments:'ams',pause:true,resume:true,cancel:true,print3mf:true,gcode:true}};
async function fixture(t,sliced=false,{backend='bambu-printer-mcp',badReceipt=false}={}){
 const root=await mkdtemp(join(tmpdir(),'published-handoff-'));t.after(()=>rm(root,{recursive:true,force:true}));const bytes=model(sliced),path=join(root,'original.3mf');await writeFile(path,bytes);const output=join(root,'derived.3mf');await writeFile(output,model(true));const calls=[];
 const properties=Object.fromEntries(['stl_path','slice_plate','orient','arrange','ensure_on_bed','load_filaments','filament_colours','filament_profile','layer_height','wall_loops','sparse_infill_density','file_path','bambu_model','plate_index','nozzle_diameters','bed_type','three_mf_path'].map(x=>[x,{}]));
 const session={hold:()=>()=>{},connect:async()=>({tools:[]}),config:{backend},hasTool:name=>['lay_flat','slice_stl','inspect_print_file','print_3mf','counterpart_printer_info','list_3mf_plates'].includes(name),getTool:name=>({name,inputSchema:{type:'object',properties}}),call:async(name,args,opts)=>{
  if(name==='counterpart_printer_info')return{content:[{type:'text',text:JSON.stringify(INFO)}]};
  // The file's plates are read-only MCP reads (list_3mf_plates), not part of the slice and print sequence asserted here.
  if(name==='list_3mf_plates')return platesResult(args.three_mf_path);
  calls.push({name,args});if(name==='lay_flat')throw Error('original 3MF was oriented');
  if(name==='slice_stl'){assert.deepEqual(await readFile(args.stl_path),bytes);return{content:[{type:'text',text:output}]};}
  if(name==='inspect_print_file')return{content:[{type:'text',text:JSON.stringify({artifact:{sha256:badReceipt?'0'.repeat(64):inspectModelFile(await readFile(args.file_path),'3mf').sha256},selection:{plate_index:1,bambu_model:'p1s'}})}]};
  if(name==='print_3mf'){await opts?.beforeDispatch?.();return{structuredContent:{jobName:'original'},content:[]};}
 }};
 const runner=new PrinterHandoffRunner({backend,process:{command:'/unused'},selection:{model:'p1s',printerType:'bambu',plateIndex:1},slicer:{loadFilaments:'/unrelated-single-spool',filamentColours:'#FFFFFF'}},{session});return{root,bytes,path,output,calls,runner};
}
test('published bundle names and verifies the actual 3MF, immutable through artifacts',async t=>{
 const f=await fixture(t),store=new HandoffBundleStore(join(f.root,'bundles'));const manifest=await store.create({model:{bytes:f.bytes,format:'3mf'},prompt:'',backend:'bambu-printer-mcp'});assert.equal(manifest.cleanStl,undefined);assert.equal(manifest.sourceModel.format,'3mf');assert.match(store.stlPath(manifest),/original\.3mf$/);await assert.rejects(store.writeDesignedStl(manifest.id,Buffer.alloc(100)),/cannot be replaced/);await store.recordArtifact(manifest.id,'sliced','original.3mf',model(true));assert.deepEqual(await readFile(store.stlPath(await store.read(manifest.id))),f.bytes);
});
for(const backend of ['bambu-printer-mcp','mcp-3d-printer-server'])test(`${backend}: unsliced source preserves bytes/filaments, selects one-based slice and zero-based print`,async t=>{
 const f=await fixture(t,false,{backend});let committed=false;await f.runner.run({stlPath:f.path,beforePrint:async()=>{committed=true;}});const slice=f.calls.find(x=>x.name==='slice_stl');assert.equal(slice.args.slice_plate,2);assert.equal(slice.args.orient,false);assert.equal(slice.args.arrange,false);assert.equal(slice.args.ensure_on_bed,false);assert.equal(slice.args.load_filaments,undefined);assert.equal(slice.args.filament_colours,undefined);assert.equal(f.calls.find(x=>x.name==='print_3mf').args.plate_index,1);assert.equal(committed,true);assert.deepEqual(await readFile(f.path),f.bytes);
});
test('already sliced original requires matching inspection receipt and never runs slicing',async t=>{
 const f=await fixture(t,true);await f.runner.run({stlPath:f.path,print:false});assert.deepEqual(f.calls.map(x=>x.name),['inspect_print_file']);const bad=await fixture(t,true,{badReceipt:true});await assert.rejects(bad.runner.run({stlPath:bad.path}),e=>e.code==='published-inspection-required');assert.ok(!bad.calls.some(x=>x.name==='print_3mf'));
});
test('malformed and oversized package metadata is refused',()=>{
 assert.throws(()=>inspectModelFile(Buffer.from('PK invalid'),'3mf'));const bomb=Buffer.from(zipSync({'[Content_Types].xml':strToU8('<Types/>'),'3D/3dmodel.model':new Uint8Array(9*1024*1024)}));assert.throws(()=>inspectModelFile(bomb,'3mf'),/too large/);
});

test('already sliced originals refuse overrides before anything is sliced or sent',async t=>{
 for (const slicer of [{repetitions:2},{layerHeightMm:0.12},{wallLoops:4},{sparseInfillDensity:'30%'},{loadFilaments:'/new/profile'}]) {
  const f=await fixture(t,true);await assert.rejects(f.runner.run({stlPath:f.path,slicer}),e=>e.code==='published-sliced-settings');assert.deepEqual(f.calls,[]);
 }
});

test('a saved archive with previews and slice metadata but no geometry or G-code is not a model',()=>{
 const bytes=Buffer.from(zipSync({'[Content_Types].xml':strToU8('<Types/>'),'3D/3dmodel.model':strToU8('<model><metadata name="Title">Preview only</metadata><resources/><build/></model>'),'Metadata/plate_1.json':strToU8('{"bbox_objects":[{"name":"Old model"}]}')}));
 assert.throws(()=>inspectModelFile(bytes,'3mf'),/no model or printable plate/);
});

test('source reads reject symlinks and preserve regular file bytes',async t=>{
 const f=await fixture(t);assert.deepEqual(await readModelFile(f.path),f.bytes);const alias=join(f.root,'alias.3mf');await symlink(f.path,alias);await assert.rejects(readModelFile(alias));
});
