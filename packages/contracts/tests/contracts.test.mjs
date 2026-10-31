import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateArtifactRef } from '../dist/index.js';

test('artifact references are immutable content identities without writable URLs', () => {
  const input = { sha256: 'c'.repeat(64), mediaType: 'model/stl', byteLength: 42 };
  const ref = validateArtifactRef(input);
  input.sha256 = 'd'.repeat(64);
  assert.equal(ref.sha256, 'c'.repeat(64));
  assert.throws(() => { ref.byteLength = 100; });
  for (const bad of [
    { ...input, sha256: 'not-a-digest' }, { ...input, byteLength: 0 },
    { ...input, byteLength: 1.5 }, { ...input, url: 'mutable.stl' }
  ]) assert.throws(() => validateArtifactRef(bad));
});
