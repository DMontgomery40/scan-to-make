/**
 * The printer MCP's picture of a sliced file (inspect_print_file `include_preview`), checked before the
 * app shows it: drawn from the exact G-code of the file with `sha256`, as PNGs. Counterpart only shows
 * it; drawing G-code is the MCP's job (PRD §8.0).
 */
export interface SlicePreviewView {name: 'top' | 'bed_side'; label: string; png: string; width: number; height: number}
export interface SlicePreview {
  /** The SHA-256 of the sliced file the pictures were drawn from: the one Print must send. */
  sha256: string;
  views: SlicePreviewView[];
  mmPerPixel?: number;
}

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_BYTES = 4 * 1024 * 1024;

/** The preview in an inspect_print_file receipt, or undefined unless it is well-formed and of exactly `sha256`. */
export function slicePreview(receipt: unknown, sha256: string): SlicePreview | undefined {
  const preview = (receipt as {preview?: unknown} | undefined)?.preview as Record<string, unknown> | undefined;
  if (!preview || typeof preview !== 'object' || preview.artifact_sha256 !== sha256 || !Array.isArray(preview.views)) return undefined;
  const views: SlicePreviewView[] = [];
  for (const view of preview.views as Record<string, unknown>[]) {
    if (!view || (view.name !== 'top' && view.name !== 'bed_side') || typeof view.label !== 'string' || typeof view.png_base64 !== 'string') return undefined;
    const bytes = Buffer.from(view.png_base64, 'base64');
    if (bytes.length > MAX_PNG_BYTES || !bytes.subarray(0, 8).equals(PNG)) return undefined;
    const width = Number(view.width), height = Number(view.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return undefined;
    views.push({name: view.name, label: view.label.slice(0, 120), png: view.png_base64, width, height});
  }
  if (!views.some(view => view.name === 'top') || !views.some(view => view.name === 'bed_side')) return undefined;
  const mmPerPixel = Number(preview.mm_per_pixel);
  return {sha256, views, ...(Number.isFinite(mmPerPixel) && mmPerPixel > 0 ? {mmPerPixel} : {})};
}
