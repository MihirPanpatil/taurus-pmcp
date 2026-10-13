import type { JSONSchema } from '@taurus/adapter-sdk';

const DATE_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const MAX_DEPTH = 8;
const MAX_ARRAY_SAMPLES = 20;

/** Reduces a value to its JSON Schema shape. The value itself is never kept. */
export function inferSchema(value: unknown, depth = 0): JSONSchema {
  if (depth > MAX_DEPTH) return {};
  if (value === null || value === undefined) return { type: 'null' };
  if (Array.isArray(value)) {
    let items: JSONSchema | undefined;
    for (const item of value.slice(0, MAX_ARRAY_SAMPLES)) {
      const shape = inferSchema(item, depth + 1);
      items = items ? mergeSchemas(items, shape) : shape;
    }
    return items ? { type: 'array', items } : { type: 'array' };
  }
  switch (typeof value) {
    case 'string':
      return DATE_TIME.test(value) ? { type: 'string', format: 'date-time' } : { type: 'string' };
    case 'number':
      return { type: Number.isInteger(value) ? 'integer' : 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'object': {
      const properties: Record<string, JSONSchema> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        properties[key] = inferSchema(child, depth + 1);
      }
      return { type: 'object', properties, required: Object.keys(properties).sort() };
    }
    default:
      return {};
  }
}

function typeList(schema: JSONSchema): string[] {
  const t = schema.type;
  if (Array.isArray(t)) return t;
  return typeof t === 'string' ? [t] : [];
}

function stripNull(schema: JSONSchema): JSONSchema {
  const types = typeList(schema).filter((t) => t !== 'null');
  if (types.length === 0) return { type: 'null' };
  return { ...schema, type: types.length === 1 ? types[0] : types };
}

function addNull(schema: JSONSchema): JSONSchema {
  if (schema.anyOf) return { anyOf: [...schema.anyOf, { type: 'null' }] };
  const types = typeList(schema);
  if (types.includes('null')) return schema;
  return { ...schema, type: [...types, 'null'] };
}

function mergeSame(a: JSONSchema, b: JSONSchema): JSONSchema {
  if (a.type === 'object' && b.type === 'object') {
    const pa = a.properties ?? {};
    const pb = b.properties ?? {};
    const properties: Record<string, JSONSchema> = { ...pa };
    for (const [key, shape] of Object.entries(pb)) {
      properties[key] = key in pa ? mergeSchemas(pa[key], shape) : shape;
    }
    const inA = new Set(a.required ?? []);
    const required = (b.required ?? []).filter((key) => inA.has(key)).sort();
    return { type: 'object', properties, required };
  }
  if (a.type === 'array' && b.type === 'array') {
    const items = a.items && b.items ? mergeSchemas(a.items, b.items) : (a.items ?? b.items);
    return items ? { type: 'array', items } : { type: 'array' };
  }
  if ((a.type === 'integer' && b.type === 'number') || (a.type === 'number' && b.type === 'integer')) {
    return { type: 'number' };
  }
  if (a.type === b.type) {
    if (a.type === 'string' && a.format !== b.format) return { type: 'string' };
    return a;
  }
  return { anyOf: [a, b] };
}

/** Merges two observed shapes of the same thing. Properties missing from either side become optional. */
export function mergeSchemas(a: JSONSchema, b: JSONSchema): JSONSchema {
  const ta = typeList(a);
  const tb = typeList(b);
  if (ta.length === 0 && !a.anyOf) return b;
  if (tb.length === 0 && !b.anyOf) return a;
  const nullable = ta.includes('null') || tb.includes('null');
  const realA = ta.filter((t) => t !== 'null');
  const realB = tb.filter((t) => t !== 'null');
  let merged: JSONSchema;
  if (realA.length === 0 && !a.anyOf) merged = stripNull(b);
  else if (realB.length === 0 && !b.anyOf) merged = stripNull(a);
  else if (realA.length === 1 && realB.length === 1) merged = mergeSame(stripNull(a), stripNull(b));
  else merged = { anyOf: [a, b] };
  return nullable && !(merged.type === 'null') ? addNull(merged) : merged;
}

/** Returns the property names of an object schema, or of the item schema of an array schema. */
export function objectProperties(schema: JSONSchema | undefined): Record<string, JSONSchema> {
  if (!schema) return {};
  if (typeList(schema).includes('array')) return objectProperties(schema.items);
  return schema.properties ?? {};
}
