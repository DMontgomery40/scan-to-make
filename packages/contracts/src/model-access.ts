import {z} from 'zod';

const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);
const endpoint = z.string().max(2048).refine(value => {
  try {
    if (!/^https?:\/\//.test(value) || /[?#\\\u0000-\u0020\u007f]/.test(value) || value.split('/')[2]?.includes('@')) return false;
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
});
/** Metadata only. Credentials are owned by the signed Mac app's Keychain service. */
export const ModelAccessChoiceSchema = z.discriminatedUnion('kind', [
  z.strictObject({kind:z.literal('none')}),
  z.strictObject({kind:z.literal('claude-code')}),
  z.strictObject({kind:z.literal('codex-cli')}),
  z.strictObject({kind:z.literal('api'),provider:z.enum(['anthropic','openai']),model,keychainRef:z.uuid()}),
  z.strictObject({kind:z.literal('endpoint'),url:endpoint,model,keychainRef:z.uuid().optional()}),
]);
export type ModelAccessChoice = z.infer<typeof ModelAccessChoiceSchema>;

/** Canonical environment names consumed by ai-tweak-cli inside the worker only. */
export const ModelAccessEnvironment = {
  kind:'SCAN_TO_MAKE_AI_ACCESS', model:'SCAN_TO_MAKE_AI_MODEL',
  provider:'SCAN_TO_MAKE_AI_PROVIDER', endpoint:'SCAN_TO_MAKE_AI_ENDPOINT',
  keyName:'SCAN_TO_MAKE_AI_KEY_ENV', secret:'SCAN_TO_MAKE_MODEL_KEY', effort:'SCAN_TO_MAKE_AI_EFFORT',
  /** The visual pick's render scripts (tools/ai-tweak-judge): set by the installation's owner, never an argument (KAN-184). */
  judgeTool:'SCAN_TO_MAKE_AI_JUDGE_TOOL',
} as const;
