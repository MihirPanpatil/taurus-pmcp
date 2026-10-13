import { createHash } from 'node:crypto';
import type { Adapter, Logger, NetworkLog, OperationCandidate } from '@taurus/adapter-sdk';
import { classify } from './classify.js';
import type { AppModel, Binder, Operation } from './model.js';

export interface CompileOptions {
  appId: string;
  origin: string;
  adapters: Adapter[];
  binders: Binder[];
  network?: NetworkLog;
  log?: Logger;
}

export const consoleLogger: Logger = {
  info: (message, data) => console.log(`[taurus] ${message}`, data ?? ''),
  warn: (message, data) => console.warn(`[taurus] ${message}`, data ?? ''),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {} };

function slug(key: string): string {
  return key
    .toLowerCase()
    .replace(/[{}]/g, '')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

function fingerprint(operations: Operation[]): string {
  const hash = createHash('sha256');
  for (const op of [...operations].sort((a, b) => a.key.localeCompare(b.key))) {
    hash.update(op.key);
    hash.update(JSON.stringify(op.input));
    hash.update(JSON.stringify(op.output ?? null));
  }
  return `sha256:${hash.digest('hex').slice(0, 16)}`;
}

/**
 * Detect -> Extract -> Model -> Classify -> Bind.
 * Probe and Verify run separately because they need a live runtime (see @taurus/capabilities).
 */
export async function compile(options: CompileOptions): Promise<AppModel> {
  const log = options.log ?? silentLogger;
  const ctx = { origin: options.origin, network: options.network, log };
  const frameworks: string[] = [];
  const candidates = new Map<string, { adapterId: string; candidate: OperationCandidate }>();

  for (const adapter of options.adapters) {
    const detection = await adapter.detect(ctx);
    if (!detection) continue;
    frameworks.push(detection.framework);
    const contribution = await adapter.extract(ctx, detection);
    for (const candidate of contribution.operations) {
      const key = `${adapter.id}:${candidate.key}`;
      if (!candidates.has(key)) candidates.set(key, { adapterId: adapter.id, candidate });
    }
    log.info(`${adapter.id}: ${contribution.operations.length} operation candidates`);
  }

  const operations: Operation[] = [...candidates.values()].map(({ adapterId, candidate }) => ({
    id: `op.${slug(candidate.key)}`,
    key: candidate.key,
    adapterId,
    nameHint: candidate.nameHint,
    descriptionHint: candidate.descriptionHint,
    input: candidate.input,
    output: candidate.output,
    execution: candidate.execution,
    ratings: classify(candidate),
    evidence: candidate.evidence,
    sources: candidate.sources,
  }));

  const model: AppModel = {
    formatVersion: 1,
    app: {
      id: options.appId,
      origin: options.origin,
      build: { fingerprint: fingerprint(operations), detectedAt: new Date().toISOString() },
      frameworks,
    },
    operations,
    bindings: [],
  };

  for (const binder of options.binders) {
    const slots = binder.bind(model);
    if (slots.length > 0) model.bindings.push({ schema: binder.schema, version: binder.version, slots });
    log.info(`${binder.schema}: bound ${slots.length} slots`);
  }
  return model;
}
