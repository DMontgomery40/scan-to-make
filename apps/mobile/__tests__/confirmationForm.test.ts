import {
  confirmationContent,
  confirmationFields,
  initialValues,
} from '../src/printing/confirmationForm';
import {
  HARDWARE_CONFIRMATION,
  MODEL_QUESTION,
} from '../src/screens/testing/fakePrinterHandoff';

test('the hardware confirmation must be ticked before it can be approved', () => {
  const fields = confirmationFields(HARDWARE_CONFIRMATION)!;
  expect(fields).toEqual([
    expect.objectContaining({ kind: 'boolean', key: 'confirmed', mustTick: true, initial: false }),
  ]);
  const values = initialValues(fields);
  expect(confirmationContent(fields, values)).toEqual({
    missing: 'Tick “I checked the printer and confirm this operation” to approve.',
  });
  expect(confirmationContent(fields, { ...values, confirmed: true })).toEqual({
    content: { confirmed: true },
  });
});

test('a choice from oneOf offers each title and answers with its value', () => {
  const fields = confirmationFields(MODEL_QUESTION)!;
  expect(fields[0]).toMatchObject({
    kind: 'choice',
    title: 'Printer Model',
    options: [
      { value: 'p1s', title: 'P1S' },
      { value: 'x1c', title: 'X1 Carbon' },
    ],
  });
  expect(confirmationContent(fields, {})).toEqual({ missing: 'Fill in “Printer Model”.' });
  expect(confirmationContent(fields, { bambu_model: 'x1c' })).toEqual({
    content: { bambu_model: 'x1c' },
  });
});

test('text, numbers, legacy enums and multi-choice lists are checked', () => {
  const fields = confirmationFields({
    type: 'object',
    properties: {
      note: { type: 'string', maxLength: 5 },
      copies: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
      plate: { type: 'string', enum: ['a', 'b'], enumNames: ['Plate A', 'Plate B'] },
      slots: { type: 'array', items: { enum: ['1', '2'] }, minItems: 1 },
    },
    required: ['copies'],
  })!;
  expect(fields.map(f => f.kind)).toEqual(['text', 'number', 'choice', 'multi']);
  expect(fields[2]).toMatchObject({ options: [{ value: 'a', title: 'Plate A' }, { value: 'b', title: 'Plate B' }] });
  expect(confirmationContent(fields, { copies: '4' })).toEqual({ missing: 'Check “copies”.' });
  expect(confirmationContent(fields, { copies: '2', note: 'toolong' })).toEqual({ missing: 'Check “note”.' });
  expect(confirmationContent(fields, { copies: '2', slots: [] })).toEqual({ content: { copies: 2 } });
  expect(confirmationContent(fields, { copies: 2, plate: 'b', slots: ['2'] })).toEqual({
    content: { copies: 2, plate: 'b', slots: ['2'] },
  });
});

test('forms the phone can’t answer are recognised', () => {
  expect(confirmationFields(undefined)).toEqual([]);
  expect(confirmationFields({ type: 'array' })).toBeNull();
  const wide = Object.fromEntries(
    Array.from({ length: 17 }, (_, i) => [`f${i}`, { type: 'string' }]),
  );
  expect(confirmationFields({ type: 'object', properties: wide, required: ['f16'] })).toBeNull();
  expect(
    confirmationFields({ type: 'object', properties: { nested: { type: 'object', properties: {} } } }),
  ).toBeNull();
});
