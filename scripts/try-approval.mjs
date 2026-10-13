// Manual check for the monitor's approval flow: asks a PMCP to delete a task, which waits for you in the monitor.
// Usage: node scripts/try-approval.mjs <appId> <taskId> [--data-dir <dir>]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PmcpStore } from '@taurus/core';

const [appId = 'todo-fixture', taskId = '1'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const dirFlag = process.argv.indexOf('--data-dir');
const store = new PmcpStore(dirFlag >= 0 ? process.argv[dirFlag + 1] : undefined);
const [profile] = await store.getProfiles(appId);

const client = new Client({ name: 'taurus-try-approval', version: '0.0.1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:7777/pmcp/${appId}/${profile.name}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${profile.token}` } },
  }),
);
console.log(`Asking to delete task ${taskId}. Approve or deny it in the monitor...`);
const result = await client.callTool({ name: 'tasks_task_delete', arguments: { id: taskId } }, undefined, { timeout: 120_000 });
console.log(result.isError ? `Not deleted: ${result.content[0].text}` : `Deleted: ${result.content[0].text}`);
await client.close();
