import {createInterface} from 'node:readline';
import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
const tool=(name,properties)=>({name,inputSchema:{type:'object',properties}});
const num={type:'number'},str={type:'string'};
if(process.env.SIZE_FIXTURE==='hang')process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),250));
for await(const line of createInterface({input:process.stdin})){
 const q=JSON.parse(line);if(q.id===undefined)continue;
 let result;
 if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'size-fixture',version:'1'}};
 else if(q.method==='tools/list')result={tools:[tool('get_stl_info',{stl_path:str}),tool('rotate_stl',{stl_path:str,angle_x:num,angle_y:num,angle_z:num}),tool('scale_stl',{stl_path:str,scale_x:num,scale_y:num,scale_z:num})]};
 else if(q.method==='tools/call'){
  const {name,arguments:a}=q.params,mode=process.env.SIZE_FIXTURE;
  await appendFile(process.env.SIZE_LOG,JSON.stringify({pid:process.pid,name,...a})+'\n');
  const data=JSON.parse(await readFile(a.stl_path,'utf8'));let value;
  if(name==='get_stl_info'){
   const dimensions=Object.fromEntries(['x','y','z'].map((k,i)=>[k,data.dim[i]]));
   const center=Object.fromEntries(['x','y','z'].map((k,i)=>[k,data.centre[i]]));
   value={faceCount:12,boundingBox:{dimensions,center,min:Object.fromEntries(['x','y','z'].map(k=>[k,center[k]-dimensions[k]/2])),max:Object.fromEntries(['x','y','z'].map(k=>[k,center[k]+dimensions[k]/2]))}};
  }else{
   if(name==='rotate_stl'){
    if(Math.abs(a.angle_z-90)>1e-8||a.angle_x!==0||a.angle_y!==0)throw Error('Unexpected rotation');
    data.dim=[data.dim[1],data.dim[0],data.dim[2]];
   }else{
    if(mode==='hang')await new Promise(()=>{setInterval(()=>{},1000);});
    const factors=[a.scale_x,a.scale_y,a.scale_z];data.dim=data.dim.map((v,i)=>v*factors[i]);data.centre=data.centre.map((v,i)=>v*factors[i]);
    if(mode==='mismatch')data.dim[0]+=1;
    if(mode==='mutate')await writeFile(a.stl_path,'mutated');
   }
   value=join(mode==='escape'?process.cwd():process.env.TEMP_DIR,name+'.stl');
   await writeFile(value,JSON.stringify(data));
  }
  result={content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value)}]};
 }else result={};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');
}
