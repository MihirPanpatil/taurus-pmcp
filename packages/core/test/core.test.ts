import { describe, expect, it } from 'vitest';
import type { OperationCandidate } from '@taurus/adapter-sdk';
import { classify, inferSchema, mergeSchemas, RateLimiter, ShapeAggregator, templatePath } from '@taurus/core';

const candidate = (method: string, pathTemplate: string, hints: OperationCandidate['effectHints'] = []): OperationCandidate => ({
  key: `${method} ${pathTemplate}`,
  nameHint: `${method} ${pathTemplate}`,
  input: {},
  effectHints: hints,
  execution: { mode: 'http', executor: 'x/request', binding: { method, pathTemplate } },
  evidence: { seen: 'observed', observations: 1 },
  sources: [],
});

describe('inferSchema / mergeSchemas', () => {
  it('keeps shapes, never values', () => {
    const schema = inferSchema({ title: 'secret plan', count: 3, done: false, dueAt: '2030-01-15T12:00:00.000Z', tags: ['a'] });
    expect(JSON.stringify(schema)).not.toContain('secret plan');
    expect(schema.properties?.count).toEqual({ type: 'integer' });
    expect(schema.properties?.dueAt).toEqual({ type: 'string', format: 'date-time' });
    expect(schema.properties?.tags).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('makes properties missing from one sample optional, and merges null into a type', () => {
    const merged = mergeSchemas(inferSchema({ a: 1, b: 'x' }), inferSchema({ a: 2.5, b: null }));
    expect(merged.required).toEqual(['a', 'b']);
    expect(merged.properties?.a).toEqual({ type: 'number' });
    expect(merged.properties?.b).toEqual({ type: ['string', 'null'] });
    expect(mergeSchemas(inferSchema({ a: 1 }), inferSchema({ c: 1 })).required).toEqual([]);
  });
});

describe('templatePath', () => {
  it('names ID segments after the collection before them', () => {
    expect(templatePath('/api/projects/12/tasks')).toEqual({ template: '/api/projects/{projectId}/tasks', params: ['projectId'] });
    expect(templatePath('/api/tasks/7').template).toBe('/api/tasks/{taskId}');
    expect(templatePath('/v1/boards/3f2b8c1e-1d2a-4b5c-9d0e-123456789abc/cards/99').params).toEqual(['boardId', 'cardId']);
    expect(templatePath('/api/tasks').params).toEqual([]);
  });
});

describe('ShapeAggregator', () => {
  it('ignores other origins and stores no values', () => {
    const aggregator = new ShapeAggregator('http://app.test');
    expect(aggregator.add({ method: 'GET', url: 'http://tracker.test/collect', status: 200, responseBody: {} })).toBe(false);
    aggregator.add({ method: 'GET', url: 'http://app.test/api/tasks/5?q=milk', status: 200, responseBody: { id: 5, title: 'Buy milk' } });
    aggregator.add({ method: 'GET', url: 'http://app.test/api/tasks/6', status: 200, responseBody: { id: 6, title: 'Call mum' } });
    const shapes = aggregator.toJSON();
    expect(shapes).toHaveLength(1);
    expect(shapes[0].pathTemplate).toBe('/api/tasks/{taskId}');
    expect(shapes[0].observations).toBe(2);
    const dump = JSON.stringify(shapes);
    for (const value of ['milk', 'Buy', 'Call mum', '"5"']) expect(dump).not.toContain(value);
  });

  it('does not learn shapes from failed requests', () => {
    const aggregator = new ShapeAggregator('http://app.test');
    aggregator.add({ method: 'POST', url: 'http://app.test/api/tasks', status: 400, requestBody: { wrong: true } });
    expect(aggregator.toJSON()[0].requestBody).toBeUndefined();
  });
});

describe('classify', () => {
  it('sets risk floors from what the request does, not from its name', () => {
    expect(classify(candidate('GET', '/api/tasks')).risk).toBe('read');
    expect(classify(candidate('POST', '/api/tasks')).risk).toBe('write');
    expect(classify(candidate('DELETE', '/api/tasks/{taskId}')).risk).toBe('delete');
    expect(classify(candidate('POST', '/api/messages/send')).risk).toBe('send');
    expect(classify(candidate('POST', '/api/billing/checkout')).risk).toBe('payment');
    expect(classify(candidate('GET', '/api/contacts')).risk).toBe('personal');
  });

  it('lets hints raise risk but never lower it', () => {
    expect(classify(candidate('DELETE', '/api/cache/refresh', ['read'])).risk).toBe('delete');
    expect(classify(candidate('POST', '/api/tasks', ['send'])).risk).toBe('send');
  });
});

describe('RateLimiter', () => {
  it('gives up instead of waiting past maxWaitMs, and honors penalties', async () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 0.1, maxWaitMs: 50 });
    expect(await limiter.acquire('a')).toBe(true);
    expect(await limiter.acquire('a')).toBe(false);
    expect(await limiter.acquire('b')).toBe(true);
    limiter.penalize('b', 10_000);
    expect(limiter.blockedFor('b')).toBeGreaterThan(9_000);
    expect(await limiter.acquire('b')).toBe(false);
  });
});

describe('limitsForOrigin', () => {
  it('gives local and self-hosted apps a faster budget than third-party sites', async () => {
    const { limitsForOrigin, LOCAL_RATE_LIMITS, DEFAULT_RATE_LIMITS } = await import('@taurus/core');
    for (const origin of ['http://127.0.0.1:4100', 'http://localhost:3000', 'http://192.168.1.1', 'http://router.local', 'http://nas.lan']) {
      expect(limitsForOrigin(origin)).toBe(LOCAL_RATE_LIMITS);
    }
    for (const origin of ['https://example.com', 'https://192.168.example.com', 'https://localhost.example.com']) {
      expect(limitsForOrigin(origin)).toBe(DEFAULT_RATE_LIMITS);
    }
  });
});
