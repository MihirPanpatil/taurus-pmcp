// @taurus/adapter-sdk — draft v0.1 (see docs/ADAPTER_SPEC.md)

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface JSONSchema {
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  format?: string;
  anyOf?: JSONSchema[];
  enum?: Json[];
  description?: string;
  [key: string]: unknown;
}

export type Effect = 'read' | 'write' | 'delete' | 'send' | 'personal' | 'account' | 'payment' | 'unknown';
export type ExecutionMode = 'http' | 'page' | 'vision';

export interface ExecutionSpec {
  mode: ExecutionMode;
  /** "<adapterId>/<executorName>" */
  executor: string;
  /** Data the executor needs. Must contain no secrets. */
  binding: Json;
}

export interface Evidence {
  seen: 'observed' | 'code-only';
  observations?: number;
}

export interface SourceRef {
  kind: 'bundle' | 'endpoint' | 'state' | 'dom';
  ref: string;
  hash: string;
}

export interface OperationCandidate {
  /** Stable within the adapter, e.g. "rest:GET /api/tasks". */
  key: string;
  nameHint: string;
  descriptionHint?: string;
  input: JSONSchema;
  output?: JSONSchema;
  /** Can only raise the risk that the rules assign. */
  effectHints: Effect[];
  execution: ExecutionSpec;
  evidence: Evidence;
  sources: SourceRef[];
}

export interface EntityCandidate {
  name: string;
  schema: JSONSchema;
  idField?: string;
}

export interface ResourceCandidate {
  key: string;
  schemaFrom?: string;
  schema?: JSONSchema;
}

export interface FlowCandidate {
  key: string;
  steps: string[];
}

export interface Contribution {
  entities: EntityCandidate[];
  operations: OperationCandidate[];
  resources: ResourceCandidate[];
  flows: FlowCandidate[];
}

/** One observed endpoint, reduced to shapes. User values are never kept. */
export interface NetworkShape {
  method: string;
  pathTemplate: string;
  pathParams: string[];
  query: JSONSchema;
  requestBody?: JSONSchema;
  responseBody?: JSONSchema;
  status: number[];
  contentType?: string;
  observations: number;
}

export interface NetworkLog {
  entries(filter?: { method?: string; pathPrefix?: string }): Promise<NetworkShape[]>;
}

export interface Logger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

export interface KeyValueStore {
  get(key: string): Promise<Json | undefined>;
  set(key: string, value: Json): Promise<void>;
}

export interface DetectContext {
  origin: string;
  network?: NetworkLog;
  kv?: KeyValueStore;
  log: Logger;
}

export type ExtractContext = DetectContext;

export interface Detection {
  framework: string;
  version?: string;
  confidence: number;
  details?: Json;
}

export interface HttpRequest {
  method: string;
  /** A path on the app's own site. Absolute URLs are rejected by the runtime. */
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: Json;
  /** Credential headers set here are removed by the runtime. */
  headers?: Record<string, string>;
}

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: Json | string | null;
}

export interface ExecContext {
  request?(req: HttpRequest): Promise<HttpResult>;
  log: Logger;
}

export interface ExecError {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface ExecResult {
  ok: boolean;
  data?: Json;
  error?: ExecError;
}

export interface Executor {
  mode: ExecutionMode;
  run(ctx: ExecContext, binding: Json, input: Json): Promise<ExecResult>;
}

export interface Adapter {
  /** Matches the manifest id. Built-in adapters declare it here until manifest loading lands. */
  id: string;
  detect(ctx: DetectContext): Promise<Detection | null>;
  extract(ctx: ExtractContext, detection: Detection): Promise<Contribution>;
  executors?: Record<string, Executor>;
}

export function defineAdapter(adapter: Adapter): Adapter {
  return adapter;
}

/** Maps an HTTP status to the shared error codes (docs/capabilities/TASKS.md, section 5). */
export function httpErrorCode(status: number): { code: string; retryable: boolean } {
  if (status === 404 || status === 410) return { code: 'not_found', retryable: false };
  if (status === 400 || status === 422) return { code: 'invalid_input', retryable: false };
  if (status === 401 || status === 403) return { code: 'permission_denied', retryable: false };
  if (status === 409 || status === 412) return { code: 'conflict', retryable: true };
  if (status === 429) return { code: 'rate_limited', retryable: true };
  // JSON endpoints that redirect are almost always sending an expired session to a sign-in page.
  if (status >= 300 && status < 400) return { code: 'needs_user', retryable: false };
  return { code: 'upstream_error', retryable: status >= 500 };
}
