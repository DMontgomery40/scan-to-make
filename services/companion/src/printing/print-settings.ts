import type {PrinterSlicer} from '@scan-to-make/printer-handoff';
import type {PrintSettings} from '@scan-to-make/contracts/counterpart';

/** PRD §8.5, for a 0.4 mm nozzle. Standard sends nothing: the MCP's own preset decides. */
export const QUALITY_LAYER_MM = {draft: 0.28, fine: 0.12} as const;
export const STRENGTH = {strong: {wallLoops: 4, sparseInfillDensity: '25%'}, max: {wallLoops: 6, sparseInfillDensity: '40%'}} as const;

/** The slice_stl overrides for the print sheet's quality and strength. */
export function sliceOverrides(settings: Pick<PrintSettings, 'quality' | 'strength'>, nozzleDiameterMm?: number): Pick<PrinterSlicer, 'layerHeightMm' | 'wallLoops' | 'sparseInfillDensity'> {
  const quality = settings.quality ?? 'standard', strength = settings.strength ?? 'standard';
  const scale = nozzleDiameterMm && nozzleDiameterMm > 0 ? nozzleDiameterMm / 0.4 : 1;
  return {
    ...(quality !== 'standard' ? {layerHeightMm: Math.round(QUALITY_LAYER_MM[quality] * scale * 100) / 100} : {}),
    ...(strength !== 'standard' ? STRENGTH[strength] : {}),
  };
}

const PACKAGE_NAMES = {'bambu-printer-mcp': 'bambu-printer-mcp', 'mcp-3d-printer-server': 'mcp-3D-printer-server'} as const;
/** The sentence for a quality or strength the installed MCP can't apply. */
export function settingsUnsupported(backend: keyof typeof PACKAGE_NAMES, settings: Pick<PrintSettings, 'quality' | 'strength'>): string {
  const what = [settings.quality && settings.quality !== 'standard' ? 'quality' : undefined, settings.strength && settings.strength !== 'standard' ? 'strength' : undefined]
    .filter(Boolean).join(' and ') || 'print settings';
  return `Update ${PACKAGE_NAMES[backend]} to choose ${what} from Counterpart. Standard prints with your printer's own preset.`;
}
