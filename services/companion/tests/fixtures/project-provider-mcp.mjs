import {createInterface} from 'node:readline';
import {writeFile} from 'node:fs/promises';
for await(const line of createInterface({input:process.stdin})){
 const q=JSON.parse(line);if(q.id===undefined)continue;let result={};
 if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'project-provider-fixture',version:'1'}};
 if(q.method==='tools/list')result={tools:[...(process.env.EXTRA_TOOLS??'').split(',').filter(Boolean).map(name=>({name,description:name,inputSchema:{type:'object',properties:{}}})),{name:'design_view',description:'Return an image of the model',inputSchema:{type:'object',properties:{},additionalProperties:false}},{name:'slice_stl',description:'Slice a checkpoint',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};
 if(q.method==='tools/call'){
  await writeFile(process.env.RECEIPT,JSON.stringify({called:q.params.name,secretPresent:!!(process.env.MODEL_SECRET||process.env.SCAN_TO_MAKE_MODEL_KEY||process.env.OPENAI_API_KEY)}));
  result={content:[{type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='},{type:'text',text:'View of the part'}]};
  if(q.params.name==='slice_stl')result={content:[{type:'text',text:'out/part.gcode'}],structuredContent:{slicer_result:{return_code:0,error:null,plates:[{plate_index:1,warnings:['floating cantilever needs supports']}]}}};
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');
}
