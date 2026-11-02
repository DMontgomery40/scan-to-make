import type {PendingElicitation} from '@scan-to-make/printer-handoff';
import type {ObjectPrintConfirmation} from './store.js';
import {InvalidStateError} from './errors.js';

/**
 * The printer MCP's own question, relayed faithfully (MCP elicitation, form
 * mode): a flat object whose properties are the elicitation primitives
 * (boolean; string with enum/oneOf, length or format; number; integer). Any
 * other shape is relayed with `supported: false`, and can only be cancelled.
 * Nothing here ever answers a question: only a person's explicit answer does.
 */

type Field = ObjectPrintConfirmation['fields'][number];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const SCHEMA_KEYS = ['type', 'properties', 'required', 'additionalProperties', 'title', 'description', '$schema'];
const PROPERTY_KEYS: Record<string, string[]> = {
  boolean: ['type', 'title', 'description', 'default'],
  string: ['type', 'title', 'description', 'default', 'enum', 'enumNames', 'oneOf', 'minLength', 'maxLength', 'format'],
  number: ['type', 'title', 'description', 'default', 'minimum', 'maximum'],
  integer: ['type', 'title', 'description', 'default', 'minimum', 'maximum'],
};
const FORMATS = ['email', 'uri', 'date', 'date-time'] as const;
const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function field(name: string, property: unknown, required: boolean): Field | undefined {
  if (!name.length || name.length > 128 || !record(property)) return undefined;
  const type = property.type;
  if (typeof type !== 'string' || !PROPERTY_KEYS[type] || Object.keys(property).some(key => !PROPERTY_KEYS[type]!.includes(key))) return undefined;
  if ((property.title !== undefined && typeof property.title !== 'string') || (property.description !== undefined && typeof property.description !== 'string')) return undefined;
  const base = {name, title: typeof property.title === 'string' ? property.title : name,
    ...(typeof property.description === 'string' ? {description: property.description} : {}), required};
  if (type === 'boolean') {
    if (property.default !== undefined && typeof property.default !== 'boolean') return undefined;
    // `type` is left out for booleans, so older clients keep reading the same fields.
    return {...base, ...(property.default !== undefined ? {default: property.default} : {})};
  }
  if (type === 'string') {
    let values: string[] | undefined, names: string[] | undefined;
    if (property.enum !== undefined) {
      if (!Array.isArray(property.enum) || !property.enum.length || property.enum.some(item => typeof item !== 'string')) return undefined;
      values = property.enum as string[];
      if (property.enumNames !== undefined) {
        if (!Array.isArray(property.enumNames) || property.enumNames.length !== values.length || property.enumNames.some(item => typeof item !== 'string')) return undefined;
        names = property.enumNames as string[];
      }
    }
    if (property.oneOf !== undefined) {
      // The titled-enum form: oneOf [{const, title}].
      if (values || !Array.isArray(property.oneOf) || !property.oneOf.length) return undefined;
      const options = property.oneOf.map(option => record(option) && typeof option.const === 'string' && Object.keys(option).every(key => key === 'const' || key === 'title')
        && (option.title === undefined || typeof option.title === 'string') ? option : undefined);
      if (options.some(option => !option)) return undefined;
      values = options.map(option => option!.const as string);
      names = options.map(option => typeof option!.title === 'string' ? option!.title : option!.const as string);
    }
    if ((property.minLength !== undefined && !count(property.minLength)) || (property.maxLength !== undefined && !count(property.maxLength))) return undefined;
    if (property.format !== undefined && !(FORMATS as readonly unknown[]).includes(property.format)) return undefined;
    if (property.default !== undefined && (typeof property.default !== 'string' || (values && !values.includes(property.default)))) return undefined;
    return {...base, type: 'string', ...(values ? {enum: values} : {}), ...(names ? {enumNames: names} : {}),
      ...(property.default !== undefined ? {default: property.default as string} : {}),
      ...(property.minLength !== undefined ? {minLength: property.minLength as number} : {}), ...(property.maxLength !== undefined ? {maxLength: property.maxLength as number} : {}),
      ...(property.format !== undefined ? {format: property.format as Field['format']} : {})};
  }
  // number | integer
  if ((property.minimum !== undefined && !finiteNumber(property.minimum)) || (property.maximum !== undefined && !finiteNumber(property.maximum))) return undefined;
  if (property.default !== undefined && (!finiteNumber(property.default) || (type === 'integer' && !Number.isInteger(property.default)))) return undefined;
  return {...base, type: type as 'number' | 'integer', ...(property.default !== undefined ? {default: property.default as number} : {}),
    ...(property.minimum !== undefined ? {minimum: property.minimum as number} : {}), ...(property.maximum !== undefined ? {maximum: property.maximum as number} : {})};
}

/** The MCP's question as the apps show it; `supported` when every property is an elicitation primitive. */
export function printQuestion(pending: PendingElicitation): ObjectPrintConfirmation {
  const question: ObjectPrintConfirmation = {id: pending.id, message: pending.message, expiresAtMs: pending.expiresAtMs, fields: [], supported: false};
  const schema = pending.requestedSchema;
  if (pending.mode !== 'form' || !record(schema) || schema.type !== 'object' || !record(schema.properties)
      || Object.keys(schema).some(key => !SCHEMA_KEYS.includes(key))
      || (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean')) return question;
  const required = schema.required ?? [];
  if (!Array.isArray(required) || required.some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties as object, key))) return question;
  const fields: Field[] = [];
  for (const [name, property] of Object.entries(schema.properties)) {
    const parsed = field(name, property, required.includes(name));
    if (!parsed) return question;
    fields.push(parsed);
  }
  return fields.length ? {...question, fields, supported: true} : question;
}

export type ConfirmationValue = string | number | boolean;
/** A refused answer, with the reason for the field it is about. */
export class InvalidAnswerError extends InvalidStateError {
  constructor(message: string) { super(message); this.name = 'InvalidAnswerError'; }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** RFC 3339 date-time (JSON Schema's): seconds required, `Z` or an offset. */
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;
/** A real calendar day: Date.parse turns 2026-02-30 into March 2, so check it round-trips. */
function realDay(year: string, month: string, day: string): boolean {
  const y = Number(year), m = Number(month), d = Number(day), at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}
function validFormat(format: NonNullable<Field['format']>, value: string): boolean {
  switch (format) {
    case 'email': return EMAIL.test(value);
    case 'uri': try { return !!new URL(value).protocol; } catch { return false; }
    case 'date': { const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value); return !!parts && realDay(parts[1]!, parts[2]!, parts[3]!); }
    case 'date-time': { const parts = DATE_TIME.exec(value); return !!parts && realDay(parts[1]!, parts[2]!, parts[3]!); }
  }
}

/** Checks an accept answer against the relayed question before it reaches the MCP. */
export function validateAnswer(question: ObjectPrintConfirmation, content: unknown): Record<string, ConfirmationValue> {
  if (!question.supported) throw new InvalidAnswerError('This printer question can only be cancelled here.');
  if (!record(content)) throw new InvalidAnswerError('Answer the printer\'s question.');
  const answer: Record<string, ConfirmationValue> = {};
  for (const [name, value] of Object.entries(content)) {
    const target = question.fields.find(item => item.name === name);
    if (!target) throw new InvalidAnswerError(`"${name}" isn't part of the printer's question.`);
    const label = `"${target.title}"`;
    const type = target.type ?? 'boolean';
    if (type === 'boolean') {
      if (typeof value !== 'boolean') throw new InvalidAnswerError(`${label} needs yes or no.`);
    } else if (type === 'string') {
      if (typeof value !== 'string') throw new InvalidAnswerError(`${label} needs text.`);
      if (target.enum && !target.enum.includes(value)) throw new InvalidAnswerError(`${label} must be one of the choices.`);
      if (target.minLength !== undefined && [...value].length < target.minLength) throw new InvalidAnswerError(`${label} needs at least ${target.minLength} characters.`);
      if (target.maxLength !== undefined && [...value].length > target.maxLength) throw new InvalidAnswerError(`${label} takes at most ${target.maxLength} characters.`);
      if (target.format && !validFormat(target.format, value)) throw new InvalidAnswerError(`${label} must be a valid ${target.format}.`);
    } else {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new InvalidAnswerError(`${label} needs a number.`);
      if (type === 'integer' && !Number.isInteger(value)) throw new InvalidAnswerError(`${label} needs a whole number.`);
      if (target.minimum !== undefined && value < target.minimum) throw new InvalidAnswerError(`${label} must be at least ${target.minimum}.`);
      if (target.maximum !== undefined && value > target.maximum) throw new InvalidAnswerError(`${label} must be at most ${target.maximum}.`);
    }
    answer[name] = value as ConfirmationValue;
  }
  for (const target of question.fields) if (target.required && !Object.hasOwn(answer, target.name)) throw new InvalidAnswerError(`"${target.title}" needs an answer.`);
  return answer;
}
