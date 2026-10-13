// End-to-end check of the walking skeleton, through the real Electron shell:
// fixture app -> shell capture (exercise.js) -> compile -> verify -> MCP gateway -> MCP client.
// Needs a display (on Linux CI, run it under xvfb-run). Set TAURUS_E2E_REA=1 to also run the optional REA analysis
// source (REA must be installed: npm install --global rea-agents).
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import restObserver from '@taurus/adapter-rest-observer';
import { SCHEMAS } from '@taurus/capabilities';
import { PmcpStore, Runtime } from '@taurus/core';
import { startGateway } from '@taurus/gateway';
import { startFixture } from '../fixtures/todo-app/server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const appId = 'todo-e2e';
const withRea = process.env.TAURUS_E2E_REA === '1';
const dataDir = await mkdtemp(join(tmpdir(), 'taurus-e2e-'));
const fixture = await startFixture(0);
let gateway;
let failed = false;

const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failed = true;
};

try {
  console.log(`fixture at ${fixture.url}, data in ${dataDir}\n`);
  const code = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        'packages/cli/dist/index.js',
        'compile',
        `${fixture.url}/`,
        '--app-id',
        appId,
        '--exercise',
        'fixtures/todo-app/exercise.js',
        '--data-dir',
        dataDir,
        ...(withRea ? ['--analyze', 'rea'] : []),
      ],
      { cwd: root, stdio: 'inherit' },
    );
    child.on('exit', (c) => resolve(c ?? 1));
  });
  check(code === 0, 'shell compiled and verified the fixture');

  const store = new PmcpStore(dataDir);
  const model = await store.loadModel(appId);
  const verification = model.verification?.[0];
  check(verification?.failed === 0 && verification?.passed === 7, `conformance ${verification?.passed ?? 0}/7 passed`);

  if (withRea) {
    const stats = model.operations.find((o) => o.nameHint === 'GET /api/stats');
    check(stats?.evidence.seen === 'code-only', 'REA found GET /api/stats in code (never used by the exercise)');
    check(model.declaredTools?.some((t) => t.name === 'count_open_tasks') === true, 'REA found the WebMCP declaration');
  }

  const runtime = new Runtime({ store, adapters: [restObserver], schemas: SCHEMAS });
  gateway = await startGateway({ runtime, store, port: 0 });
  const [profile] = await store.getProfiles(appId);
  const client = new Client({ name: 'taurus-e2e', version: '0.0.1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(gateway.endpoint(appId)), {
      requestInit: { headers: { authorization: `Bearer ${profile.token}` } },
    }),
  );
  const { tools } = await client.listTools();
  check(tools.length === 8, `MCP lists ${tools.length} tools (delete stays off by default)`);

  const created = await client.callTool({ name: 'tasks_task_create', arguments: { projectId: '1', title: 'Created over MCP' } });
  const task = JSON.parse(created.content[0].text);
  check(!created.isError && task.status?.kind === 'open', `tasks_task_create returned ${task.ref}`);

  const done = await client.callTool({ name: 'tasks_task_complete', arguments: { id: task.id } });
  check(JSON.parse(done.content[0].text).status?.kind === 'done', 'tasks_task_complete marked it done');

  const listed = await client.callTool({ name: 'tasks_task_list', arguments: { projectId: '1', status: 'done', text: 'over MCP' } });
  check(JSON.parse(listed.content[0].text).items.some((t) => t.id === task.id), 'tasks_task_list finds it with filters');
  await client.close();
} catch (error) {
  check(false, error instanceof Error ? error.stack : String(error));
} finally {
  await gateway?.close();
  await fixture.close();
  await rm(dataDir, { recursive: true, force: true });
}

console.log(failed ? '\nE2E FAILED' : '\nE2E PASSED');
process.exit(failed ? 1 : 0);
