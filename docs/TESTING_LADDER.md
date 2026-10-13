# Taurus Testing Ladder

> **Draft v0.1 (design stage).** The levels, target apps and thresholds below are starting proposals. Thresholds will be tuned once real measurements exist.

Taurus is proven one difficulty level at a time. Each level adds **one or two new hard problems** on top of everything the previous levels already solved. A level is finished only when it passes its exit gate. Complex, fast-changing apps like a web DAW come last, not first.

---

## 1. Why self-hosted open-source apps

Levels 0–6 use **open-source apps that we run ourselves** (for example with Docker), not live third-party websites.

- **No terms-of-service risk.** We own the instance and the accounts.
- **Resettable.** Every test run starts from the same known state.
- **Real ground truth.** Many of these apps publish their API (OpenAPI or GraphQL schemas), so we can measure how much of it the compiler found and how much it invented.
- **Drift on demand.** We can pin version *N*, compile, upgrade to *N+1*, and measure exactly how well incremental rebuilds survive a real update.

Real third-party websites are tested on a **parallel track (T1–T5)** that starts with your own devices' admin pages and moves up to protected and heavy apps. Each step begins only after the matching self-hosted level has passed. See [USE_CASES.md, section 4](USE_CASES.md#4-the-third-party-testing-track).

The apps named below are **candidates**. Each one's license, current tech stack and suitability must be confirmed before it is adopted.

---

## 2. The ladder

| Level | Kind of app | Candidate targets | New problems it adds | First capability schema |
|---|---|---|---|---|
| **0 · Fixtures** | Tiny apps we write ourselves | A todo app (React + Redux + REST), a form-based CRUD app (server-rendered) | Adapter conformance, determinism, "shapes, not values" | `tasks` (draft) |
| **1 · Server-rendered** | Classic pages and forms | Gitea | DOM and form extraction, CSRF tokens, `http` mode, dry-run blocking | — |
| **2 · SPA + REST** | Single-page app with a documented REST API | Vikunja | Network observation, reading code files, schema inference, coverage scoring against the published API | `tasks` |
| **3 · SPA + state store / GraphQL** | App logic in a client-side store, or a GraphQL API | Planka (Redux), Wiki.js (GraphQL) | Redux and GraphQL adapters, `page` mode, **one skill working on two different apps** | `tasks`, `docs` |
| **4 · Real-time and outward-facing** | Live updates, actions that reach other people | Mattermost or Rocket.Chat | WebSockets, `send` risk, daily caps, untrusted content and prompt injection, notification triggers | `chat` |
| **5 · Canvas, client-side logic** | Little DOM, logic mostly in the browser | Excalidraw, tldraw | Command and undo-stack adapters, scratch environments, canvas, the `vision` fallback | `whiteboard` |
| **6 · Heavy client engine** | Large in-memory state, WASM, audio or graphics engines | Penpot; an open-source web DAW (candidate: openDAW) | WASM and Web Audio adapters, large state, memory budgets | `design`, `daw` |
| **7 · Live third-party beta** | A production app that changes often and without notice | FL Studio web (beta), on the tester's own account | Unannounced updates, terms-of-service limits, real accounts | `daw` |

Level 7 begins only after levels 0–6 have passed their gates.

---

## 3. What gets measured at every level

| Metric | Question it answers | How |
|---|---|---|
| **Coverage (recall)** | Did the compiler find what the app can do? | Compare discovered operations with the app's published API, or with a hand-labeled list where there is none |
| **Precision** | Did it invent tools, or expose noise as tools? | Share of emitted tools that map to a real operation |
| **Correctness** | Do the tools work? | Pass rate of the verify tests in the scratch environment |
| **Safety during compiling** | Did exploration damage anything? | Count changes to real data outside the scratch environment. **Must be zero.** |
| **Rating accuracy** | Are risk ratings right? | Compare with hand-labeled ratings. A rating below the rule floor is an automatic failure. |
| **Drift survival** | Does it survive an update? | Upgrade the app version, run the incremental rebuild, measure the share of tools still working and the rebuild's cost in tokens and time |
| **Agent efficiency** | Is it actually better for agents? | The same fixed task set, run by a generic browser agent and by an agent using the PMCP: tokens, time, success rate |
| **Resources** | Is it lightweight? | Memory and CPU while idle, compiling and serving |

---

## 4. Exit gates (starting targets)

A level passes when **all** of these hold on its target apps:

- Safety during compiling: **zero** changes to real data, and **zero** ratings below the rule floor.
- Coverage of documented read operations **≥ 80%**, and of write operations **≥ 60%**.
- Precision **≥ 90%**.
- Verify pass rate **≥ 95%** for tools enabled by default.
- After one real version upgrade, **≥ 85%** of tools work again after the incremental rebuild, with no manual fixes.
- Agent efficiency: the PMCP agent uses **clearly fewer tokens** than the generic browser agent on the task set, at an equal or higher success rate. The exact target is set after the level 2 baseline.

Levels 4 and above also require:
- every `send` action asks for confirmation and respects its daily cap;
- the prompt-injection test set (hostile content inside messages and documents) causes **no** unapproved writes.

---

## 5. What each level unlocks

| After level | Taurus can claim |
|---|---|
| 0 | The adapter system and conformance suite work |
| 2 | Compiling typical REST web apps works, with measured coverage and token savings |
| 3 | Shared skills work across different apps (the capability-schema idea is proven) |
| 4 | Outward-facing actions are safe enough for real use |
| 5 | Client-side apps with little or no DOM can be compiled |
| 6 | Heavy creative tools can be compiled |
| 7 | Taurus handles a fast-changing live product |

---

## 6. Open questions

1. Final choice of target apps per level, after checking their licenses and current stacks.
2. Where the fixed agent task sets live, and how they are versioned.
3. Which generic browser agent is the baseline for the efficiency comparison.
4. Whether exit-gate results are published per release as a public scorecard.
