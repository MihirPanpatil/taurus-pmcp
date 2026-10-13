import type { JSONSchema, Json } from '@taurus/adapter-sdk';
import type { CapabilitySchema, SlotDef } from '@taurus/core';

// Machine-readable subset of docs/capabilities/TASKS.md (v0.1.0): the core tier plus project.create and task.delete.
// Sections, labels, assignees, priorities and comments follow once a fixture exercises them.

const id: JSONSchema = { type: 'string', description: 'Opaque ID returned by Taurus. Never construct one.' };
const dateTime: JSONSchema = { type: 'string', format: 'date-time', description: 'ISO 8601 with time zone.' };
const markdown: JSONSchema = { type: 'string', description: 'Markdown.' };
const limit: JSONSchema = { type: 'integer', minimum: 1, maximum: 100, description: 'Page size (default 25).' };
const cursor: JSONSchema = { type: 'string', description: 'nextCursor from the previous page.' };
const clientRequestId: JSONSchema = {
  type: 'string',
  description: 'Optional. Reuse the same value when retrying so the item is not created twice.',
};

const object = (properties: Record<string, JSONSchema>, required: string[] = []): JSONSchema => ({
  type: 'object',
  properties,
  required,
});

export const TASKS_SLOTS: SlotDef[] = [
  {
    name: 'tasks.project.list',
    tier: 'core',
    minEffect: 'read',
    kind: 'list',
    entity: 'Project',
    description: 'List projects (lists or boards) in this app. Returns { items, nextCursor }.',
    input: object({ limit, cursor }),
  },
  {
    name: 'tasks.project.create',
    tier: 'standard',
    minEffect: 'write',
    kind: 'create',
    entity: 'Project',
    description: 'Create a project.',
    input: object({ name: { type: 'string' }, clientRequestId }, ['name']),
  },
  {
    name: 'tasks.task.list',
    tier: 'core',
    minEffect: 'read',
    kind: 'list',
    entity: 'Task',
    description: 'List tasks, optionally filtered by project, status or text. Returns { items, nextCursor }.',
    input: object({
      projectId: id,
      status: { type: 'string', enum: ['open', 'done'] },
      text: { type: 'string', description: 'Matches title or description.' },
      limit,
      cursor,
    }),
  },
  {
    name: 'tasks.task.get',
    tier: 'core',
    minEffect: 'read',
    kind: 'get',
    entity: 'Task',
    description: 'Get one task with all its details.',
    input: object({ id }, ['id']),
  },
  {
    name: 'tasks.task.create',
    tier: 'core',
    minEffect: 'write',
    kind: 'create',
    entity: 'Task',
    description: 'Create a task in a project.',
    input: object({ projectId: id, title: { type: 'string' }, description: markdown, dueAt: dateTime, clientRequestId }, [
      'projectId',
      'title',
    ]),
  },
  {
    name: 'tasks.task.update',
    tier: 'core',
    minEffect: 'write',
    kind: 'update',
    entity: 'Task',
    description: 'Change a task. Fields left out are not changed; send null to clear one.',
    input: object({ id, title: { type: 'string' }, description: markdown, dueAt: dateTime }, ['id']),
  },
  {
    name: 'tasks.task.complete',
    tier: 'core',
    minEffect: 'write',
    kind: 'action',
    entity: 'Task',
    description: 'Mark a task as done.',
    input: object({ id }, ['id']),
  },
  {
    name: 'tasks.task.reopen',
    tier: 'core',
    minEffect: 'write',
    kind: 'action',
    entity: 'Task',
    description: 'Mark a done task as open again.',
    input: object({ id }, ['id']),
  },
  {
    name: 'tasks.task.delete',
    tier: 'standard',
    minEffect: 'delete',
    kind: 'delete',
    entity: 'Task',
    description: 'Delete a task permanently.',
    input: object({ id }, ['id']),
  },
];

const DONE_WORDS = /\b(done|complete|completed|closed|finished|resolved|archived)\b/i;

function normalizeStatus(raw: unknown): Json {
  if (typeof raw === 'boolean') return { kind: raw ? 'done' : 'open', native: String(raw) };
  if (typeof raw === 'string') return { kind: DONE_WORDS.test(raw) ? 'done' : 'open', native: raw };
  return { kind: 'open' };
}

const str = (value: unknown) => (value === undefined || value === null ? undefined : String(value));

function clean(record: Record<string, Json | undefined>): Record<string, Json> {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined)) as Record<string, Json>;
}

export const tasksSchema: CapabilitySchema = {
  id: 'tasks',
  version: '0.1.0',
  slots: TASKS_SLOTS,

  normalize(entity, raw, appId) {
    const id = str(raw.id) ?? '';
    if (entity === 'Project') {
      return clean({
        id,
        ref: `app://${appId}/project/${id}`,
        name: str(raw.name) ?? '',
        description: str(raw.description),
        archived: Boolean(raw.archived ?? false),
      });
    }
    // Contact details are not part of the schema (TASKS.md section 6), so nothing else is passed through.
    return clean({
      id,
      ref: `app://${appId}/task/${id}`,
      projectId: str(raw.projectId),
      title: str(raw.title) ?? '',
      description: str(raw.description),
      status: normalizeStatus(raw.status),
      dueAt: str(raw.dueAt),
      createdAt: str(raw.createdAt),
      updatedAt: str(raw.updatedAt),
    });
  },

  matchesFilter(_entity, item, field, value) {
    if (field === 'status') return (item.status as { kind?: string } | undefined)?.kind === value;
    if (field === 'projectId') return item.projectId === String(value);
    if (field === 'text') {
      const needle = String(value).toLowerCase();
      return [item.title, item.description].some((v) => typeof v === 'string' && v.toLowerCase().includes(needle));
    }
    return true;
  },
};
