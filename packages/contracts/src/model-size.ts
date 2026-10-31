import {z} from 'zod';

export const SIZE_EDGES=['length','width','height'] as const;
const positive=z.number().finite().positive();
export const BoxDimensionsMmSchema=z.strictObject({length:positive,width:positive,height:positive});
export type BoxDimensionsMm=z.infer<typeof BoxDimensionsMmSchema>;
const sourceUrl=z.url().refine(value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}},'Use a public HTTPS source URL');
export const SizeSourceSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('scanned')}),
 z.strictObject({kind:z.literal('maker'),name:z.string().trim().min(1).max(200),sourceUrl}),
 z.strictObject({kind:z.literal('measured'),edge:z.enum(SIZE_EDGES),mm:positive}),
]);
export type SizeSource=z.infer<typeof SizeSourceSchema>;
export const SizeSelectionSchema=z.strictObject({source:SizeSourceSchema,dimensionsMm:BoxDimensionsMmSchema.optional()}).superRefine((v,ctx)=>{
 if((v.source.kind==='maker')!==(v.dimensionsMm!==undefined))ctx.addIssue({code:'custom',message:'Only maker size requires three dimensions'});
});
export const ModelSizeRequestSchema=SizeSelectionSchema.safeExtend({
 expectedModelSha256:z.string().regex(/^[a-f0-9]{64}$/),expectedSizeRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type ModelSizeRequest=z.infer<typeof ModelSizeRequestSchema>;
const vector=z.tuple([z.number().finite(),z.number().finite(),z.number().finite()]);
export const BoxRotationSchema=z.tuple([vector,vector,vector]).superRefine((m,ctx)=>{
 for(let i=0;i<3;i++)for(let j=0;j<3;j++)if(Math.abs(m[i]!.reduce((s,v,k)=>s+v*m[j]![k]!,0)-(i===j?1:0))>1e-5)ctx.addIssue({code:'custom',message:'Invalid box rotation'});
 const det=m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])-m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])+m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
 if(Math.abs(det-1)>1e-5)ctx.addIssue({code:'custom',message:'Box rotation must preserve handedness'});
});
export type BoxRotation=z.infer<typeof BoxRotationSchema>;
export const SizeTransformSchema=z.strictObject({rotation:BoxRotationSchema,centreMm:vector,scaleFactors:BoxDimensionsMmSchema});
export const ModelSizeSchema=z.strictObject({
 schema:z.literal('scan-to-make.model-size/0.1'),jobId:z.uuid(),revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
 baseModelSha256:z.string().regex(/^[a-f0-9]{64}$/),source:SizeSourceSchema,
 scannedDimensionsMm:BoxDimensionsMmSchema,dimensionsMm:BoxDimensionsMmSchema,scaleFactors:BoxDimensionsMmSchema,
 // Estimated uncertainty, not a calibrated confidence interval; null means unknown.
 uncertaintyMm:positive.nullable(),
 artifact:z.strictObject({id:z.uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/),byteLength:z.number().int().positive().max(64*1024*1024),mediaType:z.literal('model/stl')}).nullable(),
 // For textured viewers: p_result = scale * (rotation * (p_source-centre) + centre).
 transform:SizeTransformSchema.nullable(),
}).superRefine((v,ctx)=>{
 if((v.revision===0)!==(v.artifact===null)||(v.artifact===null)!==(v.transform===null)||
   (v.source.kind==='scanned'?v.uncertaintyMm!==2:v.uncertaintyMm!==null)||v.revision===0&&v.source.kind!=='scanned')ctx.addIssue({code:'custom',message:'Incomplete size record'});
});
export type ModelSize=z.infer<typeof ModelSizeSchema>;
export class SizePlanError extends Error {
 readonly code='maker-size-out-of-range';
 constructor(name:string){super(`Your scan is too far from ${name}'s size to fix safely. Scan again, or keep the scanned size.`);}
}
export function planModelSize(scanned:BoxDimensionsMm,selection:z.infer<typeof SizeSelectionSchema>){
 const original=BoxDimensionsMmSchema.parse(scanned),choice=SizeSelectionSchema.parse(selection);
 if(original.length<original.width||original.width<original.height)throw Error('Original box edges must be longest, middle, shortest');
 const scaleFactors:BoxDimensionsMm={length:1,width:1,height:1};
 if(choice.source.kind==='maker'){
  for(const edge of SIZE_EDGES){
   const factor=choice.dimensionsMm![edge]/original[edge];
   if(factor<.95-1e-12||factor>1.05+1e-12)throw new SizePlanError(choice.source.name);
   scaleFactors[edge]=factor;
  }
 }else if(choice.source.kind==='measured'){
  const factor=choice.source.mm/original[choice.source.edge];
  for(const edge of SIZE_EDGES)scaleFactors[edge]=factor;
 }
 const dimensionsMm=BoxDimensionsMmSchema.parse(Object.fromEntries(SIZE_EDGES.map(edge=>[edge,original[edge]*scaleFactors[edge]])));
 BoxDimensionsMmSchema.parse(scaleFactors);
 return {source:choice.source,scannedDimensionsMm:original,dimensionsMm,scaleFactors,uncertaintyMm:choice.source.kind==='scanned'?2:null};
}
