import type {PrinterSlicer} from '@scan-to-make/printer-handoff';
import type {PrintSettings} from '@scan-to-make/contracts/counterpart';

/** The print sheet's choices for slice_stl. Quality and strength go as chosen; the MCP turns them into its slicer's
 * numbers (PRD §8.0). Standard sends nothing, so the MCP's own preset decides. */
export function sliceOverrides(settings: Pick<PrintSettings, 'quality' | 'strength' | 'copies' | 'pauseBeforeLayers'>): Pick<PrinterSlicer, 'quality' | 'strength' | 'repetitions' | 'pauseAtLayers'> {
  const quality = settings.quality ?? 'standard', strength = settings.strength ?? 'standard';
  return {
    ...(quality !== 'standard' ? {quality} : {}),
    ...(strength !== 'standard' ? {strength} : {}),
    // Named copies are always sent, 1 included, so they override a printer config's own `slicer.repetitions`.
    ...(settings.copies !== undefined ? {repetitions: settings.copies} : {}),
    ...(settings.pauseBeforeLayers?.length ? {pauseAtLayers: [...new Set(settings.pauseBeforeLayers)].sort((a, b) => a - b)} : {}),
  };
}

const PACKAGE_NAMES = {'bambu-printer-mcp': 'bambu-printer-mcp', 'mcp-3d-printer-server': 'mcp-3D-printer-server'} as const;
/** The printer MCP's name as people see it in Settings → Printers. */
export function mcpPackageName(backend: string): string { return PACKAGE_NAMES[backend as keyof typeof PACKAGE_NAMES] ?? backend; }
/** The sentence for a quality or strength the installed MCP can't apply. */
export function settingsUnsupported(backend: keyof typeof PACKAGE_NAMES, settings: Pick<PrintSettings, 'quality' | 'strength' | 'copies' | 'pauseBeforeLayers'> & {supports?: boolean}): string {
  const what = [settings.quality && settings.quality !== 'standard' ? 'quality' : undefined, settings.strength && settings.strength !== 'standard' ? 'strength' : undefined,
    settings.copies && settings.copies > 1 ? 'copies' : undefined, settings.pauseBeforeLayers?.length ? 'layer pauses' : undefined,
    settings.supports ? 'this design’s supports' : undefined]
    .filter(Boolean).join(' and ') || 'print settings';
  if (what === 'this design’s supports') return `Update ${PACKAGE_NAMES[backend]} in Settings → Printers so Counterpart can send this design’s supports to the slicer. Nothing was sent to the printer.`;
  return `Update ${PACKAGE_NAMES[backend]} to choose ${what} from Counterpart. Standard prints with your printer's own preset.`;
}

/** The sentence when the installed MCP can't propose each colour's spool (counterpart_propose_filaments). */
export function filamentProposalUnavailable(backend: keyof typeof PACKAGE_NAMES): string {
  return `Update ${PACKAGE_NAMES[backend]} in Settings → Printers so Counterpart can match each colour to a loaded spool. Nothing was sent to the printer.`;
}

/** Print's refusal when the installed MCP can't draw what will print (inspect_print_file `include_preview`). */
export function previewUnavailable(backend: keyof typeof PACKAGE_NAMES): string {
  return `Update ${PACKAGE_NAMES[backend]} in Settings → Printers so Counterpart can show you what will print. Nothing was sent to the printer.`;
}

/** The sheet's line when the installed MCP can't say whether a 3MF prints with its own settings (own_process). */
export function ownSettingsUnavailable(backend: keyof typeof PACKAGE_NAMES): string {
  return `Update ${PACKAGE_NAMES[backend]} in Settings → Printers so Counterpart can keep a designer's settings for this file.`;
}
