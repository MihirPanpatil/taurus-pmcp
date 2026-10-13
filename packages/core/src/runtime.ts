import type { EventEmitter } from 'node:events';
import type { Adapter, Effect, ExecContext, HttpRequest, HttpResult, JSONSchema, Json, Logger } from '@taurus/adapter-sdk';
import { maxEffect } from './classify.js';
import { silentLogger } from './compiler.js';
import type { AppModel, CapabilitySchema, Operation, SlotBinding, SlotDef } from './model.js';
import { RateLimiter } from './rate-limiter.js';
import type { AuditEntry, PmcpStore, Profile } from './store.js';

export interface ToolDef {
  name: string;
  slot: string;
  schema: string;
  tier: SlotDef['tier'];
  effect: Effect;
  /** Found in the app's code by an analysis source, never seen working. */
  codeOnly: boolean;
  description: string;
  inputSchema: JSONSchema;
}

export interface ToolInfo extends ToolDef {
  enabled: boolean;
  confidence: number;
}

export interface ToolError {
  code: string;
  message: string;
  retryable?: boolean;
  retryAfter?: number;
}

export interface ToolResult {
  ok: boolean;
  data?: Json;
  error?: ToolError;
}

export interface ApprovalRequest {
  appId: string;
  profile: string;
  tool: string;
  slot: string;
  effect: Effect;
  args: Record<string, Json>;
}

/** Asks the user. Resolves true only if they approved this specific call. */
export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;

/** Supplies the app's session credentials. Adapters never see them. */
export interface CredentialProvider {
  headersFor(origin: string): Promise<Record<string, string>>;
}

export const noCredentials: CredentialProvider = { headersFor: async () => ({}) };

export interface RuntimeOptions {
  store: PmcpStore;
  adapters: Adapter[];
  schemas: CapabilitySchema[];
  credentials?: CredentialProvider;
  approve?: ApprovalHandler;
  limiter?: RateLimiter;
  fetch?: typeof fetch;
  log?: Logger;
  /** In-memory profiles that are never written to disk, e.g. the Verify stage's own profile. */
  extraProfiles?: Profile[];
  /** Receives a `call` event after every tool call, e.g. for the monitor's live activity. */
  events?: EventEmitter;
}

export interface CallEvent extends AuditEntry {
  appId: string;
}

/** Effects that are off by default and need confirmation on every call (ARCHITECTURE 7.3). */
export const NEEDS_APPROVAL: Effect[] = ['delete', 'send', 'personal', 'account', 'payment'];
const ON_BY_DEFAULT: Effect[] = ['read', 'write'];
const RUNTIME_FIELDS = new Set(['limit', 'cursor', 'clientRequestId']);
const CREDENTIAL_HEADERS = /^(cookie|authorization|proxy-authorization)$/i;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export const toolName = (slot: string) => slot.replace(/\./g, '_');

class ToolFailure extends Error {
  constructor(readonly error: ToolError) {
    super(error.message);
  }
}

const fail = (code: string, message: string, extra: Partial<ToolError> = {}): ToolResult => ({
  ok: false,
  error: { code, message, ...extra },
});

interface Entry {
  schema: CapabilitySchema;
  slotDef: SlotDef;
  binding: SlotBinding;
  op: Operation;
  effect: Effect;
}

type OpInput = { path: Record<string, Json>; query: Record<string, Json>; body: Record<string, Json> };

function setAt(input: OpInput, location: string, value: Json): void {
  const [section, ...rest] = location.split('.');
  if (section !== 'path' && section !== 'query' && section !== 'body') throw new Error(`bad binding location "${location}"`);
  input[section][rest.join('.')] = value;
}

function mapRequest(binding: SlotBinding, args: Record<string, Json>): OpInput {
  const input: OpInput = { path: {}, query: {}, body: {} };
  for (const [field, target] of Object.entries(binding.request)) {
    const value = args[field];
    if (value === undefined) continue;
    if (typeof target === 'string') setAt(input, target, value);
    else if (String(value) in target.map) setAt(input, target.to, target.map[String(value)]);
    else throw new ToolFailure({ code: 'invalid_input', message: `"${field}" cannot be "${String(value)}"` });
  }
  for (const [location, value] of Object.entries(binding.fixed ?? {})) setAt(input, location, value);
  return input;
}

function typeMatches(schema: JSONSchema, value: Json): boolean {
  if (value === null) return true; // null clears a field
  if (schema.enum && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return true;
  }
}

function validate(entry: Entry, args: Record<string, Json>): ToolResult | undefined {
  const properties = entry.slotDef.input.properties ?? {};
  for (const field of Object.keys(args)) {
    if (entry.binding.unsupported?.includes(field)) {
      return fail('unsupported', `This app doesn't support "${field}" for ${entry.slotDef.name}.`);
    }
    if (!(field in properties)) return fail('invalid_input', `Unknown field "${field}".`);
    if (!typeMatches(properties[field], args[field])) return fail('invalid_input', `"${field}" has the wrong type or value.`);
  }
  const required = new Set([...(entry.slotDef.input.required ?? []), ...(entry.binding.requires ?? [])]);
  for (const field of required) {
    if (args[field] === undefined || args[field] === null || args[field] === '') {
      return fail('invalid_input', `"${field}" is required${entry.binding.requires?.includes(field) ? ' by this app' : ''}.`);
    }
  }
  return undefined;
}

function pick(fields: Record<string, string>, raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [entityField, responseField] of Object.entries(fields)) {
    const value = (raw as Record<string, unknown>)[responseField];
    if (value !== undefined) out[entityField] = value;
  }
  return out;
}

function decodeCursor(cursor: Json | undefined): number {
  if (typeof cursor !== 'string') return 0;
  const offset = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  return Number.isInteger(offset) && offset >= 0 ? offset : 0;
}

function shapeResult(entry: Entry, raw: Json, args: Record<string, Json>, appId: string): Json {
  const { slotDef, binding, schema } = entry;
  if (slotDef.kind === 'delete') return { deleted: true, id: args.id ?? null };
  const response = binding.response;
  if (!response) return { ok: true };
  const normalize = (item: unknown) => schema.normalize(slotDef.entity, pick(response.fields, item), appId);

  if (!response.list) return normalize(raw);

  const container = response.listPath && raw && typeof raw === 'object' && !Array.isArray(raw) ? raw[response.listPath] : raw;
  let items = Array.isArray(container) ? container.map(normalize) : [];
  for (const field of binding.localFilters ?? []) {
    const value = args[field];
    if (value === undefined || value === null) continue;
    items = items.filter((item) => schema.matchesFilter?.(slotDef.entity, item, field, value) ?? true);
  }
  const limit = Math.min(MAX_LIMIT, Number.isInteger(args.limit) ? Number(args.limit) : DEFAULT_LIMIT);
  const offset = decodeCursor(args.cursor);
  const page = items.slice(offset, offset + limit);
  const result: Record<string, Json> = { items: page };
  if (offset + limit < items.length) result.nextCursor = Buffer.from(String(offset + limit)).toString('base64url');
  return result;
}

/** Runs PMCP tools: profile check, validation, approval, rate limits, execution and result shaping. */
export class Runtime {
  readonly limiter: RateLimiter;
  private readonly models = new Map<string, AppModel>();
  private readonly dedupe = new Map<string, ToolResult>();

  constructor(private readonly options: RuntimeOptions) {
    this.limiter = options.limiter ?? new RateLimiter();
  }

  invalidate(appId?: string): void {
    if (appId) this.models.delete(appId);
    else this.models.clear();
  }

  async model(appId: string): Promise<AppModel> {
    let model = this.models.get(appId);
    if (!model) {
      model = await this.options.store.loadModel(appId);
      this.models.set(appId, model);
    }
    return model;
  }

  async profile(appId: string, name: string): Promise<Profile> {
    const profile =
      this.options.extraProfiles?.find((p) => p.name === name) ??
      (await this.options.store.getProfiles(appId)).find((p) => p.name === name);
    if (!profile) throw new Error(`no profile "${name}" for "${appId}"`);
    return profile;
  }

  private entries(model: AppModel): Entry[] {
    const entries: Entry[] = [];
    for (const capability of model.bindings) {
      const schema = this.options.schemas.find((s) => s.id === capability.schema);
      if (!schema) continue;
      for (const binding of capability.slots) {
        const slotDef = schema.slots.find((s) => s.name === binding.slot);
        const op = model.operations.find((o) => o.id === binding.operationId);
        if (!slotDef || !op) continue;
        entries.push({ schema, slotDef, binding, op, effect: maxEffect(slotDef.minEffect, op.ratings.risk) });
      }
    }
    return entries;
  }

  private isEnabled(entry: Entry, profile: Profile): boolean {
    if (profile.disabled?.includes(entry.slotDef.name)) return false;
    if (profile.enabled?.includes(entry.slotDef.name)) return true;
    // Code-only tools stay off until the user switches them on (ARCHITECTURE 3.3).
    return ON_BY_DEFAULT.includes(entry.effect) && entry.op.evidence.seen === 'observed';
  }

  private toolDef(entry: Entry): ToolDef {
    const properties: Record<string, JSONSchema> = { ...(entry.slotDef.input.properties ?? {}) };
    for (const field of entry.binding.unsupported ?? []) delete properties[field];
    const required = [...new Set([...(entry.slotDef.input.required ?? []), ...(entry.binding.requires ?? [])])].filter(
      (field) => field in properties,
    );
    const codeOnly = entry.op.evidence.seen !== 'observed';
    const notes: string[] = [];
    if (codeOnly) notes.push("Found in the app's code but never seen working, so it may fail.");
    if (NEEDS_APPROVAL.includes(entry.effect)) notes.push("Needs the user's confirmation on every call.");
    if (entry.binding.localFilters?.length) notes.push(`Taurus applies these filters itself: ${entry.binding.localFilters.join(', ')}.`);
    return {
      name: toolName(entry.slotDef.name),
      slot: entry.slotDef.name,
      schema: entry.schema.id,
      tier: entry.slotDef.tier,
      effect: entry.effect,
      codeOnly,
      description: [entry.slotDef.description, ...notes].join(' '),
      inputSchema: { type: 'object', properties, required, additionalProperties: false },
    };
  }

  /** Tools exposed to agents on this profile. */
  async listTools(appId: string, profileName = 'default'): Promise<ToolDef[]> {
    const model = await this.model(appId);
    const profile = await this.profile(appId, profileName);
    return this.entries(model)
      .filter((entry) => this.isEnabled(entry, profile))
      .map((entry) => this.toolDef(entry));
  }

  /** Every bound tool with its on/off state, for the CLI and monitor. */
  async describeTools(appId: string, profileName = 'default'): Promise<ToolInfo[]> {
    const model = await this.model(appId);
    const profile = await this.profile(appId, profileName);
    return this.entries(model).map((entry) => ({
      ...this.toolDef(entry),
      enabled: this.isEnabled(entry, profile),
      confidence: entry.op.ratings.confidence,
    }));
  }

  async callTool(appId: string, profileName: string, tool: string, args: Record<string, Json> = {}): Promise<ToolResult> {
    const started = Date.now();
    let effect: Effect = 'unknown';
    let result: ToolResult;
    try {
      ({ effect, result } = await this.call(appId, profileName, tool, args));
    } catch (error) {
      result =
        error instanceof ToolFailure
          ? { ok: false, error: error.error }
          : fail('internal_error', error instanceof Error ? error.message : String(error));
    }
    const entry: AuditEntry = {
      at: new Date().toISOString(),
      profile: profileName,
      tool,
      effect,
      ok: result.ok,
      ...(result.error ? { error: result.error.code } : {}),
      ms: Date.now() - started,
    };
    await this.options.store.appendAudit(appId, entry).catch(() => {});
    this.options.events?.emit('call', { appId, ...entry } satisfies CallEvent);
    return result;
  }

  private async call(
    appId: string,
    profileName: string,
    tool: string,
    args: Record<string, Json>,
  ): Promise<{ effect: Effect; result: ToolResult }> {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { effect: 'unknown', result: fail('invalid_input', 'Arguments must be an object.') };
    }
    const model = await this.model(appId);
    const profile = await this.profile(appId, profileName);
    const entry = this.entries(model).find((e) => toolName(e.slotDef.name) === tool || e.slotDef.name === tool);
    if (!entry) return { effect: 'unknown', result: fail('unknown_tool', `No tool "${tool}" in "${appId}".`) };
    const { slotDef, binding, op, effect } = entry;

    if (!this.isEnabled(entry, profile)) {
      return { effect, result: fail('tool_disabled', `${slotDef.name} is switched off for profile "${profile.name}".`) };
    }
    const problem = validate(entry, args);
    if (problem) return { effect, result: problem };

    if (NEEDS_APPROVAL.includes(effect)) {
      const approved = this.options.approve
        ? await this.options.approve({ appId, profile: profile.name, tool: toolName(slotDef.name), slot: slotDef.name, effect, args })
        : false;
      if (!approved) {
        return {
          effect,
          result: fail('approval_required', `${slotDef.name} needs the user's confirmation, and it was not given.`),
        };
      }
    }

    const dedupeKey =
      typeof args.clientRequestId === 'string' && args.clientRequestId
        ? `${appId}|${slotDef.name}|${args.clientRequestId}`
        : undefined;
    const previous = dedupeKey ? this.dedupe.get(dedupeKey) : undefined;
    if (previous) return { effect, result: previous };

    const [adapterId, executorName] = op.execution.executor.split('/');
    const executor = this.options.adapters.find((a) => a.id === adapterId)?.executors?.[executorName];
    if (!executor) {
      return { effect, result: fail('stale_binding', `Executor ${op.execution.executor} is not installed.`) };
    }

    const opArgs = Object.fromEntries(Object.entries(args).filter(([field]) => !RUNTIME_FIELDS.has(field)));
    const input = mapRequest(binding, opArgs);
    const ctx: ExecContext = { request: this.requester(model.app.origin), log: this.options.log ?? silentLogger };
    const exec = await executor.run(ctx, op.execution.binding, input as unknown as Json);
    if (!exec.ok) {
      return { effect, result: { ok: false, error: exec.error ?? { code: 'upstream_error', message: 'The app returned an error.' } } };
    }
    const result: ToolResult = { ok: true, data: shapeResult(entry, exec.data ?? null, args, model.app.id) };
    if (dedupeKey) this.dedupe.set(dedupeKey, result);
    return { effect, result };
  }

  /** The only way adapters reach the network: own site only, credentials attached here, rate limits applied. */
  private requester(origin: string): (req: HttpRequest) => Promise<HttpResult> {
    const fetchImpl = this.options.fetch ?? fetch;
    const credentials = this.options.credentials ?? noCredentials;
    return async (req) => {
      if (!req.path.startsWith('/') || req.path.startsWith('//')) {
        throw new ToolFailure({ code: 'internal_error', message: "Adapters may only request paths on the app's own site." });
      }
      const url = new URL(req.path, origin);
      if (url.origin !== origin) {
        throw new ToolFailure({ code: 'internal_error', message: "Adapters may only request paths on the app's own site." });
      }
      for (const [key, value] of Object.entries(req.query ?? {})) url.searchParams.set(key, String(value));

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers ?? {})) {
        if (!CREDENTIAL_HEADERS.test(key)) headers[key.toLowerCase()] = value;
      }
      Object.assign(headers, await credentials.headersFor(origin));
      headers.accept ??= 'application/json';
      const method = req.method.toUpperCase();
      let body: string | undefined;
      if (req.body !== undefined && method !== 'GET' && method !== 'HEAD') {
        body = JSON.stringify(req.body);
        headers['content-type'] ??= 'application/json';
      }

      if (!(await this.limiter.acquire(origin))) {
        throw new ToolFailure({
          code: 'rate_limited',
          message: "This site's request budget is used up for now.",
          retryable: true,
          retryAfter: Math.max(1, Math.ceil(this.limiter.blockedFor(origin) / 1000)),
        });
      }

      let response: Response;
      try {
        response = await fetchImpl(url, { method, headers, body, redirect: 'manual' });
      } catch (error) {
        throw new ToolFailure({
          code: 'upstream_error',
          message: `Could not reach ${origin}: ${error instanceof Error ? error.message : String(error)}`,
          retryable: true,
        });
      }
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'));
        this.limiter.penalize(origin, (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30) * 1000);
      }
      const text = await response.text();
      let parsed: Json | string | null = text || null;
      if (text) {
        try {
          parsed = JSON.parse(text) as Json;
        } catch {
          // keep text
        }
      }
      return { status: response.status, headers: Object.fromEntries(response.headers), body: parsed };
    };
  }
}
