// Isolated protocol fixture: no printer implementation or network access.
import {createInterface} from 'node:readline';
import {readFileSync, appendFileSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const [mode, log] = process.argv.slice(2);
const props = {bambu_model:{enum:['p1s']},plate_index:{type:'integer',minimum:0},nozzle_diameters:{type:'array',items:{enum:[0.4]}},bed_type:{enum:['textured_plate']}};
const inspection = {name:'inspect_print_file',inputSchema:{type:'object',additionalProperties:false,required:['file_path','bambu_model'],properties:{...props,file_path:{type:'string'}}}};
const print = {name:'print_3mf',inputSchema:{type:'object',additionalProperties:false,required:['three_mf_path','bambu_model'],properties:{...props,three_mf_path:{type:'string'},use_ams:{type:'boolean'},ams_mapping:{type:'array',items:{type:'integer'}}}}};
if(mode==='multi') print.inputSchema.properties.ams_mapping={const:[3,-1,129]};
if(mode==='incompatible') print.inputSchema.properties.bambu_model={enum:['a1']};
const lines=createInterface({input:process.stdin});lines.on('close',()=>process.exit());
lines.on('line',async line=>{
 const req=JSON.parse(line);appendFileSync(log,JSON.stringify(req)+'\n');if(req.id===undefined)return;
 const reply=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\n');
 if(req.method==='initialize')return reply({protocolVersion:req.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'file-only-fixture',version:'1'}});
 if(req.method==='tools/list')return reply({tools:mode==='missing'?[print]:[print,inspection]});
 if(req.method!=='tools/call'||req.params.name!=='inspect_print_file')throw Error('Forbidden fixture method');
 if(mode==='stall')return;
 if(mode==='gate')while(!existsSync(log+'.release'))await new Promise(r=>setTimeout(r,10));
 const a=req.params.arguments,bytes=readFileSync(a.file_path),hash=createHash('sha256').update(bytes).digest('hex');
 const receipt={receipt_version:'1',evidence:'file-only',dispatch_authorized:false,artifact:{sha256:hash,byte_length:bytes.length,file_format:a.file_path.endsWith('.3mf')?'3mf':'gcode'},selection:{bambu_model:a.bambu_model,plate_index:a.plate_index,nozzle_diameters:a.nozzle_diameters,bed_type:a.bed_type},inspection:{model:a.bambu_model,nozzleDiameters:a.nozzle_diameters,materials:['PLA'],usedFilamentPositions:[0],sha256:hash,maxNozzleTemperature:220,maxBedTemperature:60,maxChamberTemperature:0,bedType:'textured pei plate',selectsAms:false,...(a.file_path.endsWith('.3mf')?{plateInternalPath:`Metadata/plate_${a.plate_index+1}.gcode`}:{})}};
 if(mode==='multi'){receipt.inspection.materials=['PLA','ABS','PETG'];receipt.inspection.usedFilamentPositions=[0,2];receipt.inspection.selectsAms=true;}
 if(mode==='wrong-hash')receipt.artifact.sha256='0'.repeat(64);
 if(mode==='wrong-model')receipt.inspection.model='a1';
 if(mode==='wrong-plate')receipt.inspection.plateInternalPath='Metadata/plate_9.gcode';
 if(mode==='wrong-material')receipt.inspection.materials=['ABS'];
 if(mode==='authorized')receipt.dispatch_authorized=true;
 if(mode==='large')receipt.extra='x'.repeat(1100000);
 return reply({content:[{type:'text',text:JSON.stringify(receipt)}],...(mode==='tool-error'?{isError:true}:{})});
});
