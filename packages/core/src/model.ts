import type { Effect, Evidence, ExecutionSpec, JSONSchema, Json, SourceRef } from '@taurus/adapter-sdk';
import type { DeclaredTool } from './analysis.js';

export type PlatformRisk = 'low' | 'medium' | 'high';

export interface Ratings {
  risk: Effect;
  confidence: number;
  platformRisk: PlatformRisk;
}

export interface Operation {
  id: string;
  key: string;
  adapterId: string;
  nameHint: string;
  descriptionHint?: string;
  input: JSONSchema;
  output?: JSONSchema;
  execution: ExecutionSpec;
  ratings: Ratings;
  evidence: Evidence;
  sources: SourceRef[];
}

/**
 * Where a slot input field goes in the operation's input, e.g. "path.taskId", "query.q" or "body.title".
 * The object form translates values on the way, e.g. status "done" -> query.done = true.
 */
export type FieldTarget = string | { to: string; map: Record<string, Json> };

export interface SlotBinding {
  slot: string;
  operationId: string;
  /** slot input field -> operation input location */
  request: Record<string, FieldTarget>;
  /** operation input location -> constant value, e.g. { "body.done": true } */
  fixed?: Record<string, Json>;
  response?: {
    list: boolean;
    /** Property holding the array when the response wraps it, e.g. "items". */
    listPath?: string;
    /** entity field -> response field */
    fields: Record<string, string>;
  };
  /** Slot input fields this app cannot take. Passing them returns `unsupported`. */
  unsupported?: string[];
  /** Slot input fields the app requires even though the schema marks them optional. */
  requires?: string[];
  /** List filters the runtime applies itself because the app has no native filter. */
  localFilters?: string[];
}

export interface CapabilityBinding {
  schema: string;
  version: string;
  slots: SlotBinding[];
}

export interface VerificationStep {
  name: string;
  /** Slots the step exercised. */
  slots?: string[];
  status: 'passed' | 'failed' | 'skipped';
  detail?: string;
}

export interface Verification {
  schema: string;
  at: string;
  passed: number;
  failed: number;
  skipped: number;
  steps: VerificationStep[];
}

export interface AppModel {
  formatVersion: 1;
  app: {
    id: string;
    origin: string;
    build: { fingerprint: string; detectedAt: string };
    frameworks: string[];
  };
  operations: Operation[];
  bindings: CapabilityBinding[];
  verification?: Verification[];
  /** Tools the page declares about itself (WebMCP). Recorded and shown; not exposed to agents yet. */
  declaredTools?: (DeclaredTool & { source: string })[];
  /** Which optional analysis sources ran during this compile, and what they added. */
  analysis?: AnalysisSummary[];
}

export interface AnalysisSummary {
  source: string;
  sourceVersion?: string;
  at: string;
  endpointsFound: number;
  newOperations: number;
  declaredTools: number;
  limitations: string[];
}

export interface Binder {
  schema: string;
  version: string;
  bind(model: AppModel): SlotBinding[];
}

export type SlotKind = 'list' | 'get' | 'create' | 'update' | 'delete' | 'action';

export interface SlotDef {
  name: string;
  tier: 'core' | 'standard' | 'extended';
  minEffect: Effect;
  kind: SlotKind;
  entity: string;
  description: string;
  input: JSONSchema;
}

export interface CapabilitySchema {
  id: string;
  version: string;
  slots: SlotDef[];
  /** Turns mapped response fields into the schema's entity shape. */
  normalize(entity: string, raw: Record<string, unknown>, appId: string): Record<string, Json>;
  /** Applies a list filter the app can't apply itself. */
  matchesFilter?(entity: string, item: Record<string, Json>, field: string, value: Json): boolean;
}
