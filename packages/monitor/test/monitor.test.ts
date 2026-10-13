import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import restObserver from '@taurus/adapter-rest-observer';
import { SCHEMAS } from '@taurus/capabilities';
import { ApprovalBroker, Runtime } from '@taurus/core';
import { startGateway, type Gateway } from '@taurus/gateway';
import { createMonitor } from '@taurus/monitor';
import { compiledFixture } from '../../capabilities/test/helpers.js';

const TOKEN = 'monitor-test-token';
let ctx: Awaited<ReturnType<typeof compiledFixture>>;
let gateway: Gateway;
let runtime: Runtime;
let broker: ApprovalBroker;

beforeAll(async () => {
  ctx = await compiledFixture('todo-monitor');
  broker = new ApprovalBroker(5_000);
  const events = new EventEmitter();
  runtime = new Runtime({ store: ctx.store, adapters: [restObserver], schemas: SCHEMAS, approve: broker.handler, events });
  const monitor = createMonitor({ store: ctx.store, runtime, broker, events, adapters: [restObserver], token: TOKEN });
  gateway = await startGateway({ runtime, store: ctx.store, port: 0, extensions: [monitor] });
});

afterAll(async () => {
  await gateway?.close();
  await ctx?.cleanup();
});

const api = (path: string, init: RequestInit & { token?: string | null } = {}) => {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.token !== null) headers['x-taurus-monitor'] = init.token ?? TOKEN;
  if (init.body) headers['content-type'] = 'application/json';
  return fetch(`${gateway.url}/monitor/api/${path}`, { ...init, headers });
};

describe('monitor static files', () => {
  it('serves the PWA shell with a strict content security policy', async () => {
    const res = await fetch(`${gateway.url}/monitor/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(await res.text()).toContain('<link rel="manifest"');
    const manifest = await (await fetch(`${gateway.url}/monitor/manifest.webmanifest`)).json();
    expect(manifest.scope).toBe('/monitor/');
  });

  it('serves only known files', async () => {
    expect((await fetch(`${gateway.url}/monitor/../package.json`)).status).toBe(404);
    expect((await fetch(`${gateway.url}/monitor/src/index.ts`)).status).toBe(404);
  });
});

describe('monitor API security', () => {
  it('requires the monitor token', async () => {
    expect((await api('apps', { token: null })).status).toBe(401);
    expect((await api('apps', { token: 'wrong' })).status).toBe(401);
    expect((await api('apps')).status).toBe(200);
  });

  it('rejects requests from other sites even with the token', async () => {
    const res = await api('apps', { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });

  it('asks for acknowledgement before switching on a risky tool', async () => {
    const body = JSON.stringify({ profile: 'default', slot: 'tasks.task.delete', enabled: true });
    expect((await api('apps/todo-monitor/tools', { method: 'POST', body })).status).toBe(409);
    const ok = await api('apps/todo-monitor/tools', {
      method: 'POST',
      body: JSON.stringify({ profile: 'default', slot: 'tasks.task.delete', enabled: true, acknowledged: true }),
    });
    expect(ok.status).toBe(200);
    const detail = await ok.json();
    expect(detail.tools.find((t: { slot: string }) => t.slot === 'tasks.task.delete').enabled).toBe(true);
  });
});

describe('monitor data', () => {
  it('lists apps with their checks and tools with token estimates', async () => {
    const { apps } = await (await api('apps')).json();
    expect(apps.map((a: { appId: string }) => a.appId)).toEqual(['todo-monitor']);
    const detail = await (await api('apps/todo-monitor')).json();
    expect(detail.endpoint).toBe(`${gateway.url}/pmcp/todo-monitor/default/mcp`);
    expect(detail.tools.every((t: { tokens: number }) => t.tokens > 0)).toBe(true);
    expect(detail.enabledTokens).toBeGreaterThan(0);
    // No analysis source ran for this compile, so nothing was found in code.
    expect(detail.found).toEqual({ sources: [], operations: [], declaredTools: [] });
  });

  it('holds a risky call until it is approved in the monitor', async () => {
    const call = runtime.callTool('todo-monitor', 'default', 'tasks_task_delete', { id: '2' });
    await new Promise((r) => setTimeout(r, 50));
    const { approvals } = await (await api('approvals')).json();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ appId: 'todo-monitor', slot: 'tasks.task.delete', effect: 'delete', args: { id: '2' } });

    const decided = await api(`approvals/${approvals[0].id}`, { method: 'POST', body: JSON.stringify({ approved: true }) });
    expect(decided.status).toBe(200);
    expect((await call).ok).toBe(true);
    expect((await api(`approvals/${approvals[0].id}`, { method: 'POST', body: JSON.stringify({ approved: true }) })).status).toBe(410);
  });

  it('tells the agent when a call is denied', async () => {
    const call = runtime.callTool('todo-monitor', 'default', 'tasks_task_delete', { id: '1' });
    await new Promise((r) => setTimeout(r, 50));
    const [approval] = broker.list();
    await api(`approvals/${approval.id}`, { method: 'POST', body: JSON.stringify({ approved: false }) });
    expect((await call).error?.code).toBe('approval_required');
  });

  it('returns recent calls newest first, without arguments or results', async () => {
    const { calls } = await (await api('apps/todo-monitor/calls?limit=5')).json();
    expect(calls[0].tool).toBe('tasks_task_delete');
    expect(calls[0]).not.toHaveProperty('args');
    expect(Date.parse(calls[0].at)).toBeGreaterThanOrEqual(Date.parse(calls[1].at));
  });

  it('streams approval and call events', async () => {
    const controller = new AbortController();
    const res = await api('events', { signal: controller.signal });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    void runtime.callTool('todo-monitor', 'default', 'tasks_task_list', { projectId: '1' });
    let text = '';
    while (!text.includes('event: call')) text += (await reader.read()).value ?? '';
    controller.abort();
    expect(text).toContain('event: hello');
    expect(text).toContain('"tool":"tasks_task_list"');
  });
});
