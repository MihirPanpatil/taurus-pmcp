import type { Effect, JSONSchema, Logger, OperationCandidate } from '@taurus/adapter-sdk';
import { templatePath } from './paths.js';

/**
 * Optional analysis sources (ARCHITECTURE 3.4) look at an app's code from outside the adapter sandbox, e.g. a local
 * reverse-engineering tool attached over loopback CDP. They never replace traffic capture: what they find becomes
 * code-only candidates that stay off until the user switches them on.
 */
export interface AnalysisSource {
  id: string;
  /** Cheap check that the source is installed and runnable. */
  available(): Promise<{ ok: boolean; version?: string; reason?: string }>;
  /** Runs while the app's page is open in the shell. */
  analyze(target: AnalysisTarget, log: Logger): Promise<AnalysisFindings>;
}

export interface AnalysisTarget {
  origin: string;
  /** Loopback CDP endpoint, e.g. http://127.0.0.1:9222 */
  cdpEndpoint: string;
  targetId: string;
}

export interface CodeEndpoint {
  /** Known only when the call itself names it (e.g. axios.post). */
  method?: string;
  pathTemplate: string;
  pathParams: string[];
  /** Query parameter names only, never values. */
  queryParams: string[];
  /** How the source found it, e.g. "call:fetch". */
  mechanism: string;
}

/** A tool the page declares about itself (WebMCP). Names and descriptions are page-declared and untrusted. */
export interface DeclaredTool {
  name: string;
  description?: string;
  inputProperties: string[];
  readOnly?: boolean;
  mechanism: 'webmcp-static' | 'webmcp-runtime';
  trust: 'page-declared-untrusted';
}

/** What a source found, already reduced to templates and names. */
export interface AnalysisFindings {
  source: string;
  sourceVersion?: string;
  at: string;
  endpoints: CodeEndpoint[];
  declaredTools: DeclaredTool[];
  limitations: string[];
}

const SAFE_PATH = /^\/[A-Za-z0-9\-._~%/{}:@!$&'()*+,;=]*$/;

/**
 * Turns a URL-ish string found in code into a same-origin path template. Literal IDs and query values are dropped;
 * anything pointing at another origin is ignored.
 */
export function endpointFromCode(value: string, origin: string): Omit<CodeEndpoint, 'mechanism' | 'method'> | null {
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || !SAFE_PATH.test(url.pathname)) return null;
  const { template, params } = templatePath(url.pathname);
  return { pathTemplate: template, pathParams: params, queryParams: [...new Set(url.searchParams.keys())].sort() };
}

/** Strips control characters and caps length for page-declared text. */
export function untrustedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function effectFor(method: string | undefined): Effect {
  if (method === 'GET' || method === 'HEAD') return 'read';
  if (method === 'DELETE') return 'delete';
  // Unknown method: the call may send data, so never assume it only reads.
  return 'write';
}

/**
 * Code-only operation candidates for endpoints that traffic capture didn't already see.
 * `observed` holds "METHOD /template" keys of observed operations.
 */
export function candidatesFromFindings(findings: AnalysisFindings, observed: Set<string>): OperationCandidate[] {
  const observedPaths = new Set([...observed].map((key) => key.slice(key.indexOf(' ') + 1)));
  const out = new Map<string, OperationCandidate>();
  for (const endpoint of findings.endpoints) {
    const method = endpoint.method?.toUpperCase();
    const seen = method ? observed.has(`${method} ${endpoint.pathTemplate}`) : observedPaths.has(endpoint.pathTemplate);
    if (seen) continue;
    // fetch() and XHR calls don't name a method in the call itself; GET is fetch's default.
    const execMethod = method ?? 'GET';
    const key = `rest:${execMethod} ${endpoint.pathTemplate}`;
    if (out.has(key)) continue;
    const query: JSONSchema = {
      type: 'object',
      properties: Object.fromEntries(endpoint.queryParams.map((name) => [name, { type: 'string' }])),
      required: [],
    };
    out.set(key, {
      key,
      nameHint: `${execMethod} ${endpoint.pathTemplate}`,
      descriptionHint: `Found in the app's code by ${findings.source} (${endpoint.mechanism})${method ? '' : '; HTTP method not confirmed'}. Never seen working.`,
      input: {
        type: 'object',
        properties: {
          path: {
            type: 'object',
            properties: Object.fromEntries(endpoint.pathParams.map((name) => [name, { type: 'string' }])),
            required: endpoint.pathParams,
          },
          query,
        },
        required: ['path'],
      },
      effectHints: [effectFor(method)],
      execution: { mode: 'http', executor: 'rest-observer/request', binding: { method: execMethod, pathTemplate: endpoint.pathTemplate } },
      evidence: { seen: 'code-only' },
      sources: [{ kind: 'bundle', ref: `${findings.source}:${endpoint.mechanism}`, hash: '' }],
    });
  }
  return [...out.values()];
}
