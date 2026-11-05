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

/** What the MCP reports about a file's settings, without the file's own paths. */
function settingsOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const {summary, raw_key_count: count} = value as {summary?: unknown; raw_key_count?: unknown};
  return summary === undefined ? undefined : JSON.stringify({summary, count});
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
    const read = async (path: string) => {
      const reply = await client.callTool('get_slice_settings', {source_path: path}, {signal, timeoutMs: 60_000});
      return reply.isError ? undefined : settingsOf(replyJson(reply));
    };
    const designer = await read(original);
    // A designer's file with no settings the MCP can read has none to lose.
    if (designer === undefined) return undefined;
    return await read(edited) === designer ? undefined : DESIGNER_FILE_REBUILT;
  } catch {
    return DESIGNER_FILE_UNCHECKED;
  } finally {
    await client.close().catch(() => undefined);
  }
}
