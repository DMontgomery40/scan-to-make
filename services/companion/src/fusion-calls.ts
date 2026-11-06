import {PrinterMcpClient, PrinterMcpError, toolResultJson, type PrinterHandoffConfig} from '@scan-to-make/printer-handoff';
import {toolErrorText} from './touchup/blender.js';
import {mcpPackageName} from './printing/print-settings.js';

type Client = Pick<PrinterMcpClient, 'connect' | 'hasTool' | 'callTool' | 'close'>;

/**
 * The Mac's Fusion Set Up and its "is it working?" check (PRD §8.9), both on the printer MCP as the companion runs it:
 * `running()` is the profile after any Update or Move override, never printer-handoff.json's own route. Each answer is
 * the tool's structured result, passed to the Mac as the MCP gives it; nothing here reads the MCP's wording.
 */
export function fusionCalls(running: () => PrinterHandoffConfig, client: (config: PrinterHandoffConfig) => Client = config => new PrinterMcpClient(config)) {
  const call = async (tool: string, args: Record<string, unknown>, timeoutMs: number) => {
    const config = running(), server = mcpPackageName(config.backend), mcp = client(config);
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      await mcp.connect(signal);
      if (!mcp.hasTool(tool)) return {result: null, server};
      let result;
      // PrinterMcpClient throws a tool's error result (`tool-failed`, the MCP's diagnostic in `detail`): it is the answer.
      try { result = await mcp.callTool(tool, args, {signal}); }
      catch (error) { if (error instanceof PrinterMcpError && error.code === 'tool-failed') return {result: null, server, error: error.detail ?? `${tool} failed.`}; throw error; }
      if (result.isError) return {result: null, server, error: toolErrorText(result)};
      return {result: toolResultJson<Record<string, unknown>>(result), server};
    } finally { await mcp.close().catch(() => {}); }
  };
  return {
    fusionSetup: async (install: boolean) => {
      const {result, ...rest} = await call('fusion_mcp_setup', install ? {install: true} : {}, install ? 300_000 : 90_000);
      return {setup: result, ...rest};
    },
    /** fusion_mcp_status {launch: true}: may start Fusion, and waits up to 90 s for its add-in. */
    fusionStatus: async () => {
      const {result, ...rest} = await call('fusion_mcp_status', {launch: true, timeout_ms: 90_000}, 150_000);
      return {status: result, ...rest};
    },
  };
}
