import {PrinterMcpClient, toolResultJson, type PrinterHandoffConfig} from '@scan-to-make/printer-handoff';

interface Point {x: number; y: number; z: number}

/** The model's size in millimetres, measured by the user's printer MCP (get_stl_info), never by app code. */
export async function printerStlSize(config: PrinterHandoffConfig, stlPath: string, client = new PrinterMcpClient(config)): Promise<[number, number, number] | undefined> {
  await client.connect();
  try {
    const info = toolResultJson<{boundingBox?: {min?: Point; max?: Point}}>(await client.callTool('get_stl_info', {stl_path: stlPath}, {timeoutMs: 60000}));
    const {min, max} = info.boundingBox ?? {};
    if (!min || !max) return undefined;
    const round = (value: number) => Math.round(value * 10) / 10;
    return [round(max.x - min.x), round(max.y - min.y), round(max.z - min.z)];
  } finally {
    await client.close().catch(() => undefined);
  }
}
