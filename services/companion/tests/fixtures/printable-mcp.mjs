import {createInterface} from 'node:readline';
import {writeFile,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
const tool=(name,properties={})=>({name,inputSchema:{type:'object',properties}});
for await(const line of createInterface({input:process.stdin})){
 const q=JSON.parse(line);if(q.id===undefined)continue;
 let result;
 if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'printable-fixture',version:'1'}};
 else if(q.method==='tools/list')result={tools:[tool('blender_mcp_status',{connect:{type:'boolean'}}),tool('blender_mcp_call',{tool_name:{type:'string'},arguments:{type:'object'}}),tool('get_stl_info',{stl_path:{type:'string'}})]};
 else if(q.method==='tools/call'){
  const mode=process.env.PRINTABLE_FIXTURE;
  if(q.params.name==='blender_mcp_call'){
   const expected=process.env.PRINTABLE_EXPECT_REPAIR_DIR;
   if(expected)for(const name of ['scan_printable.py','blender_tool.py'])
    if(!q.params.arguments.arguments.code.includes(join(expected,name)))throw Error('Worker must use configured external repair installation');
   const stage=join(process.cwd(),'.stage');
   await copyFile(join(process.cwd(),'.input/corrected.obj'),join(stage,'corrected.obj'));
   await writeFile(join(stage,'corrected.stl'),'synthetic-stl');
   const bounds={min:[0,0,0],max:[10,10,10]};
   await writeFile(join(stage,'printable.json'),JSON.stringify({schema:'scan-to-make.printable/0.1',status:mode==='blocked'?'blocked':'ready',problems:mode==='blocked'?['disconnected-shells']:[],warnings:[],
    before:{bboxMm:bounds,components:1},after:{bboxMm:mode==='moved'?{min:[1,0,0],max:[11,10,10]}:bounds,components:1,watertight:true},boundsChangeMm:0,exteriorDeviationMm:0,selfIntersections:0}));
  }
  const value=q.params.name==='get_stl_info'?{faceCount:12,boundingBox:{min:{x:0,y:0,z:0},max:{x:process.env.PRINTABLE_FIXTURE==='stl-mismatch'?11:10,y:10,z:10}}}:{connected:true};
  result={content:[{type:'text',text:JSON.stringify(value)}]};
 }else result={};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');
}
