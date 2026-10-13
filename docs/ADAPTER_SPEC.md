# Taurus Adapter Specification

> **Draft v0.1 (design stage).** This spec defines what an adapter is, what it may do, and how it plugs into the compiler. Expect breaking changes until v1.0.

An **adapter** is a site-agnostic module that recognizes a framework or pattern inside a web app and extracts what that app exposes through it. Examples are a Redux adapter that lists dispatchable actions, a GraphQL adapter that lists queries and mutations, a command-stack adapter that lists undoable commands, and a Web Audio adapter that maps the audio graph.

Adapters are the main community contribution to Taurus. They run inside the user's logged-in sessions, so this spec is as much about **limits** as about capabilities.

---

## 1. Principles

1. **Site-agnostic.** An adapter targets a framework or pattern, never a specific website. Nothing in the public registry may describe the private internals of a particular third-party site.
2. **Deterministic, no LLM.** Adapters do not call language models. Naming, grouping and ranking happen in the compiler core.
3. **Least privilege.** An adapter declares the permissions it needs, and the runtime grants nothing else.
4. **Shapes, not values.** Adapters report data *shapes* (schemas, types, counts), not the user's content.
5. **Hints, not verdicts.** Adapters suggest candidates and effects. The compiler decides what becomes a tool, and the classifier sets the ratings.

---

## 2. Package layout

```
my-adapter/
  taurus-adapter.json     manifest (required)
  dist/index.js           adapter module, runs in the isolated sandbox (required)
  dist/inject.js          page-world script (optional, requires page.inject)
  fixtures/               synthetic test apps (required for community level and above)
  README.md               what it detects, known limitations
  LICENSE
```

---

## 3. Manifest

```json
{
  "id": "redux-actions",
  "name": "Redux action catalog",
  "version": "0.1.0",
  "specVersion": "0.1",
  "description": "Detects Redux stores and lists the action types the app dispatches.",
  "license": "Apache-2.0",
  "entry": "dist/index.js",
  "inject": "dist/inject.js",
  "permissions": ["page.inject", "page.state.read", "page.dispatch"],
  "provides": {
    "executors": ["dispatch"],
    "resources": true
  },
  "capabilityHints": [],
  "fixtures": ["fixtures/todo-app"]
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | Yes | Lowercase, `a-z0-9-`, unique in the registry |
| `version` | Yes | Semver |
| `specVersion` | Yes | The adapter spec version this adapter targets |
| `entry` | Yes | Sandbox module (section 5) |
| `inject` | No | Script that runs in the page before the page's own scripts (section 6). Requires `page.inject`. |
| `permissions` | Yes | See section 4. Can be an empty list. |
| `provides.executors` | No | Executor names, referenced in bindings as `<id>/<name>` |
| `capabilityHints` | No | Capability schema IDs the adapter's output often maps to, e.g. `["tasks"]`. Only a hint. |
| `fixtures` | Conditional | Required for the `community` and `verified` levels |

The **trust level is never declared in the manifest.** The registry assigns it (section 10).

---

## 4. Permissions

| Permission | Grants | Risk |
|---|---|---|
| `bundle.read` | Read the site's JavaScript files and source maps when served | Low |
| `dom.read` | Read the DOM and accessibility tree from the isolated world | Low |
| `network.observe` | Read request and response **metadata and shapes** for the app's own site | Medium |
| `storage.read` | Read IndexedDB, Cache Storage and localStorage **shapes** for the app's own site | Medium |
| `page.state.read` | Read framework state through the injected script | Medium |
| `page.inject` | Run `inject.js` in the page's main world before page scripts | **High** |
| `page.dispatch` | Call the app's own commands or actions through the injected script | **High** |
| `network.replay` | Provide `http` executors (the runtime sends the requests and attaches credentials) | **High** |
| `canvas.capture` | Capture screenshots of the app for `vision` executors | **High** |

**Never available to any adapter:**
- reading cookies, auth headers, tokens or passwords (the runtime attaches credentials itself);
- network requests to any host other than the app's own site, including through `fetch`, `XMLHttpRequest`, WebSocket or image beacons;
- access to other app profiles, the file system, the clipboard, or OS APIs;
- calling LLMs or any Taurus internals outside the context APIs below;
- persistent storage outside the key-value store the runtime provides.

---

## 5. Adapter interface (sandbox module)

The sandbox module runs in an isolated JavaScript context with **no network access and no DOM globals.** Everything goes through the context objects, and each API exists only if its permission was granted.

```ts
// @taurus/adapter-sdk — draft v0.1

export interface Adapter {
  /** Cheap check for the framework or pattern. Must not change the page. */
  detect(ctx: DetectContext): Promise<Detection | null>;

  /** Return candidates. Must be deterministic for the same page state. */
  extract(ctx: ExtractContext, detection: Detection): Promise<Contribution>;

  /** Optional: confirm a candidate's effect in the scratch environment. */
  probe?(ctx: ProbeContext, op: OperationCandidate): Promise<ProbeResult>;

  /** Optional: fingerprints of the sources read, used for incremental rebuilds. */
  fingerprint?(ctx: DetectContext): Promise<SourceRef[]>;

  /** Executors referenced by bindings as "<adapterId>/<name>". */
  executors?: Record<string, Executor>;
}

export interface Detection {
  framework: string;          // e.g. "redux"
  version?: string;
  confidence: number;         // 0–1
  details?: Json;             // passed back to extract()
}
```

### 5.1 Contexts

```ts
interface DetectContext {
  origin: string;
  bundles?: BundleReader;     // bundle.read
  dom?: DomReader;            // dom.read
  network?: NetworkLog;       // network.observe
  storage?: StorageReader;    // storage.read
  page?: PageChannel;         // page.inject: talks to inject.js
  kv: KeyValueStore;          // small, per-adapter, per-app, encrypted
  log: Logger;
}

interface ExtractContext extends DetectContext {}

interface ProbeContext extends DetectContext {
  scratch: ScratchEnv;        // only available while a scratch environment exists
}

interface BundleReader {
  list(): Promise<{ url: string; hash: string; size: number }[]>;
  read(url: string): Promise<string>;
  sourceMap(url: string): Promise<Json | null>;
}

interface NetworkLog {
  /** Requests to the app's own site. Bodies are reduced to inferred JSON schemas. */
  entries(filter?: { method?: string; pathPrefix?: string }): Promise<NetworkShape[]>;
}

interface PageChannel {
  /** Calls a handler registered by inject.js. Responses are UNTRUSTED (section 6.2). */
  call<T = Json>(method: string, params?: Json): Promise<T>;
}

interface ScratchEnv {
  id: string;
  /** Snapshot of the state shape before and after an action, used to describe effects. */
  diff<T>(action: () => Promise<T>): Promise<{ result: T; changes: StateChange[] }>;
}
```

### 5.2 Contribution

```ts
interface Contribution {
  entities: EntityCandidate[];
  operations: OperationCandidate[];
  resources: ResourceCandidate[];
  flows: FlowCandidate[];
}

interface OperationCandidate {
  key: string;                // stable within the adapter, e.g. "redux:patterns/added"
  nameHint: string;           // the raw name as found
  descriptionHint?: string;   // e.g. a menu or shortcut label
  input: JSONSchema;
  output?: JSONSchema;
  effectHints: Effect[];      // can only RAISE the risk the rules assign
  execution: ExecutionSpec;
  evidence: Evidence;
  sources: SourceRef[];
}

type Effect = 'read' | 'write' | 'delete' | 'send' | 'account' | 'payment' | 'unknown';

interface ExecutionSpec {
  mode: 'http' | 'page' | 'vision';
  executor: string;           // "<adapterId>/<executorName>"
  binding: Json;              // data the executor needs; must contain no secrets
}

interface Evidence {
  seen: 'observed' | 'code-only';
  observations?: number;
}

interface SourceRef {
  kind: 'bundle' | 'endpoint' | 'state' | 'dom';
  ref: string;                // e.g. "chunk-4812.js#m31"
  hash: string;
}
```

`EntityCandidate`, `ResourceCandidate` and `FlowCandidate` follow the same pattern and will be specified in v0.2.

### 5.3 Executors

```ts
interface Executor {
  mode: 'http' | 'page' | 'vision';
  run(ctx: ExecContext, binding: Json, input: Json): Promise<ExecResult>;
}

interface ExecContext {
  /** http mode: the runtime sends the request, attaches credentials, enforces site and rate limits. */
  request?(req: { method: string; path: string; query?: Json; body?: Json; headers?: Record<string, string> }): Promise<HttpResult>;
  /** page mode */
  page?: PageChannel;
  log: Logger;
}

interface ExecResult {
  ok: boolean;
  data?: Json;                // compact; use references for large data
  error?: { code: string; message: string; retryable?: boolean };
}
```

- `request()` accepts **paths on the app's own site only.** `Cookie`, `Authorization` and other credential headers set by the adapter are removed.
- Executors do not handle rate limits, approvals or retries. The runtime does that before and after `run()`.

---

## 6. Page-world scripts (`inject.js`)

Some frameworks can only be observed from the page's own JavaScript context, before the page's scripts run (for example the devtools hooks of React and Redux). `inject.js` covers that case.

### 6.1 Format

```js
// inject.js runs in the page's main world, before any page script.
// The runtime calls the default export once, with a private channel object.
export default function inject(taurus) {
  // taurus.handle(method, fn): register a handler the sandbox can call
  // taurus.emit(event, data): push an event to the sandbox
  // No other Taurus API is available here.
}
```

The `taurus` object is passed in privately, so page scripts cannot obtain it from a global.

### 6.2 Rules

- **Everything coming from the page world is untrusted.** The page can read and tamper with anything in its own context, including your hooks. The sandbox module must validate every response from `page.call()`.
- **Keep it minimal.** Hook, record shapes, and dispatch on request. No analysis logic.
- **Don't break the app.** Wrap hooks so that failures fall back to the original behavior. Never throw into page code.
- **Report shapes, not values** (section 1, principle 4).
- **No network access, no new globals** beyond what the hooked framework itself expects.

---

## 7. Example: Redux action catalog (illustrative)

Simplified to show the shape of an adapter. A real adapter needs more robust detection and schema inference.

**`inject.js`**

```js
export default function inject(taurus) {
  const catalog = new Map();          // action type -> { count, shape }
  let store = null;

  const shapeOf = (v) =>
    v === null ? { type: 'null' }
    : Array.isArray(v) ? { type: 'array', items: v.length ? shapeOf(v[0]) : {} }
    : typeof v === 'object'
      ? { type: 'object', properties: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x)])) }
      : { type: typeof v };            // shapes only, never values

  // Innermost enhancer: wraps the base store, so it sees every action reducers receive.
  const enhancer = (createStore) => (...args) => {
    store = createStore(...args);
    const dispatch = store.dispatch;
    store.dispatch = (action) => {
      try {
        if (action && typeof action.type === 'string') {
          const entry = catalog.get(action.type) ?? { count: 0, shape: shapeOf(action.payload ?? null) };
          entry.count += 1;
          catalog.set(action.type, entry);
        }
      } catch { /* never break the app */ }
      return dispatch(action);
    };
    return store;
  };

  const compose = (...fns) => (x) => fns.reduceRight((acc, f) => f(acc), x);

  // Many apps look for this hook when composing their store enhancers.
  window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__ = (...args) =>
    args.length === 1 && typeof args[0] === 'object'
      ? (...enhancers) => compose(...enhancers, enhancer)
      : compose(...args, enhancer);

  taurus.handle('redux.status', () => ({ storeFound: store !== null }));
  taurus.handle('redux.catalog', () =>
    [...catalog].map(([type, e]) => ({ type, count: e.count, payloadSchema: e.shape })));
  taurus.handle('redux.stateShape', () => (store ? shapeOf(store.getState()) : null));
  // Plain actions only: dispatching on the base store skips middleware such as thunks.
  taurus.handle('redux.dispatch', ({ type, payload }) => {
    if (!store) throw new Error('no store');
    store.dispatch({ type, payload });
    return { ok: true };
  });
}
```

**`index.js`**

```ts
import { defineAdapter } from '@taurus/adapter-sdk';

export default defineAdapter({
  async detect(ctx) {
    const status = await ctx.page!.call<{ storeFound: boolean }>('redux.status');
    return status?.storeFound === true ? { framework: 'redux', confidence: 0.9 } : null;
  },

  async extract(ctx) {
    const catalog = await ctx.page!.call<{ type: string; count: number; payloadSchema: JSONSchema }[]>('redux.catalog');
    const valid = Array.isArray(catalog) ? catalog.filter((a) => typeof a?.type === 'string') : [];

    return {
      entities: [],
      flows: [],
      resources: [{ key: 'redux:state', schemaFrom: 'redux.stateShape' }],
      operations: valid.map((a) => ({
        key: `redux:${a.type}`,
        nameHint: a.type,
        input: a.payloadSchema ?? {},
        effectHints: ['write'],              // every action changes state; the compiler filters UI noise
        execution: { mode: 'page', executor: 'redux-actions/dispatch', binding: { type: a.type } },
        evidence: { seen: 'observed', observations: a.count },
        sources: [{ kind: 'state', ref: `redux:${a.type}`, hash: '' }],
      })),
    };
  },

  executors: {
    dispatch: {
      mode: 'page',
      async run(ctx, binding, input) {
        const res = await ctx.page!.call('redux.dispatch', { type: (binding as any).type, payload: input });
        return { ok: (res as any)?.ok === true };
      },
    },
  },
});
```

**Known limitations, to list in the adapter's README:** apps that switch off devtools hooks in production are not detected; thunk and other middleware-only actions are not dispatchable.

---

## 8. Testing

- **Fixtures must be synthetic.** Use small apps you wrote yourself, such as a todo app built with the target framework. Never use captured third-party sites, recordings or user data.
- **A planned conformance suite** checks every adapter for:
  - deterministic output (two runs on the same fixture state produce identical contributions);
  - no network attempts outside the fixture's own site;
  - no values in reported shapes (seeded sentinel strings must not appear in the output);
  - `detect()` leaves the page unchanged;
  - an app that breaks on purpose inside an `inject.js` hook keeps working.

---

## 9. Versioning

- Adapters use semver. Any change to `key` values counts as **breaking**, because the compiler uses keys to link a tool's history across rebuilds.
- `specVersion` follows this document. Before v1.0, minor versions may break compatibility.
- The runtime refuses adapters whose `specVersion` it does not support, and says so in the monitor.

---

## 10. Trust levels and review

| Level | Requirements | Default for users |
|---|---|---|
| `experimental` | Signed by the author; manifest valid | Off; installing shows a warning |
| `community` | Passes the conformance suite; has fixtures; public source; signed release | On after the user approves its permissions |
| `verified` | Reviewed by maintainers; reproducible build; review repeated on any permission change | On after the user approves its permissions |

- **Any change to permissions requires the user's approval again**, at every level.
- Releases must be built from public source. Minified or obfuscated code without source is rejected.
- Maintainers can revoke a release. The runtime disables revoked releases and tells the user why.

**Review checklist for maintainers:** permissions are the minimum needed · no attempts to reach other hosts · values never leave the page world · `inject.js` is minimal and fails safely · effect hints are honest · no site-specific constants that identify a particular third-party site.

---

## 11. Prohibited

Adapters must not, and the registry will not accept adapters that:

- solve CAPTCHAs or other verification challenges;
- evade bot detection, including fingerprint spoofing or fake human-like input designed to disguise automation;
- read or move credentials, or act on accounts other than the user's own session;
- send data anywhere outside the app's own site;
- contain maps, endpoint lists or other private internals of a specific third-party website;
- lower risk ratings, hide operations from the monitor, or bypass approvals.

---

## 12. Related contribution types (specs planned)

- **Capability schemas:** slot definitions (name, input and output schema, minimum effect class) for a kind of app. Adapters may hint at a schema, but the compiler does the binding.
- **Skills:** know-how that declares the capability slots it requires and is activated only when a PMCP fills them.
- **Workflows:** shareable only when every step refers to a capability slot.
