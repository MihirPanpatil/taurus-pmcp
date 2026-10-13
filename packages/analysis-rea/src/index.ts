// Optional analysis source backed by REA (https://github.com/morluto/rea, MIT), a local reverse-engineering tool.
// Taurus runs REA's CLI against the shell's own page over loopback CDP, then keeps only path templates, parameter
// names and page-declared tool metadata. REA is never required: if it isn't installed, compiling continues without it.
import { execFile } from 'node:child_process';
import type { Logger } from '@taurus/adapter-sdk';
import {
  endpointFromCode,
  untrustedText,
  type AnalysisFindings,
  type AnalysisSource,
  type AnalysisTarget,
  type CodeEndpoint,
  type DeclaredTool,
} from '@taurus/core';

export interface ReaSourceOptions {
  /** The REA command. Default: $TAURUS_REA_COMMAND, else `rea`. */
  command?: string;
  /** How long REA watches the page, per call. */
  observationMs?: number;
  timeoutMs?: number;
  /** Replaces process execution, for tests. */
  run?: (args: string[]) => Promise<string>;
}

// Strict argument formats: these go to a child process, and on Windows through cmd.exe.
const LOOPBACK_ENDPOINT = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
const TARGET_ID = /^[A-Za-z0-9]{8,64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/;
const METHOD_FROM_MECHANISM = /\.(get|post|put|patch|delete)$/i;
// REA also reports WebSocket URLs and Electron loadURL targets; neither is a REST call.
const NOT_REST = /(^call:WebSocket$|loadURL$)/;

interface ReaEvidence<T> {
  normalized_result?: T;
  limitations?: string[];
}

interface BundleResult {
  observations?: {
    endpoints?: { value?: unknown; mechanism?: unknown }[];
    webmcp_declarations?: { name?: unknown; description?: unknown; schema_property_names?: unknown }[];
  };
  limitations?: string[];
}

interface WebMcpResult {
  status?: string;
  tools?: {
    items?: {
      name?: unknown;
      description?: unknown;
      input_schema?: { properties?: Record<string, unknown> } | null;
      annotations?: { read_only?: boolean | null };
    }[];
  };
  limitations?: string[];
}

function assertArgs(target: AnalysisTarget): void {
  if (!LOOPBACK_ENDPOINT.test(target.cdpEndpoint)) throw new Error('REA may only attach to a loopback CDP endpoint on 127.0.0.1.');
  if (!TARGET_ID.test(target.targetId)) throw new Error('Unexpected CDP target id.');
  const origin = new URL(target.origin);
  if (origin.origin !== target.origin || !/^https?:$/.test(origin.protocol)) throw new Error('Unexpected origin.');
}

/** Converts REA's analyze-web-bundle and discover-webmcp-tools Evidence into Taurus findings. Exported for tests. */
export function toFindings(
  origin: string,
  bundle: ReaEvidence<BundleResult> | null,
  webmcp: ReaEvidence<WebMcpResult> | null,
  version?: string,
): AnalysisFindings {
  const endpoints = new Map<string, CodeEndpoint>();
  for (const found of bundle?.normalized_result?.observations?.endpoints ?? []) {
    if (typeof found.value !== 'string' || typeof found.mechanism !== 'string' || NOT_REST.test(found.mechanism)) continue;
    const endpoint = endpointFromCode(found.value, origin);
    if (!endpoint) continue;
    const method = METHOD_FROM_MECHANISM.exec(found.mechanism)?.[1]?.toUpperCase();
    const mechanism = untrustedText(found.mechanism, 80) ?? 'call';
    const key = `${method ?? '?'} ${endpoint.pathTemplate}`;
    if (!endpoints.has(key)) endpoints.set(key, { ...endpoint, ...(method ? { method } : {}), mechanism });
  }

  const tools = new Map<string, DeclaredTool>();
  for (const declared of bundle?.normalized_result?.observations?.webmcp_declarations ?? []) {
    const name = untrustedText(declared.name, 64);
    if (!name) continue;
    const props = Array.isArray(declared.schema_property_names) ? declared.schema_property_names : [];
    tools.set(`static:${name}`, {
      name,
      description: untrustedText(declared.description, 300),
      inputProperties: props.map((p) => untrustedText(p, 64)).filter((p): p is string => !!p),
      mechanism: 'webmcp-static',
      trust: 'page-declared-untrusted',
    });
  }
  for (const item of webmcp?.normalized_result?.tools?.items ?? []) {
    const name = untrustedText(item.name, 64);
    if (!name) continue;
    tools.set(`runtime:${name}`, {
      name,
      description: untrustedText(item.description, 300),
      inputProperties: Object.keys(item.input_schema?.properties ?? {})
        .map((p) => untrustedText(p, 64))
        .filter((p): p is string => !!p),
      ...(typeof item.annotations?.read_only === 'boolean' ? { readOnly: item.annotations.read_only } : {}),
      mechanism: 'webmcp-runtime',
      trust: 'page-declared-untrusted',
    });
  }

  const limitations = new Set<string>();
  for (const text of [...(bundle?.normalized_result?.limitations ?? []), ...(webmcp?.normalized_result?.limitations ?? [])]) {
    const cleaned = untrustedText(text, 300);
    if (cleaned) limitations.add(cleaned);
  }
  if (webmcp?.normalized_result?.status === 'unavailable') limitations.add('This browser build does not expose WebMCP to pages.');

  return {
    source: 'rea',
    ...(version ? { sourceVersion: version } : {}),
    at: new Date().toISOString(),
    endpoints: [...endpoints.values()].sort((a, b) => a.pathTemplate.localeCompare(b.pathTemplate)),
    declaredTools: [...tools.values()],
    limitations: [...limitations],
  };
}

export function reaSource(options: ReaSourceOptions = {}): AnalysisSource {
  const command = options.command ?? process.env.TAURUS_REA_COMMAND ?? 'rea';
  const timeout = options.timeoutMs ?? 90_000;
  const observationMs = String(options.observationMs ?? 1500);

  const run =
    options.run ??
    ((args: string[]) =>
      new Promise<string>((resolve, reject) => {
        // npm installs REA as a .cmd shim on Windows, which needs a shell; every argument is validated above.
        const windows = process.platform === 'win32';
        const file = windows && !/\.(cmd|bat|exe)$/i.test(command) ? `${command}.cmd` : command;
        execFile(file, args, { timeout, maxBuffer: 32 * 1024 * 1024, shell: windows, windowsHide: true }, (error, stdout, stderr) => {
          if (error) reject(new Error(`rea ${args[0]} failed: ${(stderr || error.message).trim().split('\n')[0]}`));
          else resolve(stdout);
        });
      }));

  const json = async <T>(args: string[]): Promise<ReaEvidence<T>> => JSON.parse(await run([...args, '--format', 'json'])) as ReaEvidence<T>;

  return {
    id: 'rea',

    async available() {
      try {
        const version = (await run(['--version'])).trim();
        return VERSION.test(version) ? { ok: true, version } : { ok: false, reason: `unexpected version output "${version.slice(0, 40)}"` };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },

    async analyze(target: AnalysisTarget, log: Logger) {
      assertArgs(target);
      const status = await this.available();
      if (!status.ok) throw new Error(`REA is not available: ${status.reason}`);
      const base = [target.cdpEndpoint, target.targetId, '--observation-ms', observationMs];
      // Source maps are not fetched: that is the only network request REA would make.
      const bundle = await json<BundleResult>(['analyze-web-bundle', ...base]);
      let webmcp: ReaEvidence<WebMcpResult> | null = null;
      try {
        webmcp = await json<WebMcpResult>(['discover-webmcp-tools', ...base]);
      } catch (error) {
        log.warn(`REA WebMCP discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return toFindings(target.origin, bundle, webmcp, status.version);
    },
  };
}
