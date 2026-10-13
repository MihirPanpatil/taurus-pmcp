import {
  defineAdapter,
  httpErrorCode,
  type Effect,
  type JSONSchema,
  type Json,
  type NetworkShape,
  type OperationCandidate,
} from '@taurus/adapter-sdk';

const ADAPTER_ID = 'rest-observer';

/** FNV-1a, enough to notice that an endpoint's shape changed between builds. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** JSON in either direction, or a body-less success (e.g. DELETE answering 204). */
const isJson = (shape: NetworkShape) =>
  /json/i.test(shape.contentType ?? '') ||
  shape.responseBody !== undefined ||
  shape.requestBody !== undefined ||
  shape.status.includes(204);

function effectHint(method: string): Effect {
  if (method === 'GET' || method === 'HEAD') return 'read';
  if (method === 'DELETE') return 'delete';
  return 'write';
}

function inputSchema(shape: NetworkShape): JSONSchema {
  const path: JSONSchema = {
    type: 'object',
    properties: Object.fromEntries(shape.pathParams.map((name) => [name, { type: 'string' }])),
    required: shape.pathParams,
  };
  const properties: Record<string, JSONSchema> = { path, query: shape.query };
  if (shape.requestBody) properties.body = shape.requestBody;
  return { type: 'object', properties, required: ['path'] };
}

function toCandidate(shape: NetworkShape): OperationCandidate {
  const name = `${shape.method} ${shape.pathTemplate}`;
  return {
    key: `rest:${name}`,
    nameHint: name,
    input: inputSchema(shape),
    output: shape.responseBody,
    effectHints: [effectHint(shape.method)],
    execution: {
      mode: 'http',
      executor: `${ADAPTER_ID}/request`,
      binding: { method: shape.method, pathTemplate: shape.pathTemplate },
    },
    evidence: { seen: 'observed', observations: shape.observations },
    sources: [
      {
        kind: 'endpoint',
        ref: name,
        hash: hash(JSON.stringify([shape.query, shape.requestBody ?? null, shape.responseBody ?? null])),
      },
    ],
  };
}

function fillPath(template: string, values: Record<string, Json>): string {
  return template.replace(/\{(\w+)\}/g, (_, param: string) => {
    const value = values[param];
    if (value === undefined || value === null || value === '') throw new Error(`missing path parameter "${param}"`);
    return encodeURIComponent(String(value));
  });
}

export default defineAdapter({
  id: ADAPTER_ID,

  async detect(ctx) {
    const shapes = (await ctx.network?.entries()) ?? [];
    const json = shapes.filter(isJson);
    if (json.length === 0) return null;
    return { framework: 'rest', confidence: Math.min(1, 0.5 + 0.05 * json.length) };
  },

  async extract(ctx) {
    const shapes = ((await ctx.network?.entries()) ?? []).filter(isJson);
    return { entities: [], resources: [], flows: [], operations: shapes.map(toCandidate) };
  },

  executors: {
    request: {
      mode: 'http',
      async run(ctx, binding, input) {
        if (!ctx.request) return { ok: false, error: { code: 'internal_error', message: 'network.replay was not granted' } };
        const { method, pathTemplate } = binding as { method: string; pathTemplate: string };
        const { path = {}, query = {}, body } = (input ?? {}) as {
          path?: Record<string, Json>;
          query?: Record<string, string | number | boolean>;
          body?: Record<string, Json>;
        };
        let target: string;
        try {
          target = fillPath(pathTemplate, path);
        } catch (error) {
          return { ok: false, error: { code: 'invalid_input', message: (error as Error).message } };
        }
        const hasBody = body && Object.keys(body).length > 0;
        const res = await ctx.request({ method, path: target, query, body: hasBody ? body : undefined });
        if (res.status >= 200 && res.status < 300) {
          return { ok: true, data: typeof res.body === 'string' ? { text: res.body } : res.body };
        }
        const { code, retryable } = httpErrorCode(res.status);
        return { ok: false, error: { code, retryable, message: `The app answered HTTP ${res.status}.` } };
      },
    },
  },
});
