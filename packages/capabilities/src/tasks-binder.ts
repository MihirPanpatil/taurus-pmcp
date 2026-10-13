import type { JSONSchema } from '@taurus/adapter-sdk';
import { singular, type AppModel, type Binder, type FieldTarget, type Operation, type SlotBinding } from '@taurus/core';

// Deterministic, name-based binder for REST-shaped apps. The architecture's LLM-assisted binder will implement the
// same Binder interface; this one stays as the fast path and as the fallback when no model is available.

const TASK_WORDS = ['task', 'todo', 'card', 'item', 'issue', 'ticket'];
const PROJECT_WORDS = ['project', 'list', 'board', 'space', 'folder', 'workspace'];

const SYNONYMS = {
  id: ['id', '_id', 'uuid', 'key'],
  title: ['title', 'name', 'summary', 'subject', 'content'],
  name: ['name', 'title'],
  description: ['description', 'body', 'notes', 'note', 'details'],
  dueAt: ['dueAt', 'due_at', 'dueDate', 'due_date', 'due', 'deadline'],
  projectId: ['projectId', 'project_id', 'listId', 'list_id', 'boardId', 'board_id', 'project', 'list'],
  createdAt: ['createdAt', 'created_at', 'created'],
  updatedAt: ['updatedAt', 'updated_at', 'modifiedAt', 'modified', 'updated'],
  archived: ['archived', 'isArchived', 'is_archived'],
  doneFlag: ['done', 'completed', 'complete', 'isDone', 'is_done', 'isCompleted', 'is_completed', 'checked', 'closed'],
  status: ['status', 'state'],
  text: ['q', 'query', 'search', 'text', 'filter', 'term'],
};

interface Route {
  op: Operation;
  method: string;
  resource: string;
  kind: 'collection' | 'item';
  params: string[];
  query: Record<string, JSONSchema>;
  body: Record<string, JSONSchema>;
}

function routeOf(op: Operation): Route | null {
  if (op.execution.mode !== 'http') return null;
  const binding = op.execution.binding as { method?: string; pathTemplate?: string } | null;
  if (!binding?.method || !binding.pathTemplate) return null;
  const segments = binding.pathTemplate.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return null;
  const isItem = last.startsWith('{');
  const word = (isItem ? segments[segments.length - 2] : last) ?? '';
  const input = op.input.properties ?? {};
  return {
    op,
    method: binding.method.toUpperCase(),
    resource: singular(word.toLowerCase()).replace(/[-_]/g, ''),
    kind: isItem ? 'item' : 'collection',
    params: [...binding.pathTemplate.matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
    query: input.query?.properties ?? {},
    body: input.body?.properties ?? {},
  };
}

const isOf = (route: Route, words: string[]) => words.some((w) => route.resource === w || route.resource.endsWith(w));

function find(props: Record<string, unknown> | undefined, names: string[]): string | undefined {
  if (!props) return undefined;
  const keys = Object.keys(props);
  for (const name of names) {
    const key = keys.find((k) => k.toLowerCase() === name.toLowerCase());
    if (key) return key;
  }
  return undefined;
}

function choose(routes: Route[], test: (r: Route) => boolean): Route | undefined {
  return routes
    .filter(test)
    .sort((a, b) => a.params.length - b.params.length || (b.op.evidence.observations ?? 0) - (a.op.evidence.observations ?? 0))[0];
}

/** The item schema of a response, and where the array lives if the response wraps it. */
function responseShape(output: JSONSchema | undefined): { item: Record<string, JSONSchema>; list: boolean; listPath?: string } {
  if (!output) return { item: {}, list: false };
  const types = Array.isArray(output.type) ? output.type : [output.type];
  if (types.includes('array')) return { item: output.items?.properties ?? {}, list: true };
  for (const [key, child] of Object.entries(output.properties ?? {})) {
    const childTypes = Array.isArray(child.type) ? child.type : [child.type];
    if (childTypes.includes('array') && child.items?.properties) return { item: child.items.properties, list: true, listPath: key };
  }
  return { item: output.properties ?? {}, list: false };
}

function taskFields(item: Record<string, JSONSchema>): Record<string, string> {
  const fields: Record<string, string> = {};
  const add = (field: string, names: string[]) => {
    const key = find(item, names);
    if (key) fields[field] = key;
  };
  add('id', SYNONYMS.id);
  add('projectId', SYNONYMS.projectId);
  add('title', SYNONYMS.title);
  add('description', SYNONYMS.description);
  add('dueAt', SYNONYMS.dueAt);
  add('createdAt', SYNONYMS.createdAt);
  add('updatedAt', SYNONYMS.updatedAt);
  const status = find(item, SYNONYMS.doneFlag) ?? find(item, SYNONYMS.status);
  if (status) fields.status = status;
  return fields;
}

function projectFields(item: Record<string, JSONSchema>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [field, names] of [
    ['id', SYNONYMS.id],
    ['name', SYNONYMS.name],
    ['description', SYNONYMS.description],
    ['archived', SYNONYMS.archived],
  ] as const) {
    const key = find(item, names);
    if (key) fields[field] = key;
  }
  return fields;
}

function responseFor(route: Route, entity: 'Task' | 'Project'): SlotBinding['response'] {
  const shape = responseShape(route.op.output);
  return {
    list: shape.list,
    ...(shape.listPath ? { listPath: shape.listPath } : {}),
    fields: entity === 'Task' ? taskFields(shape.item) : projectFields(shape.item),
  };
}

/** Maps slot fields onto body fields by name. Fields with no match are reported as unsupported. */
function bodyFields(route: Route, fields: (keyof typeof SYNONYMS)[], request: Record<string, FieldTarget>, unsupported: string[]) {
  for (const field of fields) {
    const key = find(route.body, SYNONYMS[field]);
    if (key) request[field] = `body.${key}`;
    else unsupported.push(field);
  }
}

const itemParam = (route: Route) => route.params[route.params.length - 1];
const projectParam = (route: Route) => route.params.find((p) => /project|list|board|space|folder/i.test(p));

export const tasksBinder: Binder = {
  schema: 'tasks',
  version: '0.1.0',

  bind(model: AppModel): SlotBinding[] {
    const routes = model.operations.map(routeOf).filter((r): r is Route => r !== null);
    const tasks = routes.filter((r) => isOf(r, TASK_WORDS));
    const projects = routes.filter((r) => isOf(r, PROJECT_WORDS) && !isOf(r, TASK_WORDS));
    const slots: SlotBinding[] = [];

    const projectList = choose(projects, (r) => r.method === 'GET' && r.kind === 'collection' && r.params.length === 0);
    if (projectList) {
      slots.push({ slot: 'tasks.project.list', operationId: projectList.op.id, request: {}, response: responseFor(projectList, 'Project') });
    }

    const projectCreate = choose(projects, (r) => r.method === 'POST' && r.kind === 'collection' && r.params.length === 0);
    const projectName = projectCreate && find(projectCreate.body, SYNONYMS.name);
    if (projectCreate && projectName) {
      slots.push({
        slot: 'tasks.project.create',
        operationId: projectCreate.op.id,
        request: { name: `body.${projectName}` },
        response: responseFor(projectCreate, 'Project'),
      });
    }

    const taskList = choose(tasks, (r) => r.method === 'GET' && r.kind === 'collection');
    if (taskList) {
      const request: Record<string, FieldTarget> = {};
      const localFilters: string[] = [];
      const unsupported: string[] = [];
      const requires: string[] = [];
      const item = responseShape(taskList.op.output).item;
      const fields = taskFields(item);

      const pathProject = projectParam(taskList);
      const queryProject = find(taskList.query, SYNONYMS.projectId);
      if (pathProject) {
        request.projectId = `path.${pathProject}`;
        requires.push('projectId');
      } else if (queryProject) request.projectId = `query.${queryProject}`;
      else if (fields.projectId) localFilters.push('projectId');
      else unsupported.push('projectId');

      const doneQuery = find(taskList.query, SYNONYMS.doneFlag);
      if (doneQuery) request.status = { to: `query.${doneQuery}`, map: { done: true, open: false } };
      else if (fields.status) localFilters.push('status');
      else unsupported.push('status');

      const textQuery = find(taskList.query, SYNONYMS.text);
      if (textQuery) request.text = `query.${textQuery}`;
      else if (fields.title || fields.description) localFilters.push('text');
      else unsupported.push('text');

      slots.push({
        slot: 'tasks.task.list',
        operationId: taskList.op.id,
        request,
        response: responseFor(taskList, 'Task'),
        ...(localFilters.length ? { localFilters } : {}),
        ...(unsupported.length ? { unsupported } : {}),
        ...(requires.length ? { requires } : {}),
      });
    }

    const taskGet = choose(tasks, (r) => r.method === 'GET' && r.kind === 'item');
    if (taskGet) {
      slots.push({
        slot: 'tasks.task.get',
        operationId: taskGet.op.id,
        request: { id: `path.${itemParam(taskGet)}` },
        response: responseFor(taskGet, 'Task'),
      });
    }

    const taskCreate = choose(tasks, (r) => r.method === 'POST' && r.kind === 'collection');
    if (taskCreate && find(taskCreate.body, SYNONYMS.title)) {
      const request: Record<string, FieldTarget> = {};
      const unsupported: string[] = [];
      const pathProject = projectParam(taskCreate);
      const bodyProject = find(taskCreate.body, SYNONYMS.projectId);
      if (pathProject) request.projectId = `path.${pathProject}`;
      else if (bodyProject) request.projectId = `body.${bodyProject}`;
      bodyFields(taskCreate, ['title', 'description', 'dueAt'], request, unsupported);
      if (request.projectId) {
        slots.push({
          slot: 'tasks.task.create',
          operationId: taskCreate.op.id,
          request,
          response: responseFor(taskCreate, 'Task'),
          ...(unsupported.length ? { unsupported } : {}),
        });
      }
    }

    const taskUpdate =
      choose(tasks, (r) => r.method === 'PATCH' && r.kind === 'item') ?? choose(tasks, (r) => r.method === 'PUT' && r.kind === 'item');
    if (taskUpdate) {
      const request: Record<string, FieldTarget> = { id: `path.${itemParam(taskUpdate)}` };
      const unsupported: string[] = [];
      bodyFields(taskUpdate, ['title', 'description', 'dueAt'], request, unsupported);
      slots.push({
        slot: 'tasks.task.update',
        operationId: taskUpdate.op.id,
        request,
        response: responseFor(taskUpdate, 'Task'),
        ...(unsupported.length ? { unsupported } : {}),
      });

      const doneField = find(taskUpdate.body, SYNONYMS.doneFlag);
      if (doneField) {
        for (const [slot, value] of [
          ['tasks.task.complete', true],
          ['tasks.task.reopen', false],
        ] as const) {
          slots.push({
            slot,
            operationId: taskUpdate.op.id,
            request: { id: `path.${itemParam(taskUpdate)}` },
            fixed: { [`body.${doneField}`]: value },
            response: responseFor(taskUpdate, 'Task'),
          });
        }
      }
    }

    const taskDelete = choose(tasks, (r) => r.method === 'DELETE' && r.kind === 'item');
    if (taskDelete) {
      slots.push({ slot: 'tasks.task.delete', operationId: taskDelete.op.id, request: { id: `path.${itemParam(taskDelete)}` } });
    }

    return slots;
  },
};
