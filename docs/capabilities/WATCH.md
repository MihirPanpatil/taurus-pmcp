# Capability Schema: `watch`

> **Draft v0.1.0 (design stage).** Follows the conventions in [TASKS.md, section 1](TASKS.md#1-how-a-capability-schema-works): IDs, references, times, pagination, compact results, unsupported fields and shared error codes all work the same way.

The `watch` schema covers **observing a value over time and reacting when it changes**: a price drop, a status update, a new announcement, a new device on your network. Many of the use cases in [USE_CASES.md](../USE_CASES.md) depend on it.

---

## 1. Two halves

`watch` is split between the apps and Taurus itself:

| Half | Provided by | What it offers |
|---|---|---|
| **Sources** | Each app's PMCP | Things in that app that *can* be watched, and a way to read their current value |
| **Watches** | Taurus's built-in `taurus` PMCP | The user's watch definitions: which source, what condition, how often, who gets notified |

Agents create watches through the built-in PMCP. The runtime then runs them, so **each check is deterministic and costs zero tokens.** A model is used only if the user opts into an AI summary of a change.

---

## 2. Entities

```yaml
WatchSource:                # offered by an app's PMCP
  id: string                # e.g. "product.price"
  ref: string
  appId: string
  label: string             # "Product price"
  kind: value | status | collection | content
  params: JSONSchema        # what identifies the thing, e.g. { productId }
  valueType: number | money | text | boolean | status | collection
  itemKey?: string          # for collections: the field that identifies an item
  push: boolean             # true if the app can push changes (see 4.2)
  minInterval: duration     # the shortest allowed polling interval, from the site's rate budget
  defaultInterval: duration
  ratings: { risk: read, platformRisk: low | medium | high }

Watch:                      # owned by the user, stored locally
  id: string
  ref: string
  name: string
  sourceRef: string
  params: object
  condition: Condition
  schedule: Schedule
  notify: Notify[]
  state: active | paused | needs_user | broken | expired
  stateReason?: string
  baseline?: Value          # the first observed value
  lastValue?: Value
  lastCheckedAt?: datetime
  lastTriggeredAt?: datetime
  createdAt: datetime
  expiresAt: datetime       # required; see 6.3

Value:                      # one of, depending on valueType
  number:     { value: number, unit?: string }
  money:      { amount: number, currency: string }   # ISO 4217 code
  text:       { value: string }
  boolean:    { value: boolean }
  status:     { kind?: string, native: string }      # e.g. kind "approved", native "Application approved"
  collection: { items: [{ key, title, url? }], total?: number }
  content:    { hash: string, excerpt?: string }

Observation:
  watchId: string
  at: datetime
  value: Value              # compact; collections store keys and titles only
  changed: boolean
  triggered: boolean
  error?: { code, message }

WatchEvent:                 # sent when a watch triggers or changes state
  watchId: string
  type: triggered | state_changed
  at: datetime
  before?: Value
  after?: Value
  delta?: { amount?: number, percent?: number, added?: Item[], removed?: Item[] }
  state?: string
```

### Source kinds

| Kind | Good for | Examples |
|---|---|---|
| `value` | One number, amount, text or yes/no | Price, stock status, balance due, ink level |
| `status` | One value from a small set | Application status, delivery status, order state |
| `collection` | A list where new or removed items matter | Course announcements, connected devices, new invoices |
| `content` | A section of a page whose content matters, but not its structure | A notice board, a policy page |

Prefer `value`, `status` and `collection`. A `content` source is a fallback, because it can trigger on changes that don't matter.

---

## 3. Slots

### 3.1 Source slots (in each app's PMCP)

| Slot | Tier | Input | Output | Min effect |
|---|---|---|---|---|
| `watch.source.list` | core | — | `WatchSource[]` | `read` |
| `watch.source.read` | core | `sourceId`, `params` | `{ value: Value, observedAt }` | `read` |
| `watch.source.subscribe` | standard | `sourceId`, `params` | an event stream of `Value` | `read` |

### 3.2 Watch slots (in Taurus's built-in PMCP)

| Slot | Tier | Input | Output | Min effect |
|---|---|---|---|---|
| `watch.create` | core | `name`, `sourceRef`, `params`, `condition`, `schedule?`, `notify`, `expiresIn?` | `Watch` | `write` (local) |
| `watch.list` | core | `state?`, `appId?`, `limit?`, `cursor?` | `Watch[]` (summary) | `read` |
| `watch.get` | core | `id` | `Watch` | `read` |
| `watch.history` | core | `id`, `limit?`, `cursor?`, `onlyChanges?` | `Observation[]` | `read` |
| `watch.pause` / `watch.resume` | core | `id` | `Watch` | `write` (local) |
| `watch.delete` | core | `id` | `{ deleted: true }` | `write` (local) |
| `watch.update` | standard | `id`, plus any of: `name`, `condition`, `schedule`, `notify`, `expiresIn` | `Watch` | `write` (local) |
| `watch.test` | standard | `sourceRef`, `params`, `condition` | `{ value, wouldTrigger }`. Nothing is saved. | `read` |
| `watch.checkNow` | standard | `id` | `Observation` | `read` (counts against the site's budget) |

Watch slots change only local Taurus state, so they carry no platform risk themselves. **The checks they cause do**, which is why the rules in section 6 apply to `create`, `update` and `checkNow`.

### 3.3 Events

- **MCP clients** can subscribe to the resource `watch://<id>` and receive a resource-updated notification on every `WatchEvent`.
- **Workflows** can use a watch as a trigger (ARCHITECTURE 9.1). The event's `before`, `after` and `delta` become workflow inputs.

---

## 4. Conditions, schedules and notifications

### 4.1 Conditions

Conditions are declarative. There is no code to run.

| Condition | Value types | Meaning |
|---|---|---|
| `changed` | any | Any change from the last value |
| `equals` / `notEquals` | `text`, `boolean`, `status` | Compares with a given value |
| `above` / `below` | `number`, `money` | Crosses a threshold |
| `dropBy` / `riseBy` | `number`, `money` | Changes by an `amount` or `percent`, compared with `baseline` (default) or `previous` |
| `newItems` / `removedItems` | `collection` | Items appear or disappear (compared by `itemKey`) |
| `contains` | `text`, `content` (excerpt) | Contains a given text (case-insensitive) |
| `all` / `any` | — | Combine conditions |

Options for every condition:
- `confirmations` (default 1): the condition must hold for this many consecutive checks before the watch triggers. This prevents alerts from values that flicker.
- `cooldown` (default 0): the minimum time between two triggers of the same watch.
- `once` (default false): trigger once, then set the watch to `expired`.

Money conditions compare amounts **only in the same currency.** If the currency changes, the check returns `changed` with a note and does not evaluate thresholds.

### 4.2 Schedules

```yaml
Schedule:
  mode: auto | push | poll    # auto: push if the source supports it, otherwise poll
  every?: duration            # ≥ the source's minInterval; defaults to defaultInterval
  window?: { from: "09:00", to: "18:00", days?: [mon, tue, wed, thu, fri] }
  timezone?: string           # default: the user's zone
```

- **Push comes first.** When the app can announce changes itself, through its PWA push notifications or state-change events, Taurus listens instead of checking repeatedly.
- **Checks are spread out** by a small fixed offset per watch, so several watches on one site don't all fire at the same moment. The offset is for spreading load, not for imitating a person.

### 4.3 Notifications

| Channel | Where it goes |
|---|---|
| `monitor` | The monitor PWA's change feed (always on) |
| `desktop` | An operating-system notification on this device |
| `workflow` | Starts a workflow, passing the event as input |
| `agent` | An MCP resource notification to subscribed clients |

There are no built-in external channels such as email or SMS. A user who wants them builds a workflow step through an app they've connected themselves. That step is then rated `send`, like any other.

For apps marked **local-only**, desktop notifications show only "*watch name* changed", never the value.

---

## 5. Binding notes

- **Any stable `read` operation can become a source.** The compiler proposes sources from read operations: the tool to call, its parameters, and the path to the value inside the result. **The user approves each source in the monitor** before it can be watched.
- **Values are normalized.** Prices become `money` with an ISO currency code. Statuses keep the app's own wording in `native`, plus a shared `kind` where the compiler can map one. Collections need an `itemKey` that stays the same between checks. Without one, the source can only be `content`.
- **Content sources are scoped to a section** of the page, never the whole page, so that ads, timestamps and counters don't trigger them.
- **`minInterval` comes from the site's rate budget,** never from what the user would like it to be.

---

## 6. Rules

### 6.1 Intervals

| Site type | Default `minInterval` | Lowest allowed |
|---|---|---|
| Your own devices (local network) | 1 minute | 1 minute |
| Self-hosted apps you run | 5 minutes | 1 minute |
| Third-party websites | 60 minutes | 15 minutes, after a warning and confirmation |

A shorter interval than the source's `minInterval` is rejected with `interval_too_short`.

### 6.2 Limits

- At most **10 active watches per third-party site** by default. A user can raise this, after a warning.
- All checks count against the site's shared rate budget (ARCHITECTURE section 8). If the budget is used up, checks are delayed, never sent anyway.
- `watch.checkNow` is limited to a few calls per hour per watch.

### 6.3 Expiry

- **Every watch expires.** The default is 30 days and the maximum is 180, unless the user renews it. Forgotten watches don't keep checking a site forever.
- The monitor reminds the user 3 days before a watch expires.

### 6.4 State changes

| Event | New state | What happens |
|---|---|---|
| CAPTCHA, verification or sign-in needed | `needs_user` | Checks stop and the user is notified. They resume once the user resolves it. |
| The tool is being rebuilt (`stale_binding`) | `paused` | Checks resume after the rebuild passes verification |
| 5 checks in a row fail | `broken` | The user is notified. There are no further retries until the user acts. |
| `expiresAt` reached, or `once` triggered | `expired` | The watch is kept in history and can be renewed |

### 6.5 Risk

- Sources rated `personal` **cannot be watched**, because watches run unattended. `watch.create` on such a source is rejected.
- Creating a watch on a source with `platformRisk: high` requires confirmation and shows a platform-rules warning.
- A watch can trigger a workflow, but the workflow's own risky steps still need their own approval steps and confirmations.

---

## 7. Errors

The shared error codes ([TASKS.md, section 5](TASKS.md#5-errors)), plus:

| Code | Meaning |
|---|---|
| `interval_too_short` | The requested interval is below the source's `minInterval` |
| `too_many_watches` | The per-site limit on active watches has been reached |
| `source_unavailable` | The source is no longer offered after a rebuild |
| `not_watchable` | The source is rated `personal` |
| `expired` | The watch has expired. Renew it first. |

---

## 8. Examples

**Price drop on a saved product**
```yaml
name: Headphones under budget
sourceRef: app://shop-example/watch-source/product.price
params: { productId: "B0-EXAMPLE" }
condition: { any: [ { below: { amount: 2000, currency: INR } }, { dropBy: { percent: 10 } } ], confirmations: 2 }
schedule: { mode: auto, every: PT12H }
notify: [monitor, desktop]
expiresIn: P30D
```

**Visa application status**
```yaml
name: Visa status
sourceRef: app://visa-portal/watch-source/application.status
params: { applicationId: "…" }
condition: { changed: {} }
schedule: { mode: poll, every: P1D, window: { from: "09:00", to: "18:00" } }
notify: [monitor, desktop]
```
If the portal shows a CAPTCHA, the watch moves to `needs_user` and waits for the user.

**Course announcements → tasks** (combines two schemas)
```yaml
name: New course announcements
sourceRef: app://course-portal/watch-source/course.announcements
params: { courseId: "…" }
condition: { newItems: {} }
schedule: { mode: auto, every: PT3H }
notify: [monitor, { workflow: add-announcement-to-tasks }]   # uses tasks.task.create
```

**Unknown device on the home network**
```yaml
name: New device on Wi-Fi
sourceRef: app://home-router/watch-source/network.devices
params: {}
condition: { newItems: {} }
schedule: { mode: poll, every: PT5M }
notify: [monitor, desktop]
expiresIn: P180D
```

---

## 9. Conformance tests

These run against a fixture app whose values the test can control:

1. `watch.test` reports `wouldTrigger` correctly for each condition type.
2. Change the value → the watch triggers exactly once. With `confirmations: 2`, it triggers only after the second check.
3. `cooldown` and `once` behave as specified.
4. An interval below `minInterval` is rejected with `interval_too_short`.
5. A simulated CAPTCHA sets the state to `needs_user` and stops checks until it is resolved.
6. A simulated rebuild pauses the watch, then resumes it.
7. An expired watch makes no further requests.
8. A `personal` source is rejected with `not_watchable`.
9. **Zero LLM calls during checks**, measured over a full test run.
10. Push-capable sources produce no polling requests while push works.

---

## 10. Open questions

1. Should watch templates that use only shared capability names (e.g. "price below X" on any `orders` or `listings` source) be shareable in the registry?
2. Visual watches (changes in a rendered region) would need vision and so cost tokens. Should they be allowed at all, and how are they rated?
3. Watches are a natural fit for headless Taurus (ARCHITECTURE section 15). Should a watch be able to move between desktop and headless hosts?
4. Should the per-site watch limit adapt to the site's observed rate-limit signals instead of being fixed?
