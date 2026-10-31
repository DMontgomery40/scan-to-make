import {z} from 'zod';
export * from '@scan-to-make/contracts/printer-setup';
import {PrinterSetupChoiceSchema,PrinterConnectionModeSchema,PrinterModelSchema} from '@scan-to-make/contracts/printer-setup';
export const PrinterSetupRecordSchema = z.strictObject({version:z.literal(1),revision:z.uuid(),configured:z.boolean(),choice:PrinterSetupChoiceSchema});
export type PrinterSetupRecord = z.infer<typeof PrinterSetupRecordSchema>;
export const PrinterProbeSchema = z.strictObject({
  status:z.enum(['connected','failed']),camera:z.enum(['connected','failed','not-supported']),
  image:z.strictObject({mimeType:z.literal('image/jpeg'),base64:z.string().max(700000).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).optional(),
  model:PrinterModelSchema.optional(),firmware:z.string().regex(/^\d{2}\.\d{2}\.\d{2}\.\d{2}$/).optional(),
  fulu:z.enum(['available','unavailable']),
});
export type PrinterProbe = z.infer<typeof PrinterProbeSchema>;
export interface PrinterSetupCheck {
  id:string;revision:string;state:'checking'|'connected'|'failed'|'skipped';
  result?:PrinterProbe;
}
export interface PrinterRoute {connection_mode:z.infer<typeof PrinterConnectionModeSchema>;developerMode:'required'|'not-required'|'unknown'}
/** Presentation choices, never print authorization. Keep the only documented
 * pre-authorization threshold model-specific; missing telemetry stays unknown. */
export function printerRoutes(model:z.infer<typeof PrinterModelSchema>,firmware?:string,fulu=false):PrinterRoute[] {
  if (model==='x2d') return [{connection_mode:'bambu_native',developerMode:'not-required'},{connection_mode:'bambu_connect',developerMode:'not-required'}];
  const oldP1 = (model==='p1s'||model==='p1p') && firmware && /^\d{2}\.\d{2}\.\d{2}\.\d{2}$/.test(firmware) && firmware<'01.08.05.00';
  return [{connection_mode:'lan_mqtt_ftps',developerMode:oldP1?'not-required':(model==='p1s'||model==='p1p')&&firmware?'required':'unknown'},
    {connection_mode:'bambu_connect',developerMode:'not-required'},...(fulu?[{connection_mode:'bambu_network' as const,developerMode:'not-required' as const}]:[])];
}
