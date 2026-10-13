# Capability Schema: `tasks`

> **Draft v0.1.0 (design stage).** The first Taurus capability schema. It is used by testing-ladder levels 0–3. It also serves as the working example for the general capability-schema format, which will move into its own spec once this draft settles.

The `tasks` schema describes what **task and project apps** can do: todo lists, kanban boards, issue trackers and project planners. Skills and workflows written against it work on any app whose PMCP fills its slots.

---

## 1. How a capability schema works

- A schema defines **entities** (shared data types) and **slots** (named capabilities, each with input, output and a minimum effect).
- The compiler **binds** an app's operations to slots. Unbound slots are reported as `unsupported`. They are never faked.
- Each slot belongs to a **tier**. An app "supports `tasks`" only if it fills every `core` slot.
- Each slot has a **minimum effect**. The tool's risk rating can be higher than this (because of rules or the classifier), never lower.
- **Native values are kept.** Every app models status, priority and structure differently, so the schema maps them to a small shared set *and* keeps the app's own value next to it.

### Conventions

| Convention | Rule |
|---|---|
| IDs | Opaque strings. Never parsed or constructed by agents. |
| References | Every returned entity carries `ref` (`app://<app-id>/<entity>/<id>`) and, when available, a `url` that opens it in the app. |
| Times | ISO 8601 with time zone. A date-only value uses `T00:00:00` in the user's zone with `allDay: true`. |
| Text | `description` and comment bodies are Markdown. Bindings convert to and from the app's own format. |
| Lists | Cursor-based: `limit` (default 25, max 100) and `cursor`. Results include `nextCursor` when more exist. |
| Compact results | List slots return summary fields only. Use `get` slots for full detail. |
| Unsupported fields | Passing a field the app doesn't support returns `unsupported`. It is never silently ignored. |
| Retries | Create slots accept an optional `clientRequestId`. The runtime uses it to prevent duplicates when a request is retried. |

---

## 2. Entities

```yaml
Project:            # a list, board or project, whatever the app calls its top-level container
  id: string
  ref: string
  url?: string
  name: string
  description?: markdown
  parentId?: string       # for apps that nest projects (or boards inside projects)
  archived: boolean
  native?: object         # extra app-specific fields, passed through unchanged

Section:            # a column, bucket, list or group inside a project
  id: string
  ref: string
  projectId: string
  name: string
  position: number        # order within the project

Task:
  id: string
  ref: string
  url?: string
  projectId: string
  sectionId?: string
  parentId?: string       # subtasks
  title: string
  description?: markdown
  status:
    kind: open | done     # shared set
    native?: string       # the app's own value, e.g. "In review"
  priority?:
    level: none | low | medium | high | urgent
    native?: string | number
  startAt?: datetime
  dueAt?: datetime
  allDay?: boolean
  labels?: LabelRef[]
  assignees?: UserRef[]
  createdAt?: datetime
  updatedAt?: datetime
  native?: object

Label:     { id, ref, name, color? }
LabelRef:  { id, name }
User:      { id, ref, name, isSelf: boolean }   # no emails or phone numbers; see section 6
UserRef:   { id, name, isSelf: boolean }

Comment:
  id: string
  ref: string
  taskId: string
  author: UserRef
  body: markdown          # UNTRUSTED content (see ARCHITECTURE 7.4)
  createdAt: datetime
```

---

## 3. Slots

### 3.1 Core (required)

| Slot | Input | Output | Min effect |
|---|---|---|---|
| `tasks.project.list` | `archived?`, `limit?`, `cursor?` | `Project[]` (summary) | `read` |
| `tasks.task.list` | `projectId?`, `sectionId?`, `status?` (`open`\|`done`), `assigneeId?`, `labelId?`, `dueBefore?`, `dueAfter?`, `text?`, `limit?`, `cursor?` | `Task[]` (summary) | `read` |
| `tasks.task.get` | `id` | `Task` | `read` |
| `tasks.task.create` | `projectId`, `title`, `description?`, `sectionId?`, `parentId?`, `priority?`, `startAt?`, `dueAt?`, `allDay?`, `labelIds?`, `assigneeIds?`, `clientRequestId?` | `Task` | `write` |
| `tasks.task.update` | `id`, plus any of: `title`, `description`, `priority`, `startAt`, `dueAt`, `allDay`, `addLabelIds`, `removeLabelIds`, `addAssigneeIds`, `removeAssigneeIds` | `Task` | `write` |
| `tasks.task.complete` | `id` | `Task` | `write` |
| `tasks.task.reopen` | `id` | `Task` | `write` |

`update` is a **patch**: fields that are left out are not changed. To clear a field, send `null`. Labels and assignees use add/remove lists, so concurrent edits don't overwrite each other.

### 3.2 Standard

| Slot | Input | Output | Min effect |
|---|---|---|---|
| `tasks.project.get` | `id` | `Project` | `read` |
| `tasks.project.create` | `name`, `description?`, `parentId?`, `clientRequestId?` | `Project` | `write` |
| `tasks.section.list` | `projectId` | `Section[]` | `read` |
| `tasks.section.create` | `projectId`, `name`, `position?` | `Section` | `write` |
| `tasks.task.move` | `id`, `projectId?`, `sectionId?`, `position?` | `Task` | `write` |
| `tasks.task.delete` | `id` | `{ deleted: true }` | `delete` |
| `tasks.label.list` | `limit?`, `cursor?` | `Label[]` | `read` |
| `tasks.label.create` | `name`, `color?` | `Label` | `write` |
| `tasks.user.list` | `projectId?` | `User[]` | `read` |
| `tasks.comment.list` | `taskId`, `limit?`, `cursor?` | `Comment[]` | `read` |
| `tasks.comment.create` | `taskId`, `body` | `Comment` | `write` (see 3.4) |

### 3.3 Extended

| Slot | Input | Output | Min effect |
|---|---|---|---|
| `tasks.project.archive` / `unarchive` | `id` | `Project` | `write` |
| `tasks.project.delete` | `id` | `{ deleted: true }` | `delete` |
| `tasks.section.update` | `id`, `name?`, `position?` | `Section` | `write` |
| `tasks.section.delete` | `id`, `moveTasksTo?` | `{ deleted: true }` | `delete` |
| `tasks.task.bulkUpdate` | `ids[]` (max 50), patch as in `task.update` | `{ updated: n, failed: [] }` | `write` |

### 3.4 Effect rules beyond the minimum

These rules are fixed and checked by the runtime on every call. They are not left to the classifier.

| Situation | Effect becomes |
|---|---|
| `comment.create` in a project that has other members | `send` (it notifies other people) |
| Any slot that assigns a task to someone who isn't the user (`assigneeIds`, `addAssigneeIds`) | `send` |
| `task.bulkUpdate` touching more than 10 tasks | Requires confirmation, and counts toward the bulk-action daily cap |
| `section.delete` without `moveTasksTo` when the section contains tasks | `delete` for every contained task, plus confirmation |

---

## 4. Binding notes

Some differences between apps can't be solved automatically. The compiler records how each one was resolved in the binding, and asks the user in the monitor when it can't decide.

| Difference | How it is handled |
|---|---|
| **No native "done" state** (for example, boards where "done" is just a column) | The binding maps `done` to a section the user picks once ("Done" by default, if one exists). `complete` moves the task there, and `reopen` moves it back to its previous section or the first section. |
| **Many native statuses** ("To do", "In progress", "In review", "Done") | Each native status is mapped to `open` or `done`. The native value is kept in `status.native`. |
| **Numeric priorities** (e.g. 1–5) | Mapped to the five shared levels by a fixed table stored in the binding. The original number is kept in `priority.native`. |
| **Two-level containers** (e.g. projects that contain boards) | The inner container becomes `Project`, and its parent is linked with `parentId`. |
| **No sections** | Section slots stay unbound and report `unsupported`. |
| **Date-only due dates** | `allDay: true` |

### Illustrative mappings for ladder targets (to verify at levels 2–3)

| Schema | Vikunja (expected) | Planka (expected) |
|---|---|---|
| `Project` | Project (supports child projects) | Board, with its Planka project as `parentId` |
| `Section` | Kanban bucket | List |
| `Task` | Task | Card |
| `status.kind` | Native done flag | User-picked "done" list (section 4, first row) |
| `priority` | Numeric priority → mapped table | Probably unsupported |

These are expectations based on what each app is known to offer, not verified bindings. Confirming them is part of the ladder work.

---

## 5. Errors

Every slot returns errors in one shared format: `{ code, message, retryable }`.

| Code | Meaning |
|---|---|
| `not_found` | The ID doesn't exist, or the user can't see it |
| `invalid_input` | Input fails the slot's schema |
| `unsupported` | The slot or a field isn't available in this app |
| `conflict` | The item changed since it was read. Re-read and retry. |
| `permission_denied` | The user's account isn't allowed to do this |
| `rate_limited` | The site's budget is used up. Includes `retryAfter`. |
| `needs_user` | A CAPTCHA, verification or sign-in is waiting for the user |
| `stale_binding` | The site changed and this tool is being rebuilt |

---

## 6. Privacy rules for this schema

- `User` exposes only an ID, a display name and `isSelf`. Emails, phone numbers and other contact details are **not part of the schema**, even when the app shows them.
- Comment bodies and task descriptions written by other people are **untrusted content** (ARCHITECTURE 7.4).
- The `native` passthrough must not carry fields the schema leaves out on purpose, such as contact details.

---

## 7. Conformance tests

Every binding of `tasks` must pass the same generic test script in a scratch project:

1. `project.create` (or select the scratch project) → `task.create` with a title, description and due date.
2. `task.get` returns the same values. Times are compared after time-zone normalization.
3. `task.update`: change the title, add and remove a label.
4. `task.complete` → `task.list(status: done)` includes the task → `task.reopen`.
5. `task.list(text: …)` finds the task.
6. Retrying `task.create` with the same `clientRequestId` doesn't create a duplicate.
7. `task.delete` → `task.get` returns `not_found`.

Steps that use standard or extended slots are skipped when those slots are unbound. Level 0 fixture apps must pass every step, and level 2–3 targets must pass every step for the slots they bind.

---

## 8. Skills written against `tasks`

A skill declares the slots it needs, and is offered only for PMCPs that bind them:

```yaml
skill: weekly-review
schema: tasks@^0.1
requires: [tasks.task.list, tasks.task.update, tasks.task.complete]
optional: [tasks.comment.create]
uses-fields: [dueAt]
summary: >
  List open tasks due in the next 7 days or already overdue, ask the user which
  are finished, complete those, and push the remaining due dates as agreed.
```

---

## 9. Versioning

- Semver. **Adding** an optional slot or field is a minor change. **Changing** a slot's meaning, required inputs or minimum effect is a major change.
- Slot names are never reused for a different meaning.
- PMCPs record which schema version each binding was built against. Skills declare compatible ranges (e.g. `tasks@^0.1`).

---

## 10. Open questions

1. Should recurring tasks get their own slots, or stay in `native` until several apps are compared?
2. Should time tracking and estimates be a separate schema (`time`) that can be combined with `tasks`?
3. Should attachments be in `tasks` or in a shared `files` schema used by many app types?
4. Should the bulk threshold (10 tasks) and the bulk cap be part of the schema, or user settings only?
