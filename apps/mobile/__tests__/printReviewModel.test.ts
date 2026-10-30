import {
  duration,
  profileLine,
  reasonTexts,
  summaryRows,
  trayLabel,
  warningTexts,
} from '../src/screens/printReviewModel';
import { newJobId } from '../src/screens/printReviewServices';
import {
  syntheticPrint,
  syntheticReport,
} from '../src/screens/testing/fakePrintReviewServices';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('job IDs are version 4 UUIDs with or without a native generator', () => {
  const crypto = (globalThis as { crypto?: unknown }).crypto;
  try {
    (globalThis as { crypto?: unknown }).crypto = undefined;
    const ids = new Set(Array.from({ length: 200 }, newJobId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(UUID_V4);
    (globalThis as { crypto?: unknown }).crypto = {
      randomUUID: () => '0b9c2d4e-1f2a-4b3c-9d4e-5f6a7b8c9d0e',
    };
    expect(newJobId()).toBe('0b9c2d4e-1f2a-4b3c-9d4e-5f6a7b8c9d0e');
  } finally {
    (globalThis as { crypto?: unknown }).crypto = crypto;
  }
});

test('print times read naturally and bad values are dropped', () => {
  expect(duration(8040)).toBe('2 h 14 min');
  expect(duration(7200)).toBe('2 h');
  expect(duration(600)).toBe('10 min');
  expect(duration(59)).toBe('Under a minute');
  expect(duration(null)).toBeNull();
  expect(duration(Number.NaN)).toBeNull();
  expect(duration(-5)).toBeNull();
});

test('the summary only lists figures the slicer reported', () => {
  const full = summaryRows(syntheticPrint().slice);
  expect(full).toEqual([
    { label: 'Print time', value: '2 h 14 min' },
    { label: 'Filament', value: '18.4 g' },
    { label: 'Length', value: '6.12 m' },
    { label: 'Layers', value: '112' },
  ]);
  expect(
    summaryRows({
      estimatedPrintSeconds: null,
      filamentWeightG: Number.NaN,
      filamentLengthMm: null,
      layerCount: null,
      enableSupport: null,
    }),
  ).toEqual([]);
});

test('reasons and warnings are plain, with the companion’s words as fallback', () => {
  const report = syntheticReport(
    'not-printable',
    ['missing-flat-base', 'mystery-check'],
    [
      { code: 'requires-z-rotation-90', message: 'Rotated.' },
      { code: 'new-warning', message: 'Something else to know.' },
    ],
  );
  expect(reasonTexts(report)).toEqual([
    'It has no flat side to sit on the bed.',
    'synthetic detail for mystery-check',
  ]);
  expect(warningTexts(report)).toEqual([
    'It will be turned on the bed so it fits.',
    'Something else to know.',
  ]);
  expect(reasonTexts(syntheticReport('printable'))).toEqual([]);
});

test('printer and filament positions are named the way people see them', () => {
  expect(profileLine(syntheticPrint().profile)).toBe(
    'Bambu Lab P1S · 0.4 mm hardened steel nozzle · Textured PEI plate',
  );
  expect(trayLabel(0)).toBe('AMS 1, slot 1');
  expect(trayLabel(5)).toBe('AMS 2, slot 2');
  expect(trayLabel(254)).toBe('the external spool');
});
