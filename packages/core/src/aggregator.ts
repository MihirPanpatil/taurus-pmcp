import type { JSONSchema, NetworkLog, NetworkShape } from '@taurus/adapter-sdk';
import { templatePath } from './paths.js';
import { inferSchema, mergeSchemas } from './schema.js';

/** One request/response pair as seen by the shell. Passed in once, then reduced to shapes. */
export interface ObservedExchange {
  method: string;
  url: string;
  status: number;
  contentType?: string;
  requestBody?: unknown;
  responseBody?: unknown;
}

function queryShape(params: URLSearchParams): JSONSchema {
  const properties: Record<string, JSONSchema> = {};
  for (const [key, value] of params) {
    let shape: JSONSchema = { type: 'string' };
    if (value === 'true' || value === 'false') shape = { type: 'boolean' };
    else if (/^-?\d+$/.test(value)) shape = { type: 'integer' };
    properties[key] = key in properties ? mergeSchemas(properties[key], shape) : shape;
  }
  return { type: 'object', properties, required: [] };
}

const isSuccess = (status: number) => status >= 200 && status < 300;

/**
 * Collects observed traffic for one app origin as shapes only.
 * Requests to other origins are ignored, and no request or response values are stored.
 */
export class ShapeAggregator implements NetworkLog {
  private readonly shapes = new Map<string, NetworkShape>();

  constructor(readonly origin: string) {}

  add(exchange: ObservedExchange): boolean {
    let url: URL;
    try {
      url = new URL(exchange.url);
    } catch {
      return false;
    }
    if (url.origin !== this.origin) return false;

    const method = exchange.method.toUpperCase();
    const { template, params } = templatePath(url.pathname);
    const key = `${method} ${template}`;
    const ok = isSuccess(exchange.status);
    const query = queryShape(url.searchParams);
    const requestBody = ok && exchange.requestBody !== undefined ? inferSchema(exchange.requestBody) : undefined;
    const responseBody = ok && exchange.responseBody !== undefined ? inferSchema(exchange.responseBody) : undefined;

    const previous = this.shapes.get(key);
    if (!previous) {
      this.shapes.set(key, {
        method,
        pathTemplate: template,
        pathParams: params,
        query,
        requestBody,
        responseBody,
        status: [exchange.status],
        contentType: exchange.contentType,
        observations: 1,
      });
      return true;
    }
    previous.query = mergeSchemas(previous.query, query);
    if (requestBody) previous.requestBody = previous.requestBody ? mergeSchemas(previous.requestBody, requestBody) : requestBody;
    if (responseBody) previous.responseBody = previous.responseBody ? mergeSchemas(previous.responseBody, responseBody) : responseBody;
    if (!previous.status.includes(exchange.status)) previous.status.push(exchange.status);
    previous.contentType ??= exchange.contentType;
    previous.observations += 1;
    return true;
  }

  async entries(filter?: { method?: string; pathPrefix?: string }): Promise<NetworkShape[]> {
    return this.toJSON().filter(
      (s) =>
        (!filter?.method || s.method === filter.method.toUpperCase()) &&
        (!filter?.pathPrefix || s.pathTemplate.startsWith(filter.pathPrefix)),
    );
  }

  toJSON(): NetworkShape[] {
    return [...this.shapes.values()].sort((a, b) =>
      `${a.pathTemplate} ${a.method}`.localeCompare(`${b.pathTemplate} ${b.method}`),
    );
  }

  /** Rebuilds an aggregator from saved shapes, e.g. a capture file. */
  static fromShapes(origin: string, shapes: NetworkShape[]): ShapeAggregator {
    const aggregator = new ShapeAggregator(origin);
    for (const shape of shapes) aggregator.shapes.set(`${shape.method} ${shape.pathTemplate}`, structuredClone(shape));
    return aggregator;
  }
}
