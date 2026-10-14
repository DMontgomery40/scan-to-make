import { cupWidthPatch, seedSpec } from '../src/fit/fitDraft';
import {
  memoryFitSpecStore,
  StaleRevisionError,
} from '../src/project/fitSpecStore';

describe('memory FitSpec store', () => {
  it('applies expected-revision patches and returns detached copies', async () => {
    const store = memoryFitSpecStore();
    const created = await store.create(seedSpec());
    const next = await store.applyPatch(created.id, cupWidthPatch(created, 1));
    expect(next.revision).toBe(1);
    next.dimensions.cupOuterDiameter.nominalMm = 999;
    expect(
      (await store.get(created.id))?.dimensions.cupOuterDiameter.nominalMm,
    ).toBe(87);
  });

  it('rejects a stale preview edit and keeps the newer revision', async () => {
    const store = memoryFitSpecStore();
    const shown = await store.create(seedSpec());
    await store.applyPatch(shown.id, cupWidthPatch(shown, 1));
    await expect(
      store.applyPatch(shown.id, cupWidthPatch(shown, -1)),
    ).rejects.toBeInstanceOf(StaleRevisionError);
    const latest = await store.get(shown.id);
    expect(latest?.revision).toBe(1);
    expect(latest?.dimensions.cupOuterDiameter.nominalMm).toBe(87);
  });

  it('enforces the contract on patches and creation', async () => {
    const store = memoryFitSpecStore();
    const spec = await store.create(seedSpec());
    await expect(store.create(seedSpec())).rejects.toThrow('already exists');
    await expect(
      store.applyPatch(spec.id, {
        expectedRevision: 0,
        dimensions: {
          insertionDepth: {
            ...spec.dimensions.insertionDepth,
            nominalMm: 30,
            lowerMm: 30,
            upperMm: 30,
          },
        },
      }),
    ).rejects.toThrow('explicit interface authorization');
    await expect(
      store.applyPatch('missing', cupWidthPatch(spec, 1)),
    ).rejects.toThrow('Unknown');
  });
});
