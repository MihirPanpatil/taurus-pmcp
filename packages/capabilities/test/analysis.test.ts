import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import restObserver from '@taurus/adapter-rest-observer';
import { BINDERS, SCHEMAS } from '@taurus/capabilities';
import { candidatesFromFindings, compile, PmcpStore, Runtime, ShapeAggregator, type AnalysisFindings } from '@taurus/core';
import { recordLikeTheUi } from './helpers.js';
// @ts-expect-error plain JS fixture
import { startFixture } from '../../../fixtures/todo-app/server.mjs';

const findings = (endpoints: AnalysisFindings['endpoints']): AnalysisFindings => ({
  source: 'test',
  at: new Date().toISOString(),
  endpoints,
  declaredTools: [],
  limitations: [],
});

describe('candidatesFromFindings', () => {
  it('lets traffic capture win and treats unknown methods as writes', () => {
    const candidates = candidatesFromFindings(
      findings([
        { pathTemplate: '/api/tasks', pathParams: [], queryParams: [], mechanism: 'call:fetch' },
        { pathTemplate: '/api/stats', pathParams: [], queryParams: ['projectId'], mechanism: 'call:fetch' },
        { method: 'DELETE', pathTemplate: '/api/projects/{projectId}', pathParams: ['projectId'], queryParams: [], mechanism: 'call:axios.delete' },
      ]),
      new Set(['GET /api/tasks']),
    );
    expect(candidates.map((c) => c.nameHint)).toEqual(['GET /api/stats', 'DELETE /api/projects/{projectId}']);
    expect(candidates[0].effectHints).toEqual(['write']);
    expect(candidates[0].evidence.seen).toBe('code-only');
    expect(candidates[1].effectHints).toEqual(['delete']);
  });
});

describe('code-only tools', () => {
  let fixture: { url: string; close(): Promise<void> };
  let dir: string;
  let store: PmcpStore;

  beforeAll(async () => {
    fixture = await startFixture(0);
    dir = await mkdtemp(join(tmpdir(), 'taurus-analysis-'));
    store = new PmcpStore(dir);
    const origin = new URL(fixture.url).origin;
    // Traffic without any DELETE, so only the code analysis knows how to delete a task.
    const recorded = (await recordLikeTheUi(fixture.url)).toJSON().filter((s) => s.method !== 'DELETE');
    const model = await compile({
      appId: 'todo-codeonly',
      origin,
      adapters: [restObserver],
      binders: BINDERS,
      network: ShapeAggregator.fromShapes(origin, recorded),
      analysis: [
        findings([
          { method: 'DELETE', pathTemplate: '/api/tasks/{taskId}', pathParams: ['taskId'], queryParams: [], mechanism: 'call:axios.delete' },
          { method: 'GET', pathTemplate: '/api/tasks/{taskId}', pathParams: ['taskId'], queryParams: [], mechanism: 'call:axios.get' },
        ]),
      ],
    });
    await store.saveModel(model);
  });

  afterAll(async () => {
    await fixture?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('binds a code-only operation only where traffic capture has nothing', async () => {
    const model = await store.loadModel('todo-codeonly');
    const ops = (slot: string) => {
      const binding = model.bindings[0].slots.find((s) => s.slot === slot);
      return model.operations.find((o) => o.id === binding?.operationId);
    };
    expect(ops('tasks.task.delete')?.evidence.seen).toBe('code-only');
    expect(ops('tasks.task.get')?.evidence.seen).toBe('observed');
    expect(model.analysis?.[0]).toMatchObject({ source: 'test', endpointsFound: 2, newOperations: 1 });
  });

  it('keeps code-only tools off by default and labels them', async () => {
    const runtime = new Runtime({ store, adapters: [restObserver], schemas: SCHEMAS });
    const tools = await runtime.describeTools('todo-codeonly');
    const del = tools.find((t) => t.slot === 'tasks.task.delete');
    expect(del).toMatchObject({ codeOnly: true, enabled: false });
    expect(del?.description).toContain('never seen working');
    expect((await runtime.listTools('todo-codeonly')).map((t) => t.slot)).not.toContain('tasks.task.delete');
  });
});
