# Taurus

**A local-first browser that compiles web apps into MCP servers.**

> **Status: walking skeleton.** The first end-to-end slice works on testing-ladder level 0: a fixture task app is captured in the Electron shell, compiled into a PMCP, verified with the `tasks` conformance suite and served over MCP. Everything else in these docs is still design, and every interface is a draft that will change.

Taurus explores a web app on your own device, works out what it can do, and compiles that into a **PMCP (Progressive MCP)**: a lightweight PWA paired with a dedicated MCP server that AI agents can connect to. When the site ships an update, Taurus notices and rebuilds the affected tools.

---

## Try the walking skeleton

Requires Node 22+ and pnpm 11.

```bash
pnpm install
pnpm build
pnpm fixture
```

The last command keeps running and serves the level 0 fixture at `http://127.0.0.1:4100`. In a second terminal:

```bash
pnpm taurus compile http://127.0.0.1:4100/ --app-id todo-fixture --exercise fixtures/todo-app/exercise.js
pnpm taurus tools todo-fixture
pnpm taurus serve
```

`compile` opens the app in its own Electron session, records its traffic as shapes (never values), compiles a PMCP, and runs the `tasks` conformance suite in a scratch project. Use `--record` instead of `--exercise` to click through the app yourself. `serve` exposes every PMCP at `http://127.0.0.1:7777/pmcp/<app-id>/<profile>/mcp`.

`serve` also prints a link to the **monitor**, a PWA at `http://127.0.0.1:7777/monitor/`. Open it to:
- approve or deny risky tool calls while the agent waits;
- switch tools on and off per profile, and see how many tokens their descriptions cost;
- watch calls as they happen, and re-run the checks;
- copy the endpoint, token or a ready-made `claude mcp add` command to connect an agent.

The monitor loads nothing from outside your machine, and its API needs the token from that link.

Run the checks:

```bash
pnpm test
pnpm e2e
```

`pnpm test` runs the unit and integration tests. `pnpm e2e` runs the whole flow through the real Electron shell and an MCP client.

### What works today

| Part | State |
|---|---|
| Electron shell with an isolated session per app, and network capture reduced to shapes | Working |
| `rest-observer` adapter, compiler, rule-based risk floors | Working |
| `tasks` binder (name-based) and conformance suite | Working, core tier plus `project.create` and `task.delete` |
| Runtime: profiles, validation, approvals, per-site rate limits, own-site-only requests, audit log | Working |
| MCP gateway: loopback only, bearer token per profile, browser origins rejected | Working |
| Monitor PWA: approvals, tool toggles with token costs, live calls, checks, agent connection | Working. Change feed, rate budgets and the connection ledger are not built yet. |
| Workflows, watches, LLM-assisted binding, other adapters | Not started |

### Repository layout

```
packages/adapter-sdk     Types for adapters (docs/ADAPTER_SPEC.md)
packages/core            Shape capture, compiler, app model, PMCP store, runtime, rate limits
packages/capabilities    Capability schemas, binders and conformance suites (tasks)
packages/gateway         MCP server over Streamable HTTP
packages/monitor         Monitor PWA and its API, served by the gateway
packages/shell           Electron shell: app sessions and network capture
packages/cli             The `taurus` command
adapters/rest-observer   Turns observed REST traffic into operations
fixtures/todo-app        Testing-ladder level 0 fixture
```

---

## Why

- **Most websites have no MCP server.** Agents fall back to driving a generic browser: screenshots, page dumps, guessing, retrying. It is slow, brittle, and burns tokens on every single run.
- **Per-site community MCP servers don't scale.** They are scattered across sources, tedious to install, and break whenever the site changes.
- **Extensions see a generic view.** They miss most of what an app can do, especially apps whose logic runs in the browser (editors, DAWs, design tools) rather than behind a public API.

Taurus moves discovery from **run time** to **compile time**. An agent gets a precompiled, typed toolkit instead of rediscovering the site on every task.

## How it works

```
 Your logged-in session on a web app
        │
        ▼
 Detect ─► Extract ─► Probe ─► Model ─► Classify ─► Bind ─► Emit ─► Verify
   │          │          │        │         │          │        │       │
 what is   adapters   test in   build    rate risk  map to   write   run
 it built  pull ops   a scratch the app  and trust  shared   the     checks
 with?     and state  space     model               slots    PMCP
        │
        ▼
 PMCP  =  tools + resources + skills + monitor PWA
        │
        ▼
 Agents: Claude Code, Claude Desktop, any MCP client, or Taurus workflows
```

Every step runs on your device. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Principles

1. **Compile locally; share parts, not maps.** Taurus never downloads or publishes a map of a specific website. The community shares *site-agnostic* parts (adapters, capability schemas, skills, workflows). Each user's browser compiles its own PMCPs, and the result never leaves their device.
2. **Stable capabilities, volatile bindings.** Tools are exposed through shared capability names (`daw.pattern.create`) that stay the same across site updates. Only the hidden binding underneath gets rebuilt.
3. **Private by design.** No telemetry and no data extraction. The only optional outside party is the LLM provider you choose, and you can replace it with a zero-data-retention provider or a local model.
4. **Lightweight.** A PMCP is data, not a running process. Idle PMCPs cost disk space only.
5. **Safe by default.** Risky tools start switched off, rate limits are always on, and destructive actions ask before they run.

## Concepts

| Term | Meaning |
|---|---|
| **PMCP** | Progressive MCP. One compiled web app: its tools, resources and skills, plus a monitor PWA. |
| **Adapter** | Community module that detects a framework or pattern (React, Redux, GraphQL, Web Audio, an undo stack...) and extracts what it exposes. Site-agnostic. |
| **Capability schema** | A shared vocabulary for a *kind* of app, e.g. a DAW or a kanban board, defining slots like `transport.play`. |
| **Skill** | Shared know-how written against capability slots, e.g. "build a drum pattern". Works on any app that fills those slots. |
| **App model** | The compiler's internal description of one app: entities, operations, flows, risk. Stored locally only. |
| **Binding** | How a tool is actually carried out on the current build of a site. Rebuilt when the site changes. |
| **Profile** | A named subset of enabled tools, served at its own MCP endpoint. |
| **Ratings** | Each tool carries three separate ratings: **risk** (what it does), **confidence** (whether it works) and **platform risk** (likelihood of breaking the site's rules). |

## Planned features

- **Site compiler** with incremental rebuilds triggered by site updates.
- **Monitor PWA** per app: tool health, change feed, approval queue, live call log, token savings and an outbound-connection ledger.
- **Tool toggles and profiles.** Switch tools or whole groups on and off. Each profile shows its token cost live.
- **Ratings with rule-based floors.** A small local classifier rates tools, but fixed rules set a minimum risk it can never go below.
- **Per-site rate limits** shared by agents and workflows. They honor `429` and `Retry-After` and support daily caps on risky actions.
- **Workflow editor** (n8n-style) where most steps cost zero tokens, plus "turn this agent run into a workflow".
- **Built-in agent runtime** with prompt caching, on-demand tool loading, reference-style results and per-task model routing.
- **Local model support** and a privacy router that keeps marked apps strictly on-device.
- **Future: headless mode.** PMCPs that run without the desktop UI, on hardware you control.

## Privacy

**Stays on your device:** sessions and cookies, recorded traffic, app models, compiled PMCPs, workflow runs, logs and usage statistics. Anything sensitive is encrypted with your operating system's key store.

**Can leave your device, only when you choose:**
- prompts sent to a cloud LLM provider (avoidable with a local model; reduced exposure with a zero-data-retention provider);
- downloads of community adapters, schemas and skills (which never carry your data);
- Taurus's own update checks.

The monitor's connection ledger lists every outbound connection Taurus makes, so you can check these claims yourself.

## Responsible use

> **Warning:** automating a website can violate its terms of service. Platforms may restrict, suspend or close accounts that use automation, even for actions you could perform by hand. Taurus warns you before you enable risky tools, but you are responsible for how you use it.

Taurus will:
- automate only what you can already do by hand in your own session;
- pause and hand you any CAPTCHA or verification step to complete yourself;
- enforce per-site rate limits by default;
- keep risky tools off until you explicitly enable them.

Taurus will not include, and the project will not accept:
- CAPTCHA solvers;
- bot-detection evasion, including fingerprint spoofing and fake "human-like" behavior meant to disguise automation;
- tools for accessing other people's accounts or data;
- published maps of specific third-party websites.

## Roadmap

| Phase | Goal |
|---|---|
| **0 · Design** | Agree on the architecture, adapter spec, testing ladder and first capability schema (`tasks`). |
| **1 · Compiler proof** *(now: level 0 walking skeleton done)* | Electron shell, adapter runtime, PMCP output and monitor. Pass levels 0–3 of the [testing ladder](docs/TESTING_LADDER.md), from tiny fixture apps up to self-hosted REST, Redux and GraphQL apps. Benchmark against a generic browser agent on tokens, speed, success rate and survival across version upgrades. |
| **2 · Workflows** | Workflow engine and editor, plus turning agent runs into workflows. Continue the ladder through level 4 (real-time and outward-facing apps). |
| **3 · Agent runtime** | Built-in harness, local models, privacy router and caching layer. Ladder levels 5–6 (canvas and heavy client apps). |
| **4 · Own engine** | A minimal-patch Chromium fork, only for what Electron cannot do. Ladder level 7 (live third-party betas such as a web DAW). |
| **5 · Headless** *(future)* | Run PMCPs without the desktop UI, on a home server or another always-on machine. See [Architecture, section 15](docs/ARCHITECTURE.md#15-future-headless-taurus). |

Testing happens progressively: each level of the [testing ladder](docs/TESTING_LADDER.md) adds one or two new hard problems, and complex apps like a web DAW come last.

## Contributing

| You can build | What it is | Spec |
|---|---|---|
| **Adapters** | Framework and pattern extractors | [docs/ADAPTER_SPEC.md](docs/ADAPTER_SPEC.md) |
| **Capability schemas** | Shared slot vocabularies for a kind of app | First drafts: [tasks](docs/capabilities/TASKS.md), [watch](docs/capabilities/WATCH.md) |
| **Skills** | Know-how written against capability slots | *planned* |
| **Workflows** | Shareable automations written against capability slots only | *planned* |
| **Core** | Shell, compiler, runtime, monitor | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| **Test targets** | Fixture apps, task sets and ladder results | [docs/TESTING_LADDER.md](docs/TESTING_LADDER.md) |
| **Use cases** | Viable scenarios, including third-party sites, and what's out of scope | [docs/USE_CASES.md](docs/USE_CASES.md) |

**One rule applies to every contribution:** it must be site-agnostic. Anything describing the private internals of a specific third-party website belongs only on the user's own machine, never in the public registry.

During the design stage, please open an issue to discuss changes to these documents.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
