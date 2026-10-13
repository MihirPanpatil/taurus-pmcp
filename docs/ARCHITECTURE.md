# Taurus Architecture

> **Draft v0.1 (design stage).** Nothing here is implemented yet. Sections marked **Open question** still need a decision.

This document describes how Taurus turns a web app into a **PMCP (Progressive MCP)** on the user's device, keeps it working as the site changes, and serves it to agents safely and cheaply.

---

## 1. System overview

```
┌──────────────────────────── Taurus (one desktop app) ─────────────────────────────┐
│                                                                                   │
│  Shell ── app profiles (isolated sessions) ── renderer pool (hidden pages)        │
│    │                                                                              │
│    ├── Adapter runtime (sandboxed community adapters)                             │
│    ├── Compiler  detect → extract → probe → model → classify → bind → emit → verify│
│    ├── PMCP store (app models, bindings, tests, profiles, encrypted logs)         │
│    ├── Runtime   MCP gateway · executors · rate limiter · approvals · audit log   │
│    ├── Workflow engine                                                            │
│    ├── Agent runtime (optional: caching, tool search, model routing, budgets)     │
│    ├── Privacy router + connection ledger                                         │
│    └── Monitor PWA (served locally)                                               │
│                                                                                   │
└───────────────┬──────────────────────────────────────────────┬────────────────────┘
                │ MCP over HTTP on 127.0.0.1                    │ LLM calls, routed
                ▼                                               ▼
     External agents (any MCP client)              Local model / ZDR / cloud provider
```

**Design rules that run through every section:**

1. Site-specific knowledge is produced locally and never leaves the device.
2. The tool interface (capability slots) is stable. Bindings are disposable.
3. Idle things cost nothing. Only tools that are actively used hold memory.
4. Fixed rules set the safety floor. Models can only make things stricter.

---

## 2. Shell

**v0 runs on Electron.** It ships fastest and gives enough control. A minimal-patch Chromium fork comes later, and only for capabilities Electron cannot provide (Roadmap phase 4).

| Need | v0 mechanism |
|---|---|
| Isolated session per app | One persistent session partition per app profile (`persist:<app-id>`) |
| Code that runs before the page's own scripts | Preload scripts and `Page.addScriptToEvaluateOnNewDocument` (Chrome DevTools Protocol) |
| Adapter code kept apart from page code | Isolated worlds (`Page.createIsolatedWorld`), context isolation |
| Background pages at full speed | Hidden windows with `backgroundThrottling: false` |
| Network observation without a debugger banner | DevTools protocol `Network` domain driven by the main process |
| Credentialed requests without exposing cookies | `session.fetch()` on the app's partition, called only by the runtime |
| Secret storage | `safeStorage`, which uses the OS key store (DPAPI, Keychain, libsecret) |

**Security patching is a release requirement.** Taurus tracks Electron security releases promptly, because a privacy-focused browser on an outdated engine contradicts its own purpose.

---

## 3. The compiler

The compiler turns *(this user's session, this build of the site)* into an **app model**, then into a PMCP.

```
Detect ──► Extract ──► Probe ──► Model ──► Classify ──► Bind ──► Emit ──► Verify
```

| Stage | What happens | LLM? |
|---|---|---|
| **Detect** | Each installed adapter checks cheaply whether its framework or pattern is present (React, Redux, Apollo/GraphQL, tRPC, a command or undo stack, Web Audio, WASM, canvas UI...). | No |
| **Extract** | Matching adapters return candidate entities, operations, resources and flows, together with their evidence and source fingerprints. | No |
| **Probe** | Candidates that change data are tested in a **scratch environment** (see 3.2). Requests that would change real data are captured and blocked. | No |
| **Model** | Candidates are merged, de-duplicated and ranked into one app model. UI noise (hover state, analytics events) is filtered out. | Yes, small |
| **Classify** | Each operation gets its risk, confidence and platform-risk ratings (section 7). | Rules + small local model |
| **Bind** | Operations are matched to capability slots from installed capability schemas. Anything unmatched stays an app-local tool. | Yes, small |
| **Emit** | Writes the PMCP bundle: tool definitions, bindings, resources, skills and tests. | Yes, for naming and descriptions |
| **Verify** | Runs generated tests in the scratch environment and records pass/fail per tool. | No |

**Adapters never call LLMs.** All model use happens in the compiler core. This keeps adapters deterministic and cheap, and stops community code from sending page data anywhere.

### 3.1 App model (internal format)

Illustrative only; the format is not final.

```yaml
app:
  id: example-tasks
  origin: https://tasks.example
  build:
    fingerprint: "sha256:9f2c…"       # hash of the site's main code files
    detectedAt: 2026-10-13T10:00:00Z
  frameworks: [react, redux, rest]

entities:
  - name: Task
    idField: id
    schema: { $ref: "#/schemas/Task" }

operations:
  - id: op.task.create
    capability: tasks.task.create       # bound slot (optional)
    input:  { $ref: "#/schemas/TaskCreateInput" }
    output: { $ref: "#/schemas/TaskRef" }
    execution:
      mode: http                        # http | page | vision
      executor: rest/request
      binding: { method: POST, path: "/api/projects/{projectId}/tasks" }
    ratings: { risk: write, confidence: 0.93, platformRisk: low }
    evidence: { seen: observed, probed: true, tests: { passed: 3, failed: 0 } }
    sources: ["bundle:chunk-4812#m31"]  # for incremental rebuilds

resources:
  - uri: "app://tasks"
    from: redux-state/tasks

flows:
  - id: flow.close-task
    steps: [op.task.update, op.comment.create]
```

### 3.2 Safe exploration

The compiler must not damage the user's real data while it learns.

- **Scratch environment.** It creates its own throwaway workspace, such as a new empty project, a draft or a sandbox board, and runs probes only there. Undo-based commands are run and then undone.
- **Dry-run mode.** When no scratch environment can be created, requests that would change data are captured, recorded and **blocked** before they reach the server.
- **No probing of irreversible or outward-facing actions.** Payments, sending messages, deleting accounts and similar actions are modeled from evidence only, never executed during compiling. They are marked `confidence: code-only`.
- **Shapes, not values.** Recorded traffic and state are reduced to data shapes. User content is not kept in the app model.

### 3.3 Coverage limits

Features behind other plans, roles or feature flags may never appear in one user's session. Adapters that read the site's code can still surface them as `seen: code-only`. They are shown in the monitor as untested and stay disabled by default.

---

## 4. PMCP bundle

```
<taurus-data>/pmcp/<app-id>/
  manifest.json          app id, origin, active build, spec versions
  models/<build>.json    app model per build (the last few are kept for rollback)
  bindings/              generated binding data
  tests/                 verification scripts for the scratch environment
  skills/                installed skills that bind to this app's slots
  profiles.json          enabled tools, profiles, approval settings
  ratelimits.json        per-site budgets and caps
  audit.log              encrypted call log
```

A PMCP is **data**. Nothing runs until a tool is called.

---

## 5. Runtime

### 5.1 MCP gateway

- **One process** serves every PMCP and loads each one only when it is first called.
- **One endpoint per profile:** `http://127.0.0.1:<port>/pmcp/<app-id>/<profile>/mcp` (Streamable HTTP).
- **Each profile has its own bearer token**, generated locally and shown once in the monitor.
- **Requests carrying a browser `Origin` header are rejected** unless the user allowlists that origin. This blocks websites from reaching the gateway through DNS rebinding or cross-site requests.
- **Binds to the loopback interface only.** Remote access, if it is ever added, needs explicit pairing and end-to-end encryption.
- **Optional meta-tools** (`taurus_search_tools`, `taurus_load_toolset`) let an agent load tools on demand instead of receiving every definition.

### 5.2 Execution modes

| Mode | How it runs | Cost | Notes |
|---|---|---|---|
| `http` | The runtime sends the request through the app's session. Credentials are attached by the runtime, never by adapters. | Very small, no page needed | Preferred whenever the site allows it |
| `page` | Runs inside a hidden page for the app, through the adapter's executor and an isolated channel. | Hundreds of MB while loaded | Required for client-side apps and request signing done in the page |
| `vision` | Screenshot + model + input events on a canvas UI. | High in tokens and time | Last resort. Always rated low-confidence. |

### 5.3 Renderer pool

- Pages are created on the first `page`-mode call and closed after an idle timeout.
- Least-recently-used pages are closed first when the user-set memory budget is reached.
- Apps used by active or scheduled workflows can be pinned "warm".
- When a page is needed again, it reloads and restores the app's session.

### 5.4 Calling a tool

```
agent call
  → profile check (is this tool enabled?)
  → rate limiter (per-site budget, daily caps)
  → approval (if the risk rating or the user's settings require it)
  → executor (http | page | vision)
  → result shaping (compact JSON, references for large data)
  → audit log + monitor event
```

---

## 6. Keeping up with site updates

### 6.1 Triggers

| Signal | Source |
|---|---|
| New service worker build (`updatefound`) | The site's own PWA update mechanism |
| Main code files have a new hash | Checked when the page loads |
| A response no longer matches its expected shape | Runtime validation |
| A scheduled verification test fails | Verify stage, run on a schedule |
| Tool error rate rises | Runtime statistics |

### 6.2 Incremental rebuild

1. Compare the new build's code modules with the last build, using the `sources` fingerprints.
2. Re-run Extract and Probe only for operations whose sources changed, plus any new modules.
3. Keep the **capability slot and tool interface** unchanged and replace only the binding.
4. Run Verify. Tools that pass are switched over. Tools that fail fall back to the last working binding if it still passes, and are marked broken otherwise.
5. Newly discovered tools go to the **approval queue**. They are never enabled automatically.
6. Rebuilds run in the background, ideally before the user's next agent session, and are throttled. The user can restrict them to idle time or to when the computer is plugged in.

---

## 7. Trust and safety

### 7.1 Three separate ratings

| Rating | Values | Determined by |
|---|---|---|
| **Risk** (what it does) | `read` · `write` · `delete` · `send` (reaches other people) · `personal` (reads other people's contact or personal details) · `account` · `payment` | Rules first, then the classifier |
| **Confidence** (whether it works) | 0–1, plus `observed` / `code-only` | Evidence, test pass rate, stability across rebuilds |
| **Platform risk** (likelihood of breaking the site's rules) | `low` · `medium` · `high` | Rules (bulk, social and high-volume reads), then the classifier |

### 7.2 Rules set the floor

- Fixed rules assign a **minimum** risk. Examples: an HTTP `DELETE` or a "remove" command is at least `delete`; anything that sends to other users is at least `send`; anything that touches billing is `payment`.
- A small local classifier model can **raise** a rating but never lower it below the rule floor.
- **Ratings are based on behavior, not names.** Tool names come from the site's own code, and a hostile site could label a delete action `refreshCache`. Ratings use what the operation was observed to change.
- Users can override a rating only after acknowledging a warning. Every override is logged.

### 7.3 Defaults

| Risk | Default state | Per-call behavior |
|---|---|---|
| `read` | On | Runs |
| `write` | On if confidence ≥ threshold, otherwise queued for approval | Runs |
| `delete`, `account` | Off | Asks for confirmation every time |
| `send`, `payment` | Off | Asks for confirmation every time, with a platform-rules warning |
| `personal` | Off | Asks for confirmation for each item. Never runs in unattended workflows, and results are never sent to a cloud LLM without redaction. |
| `platformRisk: high` | Off | Shows a platform-rules warning when switched on |

### 7.4 Untrusted content

Data returned from a site (messages, comments, documents) is labeled **untrusted** in tool results. The built-in agent runtime treats instructions inside such data as content, never as commands. It can also be set to require approval for any write that follows an untrusted read in the same task.

### 7.5 Threat model summary

| Threat | Mitigation |
|---|---|
| Malicious adapter | Permission declarations, sandbox, no network access outside the target site, no access to credentials, signing and review levels (see ADAPTER_SPEC) |
| Hostile website shaping the tools it exposes | Behavior-based ratings, rule floors, approval queue for new tools |
| Prompt injection through site content | Untrusted labels, approval after untrusted reads, confirmations for risky actions |
| A local web page attacking the gateway | Loopback only, bearer tokens, `Origin` rejection |
| Leaked recordings or logs | Shapes not values, secrets stripped, encrypted storage |
| The agent going wrong | Rate limits, daily caps, confirmations, audit log |

---

## 8. Rate limiting

- **One budget per site,** shared by every tool, agent and workflow that uses that site.
- **Token bucket** with conservative defaults. Users can tighten or loosen it per site.
- **Follows server signals:** honors `429` with `Retry-After`, reads `RateLimit` headers when present, and backs off exponentially with jitter.
- **Daily caps** for `send`, `delete` and other high-platform-risk actions.
- **Workflow controls:** concurrency limits per site, delays on loops and bulk steps.
- **CAPTCHA or verification detected:** pause, notify the user and show the page so they can complete it themselves. Taurus never solves it.
- **The goal is staying within limits, not hiding automation.** There is no randomized human-like behavior designed to avoid detection.

---

## 9. Workflow engine

### 9.1 Step types

| Step | Tokens | Purpose |
|---|---|---|
| Trigger | 0 | Schedule, PWA push notification, app state change, local webhook, another workflow |
| Tool | 0 | Calls a PMCP tool directly |
| Transform | 0 | Sandboxed expressions for mapping data |
| Condition / Loop | 0 | Branching and iteration (loops are paced) |
| Approval | 0 | Waits for the user |
| Delay | 0 | Time-based pause |
| AI | Varies | Decide, extract, summarize, generate |
| Sub-workflow | — | Composition |

### 9.2 Key behaviors

- **Turn a run into a workflow.** A successful agent run is recorded as a sequence of tool steps. The user marks which values become inputs, and the result replays without LLM calls.
- **Capability references.** Steps refer to capability slots where possible, so workflows survive rebuilds. Workflows that use **only** capability slots are portable and can be shared publicly.
- **Pause, repair, resume.** If a step fails because of a site change, the run pauses, the tool is rebuilt, and the step is retried once. If it still fails, the run waits for the user.
- **Durable runs.** Run state is saved on the device, so workflows survive restarts.

**Open question:** whether to import or export n8n's workflow format for compatibility.

---

## 10. Agent runtime and token economy

The built-in runtime serves AI steps in workflows, the compiler, and an optional built-in chat agent. External MCP agents benefit from sections 10.2–10.4 only.

### 10.1 Prompt layout for caching

```
[ system ][ skills ][ tool definitions, stable order ][ conversation ... ]
 └──────────────── stable prefix (cached) ────────────┘
```

- Tool definitions are sorted deterministically, and capability names don't change across rebuilds, so rebuilds rarely break the cache.
- Tool changes are applied in batches between sessions rather than mid-conversation.
- Provider-specific caching controls are used where available.

### 10.2 Fewer definitions

Profiles, toggles and on-demand loading (5.1). The monitor shows the token cost of each profile's tool definitions.

### 10.3 Smaller results

Compact JSON, only the fields that matter, and **references** (`app://patterns/12`) for large data, which the agent reads only if it needs to.

### 10.4 Fewer calls

Flows compiled into single tools, and repeated tasks turned into workflows.

### 10.5 Model routing and budgets

- Local or small models handle routine tool use. Larger models are used for compiling and difficult reasoning.
- Rebuild work that isn't urgent can use a provider's discounted batch processing, where offered.
- Token budgets can be set per app, per workflow and per day, and are shown in the monitor.
- Read results are cached until the app's state-change events show them to be stale.

---

## 11. Privacy and data

- **No telemetry by default.** Crash reports are opt-in and are shown to the user before sending.
- **Privacy router:** before any cloud LLM call, personal details and secrets are removed, and per-app **local-only** rules are enforced. An app marked local-only can only use local models.
- **Encrypted storage:** session data, logs and recordings are encrypted with keys held by the OS key store.
- **Connection ledger:** every outbound connection (target sites, LLM providers, registry, updates) is recorded and shown in the monitor.
- **Registry downloads** carry no user data. Requests contain only package identifiers.

---

## 12. Monitor PWA

Served locally, one view per app plus an overview of all apps:

- **Health board:** each tool's status, last check and build.
- **Change feed:** builds detected, tools re-linked, added or broken.
- **Approval queue:** new and risky tools, overrides.
- **Tools and profiles:** toggles, groups, profiles, and the token cost of each.
- **Live call log:** inputs, outputs, tokens and timing, with replay.
- **Watch mode:** shows the app's page next to the log while an agent works.
- **Rate budgets and caps:** current usage per site.
- **Savings meter:** tokens spent compiling against tokens saved by agents.
- **Connection ledger** (section 11).

---

## 13. Resource budget

| Part | Cost when idle | Cost when active |
|---|---|---|
| Compiled PMCP | Disk only | — |
| MCP gateway | One small process | Grows slightly per loaded PMCP |
| `http` tools | None | A single network request |
| `page` tools | None after the idle timeout | One renderer per app, limited by the memory budget |
| Compiler | None | Short CPU bursts, throttled and run at idle time |
| Monitor | None | A static local page |

---

## 14. Open questions

1. Electron or CEF for v0, and how long Electron stays viable before a fork is needed.
2. Default local models for classification, naming and routine tool use.
3. Governance for capability schemas: who approves new slots, and how versions are handled.
4. How to verify `page`-mode tools for canvas-only apps without relying on vision.
5. Whether, and how, to let the monitor be viewed securely from another device.
6. n8n workflow format compatibility (9.2).
7. How sessions move safely from the desktop app to a headless host (15.4).
8. Which engine headless hosts use: headless Chromium over the DevTools protocol, or Electron without windows (15.2).

---

## 15. Future: headless Taurus

> **Out of scope until after Roadmap phase 4.** It is recorded now so that v0 decisions don't rule it out.

### 15.1 What it is

A background service (working name `taurusd`) that serves PMCPs **without the desktop UI**, on hardware the user controls: a home server, a NAS, a spare PC or a private VM.

Use cases:
- workflows that run around the clock, even when the user's laptop is closed;
- scheduled jobs and notification-triggered automations;
- agents running on servers or in CI that need PMCP tools.

### 15.2 Headless PMCPs

Headless PMCPs use the **same bundle format** as desktop ones. The manifest adds a per-tool `headless` flag, set during the Verify stage by running each tool's tests in headless mode:

| Execution mode | Headless support | Flag |
|---|---|---|
| `http` | Yes, with no browser at all. The ideal headless tool. | `yes` |
| `page` | Yes, using a headless browser engine. Heavier on memory. | `needs-renderer` |
| `vision` | Not supported at first | `no` |

### 15.3 Compiling and approvals

- At first, **compiling stays in the desktop app**. Compiled PMCPs are transferred to the headless host through encrypted pairing.
- The headless host may run **incremental rebuilds** when a site changes. Newly discovered tools and any rating changes still wait in the approval queue until the user approves them from a paired desktop app or monitor.

### 15.4 Sessions and sign-in

- The user signs in through the desktop app, and the session is moved to the headless host through encrypted pairing. Alternatively, the user signs in directly on the host through a remote monitor view.
- Sessions never pass through any third-party service. Taurus runs no servers of its own.
- Some sites tie sessions to a device or network and may sign the user out, or ask for verification, when a session moves. That is expected behavior, and Taurus will not try to get around it.

### 15.5 Bot detection and CAPTCHAs

- Sites challenge headless browsers more often. **Taurus will not disguise headless mode.**
- Sites that challenge headless sessions are marked **desktop-only**, and their tools run only in the desktop app.
- When a CAPTCHA or verification appears, the run pauses and the user is notified through a paired device to complete it, or the run moves back to the desktop app.

### 15.6 Monitoring and privacy

- The monitor PWA connects to the headless host through **end-to-end encrypted pairing**, or through a tunnel the user sets up themselves.
- All data stays on the user's own hardware. The connection ledger and every other privacy rule from section 11 apply unchanged.

### 15.7 Constraints for v0, so headless remains possible

1. The runtime (MCP gateway, executors, rate limiter, workflow engine) runs as a **separate process** from the shell UI and does not depend on Electron window APIs.
2. Access to pages goes through an interface that can be backed either by Electron windows or by a headless browser engine.
3. Secret storage sits behind an interface: the OS key store on desktops, an encrypted store unlocked by a passphrase or hardware key on servers.
4. Approvals and CAPTCHA handoffs are **events** that any paired UI can resolve, not modal dialogs tied to one window.
5. The PMCP bundle format contains no file paths or other assumptions that only hold on the desktop.
