# Taurus Use Cases

> **Draft v0.1 (design stage).** Use cases Taurus is designed for, including ones on third-party websites, and the ones it deliberately won't support.

---

## 1. What makes a use case viable

A use case is in scope when **all** of these hold:

1. **Your own account, your own data.** You act only on things you could already see or do by hand while signed in.
2. **Human-scale volume.** A handful of actions per run, a few runs a day at most. Nothing that only makes sense at scale.
3. **No bulk collection of other people's data.** Other people's contact or personal details are never gathered in bulk. Any tool that reads them is rated `personal` (see [ARCHITECTURE 7.3](ARCHITECTURE.md#73-defaults)).
4. **Clear value over the alternatives.** Either there is no official API or MCP server, or the official one doesn't cover what you need. If a good official MCP server exists, Taurus uses it instead of compiling the site.
5. **Low or manageable platform risk.** Read-only tasks first, writes only to your own content, and nothing that affects other users without confirmation.

Terms of service vary from site to site and change over time. Taurus shows each tool's platform-risk rating and warns before risky tools are enabled, but **checking a site's terms is the user's responsibility.**

---

## 2. Third-party use cases

Each row names a *category* of site. The examples are illustrative, and each site has to be checked individually.

### 2.1 Your own devices (no terms-of-service risk)

| Use case | What it does | Schemas | Risk |
|---|---|---|---|
| **Router and network admin pages** | Read bandwidth use and connected devices on a schedule; restart the router at night | `device` *(planned)* | `read`, `write` on your own hardware |
| **NAS, printer and smart-home web panels** | Export storage health, ink levels or sensor history into a dashboard | `device`, `records` | `read` |
| **Solar inverter or energy meter portals on your network** | Log daily generation and usage to a spreadsheet | `records` | `read` |

These are the best first real-world targets. They are third-party software, but they run on your own hardware, rarely have APIs, and change only when you update their firmware.

### 2.2 Study and work

| Use case | What it does | Schemas | Risk |
|---|---|---|---|
| **Course portal → task app** | Sync assignment deadlines from your university's learning platform into your task app, and flag new announcements | `tasks`, `notifications` | `read` on the portal, `write` to your own task app |
| **Job application tracker** | Collect the status of applications you submitted on several job portals into one board | `tasks`, `records` | `read` |
| **Internal company tools** *(only with your employer's permission)* | Run reports from legacy admin panels and file them in shared storage | varies | varies |

Some learning platforms offer an official API. Taurus is useful where personal API access is switched off, or where the API doesn't cover what you need.

**Not in scope:** automatically applying to jobs in bulk.

### 2.3 Home and life admin

| Use case | What it does | Schemas | Risk |
|---|---|---|---|
| **Utility and telecom bills** | Download each month's bill from electricity, internet and mobile portals; log amounts and due dates; remind you before the due date | `documents` *(planned)*, `records`, `tasks` | `read` |
| **Library account** | Check due dates and renew borrowed books before they're overdue | `tasks` | `read`, `write` (renewal) |
| **Application status checks** | Check government or institutional portals (passport, visa, permits, admissions) on a schedule and notify you when the status changes | [`watch`](capabilities/WATCH.md) | `read`. CAPTCHAs are handed to you. |
| **Subscription invoices** | Collect invoices from billing pages of services you pay for into one folder for expenses or taxes | `documents` | `read` |

### 2.4 Shopping and travel

| Use case | What it does | Schemas | Risk |
|---|---|---|---|
| **Price watch on items you're considering** | Check a few saved products, flights or hotels once or twice a day and notify you when the price drops | `watch` | `read`, low frequency |
| **Order and delivery overview** | Collect your recent orders and delivery status from several stores into one view | `orders` *(planned)*, `records` | `read` |
| **Trip planner** | Gather booking confirmations from airline and hotel accounts into one itinerary, with check-in reminders | `records`, `tasks` | `read` |

Purchases are never made automatically. A buy step is always `payment`: off by default, and confirmed by you each time.

### 2.5 Health (local-only)

| Use case | What it does | Schemas | Risk |
|---|---|---|---|
| **Patient portal** | Download your own lab reports and list upcoming appointments | `documents`, `tasks` | `read`, marked **local-only** |

Health apps demonstrate the privacy router. Marked local-only, their data is handled only by local models and never reaches a cloud LLM.

### 2.6 Creative tools (later ladder levels)

| Use case | What it does | Schemas | Risk |
|---|---|---|---|
| **Browser-based editors and design tools** | Batch-export your own files, apply the same edit to many of your own documents | `design`, `files` | `write` on your own content |
| **Web DAWs** (ladder level 7) | Build patterns, set up mixer routing, export stems from your own projects | `daw` | `write` on your own content |

---

## 3. Not supported

The project will not build, accept or document these, even for "personal use":

| Category | Examples |
|---|---|
| Bulk collection of other people's data | Harvesting phone numbers or emails from listings, profiles or directories |
| Mass messaging and engagement | Bulk DMs, auto-replies to strangers, automated likes, follows or comments |
| Scalping and queue-jumping | Ticket, sneaker or appointment-slot grabbing bots |
| Fake activity | Posting reviews, generating views or clicks, creating accounts |
| Getting around protections | Solving CAPTCHAs, evading bot detection, bypassing paywalls or rate limits |
| Moving money | Transfers, trades or purchases without confirmation each time |
| Other people's accounts | Acting on any account other than the user's own session |

---

## 4. The third-party testing track

Third-party sites enter the [testing ladder](TESTING_LADDER.md) as a parallel track. Each step begins only after the matching self-hosted level has passed its gate.

| Step | Sites | Starts after self-hosted level | New problems |
|---|---|---|---|
| **T1 · Own devices** | Router, NAS or printer admin pages | 1 | Real third-party code and firmware quirks, with no terms-of-service risk |
| **T2 · Read-only, own account** | Library, utility and course portals | 2 | Real sign-in sessions, unannounced site updates, no published API to compare against |
| **T3 · Own-content writes and cross-app workflows** | Library renewals; course portal → task app | 3 | Writes to live sites; one workflow across a compiled PMCP and an official MCP server |
| **T4 · Protected and sensitive** | Price watches on travel sites, government portals with CAPTCHAs, patient portals | 4 | Bot protection, CAPTCHA handoff, local-only privacy rules |
| **T5 · Heavy, fast-changing apps** | Web DAW betas | 6 | Ladder level 7 |

### How third-party testing differs

- **No published API to compare against.** Coverage is measured against a hand-written list of what the site lets a user do, made by the tester.
- **Drift is real, not simulated.** Site updates are logged as they happen, and drift survival is measured on those.
- **Testers use only their own accounts,** within each site's terms, at human-scale volume.
- **Permission where possible.** The project will ask friendly vendors for explicit permission to use their sites as test targets, and credit them.
