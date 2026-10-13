import { createHash } from 'node:crypto';
import type { Adapter, Logger, NetworkLog, OperationCandidate } from '@taurus/adapter-sdk';
import { candidatesFromFindings, type AnalysisFindings } from './analysis.js';
import { classify } from './classify.js';
import type { AnalysisSummary, AppModel, Binder, Operation } from './model.js';

export interface CompileOptions {
  appId: string;
  origin: string;
  adapters: Adapter[];
  binders: Binder[];
  network?: NetworkLog;
  /** Findings from optional analysis sources. Traffic capture wins wherever both saw the same endpoint. */
  analysis?: AnalysisFindings[];
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

  const observed = new Set(
    [...candidates.values()].map(({ candidate }) => {
      const binding = candidate.execution.binding as { method?: string; pathTemplate?: string } | null;
      return `${binding?.method?.toUpperCase() ?? ''} ${binding?.pathTemplate ?? ''}`;
    }),
  );
  const analysis: AnalysisSummary[] = [];
  const declaredTools: NonNullable<AppModel['declaredTools']> = [];
  for (const findings of options.analysis ?? []) {
    const added = candidatesFromFindings(findings, observed);
    for (const candidate of added) {
      candidates.set(`analysis:${findings.source}:${candidate.key}`, { adapterId: `analysis:${findings.source}`, candidate });
    }
    for (const tool of findings.declaredTools) declaredTools.push({ ...tool, source: findings.source });
    analysis.push({
      source: findings.source,
      sourceVersion: findings.sourceVersion,
      at: findings.at,
      endpointsFound: findings.endpoints.length,
      newOperations: added.length,
      declaredTools: findings.declaredTools.length,
      limitations: findings.limitations,
    });
    log.info(
      `${findings.source}: ${findings.endpoints.length} endpoints in code, ${added.length} not seen in traffic, ${findings.declaredTools.length} declared tools`,
    );
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
    ...(declaredTools.length ? { declaredTools } : {}),
    ...(analysis.length ? { analysis } : {}),
  };

  for (const binder of options.binders) {
    const slots = binder.bind(model);
    if (slots.length > 0) model.bindings.push({ schema: binder.schema, version: binder.version, slots });
    log.info(`${binder.schema}: bound ${slots.length} slots`);
  }
  return model;
}
