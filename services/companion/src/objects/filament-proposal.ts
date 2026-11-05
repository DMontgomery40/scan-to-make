import {z} from 'zod';

/**
 * The printer MCP's `counterpart_propose_filaments` result (docs/protocols/mcp-contract.md): which loaded spool
 * prints each of a model's colours, in the MCP's own words. The companion renders and passes it through; it keeps
 * no colour matching, tray naming or feed rules of its own (PRD §8.0 item 7).
 */
const colour = z.string().regex(/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/);
export const ProposalTraySchema = z.object({
  slot: z.number().int().min(0).max(4095),
  label: z.string().min(1).max(64),
  name: z.string().min(1).max(256),
  colour,
  material: z.string().min(1).max(128),
  filamentId: z.string().max(128),
  feed: z.string().min(1).max(32),
  sliceable: z.boolean(),
  profile: z.string().startsWith('/').max(4096).optional(),
});
export const FilamentProposalSchema = z.object({
  contract: z.literal('counterpart/1'),
  trays: z.array(ProposalTraySchema).max(256),
  proposal: z.array(z.object({
    index: z.number().int().min(1).max(64),
    slot: z.number().int().min(0).max(4095).optional(),
    verdict: z.enum(['same-colour', 'closest', 'no-colour', 'none']),
    distance: z.number().optional(),
    materialMismatch: z.boolean().optional(),
    note: z.string().max(1024).optional(),
  })).max(64),
  mapping: z.array(z.object({index: z.number().int().min(1).max(64), slot: z.number().int().min(0).max(4095)})).max(64).optional(),
  problems: z.array(z.object({code: z.string().max(64), message: z.string().min(1).max(1024), index: z.number().int().optional()})).max(64),
});
export type FilamentProposal = z.infer<typeof FilamentProposalSchema>;
export type ProposalTray = z.infer<typeof ProposalTraySchema>;

/** The MCP's result, or undefined when it isn't a `counterpart/1` proposal. */
export function readFilamentProposal(value: unknown): FilamentProposal | undefined {
  const parsed = FilamentProposalSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
