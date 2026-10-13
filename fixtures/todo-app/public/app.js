const $ = (selector) => document.querySelector(selector);
const state = { projectId: null };

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

async function loadProjects() {
  const projects = await api('/api/projects');
  const select = $('#project-select');
  select.replaceChildren(...projects.map((p) => new Option(p.name, String(p.id))));
  if (state.projectId === null && projects[0]) state.projectId = projects[0].id;
  select.value = String(state.projectId);
  await loadTasks();
}

async function loadTasks() {
  const params = new URLSearchParams({ projectId: String(state.projectId) });
  const text = $('#search').value.trim();
  if (text) params.set('q', text);
  const filter = $('#filter').value;
  if (filter !== 'all') params.set('done', String(filter === 'done'));
  render(await api(`/api/tasks?${params}`));
}

function render(tasks) {
  $('#task-list').replaceChildren(
    ...tasks.map((task) => {
      const li = document.createElement('li');
      li.dataset.id = String(task.id);
      li.className = task.done ? 'done' : '';

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.className = 'toggle';
      toggle.checked = task.done;
      toggle.addEventListener('change', async () => {
        await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: { done: toggle.checked } });
        await loadTasks();
      });

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = task.title;
      title.addEventListener('click', () => showDetails(task.id));

      const edit = document.createElement('button');
      edit.className = 'edit';
      edit.type = 'button';
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => startEdit(li, task));

      const remove = document.createElement('button');
      remove.className = 'delete';
      remove.type = 'button';
      remove.textContent = 'Delete';
      remove.addEventListener('click', async () => {
        await api(`/api/tasks/${task.id}`, { method: 'DELETE' });
        await loadTasks();
      });

      li.append(toggle, title, edit, remove);
      return li;
    }),
  );
}

function startEdit(li, task) {
  const input = document.createElement('input');
  input.className = 'edit-input';
  input.value = task.title;
  const save = document.createElement('button');
  save.className = 'save';
  save.type = 'button';
  save.textContent = 'Save';
  save.addEventListener('click', async () => {
    await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: { title: input.value } });
    await loadTasks();
  });
  li.querySelector('.title').replaceWith(input);
  li.querySelector('.edit').replaceWith(save);
}

async function showDetails(id) {
  const task = await api(`/api/tasks/${id}`);
  const due = task.dueAt ? new Date(task.dueAt).toLocaleDateString() : 'no due date';
  $('#details').textContent = `${task.title}\n${task.description || 'No description'}\nDue: ${due}`;
}

$('#project-select').addEventListener('change', async (event) => {
  state.projectId = Number(event.target.value);
  await loadTasks();
});

$('#new-project-btn').addEventListener('click', async () => {
  const name = $('#new-project-name').value.trim();
  if (!name) return;
  const project = await api('/api/projects', { method: 'POST', body: { name } });
  $('#new-project-name').value = '';
  state.projectId = project.id;
  await loadProjects();
});

$('#add-task-btn').addEventListener('click', async () => {
  const title = $('#task-title').value.trim();
  if (!title) return;
  const due = $('#task-due').value;
  await api(`/api/projects/${state.projectId}/tasks`, {
    method: 'POST',
    body: { title, description: $('#task-desc').value, dueAt: due ? new Date(`${due}T12:00:00Z`).toISOString() : null },
  });
  $('#task-title').value = '';
  $('#task-desc').value = '';
  $('#task-due').value = '';
  await loadTasks();
});

// Reached only from the "Show stats" button, which exercise.js never clicks: traffic capture misses it, but the
// literal URL is visible to static analysis (testing the optional REA analysis source).
async function showStats() {
  const response = await fetch('/api/stats', { headers: { accept: 'application/json' } });
  const stats = await response.json();
  $('#details').textContent = `${stats.open} open, ${stats.done} done`;
}

// Declares one tool through WebMCP where the browser supports it (the "native tools" source in the architecture).
if (navigator.modelContext && typeof navigator.modelContext.registerTool === 'function') {
  navigator.modelContext.registerTool({
    name: 'count_open_tasks',
    description: 'Count the open tasks in the selected project.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async execute() {
      const tasks = await api(`/api/tasks?projectId=${state.projectId}&done=false`);
      return { content: [{ type: 'text', text: String(tasks.length) }] };
    },
  });
}

$('#stats-btn').addEventListener('click', () => showStats());
$('#search').addEventListener('input', () => loadTasks());
$('#filter').addEventListener('change', () => loadTasks());

loadProjects();
