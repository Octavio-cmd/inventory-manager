// #21A — updateInventory() sends the session and keeps its SET behaviour.
// Runs the REAL updateInventory()/savvyAuthFetch() from index.html in a vm
// sandbox with a recording fetch. Run: node --test tests/*.mjs
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const appCode = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const BACKEND = 'https://savvy-ebay-prices-production.up.railway.app';
const TOKEN = 'tok-abc.def-123';

function sandbox({ token = TOKEN, status = 200, body = { status: 'success' } } = {}) {
  const els = {};
  const el = id => (els[id] = els[id] || {
    id, value: '', textContent: '', innerHTML: '', style: {},
    classList: { on: false, add() { this.on = true; }, remove() { this.on = false; } },
    addEventListener() {},
  });
  const store = token ? { savvy_session_token: token, savvy_session_user: 'tester' } : {};
  const calls = [], logs = [];
  const ctx = {
    els, store, calls, logs,
    document: { getElementById: el, querySelectorAll: () => ['scr-home', 'scr-login'].map(el) },
    sessionStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    window: { addEventListener() {} },
    console: { log: (...a) => logs.push(a.map(String).join(' ')), error: (...a) => logs.push(a.map(String).join(' ')), warn() {} },
    setTimeout: () => 0, clearTimeout() {},
    URL, Headers, Event: class {}, Html5Qrcode: class {},
    fetch: async (url, opts = {}) => {
      calls.push({ url, opts });
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    },
  };
  vm.createContext(ctx);
  try { vm.runInContext(appCode, ctx, { timeout: 5000 }); } catch (e) { /* DOM-only init */ }
  vm.runInContext('window.loadedProducts = { 0: { sku: "IRW-710363598525-2", warehouse_uuid: "wh-1", inputId: "qty-0" } };', ctx);
  el('qty-0').value = '6';
  const toasts = () => el('toast').textContent;
  return { ctx, calls, store, logs, els, toasts, loginShown: () => el('scr-login').classList.on };
}
const hdr = c => new Headers(c.opts.headers);

test('updateInventory: authenticated POST to /sb/update-inventory via savvyAuthFetch', async () => {
  const s = sandbox();
  await s.ctx.updateInventory(0);
  assert.strictEqual(s.calls.length, 1);
  const c = s.calls[0];
  assert.strictEqual(c.url, BACKEND + '/sb/update-inventory');
  assert.strictEqual(c.opts.method, 'POST');
  assert.strictEqual(hdr(c).get('Authorization'), 'Bearer ' + TOKEN);
  assert.strictEqual(hdr(c).get('Content-Type'), 'application/json');
  assert.match(extract('updateInventory'), /savvyAuthFetch\('\/sb\/update-inventory'/);
});

test('updateInventory: payload unchanged — {sku, warehouse_uuid, quantity}, no mode (backend SET)', async () => {
  const s = sandbox();
  await s.ctx.updateInventory(0);
  const b = JSON.parse(s.calls[0].opts.body);
  assert.deepStrictEqual(b, { sku: 'IRW-710363598525-2', warehouse_uuid: 'wh-1', quantity: 6 });
  assert.ok(!('mode' in b), 'no mode → backend default "set" (replacement), same as main');
  assert.match(s.toasts(), /actualizado a 6 unidades/);
});

test('updateInventory: missing warehouse_uuid still sent as empty string (unchanged)', async () => {
  const s = sandbox();
  vm.runInContext('window.loadedProducts[0].warehouse_uuid = undefined;', s.ctx);
  await s.ctx.updateInventory(0);
  assert.strictEqual(JSON.parse(s.calls[0].opts.body).warehouse_uuid, '');
});

test('updateInventory: body literal is the same {sku, warehouse_uuid, quantity} as main, no mode', () => {
  const now = extract('updateInventory');
  assert.ok(now.includes("body: JSON.stringify({\n        sku: p.sku,\n        warehouse_uuid: p.warehouse_uuid || '',\n        quantity: newQty\n      })"));
  assert.ok(!/mode\s*:/.test(now));
});

test('updateInventory: 401 clears session, opens login, reports error, no success toast', async () => {
  const s = sandbox({ status: 401, body: { error: 'no_autorizado' } });
  await s.ctx.updateInventory(0);
  assert.strictEqual(s.calls.length, 1);
  assert.ok(!('savvy_session_token' in s.store) && !('savvy_session_user' in s.store));
  assert.ok(s.loginShown(), 'login screen shown');
  assert.match(s.toasts(), /Error al actualizar/);
  assert.doesNotMatch(s.toasts(), /actualizado a/);
});

test('updateInventory: no session → no request, login required', async () => {
  const s = sandbox({ token: '' });
  await s.ctx.updateInventory(0);
  assert.strictEqual(s.calls.length, 0);
  assert.match(s.toasts(), /No hay sesión activa/);
});

test('updateInventory: non-401 backend error keeps the session', async () => {
  const s = sandbox({ status: 409, body: { status: 'error', error: 'current_quantity_unavailable' } });
  await s.ctx.updateInventory(0);
  assert.strictEqual(s.store.savvy_session_token, TOKEN);
  assert.match(s.toasts(), /current_quantity_unavailable/);
});

test('updateInventory: token never in URL, query, body or console', async () => {
  for (const status of [200, 401, 500]) {
    const s = sandbox({ status, body: status === 200 ? { status: 'success' } : { error: 'x' } });
    await s.ctx.updateInventory(0);
    const c = s.calls[0];
    assert.ok(!c.url.includes(TOKEN) && !c.url.includes('?'));
    assert.ok(!String(c.opts.body).includes(TOKEN));
    assert.ok(s.logs.every(l => !l.includes(TOKEN)));
  }
});

test('Exits / QR / multi-location / webhook workflows still present', () => {
  for (const fn of ['exitSubmit', 'manualExitSubmit', 'saveLocations', 'loadLocationsList']) {
    assert.ok(new RegExp('function ' + fn + '\\s*\\(').test(appCode), fn + ' present');
  }
  assert.ok(appCode.includes('const EXIT_WEBHOOK_URL'));
  assert.ok(appCode.includes("mode:'no-cors'"), 'exit webhook still posts directly (not via backend auth)');
});

function extract(name) {
  const m = new RegExp('^(async )?function ' + name + '\\s*\\(', 'm').exec(appCode);
  return appCode.slice(m.index, appCode.indexOf('\n}\n', m.index) + 2);
}
