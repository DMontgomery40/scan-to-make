import {PrinterMcpClient, type PrinterHandoffConfig} from '@scan-to-make/printer-handoff';

/**
 * A copy of a designer's 3MF must stay that 3MF: its parts, painted colours and print settings are what made it
 * print (2026-11-04: a caliper card rebuilt from its merged mesh lost its settings and its finest markings, and
 * no longer folded). The app doesn't read slicer settings itself; it asks the printer MCP's get_slice_settings
 * for the designer's file and the edited one, and the two must match.
 */
export const DESIGNER_FILE_REBUILT = "This change rebuilt the designer's file instead of editing it, so it wouldn't print the way the designer set it up. Your model wasn't changed. Ask again for just the change you want.";
export const DESIGNER_FILE_UNCHECKED = "Your printer service can't check that the designer's settings were kept. Update it in Settings → Printers, then ask again.";

type Client = Pick<PrinterMcpClient, 'connect' | 'callTool' | 'close' | 'hasTool'>;

function replyJson(reply: {content?: Array<{type: string; text?: string}>; structuredContent?: unknown}): unknown {
  if (reply.structuredContent !== undefined) return reply.structuredContent;
  const text = (reply.content ?? []).flatMap(item => item.type === 'text' && item.text ? [item.text] : []).join('');
  try { return JSON.parse(text); } catch { return undefined; }
}

/**
 * What the MCP reports about a file's settings, without the file's own paths; undefined when the reply isn't a
 * reading of them (an error, other JSON, or no summary). `none` is a successful reading that found no settings.
 */
function settingsOf(reply: {isError?: boolean; content?: Array<{type: string; text?: string}>; structuredContent?: unknown}): {key: string; none: boolean} | undefined {
  if (reply.isError) return undefined;
  const value = replyJson(reply);
  if (!value || typeof value !== 'object') return undefined;
  const {summary, raw_key_count: count} = value as {summary?: unknown; raw_key_count?: unknown};
  if (summary === undefined || typeof count !== 'number') return undefined;
  return {key: JSON.stringify({summary, count}), none: count === 0};
}

/**
 * Undefined when `edited` keeps the designer's settings, else the sentence the person reads. `original` is the
 * designer's own file; `edited` is the pass's out/touched.3mf, or undefined when the pass wrote none.
 */
export async function designerEditProblem(handoff: PrinterHandoffConfig, original: string, edited: string | undefined,
  opts: {client?: (handoff: PrinterHandoffConfig) => Client; signal?: AbortSignal} = {}): Promise<string | undefined> {
  if (!edited) return DESIGNER_FILE_REBUILT;
  const client = (opts.client ?? (config => new PrinterMcpClient(config)))(handoff);
  const signal = opts.signal ?? AbortSignal.timeout(120_000);
  try {
    await client.connect(signal);
    if (!client.hasTool('get_slice_settings')) return DESIGNER_FILE_UNCHECKED;
    const read = async (path: string) => settingsOf(await client.callTool('get_slice_settings', {source_path: path}, {signal, timeoutMs: 60_000}));
    const designer = await read(original);
    // Only a reading of the designer's file can approve an edit: one that couldn't be read proves nothing.
    if (!designer) return DESIGNER_FILE_UNCHECKED;
    // A designer's file the MCP read and found no settings in has none to lose.
    if (designer.none) return undefined;
    return (await read(edited))?.key === designer.key ? undefined : DESIGNER_FILE_REBUILT;
  } catch {
    return DESIGNER_FILE_UNCHECKED;
  } finally {
    await client.close().catch(() => undefined);
  }
}
