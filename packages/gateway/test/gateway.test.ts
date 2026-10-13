import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import restObserver from '@taurus/adapter-rest-observer';
import { SCHEMAS } from '@taurus/capabilities';
import { Runtime } from '@taurus/core';
import { startGateway, type Gateway } from '@taurus/gateway';
import { compiledFixture } from '../../capabilities/test/helpers.js';

let ctx: Awaited<ReturnType<typeof compiledFixture>>;
let gateway: Gateway;
let token: string;

beforeAll(async () => {
  ctx = await compiledFixture('todo-gateway');
  const runtime = new Runtime({ store: ctx.store, adapters: [restObserver], schemas: SCHEMAS });
  gateway = await startGateway({ runtime, store: ctx.store, port: 0 });
  token = (await ctx.store.getProfiles('todo-gateway'))[0].token;
});

afterAll(async () => {
  await gateway?.close();
  await ctx?.cleanup();
});

async function connect(authToken = token) {
  const client = new Client({ name: 'taurus-test', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(new URL(gateway.endpoint('todo-gateway')), {
    requestInit: { headers: { authorization: `Bearer ${authToken}` } },
  });
  await client.connect(transport);
  return client;
}

describe('MCP gateway', () => {
  it('lists the PMCP tools with annotations', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('tasks_task_list');
    expect(names).not.toContain('tasks_task_delete');
    const list = tools.find((t) => t.name === 'tasks_task_list');
    expect(list?.annotations?.readOnlyHint).toBe(true);
    expect(list?.inputSchema.properties).toHaveProperty('status');
    await client.close();
  });

  it('calls a tool end to end', async () => {
    const client = await connect();
    const result = (await client.callTool({ name: 'tasks_task_create', arguments: { projectId: '1', title: 'Via MCP' } })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    expect(result.isError).toBeFalsy();
    const task = JSON.parse(result.content[0].text);
    expect(task.title).toBe('Via MCP');
    expect(task.status.kind).toBe('open');
    await client.close();
  });

  it('returns tool errors as isError results', async () => {
    const client = await connect();
    const result = (await client.callTool({ name: 'tasks_task_get', arguments: { id: '424242' } })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('not_found');
    await client.close();
  });

  it('rejects a wrong token', async () => {
    await expect(connect('not-the-token')).rejects.toThrow();
  });

  it('rejects requests from web pages and foreign host names', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const fromPage = await fetch(gateway.endpoint('todo-gateway'), { method: 'POST', body, headers: { ...headers, origin: 'https://evil.example' } });
    expect(fromPage.status).toBe(403);
  });

  it('answers 404 for unknown apps and internal profiles', async () => {
    const unknown = await fetch(`${gateway.url}/pmcp/nope/default/mcp`, { method: 'POST' });
    expect(unknown.status).toBe(404);
    const internal = await fetch(`${gateway.url}/pmcp/todo-gateway/__verify/mcp`, { method: 'POST' });
    expect(internal.status).toBe(404);
  });
});
