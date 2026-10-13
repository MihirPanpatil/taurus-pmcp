import type { Adapter, Json } from '@taurus/adapter-sdk';
import { Runtime, type AppModel, type CredentialProvider, type PmcpStore } from '@taurus/core';
import { runTasksConformance } from './tasks-conformance.js';
import { tasksBinder } from './tasks-binder.js';
import { tasksSchema } from './tasks.js';

export { tasksBinder } from './tasks-binder.js';
export { runTasksConformance, type SlotCaller } from './tasks-conformance.js';
export { TASKS_SLOTS, tasksSchema } from './tasks.js';

export const SCHEMAS = [tasksSchema];
export const BINDERS = [tasksBinder];

const VERIFY_PROFILE = '__verify';

export interface VerifyOptions {
  store: PmcpStore;
  adapters: Adapter[];
  credentials?: CredentialProvider;
  fetch?: typeof fetch;
}

/**
 * The Verify stage. Runs each bound schema's conformance suite in a scratch project, records the result in the
 * model and adjusts each tool's confidence. It uses its own in-memory profile, and approves deletes only for items
 * the suite itself created.
 */
export async function verifyApp(appId: string, options: VerifyOptions): Promise<AppModel> {
  const created = new Set<string>();
  const model = await options.store.loadModel(appId);
  const allSlots = model.bindings.flatMap((b) => b.slots.map((s) => s.slot));
  const runtime = new Runtime({
    ...options,
    schemas: SCHEMAS,
    extraProfiles: [{ name: VERIFY_PROFILE, token: '', enabled: allSlots }],
    approve: async (req) => req.effect === 'delete' && created.has(String(req.args.id)),
  });

  const call = async (slot: string, args: Record<string, Json>) => {
    const result = await runtime.callTool(appId, VERIFY_PROFILE, slot, args);
    const id = (result.data as { id?: unknown } | undefined)?.id;
    if (result.ok && slot.endsWith('.create') && id !== undefined) created.add(String(id));
    return result;
  };

  model.verification = [];
  for (const capability of model.bindings) {
    if (capability.schema !== tasksSchema.id) continue;
    const result = await runTasksConformance(call, new Set(capability.slots.map((s) => s.slot)));
    model.verification.push(result);

    const failed = new Set(result.steps.filter((s) => s.status === 'failed').flatMap((s) => s.slots ?? []));
    const passed = new Set(result.steps.filter((s) => s.status === 'passed').flatMap((s) => s.slots ?? []));
    for (const binding of capability.slots) {
      const op = model.operations.find((o) => o.id === binding.operationId);
      if (!op) continue;
      const delta = failed.has(binding.slot) ? -0.3 : passed.has(binding.slot) ? 0.1 : 0;
      op.ratings.confidence = Number(Math.min(0.99, Math.max(0.05, op.ratings.confidence + delta)).toFixed(2));
    }
  }
  await options.store.saveModel(model);
  return model;
}
