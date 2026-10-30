import {
  validateProjectFitSpec,
  type DrawerFitSpec,
  type DrawerFitSpecPatch,
} from '@scan-to-make/contracts';
import fixture from '../../../../packages/contracts/fixtures/drawer-tray.json';
export const DRAWER_FIELDS = [
  ['drawerInnerWidth', 'Drawer width'],
  ['drawerInnerDepth', 'Drawer depth'],
  ['drawerInnerHeight', 'Clear height'],
  ['wallThickness', 'Wall thickness'],
  ['floorThickness', 'Floor thickness'],
  ['peripheralClearance', 'Clearance per side'],
  ['trayHeight', 'Tray height'],
] as const;
export function drawerExample(id: string): DrawerFitSpec {
  const fit = validateProjectFitSpec({ ...fixture, id });
  if (fit.template !== 'drawer-tray') {
    throw new Error('Invalid drawer example');
  }
  for (const [key] of DRAWER_FIELDS) {
    if (fit.dimensions[key].source === 'manual') {
      fit.dimensions[key] = {
        ...fit.dimensions[key],
        source: 'reference',
        sourceId: `synthetic-drawer-${key}`,
      };
    }
  }
  return fit;
}
export type DrawerText = Record<
  (typeof DRAWER_FIELDS)[number][0] | 'dividersAcross' | 'dividersAlong',
  string
>;
export function drawerText(fit: DrawerFitSpec): DrawerText {
  return Object.fromEntries([
    ...DRAWER_FIELDS.map(([key]) => [
      key,
      String(fit.dimensions[key].nominalMm),
    ]),
    ...Object.entries(fit.parameters).map(([k, v]) => [k, String(v)]),
  ]) as DrawerText;
}
export function drawerPatch(
  fit: DrawerFitSpec,
  text: DrawerText,
): DrawerFitSpecPatch {
  const dimensions: DrawerFitSpecPatch['dimensions'] = {};
  for (const [key] of DRAWER_FIELDS) {
    const value = Number(text[key]);
    if (!text[key].trim() || !Number.isFinite(value) || value < 0) {
      throw new Error('Enter a valid size for every dimension.');
    }
    const old = fit.dimensions[key];
    if (value !== old.nominalMm) {
      const low = old.nominalMm - old.lowerMm,
        high = old.upperMm - old.nominalMm;
      // This example remains a synthetic design study even after numeric edits.
      dimensions[key] = {
        ...old,
        nominalMm: value,
        // Sizes are nonnegative; a small clearance keeps a zero lower bound.
        lowerMm: Math.max(0, value - low),
        upperMm: value + high,
        source: old.source === 'reference' ? 'reference' : 'design',
        sourceId: `drawer-design-${key}-r${fit.revision + 1}`,
      };
    }
  }
  if (!text.dividersAcross.trim() || !text.dividersAlong.trim()) {
    throw new Error('Enter both divider counts.');
  }
  return {
    template: 'drawer-tray',
    expectedRevision: fit.revision,
    dimensions,
    parameters: {
      dividersAcross: Number(text.dividersAcross),
      dividersAlong: Number(text.dividersAlong),
    },
    authorizedInterfaceIds: ['drawer-cavity'],
  };
}
