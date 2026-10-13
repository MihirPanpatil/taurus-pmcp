import type { Json } from '@taurus/adapter-sdk';
import type { ToolResult, Verification, VerificationStep } from '@taurus/core';

/** Calls one slot, e.g. call('tasks.task.get', { id }). */
export type SlotCaller = (slot: string, args: Record<string, Json>) => Promise<ToolResult>;

type Task = { id: string; title?: string; description?: string; dueAt?: string; status?: { kind?: string } };

class StepFailure extends Error {}
class StepSkipped extends Error {}

function expectOk(result: ToolResult, what: string): Json {
  if (!result.ok) throw new StepFailure(`${what} failed: ${result.error?.code} ${result.error?.message ?? ''}`.trim());
  return result.data ?? null;
}

const asTask = (data: Json) => data as unknown as Task;
const items = (data: Json) => ((data as { items?: Task[] } | null)?.items ?? []) as Task[];

/**
 * The generic `tasks` conformance script (docs/capabilities/TASKS.md, section 7).
 * Runs only inside a scratch project it creates, and deletes the tasks it created.
 */
export async function runTasksConformance(call: SlotCaller, bound: Set<string>): Promise<Verification> {
  const token = `taurus-${Date.now().toString(36)}`;
  const steps: VerificationStep[] = [];
  const created = new Set<string>();
  let projectId: string | undefined;
  let taskId: string | undefined;

  const step = async (name: string, slots: string[], body: () => Promise<string | void>) => {
    try {
      const missing = slots.filter((s) => !bound.has(s));
      if (missing.length) throw new StepSkipped(`not bound: ${missing.join(', ')}`);
      const detail = await body();
      steps.push({ name, slots, status: 'passed', ...(detail ? { detail } : {}) });
    } catch (error) {
      if (error instanceof StepSkipped) steps.push({ name, slots, status: 'skipped', detail: error.message });
      else steps.push({ name, slots, status: 'failed', detail: (error as Error).message });
    }
  };

  const dueAt = '2030-01-15T12:00:00.000Z';

  await step('1. scratch project and task.create', ['tasks.project.create', 'tasks.task.create'], async () => {
    const project = expectOk(await call('tasks.project.create', { name: `Taurus scratch ${token}` }), 'project.create');
    projectId = (project as { id?: string }).id;
    if (!projectId) throw new StepFailure('project.create returned no id');
    const task = asTask(
      expectOk(
        await call('tasks.task.create', {
          projectId,
          title: `${token} original`,
          description: 'Created by the Taurus conformance suite.',
          dueAt,
        }),
        'task.create',
      ),
    );
    if (!task.id) throw new StepFailure('task.create returned no id');
    taskId = task.id;
    created.add(task.id);
  });

  await step('2. task.get returns the same values', ['tasks.task.get'], async () => {
    if (!taskId) throw new StepSkipped('no task from step 1');
    const task = asTask(expectOk(await call('tasks.task.get', { id: taskId }), 'task.get'));
    if (task.title !== `${token} original`) throw new StepFailure(`title is "${task.title}"`);
    if (task.description !== 'Created by the Taurus conformance suite.') throw new StepFailure(`description is "${task.description}"`);
    if (!task.dueAt || Date.parse(task.dueAt) !== Date.parse(dueAt)) throw new StepFailure(`dueAt is "${task.dueAt}"`);
    if (task.status?.kind !== 'open') throw new StepFailure(`status is "${task.status?.kind}"`);
  });

  await step('3. task.update changes the title', ['tasks.task.update', 'tasks.task.get'], async () => {
    if (!taskId) throw new StepSkipped('no task from step 1');
    expectOk(await call('tasks.task.update', { id: taskId, title: `${token} renamed` }), 'task.update');
    const task = asTask(expectOk(await call('tasks.task.get', { id: taskId }), 'task.get'));
    if (task.title !== `${token} renamed`) throw new StepFailure(`title is "${task.title}"`);
    return 'label add/remove skipped: label slots are not in schema v0.1 yet';
  });

  await step('4. complete, list(status: done), reopen', ['tasks.task.complete', 'tasks.task.reopen', 'tasks.task.list', 'tasks.task.get'], async () => {
    if (!taskId || !projectId) throw new StepSkipped('no task from step 1');
    expectOk(await call('tasks.task.complete', { id: taskId }), 'task.complete');
    const done = items(expectOk(await call('tasks.task.list', { projectId, status: 'done', limit: 100 }), 'task.list'));
    if (!done.some((t) => t.id === taskId)) throw new StepFailure('completed task missing from list(status: done)');
    if (done.some((t) => t.status?.kind !== 'done')) throw new StepFailure('list(status: done) returned open tasks');
    expectOk(await call('tasks.task.reopen', { id: taskId }), 'task.reopen');
    const task = asTask(expectOk(await call('tasks.task.get', { id: taskId }), 'task.get'));
    if (task.status?.kind !== 'open') throw new StepFailure(`status after reopen is "${task.status?.kind}"`);
  });

  await step('5. task.list(text) finds the task', ['tasks.task.list'], async () => {
    if (!taskId || !projectId) throw new StepSkipped('no task from step 1');
    const found = items(expectOk(await call('tasks.task.list', { projectId, text: token, limit: 100 }), 'task.list'));
    if (!found.some((t) => t.id === taskId)) throw new StepFailure('task not found by text');
  });

  await step('6. clientRequestId prevents duplicates', ['tasks.task.create', 'tasks.task.list'], async () => {
    if (!projectId) throw new StepSkipped('no scratch project');
    const args = { projectId, title: `${token} dedupe`, clientRequestId: `${token}-dedupe` };
    const first = asTask(expectOk(await call('tasks.task.create', args), 'task.create'));
    const second = asTask(expectOk(await call('tasks.task.create', args), 'task.create (retry)'));
    created.add(first.id);
    created.add(second.id);
    if (first.id !== second.id) throw new StepFailure('retry created a second task');
    const found = items(expectOk(await call('tasks.task.list', { projectId, text: `${token} dedupe`, limit: 100 }), 'task.list'));
    if (found.length !== 1) throw new StepFailure(`expected 1 task, found ${found.length}`);
  });

  await step('7. task.delete, then task.get is not_found', ['tasks.task.delete', 'tasks.task.get'], async () => {
    if (!taskId) throw new StepSkipped('no task from step 1');
    for (const id of created) expectOk(await call('tasks.task.delete', { id }), `task.delete ${id}`);
    const after = await call('tasks.task.get', { id: taskId });
    if (after.ok || after.error?.code !== 'not_found') throw new StepFailure(`expected not_found, got ${after.ok ? 'ok' : after.error?.code}`);
    created.clear();
  });

  // Best-effort cleanup if a step failed before deleting.
  if (bound.has('tasks.task.delete')) for (const id of created) await call('tasks.task.delete', { id }).catch(() => undefined);

  return {
    schema: 'tasks',
    at: new Date().toISOString(),
    passed: steps.filter((s) => s.status === 'passed').length,
    failed: steps.filter((s) => s.status === 'failed').length,
    skipped: steps.filter((s) => s.status === 'skipped').length,
    steps,
  };
}
