// #21B — search accepts a full SKU or a UPC without corrupting either.
// Runs the REAL parseSearchQuery()/searchUPC()/showProductFromProxy()/
// renderRecent() from index.html in a vm sandbox with a recording fetch.
// The paste/typing test drives real Chromium when Playwright is installed
// (skipped otherwise). Run: node --test tests/*.mjs
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = join(__dirname, '..', 'index.html');
const html = readFileSync(indexPath, 'utf8');
const appCode = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const BACKEND = 'https://savvy-ebay-prices-production.up.railway.app';
const TOKEN = 'tok-abc.def-123';

const SKUS = {
  PLU: ['PLU-843445030108-1', 'PLU', '843445030108', 1],
  LEG: ['LEG-673419373609-2pk', 'LEG', '673419373609', 2],
  IRW: ['IRW-710363598525-2', 'IRW', '710363598525', 2],
  NAT: ['NAT-031604004033-2pk', 'NAT', '031604004033', 2],
  EUC: ['EUC-072140041298-5pk', 'EUC', '072140041298', 5],
  SOL: ['SOL-033984023192-2pk', 'SOL', '033984023192', 2],
};

function sandbox({ token = TOKEN, products = null, status = 200, recent = null } = {}) {
  const els = {};
  const el = id => (els[id] = els[id] || {
    id, value: '', textContent: '', innerHTML: '', style: {},
    classList: { on: false, add() { this.on = true; }, remove() { this.on = false; } },
    addEventListener() {},
  });
  const store = token ? { savvy_session_token: token, savvy_session_user: 'tester' } : {};
  const local = recent ? { inv_recent: JSON.stringify(recent) } : {};
  const calls = [];
  const ctx = {
    els, calls,
    document: { getElementById: el, querySelectorAll: () => ['scr-home', 'scr-login', 'scr-load', 'scr-result', 'scr-notfound'].map(el) },
    sessionStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    localStorage: { getItem: k => (k in local ? local[k] : null), setItem: (k, v) => { local[k] = String(v); }, removeItem: k => { delete local[k]; } },
    window: { addEventListener() {} },
    console: { log() {}, error() {}, warn() {} },
    setTimeout: () => 0, clearTimeout() {},
    URL, Headers, Event: class {}, Html5Qrcode: class {},
    fetch: async (url, opts = {}) => {
      calls.push({ url, opts });
      if (url.includes('/sb/search')) {
        const body = products ? { status: 'success', products } : { status: 'not_found', products: [] };
        const st = products ? status : 404;
        return { ok: st >= 200 && st < 300, status: st, json: async () => body };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  };
  vm.createContext(ctx);
  try { vm.runInContext(appCode, ctx, { timeout: 5000 }); } catch (e) { /* DOM-only init */ }
  return ctx;
}
const searchCalls = ctx => ctx.calls.filter(c => c.url.includes('/sb/search'));
const query = c => Object.fromEntries(new URL(c.url).searchParams);
const prod = sku => ({ sku, name: sku, inventory: { total_quantity: 1, total_on_hand: 1, channels: [{ warehouse_uuid: 'wh-1' }] } });

// ── 1–6, 11–15: parser keeps the exact SKU and derives prefix/UPC/pack ──
for (const [n, [sku, prefix, upc, pack]] of Object.entries(SKUS)) {
  test(`${n}: full SKU preserved and parsed (${sku})`, () => {
    const q = sandbox().parseSearchQuery(sku);
    assert.strictEqual(q.kind, 'sku');
    assert.strictEqual(q.sku, sku, 'exact SKU kept verbatim');
    assert.strictEqual(q.prefix, prefix);
    assert.strictEqual(q.upc, upc);
    assert.strictEqual(q.pack, pack);
  });
}

test('legacy SKU stays legacy, modern stays modern (no -N ↔ -Npk rewrite)', () => {
  const ctx = sandbox();
  assert.strictEqual(ctx.parseSearchQuery('IRW-710363598525-2').sku, 'IRW-710363598525-2');
  assert.strictEqual(ctx.parseSearchQuery('NAT-031604004033-2pk').sku, 'NAT-031604004033-2pk');
  assert.strictEqual(ctx.parseSearchQuery('nat-031604004033-2PK').sku, 'nat-031604004033-2PK', 'case of original kept');
  assert.strictEqual(ctx.parseSearchQuery('nat-031604004033-2PK').prefix, 'NAT');
});

// ── 7–10: UPCs ──
test('12-digit UPC preserved', () => {
  assert.deepStrictEqual({ ...sandbox().parseSearchQuery('673419373609') }, { kind: 'upc', upc: '673419373609', text: '673419373609' });
});
test('leading-zero UPC preserved', () => {
  assert.strictEqual(sandbox().parseSearchQuery('031604004033').upc, '031604004033');
});
test('surrounding whitespace / scanner newline trimmed only', () => {
  const ctx = sandbox();
  assert.strictEqual(ctx.parseSearchQuery('  031604004033\n').upc, '031604004033');
  assert.strictEqual(ctx.parseSearchQuery('\tLEG-673419373609-2pk \r\n').sku, 'LEG-673419373609-2pk');
});
test('no global non-digit stripping', () => {
  const ctx = sandbox();
  assert.strictEqual(ctx.parseSearchQuery('PLU-843445030108-1').upc, '843445030108', 'not 8434450301081');
  assert.strictEqual(ctx.parseSearchQuery('673-419-373609').kind, 'invalid');
  assert.strictEqual(ctx.parseSearchQuery('-843445030108-1').kind, 'invalid');
  assert.ok(!/upc\.replace\(\/\\D\/g/.test(appCode), 'digit-stripping removed from searchUPC');
});

// ── Full SKU → /sb/search?upc=&brand=, exact SKU first ──
test('full SKU queries backend with upc + brand prefix, authenticated', async () => {
  const ctx = sandbox({ products: [prod('LEG-673419373609-1pk'), prod('LEG-673419373609-1'), prod('LEG-673419373609-2pk')] });
  await ctx.searchUPC('LEG-673419373609-2pk');
  const c = searchCalls(ctx);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(new URL(c[0].url).origin + new URL(c[0].url).pathname, BACKEND + '/sb/search');
  assert.deepStrictEqual(query(c[0]), { upc: '673419373609', brand: 'LEG' });
  assert.strictEqual(new Headers(c[0].opts.headers).get('Authorization'), 'Bearer ' + TOKEN);
});
test('exact SKU entered is selected first; other packs still shown', async () => {
  const ctx = sandbox({ products: [prod('LEG-673419373609-1pk'), prod('LEG-673419373609-1'), prod('LEG-673419373609-2pk')] });
  await ctx.searchUPC('LEG-673419373609-2pk');
  assert.strictEqual(ctx.window.loadedProducts[0].sku, 'LEG-673419373609-2pk');
  assert.strictEqual(Object.keys(ctx.window.loadedProducts).length, 3);
  assert.ok(!ctx.els['result-content'].innerHTML.includes('SKU exacto no encontrado'));
});
test('legacy exact SKU selected, not substituted by the modern pack', async () => {
  const ctx = sandbox({ products: [prod('IRW-710363598525-2pk'), prod('IRW-710363598525-2')] });
  await ctx.searchUPC('IRW-710363598525-2');
  assert.strictEqual(ctx.window.loadedProducts[0].sku, 'IRW-710363598525-2');
});
test('exact SKU missing → notice shown with the searched SKU, same-UPC packs listed', async () => {
  const ctx = sandbox({ products: [prod('SOL-033984023192-1pk')] });
  await ctx.searchUPC('SOL-033984023192-2pk');
  assert.ok(ctx.els['result-content'].innerHTML.includes('SKU exacto no encontrado: SOL-033984023192-2pk'));
  assert.strictEqual(ctx.window.loadedProducts[0].sku, 'SOL-033984023192-1pk');
});
test('invalid text → no request, clear message', async () => {
  const ctx = sandbox();
  await ctx.searchUPC('-843445030108-1');
  assert.strictEqual(searchCalls(ctx).length, 0);
  assert.match(ctx.els['toast'].textContent, /UPC.*SKU/);
});

// ── UPC-only: unchanged (no brand invented) ──
test('UPC-only search unchanged: upc only, no brand', async () => {
  for (const upc of ['673419373609', '031604004033']) {
    const ctx = sandbox();
    await ctx.searchUPC(upc);
    assert.deepStrictEqual(query(searchCalls(ctx)[0]), { upc });
  }
});

// ── 16–17: Recent Search ──
test('Recent Search prefers the exact SKU', async () => {
  const ctx = sandbox({ recent: [{ sku: 'PLU-843445030108-1', name: 'x', upc: '843445030108' }] });
  assert.strictEqual(ctx.recentSearchQuery({ sku: 'PLU-843445030108-1', upc: '843445030108' }), 'PLU-843445030108-1');
  ctx.renderRecent();
  assert.ok(ctx.els['recent-searches'].innerHTML.includes('searchRecent(0)'));
  await ctx.searchRecent(0);
  assert.deepStrictEqual(query(searchCalls(ctx)[0]), { upc: '843445030108', brand: 'PLU' });
});
test('Recent Search falls back to UPC when no valid SKU; never flattens a SKU', async () => {
  const ctx = sandbox();
  assert.strictEqual(ctx.recentSearchQuery({ sku: '', upc: '031604004033' }), '031604004033');
  assert.strictEqual(ctx.recentSearchQuery({ sku: 'OLD SCHEME 12', upc: '031604004033' }), '031604004033');
  assert.strictEqual(ctx.recentSearchQuery({ sku: 'LEG-673419373609-2pk', upc: '' }), 'LEG-673419373609-2pk');
});

// ── 18: camera ──
test('camera path unchanged: decoded UPC goes straight to searchUPC', async () => {
  assert.ok(appCode.includes('searchUPC(decodedText.trim());'));
  const ctx = sandbox();
  await ctx.searchUPC('031604004033\n'.trim());
  assert.deepStrictEqual(query(searchCalls(ctx)[0]), { upc: '031604004033' });
});

// ── 20: both fields are text ──
test('manualUpc and scanUpc accept text (no type=number, no numeric keypad)', () => {
  for (const id of ['manualUpc', 'scanUpc']) {
    const tag = html.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>'))[0];
    assert.match(tag, /type="text"/);
    assert.doesNotMatch(tag, /type="number"|inputmode="numeric"/);
  }
});

// ── 19: typing and paste equivalent (real Chromium) ──
const require = createRequire(import.meta.url);
let pw = null;
try { pw = require('playwright'); } catch (e) {
  try { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); } catch (e2) { pw = null; }
}
test('real browser: typed and pasted values are identical and exact', { skip: pw ? false : 'playwright not installed' }, async () => {
  const browser = await pw.chromium.launch();
  try {
    const bctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const sent = [];
    await bctx.route('**/*', r => {
      const u = r.request().url();
      if (u.startsWith('file:')) return r.continue();
      if (u.includes('/sb/search')) { sent.push(Object.fromEntries(new URL(u).searchParams)); return r.fulfill({ status: 404, contentType: 'application/json', body: '{"status":"not_found","products":[]}' }); }
      return r.fulfill({ status: 204, body: '' });
    });
    await bctx.addInitScript(() => { sessionStorage.setItem('savvy_session_token', 'T'); sessionStorage.setItem('savvy_session_user', 'u'); });
    const page = await bctx.newPage();
    await page.goto(pathToFileURL(indexPath).href);
    const cases = [...Object.values(SKUS).map(s => s[0]), '673419373609', '031604004033'];
    for (const id of ['manualUpc', 'scanUpc']) {
      for (const text of cases) {
        const got = {};
        for (const how of ['type', 'paste']) {
          await page.evaluate(id => showScreen(id === 'scanUpc' ? 'scr-scan' : 'scr-home'), id);
          await page.$eval('#' + id, e => { e.value = ''; });
          await page.focus('#' + id);
          if (how === 'paste') { await page.evaluate(t => navigator.clipboard.writeText(t), text); await page.keyboard.press('Control+V'); }
          else await page.keyboard.type(text);
          got[how] = await page.$eval('#' + id, e => e.value);
        }
        assert.strictEqual(got.type, text, `${id} typed ${text}`);
        assert.strictEqual(got.paste, text, `${id} pasted ${text}`);
      }
    }
    sent.length = 0;
    await page.evaluate(() => showScreen('scr-home'));
    await page.$eval('#manualUpc', e => { e.value = ''; });
    await page.focus('#manualUpc');
    await page.evaluate(() => navigator.clipboard.writeText('PLU-843445030108-1'));
    await page.keyboard.press('Control+V');
    await page.evaluate(() => searchManual());
    await page.waitForTimeout(100);
    assert.deepStrictEqual(sent[0], { upc: '843445030108', brand: 'PLU' });
  } finally { await browser.close(); }
});

// ── 21–27: auth, update, exits/QR/multi-location/webhooks unchanged ──
function extract(name, src = appCode) {
  const m = new RegExp('^(async )?function ' + name + '\\s*\\(', 'm').exec(src);
  return src.slice(m.index, src.indexOf('\n}\n', m.index) + 2);
}
const MAIN_CODE = (() => {
  try { return execSync('git show 54e1129:index.html', { cwd: join(__dirname, '..') }).toString().match(/<script>([\s\S]*?)<\/script>/)[1]; }
  catch (e) { return null; }
})();
test('auth code identical to 54e1129 (login, savvyAuthFetch, logout, session)', { skip: MAIN_CODE ? false : 'git history unavailable' }, () => {
  for (const fn of ['getToken', 'getSessionUser', 'isAuthenticated', 'savvyAuthFetch', 'showLoginScreen', 'savvyLogin', 'savvyLogout', 'updateAuthUI']) {
    assert.strictEqual(extract(fn), extract(fn, MAIN_CODE), fn);
  }
});
test('inventory update still authenticated and payload unchanged', async () => {
  assert.ok(!MAIN_CODE || extract('updateInventory') === extract('updateInventory', MAIN_CODE), 'updateInventory byte-identical');
  const ctx = sandbox();
  vm.runInContext('window.loadedProducts = { 0: { sku: "LEG-673419373609-2pk", warehouse_uuid: "wh-1", inputId: "qty-0" } };', ctx);
  ctx.els['qty-0'] = { value: '77' };
  await ctx.updateInventory(0);
  const c = ctx.calls.find(x => x.url.endsWith('/sb/update-inventory'));
  assert.strictEqual(new Headers(c.opts.headers).get('Authorization'), 'Bearer ' + TOKEN);
  assert.deepStrictEqual(JSON.parse(c.opts.body), { sku: 'LEG-673419373609-2pk', warehouse_uuid: 'wh-1', quantity: 77 });
});
test('401 on search unchanged: session cleared, next search asks for login', async () => {
  // Same as 54e1129: savvyAuthFetch clears the session; searchUPC's catch
  // then returns to Home; the next search attempt opens the login screen.
  const ctx = sandbox({ products: [], status: 401 });
  await ctx.searchUPC('LEG-673419373609-2pk');
  assert.strictEqual(ctx.sessionStorage.getItem('savvy_session_token'), null);
  ctx.els['scr-login'].classList.on = false;
  await ctx.searchUPC('LEG-673419373609-2pk');
  assert.ok(ctx.els['scr-login'].classList.on);
  assert.strictEqual(searchCalls(ctx).length, 1, 'no request without session');
});
test('exits, QR, multi-location and webhooks unchanged vs 54e1129', { skip: MAIN_CODE ? false : 'git history unavailable' }, () => {
  const fns = ['exitSubmit', 'manualExitSubmit', 'exitModalOpen', 'startScanner', 'stopScanner', 'locModalOpen', 'locModalQRCapture',
    'saveLocations', 'loadLocationsList', 'loadLocation', 'saveLocation', 'loadEbayDates', 'loadEbaySales'];
  for (const fn of fns) {
    if (!new RegExp('function ' + fn + '\\s*\\(').test(MAIN_CODE)) continue;
    assert.strictEqual(extract(fn), extract(fn, MAIN_CODE), fn);
  }
  const hook = s => s.match(/const EXIT_WEBHOOK_URL = [^\n]+/)[0];
  assert.strictEqual(hook(appCode), hook(MAIN_CODE));
  assert.strictEqual((appCode.match(/fetch\(EXIT_WEBHOOK_URL/g) || []).length, 2);
});
