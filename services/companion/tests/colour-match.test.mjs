import test from 'node:test';
import assert from 'node:assert/strict';
import {colourDistance, matchColours} from '../dist/objects/colour-match.js';

// The trays the printing tests use: PETG black, PLA Bambu yellow, external PLA white.
const TRAYS = [
  {slot: 0, colour: '#000000', material: 'PETG'},
  {slot: 1, colour: '#FEC600', material: 'PLA'},
  {slot: 254, colour: '#FFFFFF', material: 'PLA'},
];

test('OKLab distance: identical is zero, black to white is about one, near colours are near', () => {
  assert.equal(colourDistance('#FEC600', '#FEC600'), 0);
  const blackWhite = colourDistance('#000000', '#FFFFFF');
  assert.ok(blackWhite > 0.9 && blackWhite < 1.1, `black-white ${blackWhite}`);
  assert.ok(colourDistance('#FFD200', '#FEC600') < 0.1, 'two yellows are close');
  assert.ok(colourDistance('#FFD200', '#0000FF') > 0.5, 'yellow to blue is far');
  // Alpha and case are not colour.
  assert.equal(colourDistance('#fec600ff', '#FEC600'), 0);
});

test('each part colour goes to the nearest loaded spool (the Vivi pick: black body, yellow letters)', () => {
  const matches = matchColours([{colour: '#111111'}, {colour: '#FFD200'}], TRAYS);
  assert.equal(matches[0].slot, 0);
  assert.equal(matches[1].slot, 1);
  assert.ok(matches[1].distance > 0 && matches[1].distance < 0.1);
  assert.equal(matches[0].materialMismatch, undefined);
});

test('the same spool serves two parts of the same colour', () => {
  const matches = matchColours([{colour: '#FEFEFE'}, {colour: '#FFFFFF'}], TRAYS);
  assert.deepEqual(matches.map(m => m.slot), [254, 254]);
});

test('a named material prefers its own spool, but the right colour in another material beats a wrong colour', () => {
  // Black asked as PLA: the only black spool is PETG. Colour wins, flagged.
  const [black] = matchColours([{colour: '#000000', material: 'PLA'}], TRAYS);
  assert.equal(black.slot, 0);
  assert.equal(black.materialMismatch, true);
  // White asked as PLA: the white spool is PLA already.
  const [white] = matchColours([{colour: '#FFFFFF', material: 'pla'}], TRAYS);
  assert.equal(white.slot, 254);
  assert.equal(white.materialMismatch, undefined);
});

test('between two spools of one colour, the asked-for material wins', () => {
  const trays = [{slot: 0, colour: '#000000', material: 'PETG'}, {slot: 2, colour: '#010101', material: 'PLA'}];
  const [match] = matchColours([{colour: '#000000', material: 'PLA'}], trays);
  assert.equal(match.slot, 2);
  assert.equal(match.materialMismatch, undefined);
});

test('a part with no known colour takes the first free spool of its material, marked as a guess', () => {
  const matches = matchColours([{material: 'PLA'}, {}], TRAYS);
  assert.equal(matches[0].slot, 1);
  assert.equal(matches[0].guessed, true);
  assert.equal(matches[0].distance, undefined);
  // The second guess does not reuse the first guess's spool while another is free.
  assert.notEqual(matches[1].slot, matches[0].slot);
  assert.equal(matches[1].guessed, true);
});

test('no loaded spools: no match, never a invented slot', () => {
  assert.deepEqual(matchColours([{colour: '#000000'}, {}], []), [undefined, undefined]);
});

test('a malformed colour is treated as unknown, not as black', () => {
  const [match] = matchColours([{colour: 'yellow'}, ], TRAYS);
  assert.equal(match.guessed, true);
});
