import test from 'node:test';
import assert from 'node:assert/strict';
import {printQuestion, validateAnswer, InvalidAnswerError} from '../dist/objects/confirmation.js';

const pending = requestedSchema => ({id: '00000000-0000-4000-8000-000000000001', mode: 'form', message: 'Printer: P1S. Before printing:', requestedSchema, createdAtMs: 0, expiresAtMs: 1});
const SCHEMA = {type: 'object', required: ['confirmed', 'model', 'copies'], properties: {
  confirmed: {type: 'boolean', title: 'I checked the printer', default: false},
  model: {type: 'string', title: 'Printer model', oneOf: [{const: 'p1s', title: 'P1S'}, {const: 'a1', title: 'A1'}]},
  plate: {type: 'string', title: 'Plate', enum: ['textured_plate', 'cool_plate'], enumNames: ['Textured PEI', 'Cool plate'], default: 'textured_plate'},
  note: {type: 'string', title: 'Note', minLength: 2, maxLength: 10},
  contact: {type: 'string', title: 'Email', format: 'email'},
  site: {type: 'string', title: 'Link', format: 'uri'},
  day: {type: 'string', title: 'Day', format: 'date'},
  copies: {type: 'integer', title: 'Copies', minimum: 1, maximum: 5, default: 1},
  scale: {type: 'number', title: 'Scale', minimum: 0.5, maximum: 2},
}};

test('every MCP elicitation primitive is relayed as a field the Mac can render', () => {
  const question = printQuestion(pending(SCHEMA));
  assert.equal(question.supported, true);
  assert.deepEqual(question.fields, [
    {name: 'confirmed', title: 'I checked the printer', required: true, default: false},
    {name: 'model', title: 'Printer model', required: true, type: 'string', enum: ['p1s', 'a1'], enumNames: ['P1S', 'A1']},
    {name: 'plate', title: 'Plate', required: false, type: 'string', enum: ['textured_plate', 'cool_plate'], enumNames: ['Textured PEI', 'Cool plate'], default: 'textured_plate'},
    {name: 'note', title: 'Note', required: false, type: 'string', minLength: 2, maxLength: 10},
    {name: 'contact', title: 'Email', required: false, type: 'string', format: 'email'},
    {name: 'site', title: 'Link', required: false, type: 'string', format: 'uri'},
    {name: 'day', title: 'Day', required: false, type: 'string', format: 'date'},
    {name: 'copies', title: 'Copies', required: true, type: 'integer', default: 1, minimum: 1, maximum: 5},
    {name: 'scale', title: 'Scale', required: false, type: 'number', minimum: 0.5, maximum: 2},
  ]);
  // Not flat primitives: relayed, but only cancellable.
  for (const bad of [{type: 'object', properties: {list: {type: 'array'}}}, {type: 'object', properties: {x: {type: 'string', pattern: '^a'}}},
    {type: 'object', properties: {x: {type: 'string', format: 'phone'}}}, {type: 'object', properties: {x: {type: 'integer', default: 1.5}}},
    {...SCHEMA, anyOf: []}, {type: 'object', properties: {}}])
    assert.equal(printQuestion(pending(bad)).supported, false, JSON.stringify(bad));
});

test('answers are checked against the question: type, choices, whole numbers, ranges, lengths, formats and required fields', () => {
  const question = printQuestion(pending(SCHEMA));
  const ok = {confirmed: true, model: 'p1s', copies: 2, plate: 'cool_plate', note: 'hi', contact: 'a@b.co', site: 'https://x.test/p', day: '2026-11-01', scale: 1.5};
  assert.deepEqual(validateAnswer(question, ok), ok);
  const refuse = (change, reason) => assert.throws(() => validateAnswer(question, {...ok, ...change}), error => error instanceof InvalidAnswerError && reason.test(error.message), JSON.stringify(change));
  refuse({confirmed: 'true'}, /"I checked the printer" needs yes or no/);
  refuse({model: 'x1c'}, /"Printer model" must be one of the choices/);
  refuse({copies: 2.5}, /"Copies" needs a whole number/);
  refuse({copies: 9}, /"Copies" must be at most 5/);
  refuse({scale: 0.1}, /"Scale" must be at least 0.5/);
  refuse({scale: 'big'}, /"Scale" needs a number/);
  refuse({note: 'x'}, /at least 2 characters/);
  refuse({note: 'far too long here'}, /at most 10 characters/);
  refuse({contact: 'nope'}, /valid email/);
  refuse({site: 'not a uri'}, /valid uri/);
  refuse({day: '2026-13-45'}, /valid date/);
  refuse({day: '2026-02-30'}, /valid date/);
  assert.deepEqual(validateAnswer(question, {...ok, day: '2028-02-29'}).day, '2028-02-29', 'a leap day is a real day');
  refuse({extra: 1}, /"extra" isn't part of the printer's question/);
  assert.throws(() => validateAnswer(question, {confirmed: true, model: 'p1s'}), /"Copies" needs an answer/);
  assert.throws(() => validateAnswer(printQuestion(pending({type: 'object', properties: {x: {type: 'array'}}})), {}), /can only be cancelled/);
  const when = printQuestion(pending({type: 'object', properties: {at: {type: 'string', title: 'When', format: 'date-time'}}}));
  for (const at of ['2026-11-01T18:30:00Z', '2026-11-01T18:30:00.250-07:00']) assert.deepEqual(validateAnswer(when, {at}), {at});
  for (const at of ['2026-11-01 18:30:00Z', '2026-11-01T18:30:00', '2026-11-01T18:30+01:00', '2026-02-30T10:00:00Z', '2026-11-01T24:00:00Z'])
    assert.throws(() => validateAnswer(when, {at}), /"When" must be a valid date-time/, at);
  // An explicit false is an answer, not a missing one.
  assert.deepEqual(validateAnswer(printQuestion(pending({type: 'object', required: ['confirmed'], properties: {confirmed: {type: 'boolean'}}})), {confirmed: false}), {confirmed: false});
});
