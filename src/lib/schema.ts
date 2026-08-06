/**
 * Minimal JSON Schema (draft 2020-12) validator.
 *
 * Deliberately covers only the keywords our two schemas actually use. That is
 * the whole point: a deck of facts about AWS should not carry an npm supply
 * chain, and a 150-line checker we can read end to end is a better trade than a
 * general-purpose validator we cannot audit.
 *
 * Supported: type, const, enum, required, properties, additionalProperties:false,
 * additionalProperties:<schema>, items, minItems, minLength, minProperties,
 * pattern, uniqueItems, format:date-time.
 * Anything else in a schema is IGNORED — so do not add a keyword to a schema
 * without adding it here. validateSchemaKeywords() enforces that.
 */

export type Schema = Record<string, unknown>;

const SUPPORTED = new Set([
  '$schema', '$id', 'title', 'description', 'type', 'const', 'enum', 'required',
  'properties', 'additionalProperties', 'items', 'minItems', 'minLength',
  'minProperties', 'pattern', 'uniqueItems', 'format',
]);

/** Fail loudly if a schema uses a keyword this validator would silently skip. */
export function validateSchemaKeywords(schema: unknown, path = '#'): string[] {
  const errs: string[] = [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return errs;
  const s = schema as Schema;
  for (const k of Object.keys(s)) {
    if (!SUPPORTED.has(k)) errs.push(`${path}: unsupported schema keyword "${k}" — validator would ignore it`);
  }
  if (s.properties && typeof s.properties === 'object') {
    for (const [k, v] of Object.entries(s.properties as Schema)) {
      errs.push(...validateSchemaKeywords(v, `${path}/properties/${k}`));
    }
  }
  if (s.items) errs.push(...validateSchemaKeywords(s.items, `${path}/items`));
  if (s.additionalProperties && typeof s.additionalProperties === 'object') {
    errs.push(...validateSchemaKeywords(s.additionalProperties, `${path}/additionalProperties`));
  }
  return errs;
}

export function validate(value: unknown, schema: Schema, path = ''): string[] {
  const errs: string[] = [];
  const at = path || '(root)';

  if ('const' in schema && !deepEqual(value, schema.const)) {
    errs.push(`${at}: must equal ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    return errs;
  }

  if ('enum' in schema) {
    const allowed = schema.enum as unknown[];
    if (!allowed.some((a) => deepEqual(a, value))) {
      errs.push(`${at}: must be one of ${JSON.stringify(allowed)}, got ${JSON.stringify(value)}`);
      return errs;
    }
  }

  if ('type' in schema) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    if (!types.some((t) => matchesType(value, t))) {
      errs.push(`${at}: expected type ${types.join('|')}, got ${describe(value)}`);
      return errs;
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errs.push(`${at}: shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      errs.push(`${at}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
    }
    if (schema.format === 'date-time' && !isIsoDateTime(value)) {
      errs.push(`${at}: ${JSON.stringify(value)} is not an ISO 8601 date-time`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errs.push(`${at}: fewer than minItems ${schema.minItems}`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      if (seen.size !== value.length) errs.push(`${at}: items must be unique`);
    }
    if (schema.items) {
      value.forEach((v, i) => errs.push(...validate(v, schema.items as Schema, `${at}[${i}]`)));
    }
  }

  if (isPlainObject(value)) {
    const obj = value as Record<string, unknown>;
    if (typeof schema.minProperties === 'number' && Object.keys(obj).length < schema.minProperties) {
      errs.push(`${at}: fewer than minProperties ${schema.minProperties}`);
    }
    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (!(req in obj)) errs.push(`${at}: missing required property "${req}"`);
    }
    const props = (schema.properties as Schema | undefined) ?? {};
    for (const [k, v] of Object.entries(obj)) {
      if (k in props) {
        errs.push(...validate(v, props[k] as Schema, `${at}.${k}`));
      } else if (schema.additionalProperties === false) {
        errs.push(`${at}: unexpected property "${k}"`);
      } else if (isPlainObject(schema.additionalProperties)) {
        errs.push(...validate(v, schema.additionalProperties as Schema, `${at}.${k}`));
      }
    }
  }

  return errs;
}

function matchesType(v: unknown, t: string): boolean {
  switch (t) {
    case 'object': return isPlainObject(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    default: return false;
  }
}

function isPlainObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function isIsoDateTime(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s));
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
