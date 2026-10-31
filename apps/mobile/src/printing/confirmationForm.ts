import type { ConfirmationValue } from './printerHandoff';

/**
 * The fields of an MCP elicitation form: a flat object of booleans, strings
 * (free text or a choice), numbers and multi-choice lists. Anything richer
 * isn't answered on the phone.
 */
type Base = { key: string; title: string; description?: string; required: boolean };
export type ConfirmationField =
  | (Base & {
      kind: 'boolean';
      initial: boolean;
      /**
       * A required checkbox that starts unticked must be ticked to approve.
       * Both printer servers ask "I checked the printer and confirm this
       * operation" this way, and treat an unticked approval as a refusal.
       */
      mustTick: boolean;
    })
  | (Base & { kind: 'choice'; options: { value: string; title: string }[]; initial?: string })
  | (Base & {
      kind: 'multi';
      options: { value: string; title: string }[];
      initial: string[];
      minItems?: number;
      maxItems?: number;
    })
  | (Base & { kind: 'text'; initial?: string; minLength?: number; maxLength?: number })
  | (Base & { kind: 'number'; integer: boolean; initial?: number; minimum?: number; maximum?: number });

const MAX_FIELDS = 16;
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 500) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
const count = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
const finite = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function options(spec: Json): { value: string; title: string }[] | null {
  const consts = (list: unknown) =>
    Array.isArray(list) && list.length && list.every(o => isObject(o) && typeof o.const === 'string')
      ? (list as Json[]).map(o => ({ value: o.const as string, title: text(o.title, 120) ?? (o.const as string) }))
      : null;
  const fromOneOf = consts(spec.oneOf) ?? consts(spec.anyOf);
  if (fromOneOf) return fromOneOf;
  if (Array.isArray(spec.enum) && spec.enum.length && spec.enum.every(v => typeof v === 'string')) {
    const names = Array.isArray(spec.enumNames) ? spec.enumNames : [];
    return (spec.enum as string[]).map((value, i) => ({ value, title: text(names[i], 120) ?? value }));
  }
  return null;
}

/** The form's fields, or null when the phone can't answer this form. */
export function confirmationFields(schema: unknown): ConfirmationField[] | null {
  if (schema === undefined) return [];
  if (!isObject(schema) || schema.type !== 'object') return null;
  const properties = schema.properties ?? {};
  if (!isObject(properties)) return null;
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === 'string') : [],
  );
  const entries = Object.entries(properties);
  // A partial form can't be answered correctly, so a long one isn't answered here.
  if (entries.length > MAX_FIELDS) return null;
  const fields: ConfirmationField[] = [];
  for (const [key, spec] of entries) {
    if (!isObject(spec)) return null;
    const base: Base = {
      key,
      title: text(spec.title, 200) ?? key,
      ...(text(spec.description) ? { description: text(spec.description) } : {}),
      required: required.has(key),
    };
    if (spec.type === 'boolean') {
      const initial = spec.default === true;
      fields.push({ ...base, kind: 'boolean', initial, mustTick: base.required && !initial });
    } else if (spec.type === 'string') {
      const choices = options(spec);
      if (choices) {
        const initial = choices.some(c => c.value === spec.default) ? (spec.default as string) : undefined;
        fields.push({ ...base, kind: 'choice', options: choices, ...(initial ? { initial } : {}) });
      } else {
        fields.push({
          ...base,
          kind: 'text',
          ...(typeof spec.default === 'string' ? { initial: spec.default } : {}),
          ...(count(spec.minLength) !== undefined ? { minLength: count(spec.minLength) } : {}),
          ...(count(spec.maxLength) !== undefined ? { maxLength: count(spec.maxLength) } : {}),
        });
      }
    } else if (spec.type === 'number' || spec.type === 'integer') {
      fields.push({
        ...base,
        kind: 'number',
        integer: spec.type === 'integer',
        ...(finite(spec.default) !== undefined ? { initial: finite(spec.default) } : {}),
        ...(finite(spec.minimum) !== undefined ? { minimum: finite(spec.minimum) } : {}),
        ...(finite(spec.maximum) !== undefined ? { maximum: finite(spec.maximum) } : {}),
      });
    } else if (spec.type === 'array' && isObject(spec.items)) {
      const choices = options(spec.items);
      if (!choices) return null;
      const initial = Array.isArray(spec.default)
        ? spec.default.filter((v): v is string => choices.some(c => c.value === v))
        : [];
      fields.push({
        ...base,
        kind: 'multi',
        options: choices,
        initial,
        ...(count(spec.minItems) !== undefined ? { minItems: count(spec.minItems) } : {}),
        ...(count(spec.maxItems) !== undefined ? { maxItems: count(spec.maxItems) } : {}),
      });
    } else {
      return null;
    }
  }
  return fields;
}

export type ConfirmationValues = Record<string, ConfirmationValue | undefined>;

export function initialValues(fields: ConfirmationField[]): ConfirmationValues {
  return Object.fromEntries(fields.map(field => [field.key, field.initial]));
}

/**
 * The accept content for these values, or what still needs doing. Number
 * fields hold the typed text until they are checked here.
 */
export function confirmationContent(
  fields: ConfirmationField[],
  values: ConfirmationValues,
): { content: Record<string, ConfirmationValue> } | { missing: string } {
  const content: Record<string, ConfirmationValue> = {};
  for (const field of fields) {
    const value = values[field.key];
    const empty =
      value === undefined || value === '' || (Array.isArray(value) && !value.length);
    if (field.kind === 'boolean') {
      if (field.mustTick && value !== true) return { missing: `Tick “${field.title}” to approve.` };
      content[field.key] = value === true;
      continue;
    }
    if (empty) {
      if (field.required) return { missing: `Fill in “${field.title}”.` };
      continue;
    }
    if (field.kind === 'number') {
      const number = Number(typeof value === 'string' ? value.trim() : value);
      if (
        !Number.isFinite(number) ||
        (field.integer && !Number.isInteger(number)) ||
        (field.minimum !== undefined && number < field.minimum) ||
        (field.maximum !== undefined && number > field.maximum)
      ) {
        return { missing: `Check “${field.title}”.` };
      }
      content[field.key] = number;
    } else if (field.kind === 'text') {
      const string = String(value);
      if (
        (field.minLength !== undefined && string.length < field.minLength) ||
        (field.maxLength !== undefined && string.length > field.maxLength)
      ) {
        return { missing: `Check “${field.title}”.` };
      }
      content[field.key] = string;
    } else if (field.kind === 'multi') {
      const list = (value as string[]).filter(v => field.options.some(o => o.value === v));
      if (
        (field.minItems !== undefined && list.length < field.minItems) ||
        (field.maxItems !== undefined && list.length > field.maxItems)
      ) {
        return { missing: `Check “${field.title}”.` };
      }
      content[field.key] = list;
    } else {
      content[field.key] = String(value);
    }
  }
  return { content };
}
