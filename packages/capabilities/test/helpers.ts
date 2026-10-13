import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import restObserver from '@taurus/adapter-rest-observer';
import { BINDERS } from '@taurus/capabilities';
import { compile, PmcpStore, ShapeAggregator, type AppModel } from '@taurus/core';
// @ts-expect-error plain JS fixture
import { startFixture } from '../../../fixtures/todo-app/server.mjs';

export interface Fixture {
  url: string;
  close(): Promise<void>;
}

/**
 * Makes the same requests the fixture's UI makes during exercise.js, feeding each exchange to the aggregator the
 * way the shell's network capture does. Used where launching Electron would make unit tests slow.
 */
export async function recordLikeTheUi(baseUrl: string): Promise<ShapeAggregator> {
  const origin = new URL(baseUrl).origin;
  const aggregator = new ShapeAggregator(origin);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const responseBody = text ? JSON.parse(text) : undefined;
    aggregator.add({ method, url: new URL(path, baseUrl).href, status: res.status, contentType: res.headers.get('content-type') ?? undefined, requestBody: body, responseBody });
    return responseBody;
  };
  await call('GET', '/api/projects');
  const project = await call('POST', '/api/projects', { name: 'Exercise project' });
  await call('GET', `/api/tasks?projectId=${project.id}`);
  const task = await call('POST', `/api/projects/${project.id}/tasks`, { title: 'Exercise task', description: 'Walk through every feature once', dueAt: '2030-01-15T12:00:00.000Z' });
  await call('GET', `/api/tasks/${task.id}`);
  await call('PATCH', `/api/tasks/${task.id}`, { done: true });
  await call('PATCH', `/api/tasks/${task.id}`, { done: false });
  await call('PATCH', `/api/tasks/${task.id}`, { title: 'Exercise task renamed' });
  await call('GET', `/api/tasks?projectId=${project.id}&q=renamed`);
  await call('GET', `/api/tasks?projectId=${project.id}&done=true`);
  await call('GET', `/api/tasks?projectId=${project.id}&done=false`);
  await call('DELETE', `/api/tasks/${task.id}`);
  return aggregator;
}

export async function compiledFixture(appId = 'todo-fixture'): Promise<{
  fixture: Fixture;
  store: PmcpStore;
  model: AppModel;
  cleanup(): Promise<void>;
}> {
  const fixture: Fixture = await startFixture(0);
  const dir = await mkdtemp(join(tmpdir(), 'taurus-test-'));
  const store = new PmcpStore(dir);
  const network = await recordLikeTheUi(fixture.url);
  const model = await compile({ appId, origin: new URL(fixture.url).origin, adapters: [restObserver], binders: BINDERS, network });
  await store.saveModel(model);
  return {
    fixture,
    store,
    model,
    cleanup: async () => {
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
