import {z} from 'zod';

export const PrinterModelSchema = z.enum(['p1s','p1p','p2s','x1c','x1e','a1','a1mini','h2d','h2dpro','h2s','h2c','x2d']);
export const PrinterConnectionModeSchema = z.enum(['lan_mqtt_ftps','bambu_native','bambu_network','bambu_connect']);
// Literal hosts only: no URL credentials, ports, paths, escaped delimiters or
// schemes whose interpretation could differ between Swift and the MCP server.
export const PrinterHostSchema = z.string().min(1).max(253).refine(v=>!/[\s\x00-\x1f]/.test(v)).regex(/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/);
export const PrinterDestinationSchema = z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('bambu'),printer_host:PrinterHostSchema,bambu_serial:z.string().refine(v=>!/[\s\x00-\x1f]/.test(v)).regex(/^[A-Za-z0-9]{1,64}$/),bambu_model:PrinterModelSchema}),
  z.strictObject({kind:z.literal('other'),printer_host:PrinterHostSchema,printer_type:z.enum(['octoprint','klipper','duet','repetier','prusa','creality']),printer_port:z.string().regex(/^[1-9][0-9]{0,4}$/).refine(v=>Number(v)<=65535).optional()}),
]);
const optionalPath = z.string().refine(v=>new TextEncoder().encode(v).length<=4096&&!/[\x00-\x1f\x7f-\x9f]/.test(v)).regex(/^\/[^\x00-\x1f]*$/).optional();
export const PrinterSetupChoiceSchema = z.union([
  z.strictObject({kind:z.literal('none')}),
  z.strictObject({...PrinterDestinationSchema.options[0].shape,keychainRef:z.uuid(),connection_mode:PrinterConnectionModeSchema,slicer_path:optionalPath,blender_mcp_command:optionalPath,
    blender_mcp_args:z.string().refine(v=>new TextEncoder().encode(v).length<=8192).refine(v=>{try { const a=JSON.parse(v); return Array.isArray(a)&&a.length<=64&&a.every(x=>typeof x==='string'&&!/[\x00-\x1f\x7f-\x9f]/.test(x)); } catch {return false;} }).optional()})
    .refine(v=>v.connection_mode!=='bambu_native'||v.bambu_model==='x2d')
    .refine(v=>v.bambu_model!=='x2d'||v.connection_mode!=='lan_mqtt_ftps'),
  z.strictObject({...PrinterDestinationSchema.options[1].shape,keychainRef:z.uuid(),slicer_path:optionalPath,slicer_type:z.enum(['prusaslicer','slic3r','cura','orcaslicer','orcaslicer-bambulab','bambustudio']).optional()}),
]).refine(v=>new TextEncoder().encode(JSON.stringify(v)).length<=12288);
export type PrinterDestination = z.infer<typeof PrinterDestinationSchema>;
export type PrinterSetupChoice = z.infer<typeof PrinterSetupChoiceSchema>;
export type PrinterModel = z.infer<typeof PrinterModelSchema>;
export type PrinterConnectionMode = z.infer<typeof PrinterConnectionModeSchema>;
export function printerDestination(choice:Exclude<PrinterSetupChoice,{kind:'none'}>):PrinterDestination {
  return choice.kind==='bambu' ? {kind:choice.kind,printer_host:choice.printer_host,bambu_serial:choice.bambu_serial,bambu_model:choice.bambu_model}
    : {kind:choice.kind,printer_host:choice.printer_host,printer_type:choice.printer_type,...(choice.printer_port ? {printer_port:choice.printer_port}: {})};
}
