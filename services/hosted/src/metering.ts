import {z} from 'zod';

/**
 * Free-trial metering seam for the hosted service. This in-memory ledger is
 * the local-dev stand-in for the append-only hosted ledger described in
 * docs/hosted-service.md: same check/record shape, no persistence, no billing.
 * Production enforcement must record durably before dispatching paid work.
 */
export const METERING_UNITS=['scan-processing','ai-correction','design-generation','slicing'] as const;
export type MeteringUnit=(typeof METERING_UNITS)[number];
export type TrialLimits=Readonly<Record<MeteringUnit,number>>;
export interface TrialUsage {used:number;limit:number;allowed:boolean}
export interface TrialLedger {
 /** Current usage against the trial limit for one user and unit. */
 check(userId:string,unit:MeteringUnit):TrialUsage;
 /** Atomically consume one unit if the trial limit allows it. */
 tryRecord(userId:string,unit:MeteringUnit):boolean;
}
const limitsSchema=z.strictObject({
 'scan-processing':z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
 'ai-correction':z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
 'design-generation':z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
 slicing:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const userIdSchema=z.string().trim().min(1).max(256);
const unitSchema=z.enum(METERING_UNITS);

export function createInMemoryTrialLedger(limits:TrialLimits):TrialLedger{
 const parsed=limitsSchema.parse(limits);
 const usage=new Map<string,number>();
 const key=(userId:string,unit:MeteringUnit)=>JSON.stringify([userIdSchema.parse(userId),unitSchema.parse(unit)]);
 return {
  check(userId,unit){
   const used=usage.get(key(userId,unit))??0,limit=parsed[unit];
   return {used,limit,allowed:used<limit};
  },
  tryRecord(userId,unit){
   const k=key(userId,unit),used=usage.get(k)??0;
   if(used>=parsed[unit])return false;
   usage.set(k,used+1);return true;
  },
 };
}
