// Taurus Monitor. Plain ES modules, no build step, no third-party code, nothing loaded from outside this machine.

const TOKEN_KEY = 'taurus-monitor-token';
const APP_KEY = 'taurus-monitor-app';

const EFFECT_LABEL = {
  read: 'Reads',
  write: 'Changes',
  delete: 'Deletes',
  send: 'Reaches other people',
  personal: 'Personal data',
  account: 'Account settings',
  payment: 'Money',
  unknown: 'Unknown',
};

const RISK_WARNING = {
  delete: 'This tool can permanently delete things in the app.',
  send: 'This tool can send things from your account to other people.',
  personal: "This tool reads other people's contact or personal details.",
  account: 'This tool can change your account settings.',
  payment: 'This tool can spend money.',
};

const ERROR_LABEL = {
  not_found: 'Not found',
  invalid_input: 'Invalid input',
  unsupported: 'Not supported by this app',
  conflict: 'Changed somewhere else',
  permission_denied: 'Not allowed for this account',
  rate_limited: 'Slowed down by the rate limit',
  needs_user: 'Needs you to sign in again',
  stale_binding: 'Tool is being rebuilt',
  approval_required: 'Not approved',
  tool_disabled: 'Tool is switched off',
  unknown_tool: 'Unknown tool',
  upstream_error: 'The app returned an error',
  internal_error: 'Taurus error',
};

const state = {
  apps: [],
  selected: null,
  profile: 'default',
  detail: null,
  calls: [],
  approvals: [],
  online: false,
  connection: null,
  revealToken: false,
};

const $ = (selector) => document.querySelector(selector);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') Object.assign(el.style, value); // CSSOM, allowed by the monitor's CSP
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function storage(action, key, value) {
  try {
    if (action === 'get') return localStorage.getItem(key);
    if (action === 'set') localStorage.setItem(key, value);
    if (action === 'remove') localStorage.removeItem(key);
  } catch {
    // storage blocked: the monitor still works for this visit
  }
  return null;
}

function readToken() {
  const match = location.hash.match(/token=([A-Za-z0-9_-]+)/);
  if (match) {
    storage('set', TOKEN_KEY, match[1]);
    history.replaceState(null, '', location.pathname);
    return match[1];
  }
  return storage('get', TOKEN_KEY);
}

let token = readToken();

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(path, options = {}) {
  const response = await fetch(`api/${path}`, {
    method: options.method ?? 'GET',
    headers: { 'x-taurus-monitor': token ?? '', ...(options.body ? { 'content-type': 'application/json' } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    showSignIn('That monitor link is out of date. Open the link printed by taurus serve, or paste the token below.');
    throw new ApiError(401, 'unauthorized', 'Not signed in.');
  }
  if (!response.ok) throw new ApiError(response.status, data.error, data.message ?? `Request failed (${response.status}).`);
  return data;
}

// Wording

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function slotWords(slot) {
  const [, entity = 'item', action = ''] = slot.split('.');
  const plural = entity.endsWith('s') ? entity : `${entity}s`;
  if (action === 'list') return `List ${plural}`;
  if (action === 'get') return `Get a ${entity}`;
  return `${capitalize(action)} a ${entity}`;
}

const toolWords = (name) => {
  const slot = name.includes('.') ? name : name.replace(/_/g, '.');
  return slot.split('.').length === 3 ? slotWords(slot) : name;
};

function approvalQuestion(approval) {
  const [, entity = 'item', action = 'use'] = approval.slot.split('.');
  const target = approval.args && typeof approval.args.id === 'string' ? ` ${approval.args.id}` : '';
  return `${capitalize(action)} ${entity}${target} in ${approval.appId}?`;
}

function ago(iso) {
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// Feedback

let toastTimer;
function toast(message) {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: 'toast', role: 'status' }, message);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3500);
}

function confirmDialog(title, body, okLabel) {
  const dialog = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-body').textContent = body;
  $('#confirm-ok').textContent = okLabel;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }));
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    toast(`Couldn't copy the ${what.toLowerCase()}. Select it and copy it by hand.`);
  }
}

function setOnline(online) {
  state.online = online;
  const el = $('#connection');
  el.classList.toggle('online', online);
  el.textContent = online ? 'Connected to Taurus' : "Taurus isn't running. Start it with taurus serve.";
}

// Rendering: apps rail

function renderApps() {
  const list = $('#app-list');
  if (state.apps.length === 0) {
    list.replaceChildren(h('li', { class: 'empty' }, 'No apps yet'));
    return;
  }
  list.replaceChildren(
    ...state.apps.map((app) => {
      const status = !app.checks ? '' : app.checks.failed > 0 ? 'bad' : 'ok';
      return h(
        'li',
        null,
        h(
          'button',
          {
            type: 'button',
            'aria-current': app.appId === state.selected ? 'true' : 'false',
            onclick: () => selectApp(app.appId),
          },
          h('span', { class: `dot ${status}`, title: status === 'ok' ? 'Checks passed' : status === 'bad' ? 'Checks failed' : 'Not checked' }),
          h('span', { class: 'app-name' }, app.appId),
          app.pendingApprovals > 0 ? h('span', { class: 'badge-count', title: 'Waiting for approval' }, app.pendingApprovals) : null,
        ),
      );
    }),
  );
}

// Rendering: approval strip

const shownApprovals = new Set();

function renderApprovals() {
  const section = $('#approvals');
  const current = new Set(state.approvals.map((a) => a.id));
  for (const id of shownApprovals) if (!current.has(id)) shownApprovals.delete(id);
  document.title = state.approvals.length ? `(${state.approvals.length}) Taurus Monitor` : 'Taurus Monitor';
  section.hidden = state.approvals.length === 0;
  section.replaceChildren(
    ...state.approvals.map((approval) => {
      const args = Object.entries(approval.args ?? {});
      const isNew = !shownApprovals.has(approval.id);
      shownApprovals.add(approval.id);
      return h(
        'article',
        { class: `approval${isNew ? ' fresh' : ''}` },
        h(
          'div',
          null,
          h('p', { class: 'approval-question' }, approvalQuestion(approval)),
          h(
            'p',
            { class: 'approval-meta' },
            `${EFFECT_LABEL[approval.effect] ?? approval.effect}. Asked through the "${approval.profile}" profile. `,
            h('span', { 'data-expires': approval.expiresAt }, expiresText(approval.expiresAt)),
          ),
          args.length
            ? h(
                'dl',
                { class: 'approval-args' },
                args.map(([key, value]) => h('div', null, h('dt', null, key), h('dd', null, typeof value === 'string' ? value : JSON.stringify(value)))),
              )
            : null,
        ),
        h(
          'div',
          { class: 'approval-actions' },
          h('button', { type: 'button', class: 'deny', onclick: (e) => decide(approval, false, e.currentTarget) }, 'Deny'),
          h('button', { type: 'button', class: 'approve', onclick: (e) => decide(approval, true, e.currentTarget) }, 'Approve'),
        ),
      );
    }),
  );
}

function expiresText(iso) {
  const seconds = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000));
  return seconds > 0 ? `Expires in ${seconds} s.` : 'Expiring.';
}

function tickCountdowns() {
  for (const el of document.querySelectorAll('[data-expires]')) el.textContent = expiresText(el.dataset.expires);
}

async function decide(approval, approved, button) {
  button.disabled = true;
  try {
    await api(`approvals/${encodeURIComponent(approval.id)}`, { method: 'POST', body: { approved } });
    toast(approved ? 'Approved' : 'Denied');
  } catch (error) {
    toast(error.code === 'expired' ? 'That request already expired, so the agent was told it was not approved.' : error.message);
  }
  await refreshApprovals();
}

// Rendering: app view

function renderHeader(detail) {
  const latest = detail.checks[detail.checks.length - 1];
  let result;
  if (!latest) result = h('span', { class: 'checks-result none' }, 'Not checked yet');
  else {
    const total = latest.passed + latest.failed + latest.skipped;
    const skipped = latest.skipped ? `, ${latest.skipped} skipped` : '';
    result = h(
      'span',
      { class: `checks-result ${latest.failed ? 'bad' : 'ok'}` },
      latest.failed ? `${latest.failed} of ${total} checks failed${skipped}` : `${latest.passed} of ${total} checks passed${skipped}`,
    );
  }
  const run = h('button', { type: 'button', class: 'quiet', onclick: (e) => runChecks(e.currentTarget) }, 'Run checks again');
  return h(
    'header',
    { class: 'app-head' },
    h('h1', null, detail.appId),
    h('p', { class: 'app-origin' }, detail.origin),
    h(
      'div',
      { class: 'checks-line' },
      result,
      h('span', { class: 'build' }, `Compiled ${ago(detail.compiledAt)}, build ${detail.build.replace('sha256:', '')}`),
      run,
    ),
  );
}

function renderTools(detail) {
  const on = detail.tools.filter((t) => t.enabled).length;
  const picker =
    detail.profiles.length > 1
      ? h(
          'label',
          { class: 'profile-picker' },
          'Profile',
          h(
            'select',
            {
              onchange: (e) => {
                state.profile = e.currentTarget.value;
                loadApp();
              },
            },
            detail.profiles.map((p) => h('option', { value: p, selected: p === detail.profile }, p)),
          ),
        )
      : null;

  const rows = detail.tools.map((tool) => {
    const risky = tool.needsApproval;
    return h(
      'tr',
      { class: tool.enabled ? '' : 'off' },
      h('td', null, h('span', { class: 'tool-name' }, slotWords(tool.slot)), h('code', { class: 'tool-slot' }, tool.name)),
      h(
        'td',
        null,
        h('span', { class: `effect ${tool.effect}` }, EFFECT_LABEL[tool.effect] ?? tool.effect),
        risky ? h('span', { class: 'asks' }, 'Asks you every time') : null,
      ),
      h(
        'td',
        { class: 'num hide-narrow', title: 'How sure Taurus is that this tool works' },
        h('span', { class: 'meter' }, h('span', { style: { width: `${Math.round(tool.confidence * 100)}%` } })),
        `${Math.round(tool.confidence * 100)}%`,
      ),
      h('td', { class: 'num hide-narrow' }, tool.tokens),
      h(
        'td',
        { class: 'num' },
        h('button', {
          type: 'button',
          role: 'switch',
          class: `switch${risky ? ' risky' : ''}`,
          'aria-checked': tool.enabled ? 'true' : 'false',
          'aria-label': `${slotWords(tool.slot)} for agents`,
          onclick: (e) => toggleTool(tool, e.currentTarget),
        }),
      ),
    );
  });

  return h(
    'section',
    { class: 'panel', 'aria-labelledby': 'tools-title' },
    h(
      'div',
      { class: 'panel-head' },
      h('h2', { id: 'tools-title' }, 'Tools agents can use'),
      picker,
      h('p', { class: 'panel-note' }, `${on} of ${detail.tools.length} on. About ${detail.enabledTokens.toLocaleString()} tokens of tool descriptions per request.`),
    ),
    detail.tools.length
      ? h(
          'table',
          { class: 'tools' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { scope: 'col' }, 'Tool'),
              h('th', { scope: 'col' }, 'What it does'),
              h('th', { scope: 'col', class: 'num hide-narrow' }, 'Confidence'),
              h('th', { scope: 'col', class: 'num hide-narrow' }, 'Tokens'),
              h('th', { scope: 'col', class: 'num' }, 'On'),
            ),
          ),
          h('tbody', null, rows),
        )
      : h('p', { class: 'empty' }, 'Taurus found no tools it could connect to a shared schema. Try compiling again after using more of the app.'),
  );
}

function callItem(call) {
  const during = call.profile === '__verify' ? ' during checks' : call.profile !== 'default' ? ` through ${call.profile}` : '';
  return h(
    'li',
    { class: call.fresh ? 'fresh' : '' },
    h('span', { class: 'call-time' }, clock(call.at)),
    h('span', { class: 'call-tool' }, toolWords(call.tool)),
    h('span', { class: 'call-ms' }, call.ms >= 1000 ? `${(call.ms / 1000).toFixed(1)} s` : `${call.ms} ms`),
    h(
      'span',
      { class: `call-result${call.ok ? '' : ' error'}` },
      call.ok ? `Done${during}` : `${ERROR_LABEL[call.error] ?? call.error ?? 'Failed'}${during}`,
    ),
  );
}

function renderActivity() {
  const list = state.calls.length
    ? h('ul', { class: 'calls', id: 'calls' }, state.calls.map(callItem))
    : h('p', { class: 'empty', id: 'calls' }, 'No calls yet. Connect an agent below, and its calls show up here as they happen.');
  return h(
    'section',
    { class: 'panel', 'aria-labelledby': 'activity-title' },
    h('div', { class: 'panel-head' }, h('h2', { id: 'activity-title' }, 'Recent calls')),
    list,
  );
}

function renderChecks(detail) {
  const latest = detail.checks[detail.checks.length - 1];
  return h(
    'section',
    { class: 'panel', 'aria-labelledby': 'checks-title' },
    h(
      'div',
      { class: 'panel-head' },
      h('h2', { id: 'checks-title' }, 'Checks'),
      h('p', { class: 'panel-note' }, latest ? `Last run ${ago(latest.at)} in a scratch project` : 'Checks run in a scratch project and clean up after themselves.'),
    ),
    latest
      ? h(
          'ul',
          { class: 'steps' },
          latest.steps.map((step) =>
            h(
              'li',
              null,
              h('span', { class: `step-status ${step.status}` }, capitalize(step.status)),
              h('span', null, step.name.replace(/^\d+\.\s*/, ''), step.detail ? h('span', { class: 'step-detail' }, step.detail) : null),
            ),
          ),
        )
      : h('p', { class: 'empty' }, 'Not checked yet.'),
  );
}

function renderConnect(detail) {
  const masked = '•'.repeat(24);
  const tokenText = state.revealToken && state.connection ? state.connection.token : masked;
  const command = `claude mcp add --transport http ${detail.appId} ${detail.endpoint} --header "Authorization: Bearer ${tokenText}"`;
  const withToken = async (use) => {
    try {
      if (!state.connection) state.connection = await api(`apps/${encodeURIComponent(detail.appId)}/connection?profile=${encodeURIComponent(state.profile)}`);
      use(state.connection.token);
    } catch (error) {
      toast(error.message);
    }
  };
  return h(
    'section',
    { class: 'panel', 'aria-labelledby': 'connect-title' },
    h(
      'div',
      { class: 'panel-head' },
      h('h2', { id: 'connect-title' }, 'Connect an agent'),
      h('p', { class: 'panel-note' }, `Any MCP client works. Agents see only the tools that are on for the "${detail.profile}" profile.`),
    ),
    h(
      'div',
      { class: 'connect' },
      h(
        'div',
        { class: 'connect-row' },
        h('span', { class: 'label' }, 'Endpoint'),
        h('code', null, detail.endpoint),
        h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'quiet', onclick: () => copy(detail.endpoint, 'Endpoint') }, 'Copy')),
      ),
      h(
        'div',
        { class: 'connect-row' },
        h('span', { class: 'label' }, 'Bearer token'),
        h('code', null, tokenText),
        h(
          'div',
          { class: 'row-actions' },
          h(
            'button',
            {
              type: 'button',
              class: 'quiet',
              onclick: () =>
                state.revealToken
                  ? ((state.revealToken = false), renderView())
                  : withToken(() => {
                      state.revealToken = true;
                      renderView();
                    }),
            },
            state.revealToken ? 'Hide' : 'Show',
          ),
          h('button', { type: 'button', class: 'quiet', onclick: () => withToken((t) => copy(t, 'Token')) }, 'Copy'),
        ),
      ),
      h(
        'div',
        { class: 'connect-row' },
        h('span', { class: 'label' }, 'Claude Code'),
        h('code', null, command),
        h(
          'div',
          { class: 'row-actions' },
          h(
            'button',
            {
              type: 'button',
              class: 'quiet',
              onclick: () => withToken((t) => copy(command.replace(tokenText, t), 'Command')),
            },
            'Copy',
          ),
        ),
      ),
    ),
  );
}

function renderView() {
  const view = $('#view');
  const detail = state.detail;
  if (!detail) return;
  view.replaceChildren(
    renderHeader(detail),
    h('div', { class: 'columns' }, renderTools(detail), renderActivity()),
    h('div', { class: 'columns' }, renderConnect(detail), renderChecks(detail)),
  );
}

function renderEmpty() {
  $('#view').replaceChildren(
    h(
      'div',
      { class: 'notice' },
      h('h1', null, 'No apps compiled yet'),
      h('p', null, 'Compile a web app and it shows up here with its tools, checks and activity.'),
      h('p', null, h('code', null, 'taurus compile <url> --app-id <id> --record')),
    ),
  );
}

function showSignIn(message) {
  storage('remove', TOKEN_KEY);
  token = null;
  $('#app-list').replaceChildren();
  const input = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Monitor token', 'aria-label': 'Monitor token', required: true });
  $('#view').replaceChildren(
    h(
      'div',
      { class: 'notice' },
      h('h1', null, 'Open the monitor link'),
      h('p', null, message ?? 'Run taurus serve and open the monitor link it prints. You can also paste the token from that link here.'),
      h(
        'form',
        {
          onsubmit: (e) => {
            e.preventDefault();
            token = input.value.trim();
            storage('set', TOKEN_KEY, token);
            start();
          },
        },
        input,
        h('button', { type: 'submit', class: 'primary' }, 'Open monitor'),
      ),
    ),
  );
}

// Actions

async function selectApp(appId) {
  state.selected = appId;
  state.profile = 'default';
  storage('set', APP_KEY, appId);
  renderApps();
  await loadApp();
}

async function loadApp() {
  if (!state.selected) return renderEmpty();
  const id = encodeURIComponent(state.selected);
  const [detail, calls] = await Promise.all([
    api(`apps/${id}?profile=${encodeURIComponent(state.profile)}`),
    api(`apps/${id}/calls?limit=50`),
  ]);
  state.detail = detail;
  state.calls = calls.calls;
  state.connection = null;
  state.revealToken = false;
  renderView();
}

async function toggleTool(tool, button) {
  const enabling = !tool.enabled;
  let acknowledged = false;
  if (enabling && tool.needsApproval) {
    const ok = await confirmDialog(
      `Switch on "${slotWords(tool.slot)}"?`,
      `${RISK_WARNING[tool.effect] ?? 'This tool is risky.'} Taurus will still ask you before every call. Automating this on a third-party site can break the site's rules, and the site may restrict or close your account.`,
      'Switch on',
    );
    if (!ok) return;
    acknowledged = true;
  }
  button.disabled = true;
  try {
    state.detail = await api(`apps/${encodeURIComponent(state.selected)}/tools`, {
      method: 'POST',
      body: { profile: state.profile, slot: tool.slot, enabled: enabling, acknowledged },
    });
    renderView();
    toast(`${slotWords(tool.slot)} is ${enabling ? 'on' : 'off'}`);
  } catch (error) {
    button.disabled = false;
    toast(error.message);
  }
}

async function runChecks(button) {
  button.disabled = true;
  button.textContent = 'Running checks';
  try {
    state.detail = await api(`apps/${encodeURIComponent(state.selected)}/verify?profile=${encodeURIComponent(state.profile)}`, { method: 'POST' });
    const latest = state.detail.checks[state.detail.checks.length - 1];
    toast(latest?.failed ? `${latest.failed} checks failed` : 'All checks passed');
    await refreshApps(false);
    renderView();
  } catch (error) {
    toast(error.message);
    button.disabled = false;
    button.textContent = 'Run checks again';
  }
}

async function refreshApps(reloadDetail = true) {
  const { apps } = await api('apps');
  state.apps = apps;
  if (!apps.some((a) => a.appId === state.selected)) {
    const remembered = storage('get', APP_KEY);
    state.selected = apps.some((a) => a.appId === remembered) ? remembered : (apps[0]?.appId ?? null);
    reloadDetail = true;
  }
  renderApps();
  if (!reloadDetail) return;
  if (state.selected) await loadApp();
  else renderEmpty();
}

async function refreshApprovals() {
  const { approvals } = await api('approvals');
  state.approvals = approvals;
  renderApprovals();
}

// Alerts

async function notify(approval) {
  if (document.visibilityState === 'visible' || !('Notification' in window) || Notification.permission !== 'granted') return;
  const options = { body: approvalQuestion(approval), tag: approval.id, icon: 'icon.svg', requireInteraction: true };
  const registration = await navigator.serviceWorker?.getRegistration();
  if (registration) registration.showNotification('Taurus needs your approval', options);
  else new Notification('Taurus needs your approval', options);
}

function setupAlerts() {
  const button = $('#alerts');
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  button.hidden = false;
  button.addEventListener('click', async () => {
    await Notification.requestPermission();
    button.hidden = true;
  });
}

// Live events

async function stream() {
  for (;;) {
    if (!token) return;
    try {
      const response = await fetch('api/events', { headers: { 'x-taurus-monitor': token } });
      if (response.status === 401) return showSignIn();
      if (!response.ok || !response.body) throw new Error('stream failed');
      if (!state.online) {
        setOnline(true);
        await Promise.all([refreshApps(), refreshApprovals()]);
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let split;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          handleEvent(buffer.slice(0, split));
          buffer = buffer.slice(split + 2);
        }
      }
    } catch {
      // fall through to reconnect
    }
    setOnline(false);
    await sleep(3000);
  }
}

function handleEvent(chunk) {
  let event = 'message';
  let data = '';
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) data += line.slice(6);
  }
  if (!data) return;
  const payload = JSON.parse(data);
  if (event === 'approval') {
    refreshApprovals().catch(() => {});
    refreshApps(false).catch(() => {});
    if (payload.type === 'requested') notify(payload.approval);
  } else if (event === 'call' && payload.appId === state.selected) {
    state.calls = [{ ...payload, fresh: true }, ...state.calls.map((c) => ({ ...c, fresh: false }))].slice(0, 50);
    const list = $('#calls');
    if (list) list.replaceWith(renderActivity().querySelector('#calls'));
  }
}

// Start

async function start() {
  if (!token) return showSignIn();
  setOnline(false);
  try {
    await Promise.all([refreshApps(), refreshApprovals()]);
    setOnline(true);
  } catch (error) {
    if (error.status === 401) return;
  }
  stream();
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
setupAlerts();
setInterval(tickCountdowns, 1000);
start();
