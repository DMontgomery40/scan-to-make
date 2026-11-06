import {PrinterMcpClient, PrinterMcpError, toolResultJson, type PrinterHandoffConfig} from '@scan-to-make/printer-handoff';
import {toolErrorText} from './touchup/blender.js';
import {mcpPackageName} from './printing/print-settings.js';

type Client = Pick<PrinterMcpClient, 'connect' | 'hasTool' | 'callTool' | 'close'>;

/**
 * The Mac's Fusion Set Up and its "is it working?" check (PRD §8.9), both on the printer MCP as the companion runs it:
 * `running()` is the profile after any Update or Move override, never printer-handoff.json's own route. Each answer is
 * the tool's structured result, passed to the Mac as the MCP gives it; nothing here reads the MCP's wording.
 * `fusionStatus` adds `design` (the interim open-design read) only for an MCP that doesn't report `activeDesign`.
 */
export function fusionCalls(running: () => PrinterHandoffConfig, client: (config: PrinterHandoffConfig) => Client = config => new PrinterMcpClient(config)) {
  /** One tool call on an open connection: its structured result, or the MCP's own error text (never matched here). */
  const ask = async (mcp: Client, tool: string, args: Record<string, unknown>, signal: AbortSignal) => {
    let result;
    // PrinterMcpClient throws a tool's error result (`tool-failed`, the MCP's diagnostic in `detail`): it is the answer.
    try { result = await mcp.callTool(tool, args, {signal}); }
    catch (error) { if (error instanceof PrinterMcpError && error.code === 'tool-failed') return {error: error.detail ?? `${tool} failed.`}; throw error; }
    if (result.isError) return {error: toolErrorText(result)};
    return {result: toolResultJson<Record<string, unknown>>(result)};
  };
  const call = async (tool: string, args: Record<string, unknown>, timeoutMs: number,
      then?: (mcp: Client, result: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>>) => {
    const config = running(), server = mcpPackageName(config.backend), mcp = client(config);
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      await mcp.connect(signal);
      if (!mcp.hasTool(tool)) return {result: null, server};
      const answer = await ask(mcp, tool, args, signal);
      if (!answer.result) return {result: null, server, error: answer.error};
      return {result: answer.result, server, ...(then ? await then(mcp, answer.result, signal) : {})};
    } finally { await mcp.close().catch(() => {}); }
  };
  return {
    fusionSetup: async (install: boolean) => {
      const {result, ...rest} = await call('fusion_mcp_setup', install ? {install: true} : {}, install ? 300_000 : 90_000);
      return {setup: result, ...rest};
    },
    /** fusion_mcp_status {launch: true}: may start Fusion, and waits up to 90 s for its add-in. */
    fusionStatus: async () => {
      // Until both MCPs report `activeDesign` and it is installed through Update (PRD §8.0's order), an MCP without it
      // gets the check the Mac ran before: a read of the open design's parameters, which changes nothing. Its answer
      // goes to the Mac as `design`, as the MCP gave it. Delete this once the field ships in both MCPs.
      const {result, ...rest} = await call('fusion_mcp_status', {launch: true, timeout_ms: 90_000}, 150_000, async (mcp, status, signal) => {
        if (status.connected !== true || 'activeDesign' in status || !mcp.hasTool('fusion_mcp_call')) return {};
        const read = await ask(mcp, 'fusion_mcp_call', {tool_name: 'get_parameters', arguments: {}, timeout_ms: 20_000}, signal);
        return {design: read.result ? {isError: false} : {isError: true, text: read.error ?? ''}};
      });
      return {status: result, ...rest};
    },
  };
}
