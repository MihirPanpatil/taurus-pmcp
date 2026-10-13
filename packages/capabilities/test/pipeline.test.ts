import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import restObserver from '@taurus/adapter-rest-observer';
import { SCHEMAS, verifyApp } from '@taurus/capabilities';
import { Runtime, type AppModel, type PmcpStore } from '@taurus/core';
import { compiledFixture } from './helpers.js';

let ctx: Awaited<ReturnType<typeof compiledFixture>>;

beforeAll(async () => {
  ctx = await compiledFixture();
});
afterAll(async () => {
  await ctx?.cleanup();
});

const runtimeFor = (store: PmcpStore, approve?: () => Promise<boolean>) =>
  new Runtime({ store, adapters: [restObserver], schemas: SCHEMAS, approve });

describe('compile', () => {
  it('turns observed traffic into rated operations', () => {
    const ops = ctx.model.operations.map((o) => `${o.nameHint} -> ${o.ratings.risk}`).sort();
    expect(ops).toEqual([
      'DELETE /api/tasks/{taskId} -> delete',
      'GET /api/projects -> read',
      'GET /api/tasks -> read',
      'GET /api/tasks/{taskId} -> read',
      'PATCH /api/tasks/{taskId} -> write',
      'POST /api/projects -> write',
      'POST /api/projects/{projectId}/tasks -> write',
    ]);
  });

  it('binds every tasks slot the fixture supports', () => {
    const slots = ctx.model.bindings.find((b) => b.schema === 'tasks')?.slots.map((s) => s.slot).sort();
    expect(slots).toEqual([
      'tasks.project.create',
      'tasks.project.list',
      'tasks.task.complete',
      'tasks.task.create',
      'tasks.task.delete',
      'tasks.task.get',
      'tasks.task.list',
      'tasks.task.reopen',
      'tasks.task.update',
    ]);
    const list = ctx.model.bindings[0].slots.find((s) => s.slot === 'tasks.task.list');
    expect(list?.request).toEqual({ projectId: 'query.projectId', status: { to: 'query.done', map: { done: true, open: false } }, text: 'query.q' });
  });

  it('keeps no user values in the model', () => {
    const dump = JSON.stringify(ctx.model);
    for (const value of ['Exercise task', 'Walk through', 'renamed', 'Exercise project']) expect(dump).not.toContain(value);
  });
});

describe('verify', () => {
  let verified: AppModel;
  beforeAll(async () => {
    verified = await verifyApp('todo-fixture', { store: ctx.store, adapters: [restObserver] });
  });

  it('passes the tasks conformance suite', () => {
    const result = verified.verification?.[0];
    expect(result?.failed).toBe(0);
    expect(result?.passed).toBe(7);
  });

  it('raises confidence for tools that passed', () => {
    const get = verified.operations.find((o) => o.nameHint === 'GET /api/tasks/{taskId}');
    expect(get?.ratings.confidence).toBeGreaterThan(0.6);
  });
});

describe('runtime', () => {
  it('hides delete tools by default and lists the rest', async () => {
    const tools = (await runtimeFor(ctx.store).listTools('todo-fixture')).map((t) => t.name);
    expect(tools).toContain('tasks_task_create');
    expect(tools).not.toContain('tasks_task_delete');
  });

  it('creates, lists and normalizes tasks', async () => {
    const runtime = runtimeFor(ctx.store);
    const created = await runtime.callTool('todo-fixture', 'default', 'tasks_task_create', { projectId: '1', title: 'From an agent' });
    expect(created.ok).toBe(true);
    const task = created.data as { id: string; ref: string; status: { kind: string } };
    expect(task.ref).toBe(`app://todo-fixture/task/${task.id}`);
    expect(task.status.kind).toBe('open');
    const listed = await runtime.callTool('todo-fixture', 'default', 'tasks_task_list', { projectId: '1', text: 'agent' });
    expect((listed.data as { items: { id: string }[] }).items.map((t) => t.id)).toContain(task.id);
  });

  it('validates input before calling the app', async () => {
    const runtime = runtimeFor(ctx.store);
    expect((await runtime.callTool('todo-fixture', 'default', 'tasks_task_create', { projectId: '1' })).error?.code).toBe('invalid_input');
    expect((await runtime.callTool('todo-fixture', 'default', 'tasks_task_get', { id: '1', bogus: true })).error?.code).toBe('invalid_input');
    expect((await runtime.callTool('todo-fixture', 'default', 'tasks_task_list', { status: 'archived' })).error?.code).toBe('invalid_input');
  });

  it('requires approval for deletes even when the tool is enabled', async () => {
    const profiles = await ctx.store.getProfiles('todo-fixture');
    profiles[0].enabled = ['tasks.task.delete'];
    await ctx.store.saveProfiles('todo-fixture', profiles);

    const denied = await runtimeFor(ctx.store).callTool('todo-fixture', 'default', 'tasks_task_delete', { id: '1' });
    expect(denied.error?.code).toBe('approval_required');

    const approved = await runtimeFor(ctx.store, async () => true).callTool('todo-fixture', 'default', 'tasks_task_delete', { id: '1' });
    expect(approved.ok).toBe(true);
  });

  it('maps app errors to shared error codes', async () => {
    const result = await runtimeFor(ctx.store).callTool('todo-fixture', 'default', 'tasks_task_get', { id: '99999' });
    expect(result.error?.code).toBe('not_found');
  });
});
