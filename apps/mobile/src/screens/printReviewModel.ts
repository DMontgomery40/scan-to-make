import type { Tone } from '../ui/components';
import type {
  PrintabilityReport,
  PrintabilityVerdict,
  PrinterProfile,
  SliceSummary,
} from './printReviewServices';

export const VERDICTS: Record<
  PrintabilityVerdict,
  { label: string; tone: Tone; title: string; body: string }
> = {
  printable: {
    label: 'Ready to print',
    tone: 'pass',
    title: 'This design can print',
    body: 'It fits the bed, sits flat and has walls thick enough for the nozzle.',
  },
  'printable-with-supports': {
    label: 'Needs supports',
    tone: 'pending',
    title: 'This design needs supports',
    body: 'Supports hold those parts up while printing, and you snap them off afterwards.',
  },
  'not-printable': {
    label: 'Can’t print yet',
    tone: 'fail',
    title: 'This design can’t print as it is',
    body: 'Fix these first, then check again.',
  },
};

const REASONS: Record<string, string> = {
  'exceeds-build-volume': 'It’s too big for this printer’s bed.',
  'intersects-bed-exclusion-zone':
    'It can’t be placed clear of the printer’s filament cutter area.',
  'mesh-not-watertight':
    'The design has gaps in its surface, so the slicer can’t tell inside from outside.',
  'invalid-stl-normals': 'Some of the design’s surfaces face the wrong way.',
  'missing-flat-base': 'It has no flat side to sit on the bed.',
  'unstable-base-contact': 'It could tip over while it prints.',
  'wall-thinner-than-nozzle':
    'Some walls are thinner than the nozzle can print.',
  'overhangs-require-supports':
    'Some parts hang out at a steep angle and need supports underneath.',
};
const WARNINGS: Record<string, string> = {
  'single-perimeter-thin-wall':
    'Some walls are only one line thick, so they may be fragile.',
  'minor-localized-overhang':
    'A small overhang may print a little rough underneath.',
  'requires-z-rotation-90': 'It will be turned on the bed so it fits.',
};

/** Plain reasons, falling back to the companion's own words for new codes. */
export function reasonTexts(report: PrintabilityReport): string[] {
  return report.reasonCodes
    .filter(code => code !== 'all-checks-passed')
    .map(code => {
      if (REASONS[code]) return REASONS[code];
      const own = report.reasons.find(r => r.startsWith(`${code}:`));
      return own ? own.slice(code.length + 1).trim() : code;
    });
}
export function warningTexts(report: PrintabilityReport): string[] {
  return report.warnings.map(w => WARNINGS[w.code] ?? w.message);
}

export function duration(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return 'Under a minute';
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}
const finite = (value: number | null) =>
  value != null && Number.isFinite(value) && value >= 0;
/** Only the summary values the slicer actually reported. */
export function summaryRows(slice: SliceSummary) {
  const rows: { label: string; value: string }[] = [];
  const time = duration(slice.estimatedPrintSeconds);
  if (time) rows.push({ label: 'Print time', value: time });
  if (finite(slice.filamentWeightG)) {
    rows.push({
      label: 'Filament',
      value: `${slice.filamentWeightG!.toFixed(1)} g`,
    });
  }
  if (finite(slice.filamentLengthMm)) {
    rows.push({
      label: 'Length',
      value: `${(slice.filamentLengthMm! / 1000).toFixed(2)} m`,
    });
  }
  if (finite(slice.layerCount)) {
    rows.push({ label: 'Layers', value: String(slice.layerCount) });
  }
  return rows;
}

const NOZZLES: Record<string, string> = {
  hardened_steel: 'hardened steel',
  stainless_steel: 'stainless steel',
  tungsten_carbide: 'tungsten carbide',
  brass: 'brass',
};
const BEDS: Record<string, string> = {
  textured_plate: 'Textured PEI plate',
  cool_plate: 'Cool plate',
  engineering_plate: 'Engineering plate',
  hot_plate: 'High-temperature plate',
  supertack_plate: 'Cool Plate SuperTack',
};
export const bedLabel = (bedType: string) => BEDS[bedType] ?? bedType;
/** e.g. "Bambu Lab P1S · 0.4 mm hardened steel nozzle · Textured PEI plate". */
export function profileLine(profile: PrinterProfile): string {
  const printer = profile.displayName.replace(/\s*\(.*\)\s*$/, '');
  const nozzle = `${profile.nozzleDiameterMm} mm ${
    NOZZLES[profile.nozzleType] ?? profile.nozzleType.replace(/_/g, ' ')
  } nozzle`;
  return [printer, nozzle, bedLabel(profile.bedType)].join(' · ');
}
/** Bambu tray numbers: 254 is the external spool; AMS trays count from 0. */
export function trayLabel(tray: number): string {
  if (tray === 254) return 'the external spool';
  return `AMS ${Math.floor(tray / 4) + 1}, slot ${(tray % 4) + 1}`;
}
