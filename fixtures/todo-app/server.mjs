// Level 0 fixture (docs/TESTING_LADDER.md): a tiny task app with a REST API and a vanilla-JS frontend.
// No dependencies, in-memory data, and a fresh state on every start.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), 'public');
const STATIC = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };

function seed() {
  const now = new Date().toISOString();
  return {
    nextProject: 2,
    nextTask: 3,
    projects: [{ id: 1, name: 'Inbox', archived: false, createdAt: now }],
    tasks: [
      { id: 1, projectId: 1, title: 'Try Taurus', description: 'Compile this app into a PMCP.', dueAt: null, done: false, createdAt: now, updatedAt: now },
      { id: 2, projectId: 1, title: 'Read the testing ladder', description: '', dueAt: null, done: true, createdAt: now, updatedAt: now },
    ],
  };
}

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

function validDate(value) {
  return value === null || value === undefined || (typeof value === 'string' && !Number.isNaN(Date.parse(value)));
}

export function createApp() {
  const db = seed();
  const findTask = (id) => db.tasks.find((t) => t.id === Number(id));

  async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ["api", ...]
    const method = req.method;

    if (parts[1] === 'projects' && parts.length === 2) {
      if (method === 'GET') return send(res, 200, db.projects);
      if (method === 'POST') {
        const body = await readBody(req);
        if (!body || typeof body.name !== 'string' || !body.name.trim()) return send(res, 400, { error: 'name is required' });
        const project = { id: db.nextProject++, name: body.name.trim(), archived: false, createdAt: new Date().toISOString() };
        db.projects.push(project);
        return send(res, 201, project);
      }
    }

    if (parts[1] === 'projects' && parts.length === 4 && parts[3] === 'tasks' && method === 'POST') {
      const project = db.projects.find((p) => p.id === Number(parts[2]));
      if (!project) return send(res, 404, { error: 'project not found' });
      const body = await readBody(req);
      if (!body || typeof body.title !== 'string' || !body.title.trim()) return send(res, 400, { error: 'title is required' });
      if (!validDate(body.dueAt)) return send(res, 400, { error: 'dueAt must be a date' });
      const now = new Date().toISOString();
      const task = {
        id: db.nextTask++,
        projectId: project.id,
        title: body.title.trim(),
        description: typeof body.description === 'string' ? body.description : '',
        dueAt: body.dueAt ? new Date(body.dueAt).toISOString() : null,
        done: false,
        createdAt: now,
        updatedAt: now,
      };
      db.tasks.push(task);
      return send(res, 201, task);
    }

    if (parts[1] === 'stats' && parts.length === 2 && method === 'GET') {
      const projectId = url.searchParams.get('projectId');
      const tasks = projectId ? db.tasks.filter((t) => t.projectId === Number(projectId)) : db.tasks;
      return send(res, 200, { open: tasks.filter((t) => !t.done).length, done: tasks.filter((t) => t.done).length });
    }

    if (parts[1] === 'tasks' && parts.length === 2 && method === 'GET') {
      let tasks = db.tasks;
      const projectId = url.searchParams.get('projectId');
      const done = url.searchParams.get('done');
      const q = url.searchParams.get('q')?.toLowerCase();
      if (projectId) tasks = tasks.filter((t) => t.projectId === Number(projectId));
      if (done === 'true' || done === 'false') tasks = tasks.filter((t) => t.done === (done === 'true'));
      if (q) tasks = tasks.filter((t) => `${t.title} ${t.description}`.toLowerCase().includes(q));
      return send(res, 200, tasks);
    }

    if (parts[1] === 'tasks' && parts.length === 3) {
      const task = findTask(parts[2]);
      if (!task) return send(res, 404, { error: 'task not found' });
      if (method === 'GET') return send(res, 200, task);
      if (method === 'PATCH') {
        const body = await readBody(req);
        if (!body || typeof body !== 'object') return send(res, 400, { error: 'invalid JSON' });
        if ('title' in body && (typeof body.title !== 'string' || !body.title.trim())) return send(res, 400, { error: 'title cannot be empty' });
        if ('dueAt' in body && !validDate(body.dueAt)) return send(res, 400, { error: 'dueAt must be a date' });
        if ('title' in body) task.title = body.title.trim();
        if ('description' in body) task.description = body.description ?? '';
        if ('dueAt' in body) task.dueAt = body.dueAt ? new Date(body.dueAt).toISOString() : null;
        if ('done' in body) task.done = Boolean(body.done);
        task.updatedAt = new Date().toISOString();
        return send(res, 200, task);
      }
      if (method === 'DELETE') {
        db.tasks = db.tasks.filter((t) => t !== task);
        return send(res, 204);
      }
    }

    return send(res, 404, { error: 'not found' });
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture.local');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      const file = STATIC[url.pathname];
      if (file && req.method === 'GET') {
        const content = await readFile(join(PUBLIC, file[0]));
        return res.writeHead(200, { 'content-type': `${file[1]}; charset=utf-8` }).end(content);
      }
      res.writeHead(404).end('not found');
    } catch (error) {
      send(res, 500, { error: String(error) });
    }
  });
}

/** Starts the fixture on a port (0 = any free port). */
export function startFixture(port = 0) {
  const server = createApp();
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      resolve({ url: `http://127.0.0.1:${actual}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { url } = await startFixture(Number(process.env.PORT ?? 4100));
  console.log(`Todo fixture running at ${url}`);
}
