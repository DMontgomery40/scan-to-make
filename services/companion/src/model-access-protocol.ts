import {z} from 'zod';
import {ModelAccessChoiceSchema} from '@scan-to-make/contracts/model-access';
export {ModelAccessChoiceSchema,type ModelAccessChoice} from '@scan-to-make/contracts/model-access';

export const ModelAccessRecordSchema = z.strictObject({version:z.literal(1),revision:z.uuid(),choice:ModelAccessChoiceSchema});
export type ModelAccessRecord = z.infer<typeof ModelAccessRecordSchema>;
export interface ModelAccessCheck {
  id:string; revision:string;
  state:'checking'|'connected'|'failed'|'skipped';
  outcome?:'auth-failed'|'needs-gui-session'|'timed-out'|'cancelled'|'failed'|'skipped';
}
