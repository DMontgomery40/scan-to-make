import { applyProjectFitSpecPatch } from '@scan-to-make/contracts';
import {
  drawerExample,
  drawerPatch,
  drawerText,
  type DrawerText,
} from '../src/fit/drawerDraft';

const edit = (changes: Partial<DrawerText>) => {
  const fit = drawerExample('drawer');
  const text = { ...drawerText(fit), ...changes };
  return { fit, patch: drawerPatch(fit, text) };
};

describe('drawer draft over packages/contracts', () => {
  it('unchanged text is a no-op patch', () => {
    const { fit, patch } = edit({});
    expect(patch.dimensions).toEqual({});
    expect(applyProjectFitSpecPatch(fit, patch)).toEqual(fit);
  });

  it.each(['0', '0.05'])(
    'accepts a clearance of %s mm below its lower tolerance',
    value => {
      const { fit, patch } = edit({ peripheralClearance: value });
      const next = applyProjectFitSpecPatch(fit, patch);
      if (next.template !== 'drawer-tray') {
        throw new Error('Expected a drawer fit');
      }
      const old = fit.dimensions.peripheralClearance;
      expect(next.revision).toBe(fit.revision + 1);
      expect(next.dimensions.peripheralClearance).toMatchObject({
        nominalMm: Number(value),
        lowerMm: 0,
        upperMm: Number(value) + (old.upperMm - old.nominalMm),
      });
    },
  );

  it('keeps the tolerance band for an ordinary edit', () => {
    const { fit, patch } = edit({ drawerInnerWidth: '250' });
    const next = applyProjectFitSpecPatch(fit, patch);
    if (next.template !== 'drawer-tray') {
      throw new Error('Expected a drawer fit');
    }
    expect(next.dimensions.drawerInnerWidth).toMatchObject({
      nominalMm: 250,
      lowerMm: 249,
      upperMm: 251,
    });
  });

  it('still rejects a required dimension that reaches zero', () => {
    const { fit, patch } = edit({ drawerInnerHeight: '0.5' });
    expect(() => applyProjectFitSpecPatch(fit, patch)).toThrow(
      expect.objectContaining({ name: 'ZodError' }),
    );
  });

  it.each([['-1'], [''], ['abc']])(
    'rejects dimension text %j before building a patch',
    value => {
      expect(() => edit({ wallThickness: value })).toThrow(
        'Enter a valid size for every dimension.',
      );
    },
  );

  it.each(['1.5', 'abc'])('rejects divider count %j', value => {
    const { fit, patch } = edit({ dividersAcross: value });
    expect(() => applyProjectFitSpecPatch(fit, patch)).toThrow(
      expect.objectContaining({ name: 'ZodError' }),
    );
  });

  it('a divider-only edit keeps the envelope and interfaces', () => {
    const { fit, patch } = edit({ dividersAcross: '3' });
    expect(patch.dimensions).toEqual({});
    const next = applyProjectFitSpecPatch(fit, patch);
    if (next.template !== 'drawer-tray') {
      throw new Error('Expected a drawer fit');
    }
    expect(next.parameters.dividersAcross).toBe(3);
    expect(next.dimensions).toEqual(fit.dimensions);
    expect(next.interfaces).toEqual(fit.interfaces);
  });
});
