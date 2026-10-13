import { timingSafeEqual } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Adapter, Json } from '@taurus/adapter-sdk';
import { verifyApp } from '@taurus/capabilities';
import { NEEDS_APPROVAL, type ApprovalBroker, type ApprovalEvent, type CallEvent, type PmcpStore, type Runtime, type ToolDef } from '@taurus/core';
import type { GatewayExtension } from '@taurus/gateway';

export interface MonitorOptions {
  store: PmcpStore;
  runtime: Runtime;
  broker: ApprovalBroker;
  /** The same emitter passed to the runtime as `events`. */
  events: EventEmitter;
  /** Adapters for re-running checks. */
  adapters: Adapter[];
  /** Required in the `x-taurus-monitor` header on every API request. */
  token: string;
}

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const STATIC: Record<string, [file: string, type: string]> = {
  '': ['index.html', 'text/html; charset=utf-8'],
  'index.html': ['index.html', 'text/html; charset=utf-8'],
  'app.js': ['app.js', 'text/javascript; charset=utf-8'],
  'style.css': ['style.css', 'text/css; charset=utf-8'],
  'sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  'icon.svg': ['icon.svg', 'image/svg+xml'],
  'manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
};
// The monitor never loads anything from outside this machine.
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};
const MAX_BODY = 64 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, Json>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'too_large', 'Request body is too large.');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, Json>;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'invalid_json', 'Send a JSON object.');
}

function sameToken(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Rough size of a tool definition in a model's context: about four characters per token. */
export function estimateTokens(tool: Pick<ToolDef, 'name' | 'description' | 'inputSchema'>): number {
  return Math.ceil(JSON.stringify({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }).length / 4);
}

/** The monitor PWA and its API, mounted on the gateway at /monitor/. */
export function createMonitor(options: MonitorOptions): GatewayExtension {
  const { store, runtime, broker, events, adapters, token } = options;

  async function appSummary(appId: string) {
    const model = await runtime.model(appId);
    const latest = model.verification?.[model.verification.length - 1];
    return {
      appId,
      origin: model.app.origin,
      build: model.app.build.fingerprint,
      compiledAt: model.app.build.detectedAt,
      checks: latest ? { passed: latest.passed, failed: latest.failed, skipped: latest.skipped, at: latest.at } : null,
      pendingApprovals: broker.list().filter((a) => a.appId === appId).length,
    };
  }

  async function appDetail(appId: string, profile: string, ownOrigin: string) {
    const model = await runtime.model(appId);
    const profiles = (await store.getProfiles(appId)).map((p) => p.name);
    if (!profiles.includes(profile)) throw new HttpError(404, 'not_found', `No profile "${profile}".`);
    const tools = (await runtime.describeTools(appId, profile)).map((tool) => ({
      name: tool.name,
      slot: tool.slot,
      schema: tool.schema,
      tier: tool.tier,
      effect: tool.effect,
      enabled: tool.enabled,
      confidence: tool.confidence,
      description: tool.description,
      tokens: estimateTokens(tool),
      needsApproval: NEEDS_APPROVAL.includes(tool.effect),
    }));
    return {
      ...(await appSummary(appId)),
      frameworks: model.app.frameworks,
      operations: model.operations.length,
      profile,
      profiles,
      tools,
      enabledTokens: tools.filter((t) => t.enabled).reduce((sum, t) => sum + t.tokens, 0),
      checks: model.verification ?? [],
      endpoint: `${ownOrigin}/pmcp/${appId}/${profile}/mcp`,
    };
  }

  async function requireApp(appId: string): Promise<void> {
    if (!(await store.listApps()).includes(appId)) throw new HttpError(404, 'not_found', `No app "${appId}".`);
  }

  function streamEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', ...SECURITY_HEADERS });
    const write = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    write('hello', { at: new Date().toISOString() });
    const onApproval = (event: ApprovalEvent) => write('approval', event);
    const onCall = (event: CallEvent) => write('call', event);
    broker.on('approval', onApproval);
    events.on('call', onCall);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      broker.off('approval', onApproval);
      events.off('call', onCall);
    });
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL, path: string, ownOrigin: string): Promise<void> {
    const method = req.method ?? 'GET';
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    const profile = url.searchParams.get('profile') ?? 'default';

    if (parts[0] === 'events' && method === 'GET') return streamEvents(req, res);

    if (parts[0] === 'approvals') {
      if (parts.length === 1 && method === 'GET') return send(res, 200, { approvals: broker.list() });
      if (parts.length === 2 && method === 'POST') {
        const body = await readBody(req);
        if (typeof body.approved !== 'boolean') throw new HttpError(400, 'invalid_input', '"approved" must be true or false.');
        if (!broker.decide(parts[1], body.approved)) throw new HttpError(410, 'expired', 'This request has already expired or been decided.');
        return send(res, 200, { ok: true });
      }
    }

    if (parts[0] === 'apps') {
      if (parts.length === 1 && method === 'GET') {
        const apps = await Promise.all((await store.listApps()).map(appSummary));
        return send(res, 200, { apps });
      }
      const appId = parts[1];
      await requireApp(appId);
      if (parts.length === 2 && method === 'GET') return send(res, 200, await appDetail(appId, profile, ownOrigin));

      if (parts[2] === 'tools' && parts.length === 3 && method === 'POST') {
        const body = await readBody(req);
        const { slot, enabled } = body;
        const profileName = typeof body.profile === 'string' ? body.profile : 'default';
        if (typeof slot !== 'string' || typeof enabled !== 'boolean') {
          throw new HttpError(400, 'invalid_input', 'Send { slot, enabled, profile }.');
        }
        const tool = (await runtime.describeTools(appId, profileName)).find((t) => t.slot === slot);
        if (!tool) throw new HttpError(404, 'not_found', `No tool "${slot}".`);
        if (enabled && NEEDS_APPROVAL.includes(tool.effect) && body.acknowledged !== true) {
          throw new HttpError(409, 'acknowledgement_required', 'Confirm the warning before switching on a risky tool.');
        }
        await store.setSlotEnabled(appId, profileName, slot, enabled);
        return send(res, 200, await appDetail(appId, profileName, ownOrigin));
      }

      if (parts[2] === 'calls' && method === 'GET') {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
        return send(res, 200, { calls: await store.readAudit(appId, limit) });
      }

      if (parts[2] === 'connection' && method === 'GET') {
        const target = (await store.getProfiles(appId)).find((p) => p.name === profile);
        if (!target) throw new HttpError(404, 'not_found', `No profile "${profile}".`);
        return send(res, 200, { endpoint: `${ownOrigin}/pmcp/${appId}/${profile}/mcp`, token: target.token });
      }

      if (parts[2] === 'verify' && method === 'POST') {
        await verifyApp(appId, { store, adapters });
        runtime.invalidate(appId);
        return send(res, 200, await appDetail(appId, profile, ownOrigin));
      }
    }

    throw new HttpError(404, 'not_found', 'No such monitor API route.');
  }

  async function serveStatic(path: string, res: ServerResponse): Promise<boolean> {
    const entry = STATIC[path];
    if (!entry) return false;
    const content = await readFile(join(PUBLIC, entry[0]));
    res.writeHead(200, { 'content-type': entry[1], ...SECURITY_HEADERS }).end(content);
    return true;
  }

  return async (req, res, url, ownOrigin) => {
    if (url.pathname === '/monitor') {
      res.writeHead(308, { location: '/monitor/' }).end();
      return true;
    }
    if (!url.pathname.startsWith('/monitor/')) return false;
    const path = url.pathname.slice('/monitor/'.length);

    try {
      if (!path.startsWith('api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Use GET.');
        if (!(await serveStatic(path, res))) throw new HttpError(404, 'not_found', 'Not found.');
        return true;
      }
      // Same-origin pages only, and the monitor token on every call. Approvals are too powerful for anything less.
      const origin = req.headers.origin;
      if (origin && origin !== ownOrigin) throw new HttpError(403, 'forbidden_origin', 'Requests from other sites are blocked.');
      if (!sameToken(req.headers['x-taurus-monitor'], token)) throw new HttpError(401, 'unauthorized', 'Open the monitor link printed by `taurus serve`.');
      await api(req, res, url, path.slice('api/'.length), ownOrigin);
    } catch (error) {
      if (res.headersSent) {
        res.end();
      } else if (error instanceof HttpError) {
        send(res, error.status, { error: error.code, message: error.message });
      } else {
        send(res, 500, { error: 'internal_error', message: error instanceof Error ? error.message : String(error) });
      }
    }
    return true;
  };
}
