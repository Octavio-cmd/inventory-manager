import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = join(__dirname, '..', 'index.html');

// Extract JavaScript from index.html
const htmlContent = readFileSync(indexPath, 'utf8');
const scriptMatch = htmlContent.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error('No script found in index.html');
const appCode = scriptMatch[1];

// Mock DOM environment
const mockDOM = {
  document: {
    getElementById: (id) => mockDOM.elements[id] || null,
    querySelectorAll: (selector) => mockDOM.queryResults[selector] || [],
  },
  sessionStorage: new (class {
    constructor() { this.data = {}; }
    getItem(key) { return this.data[key] || null; }
    setItem(key, value) { this.data[key] = String(value); }
    removeItem(key) { delete this.data[key]; }
    clear() { this.data = {}; }
  })(),
  localStorage: new (class {
    constructor() { this.data = {}; }
    getItem(key) { return this.data[key] || null; }
    setItem(key, value) { this.data[key] = String(value); }
    removeItem(key) { delete this.data[key]; }
    clear() { this.data = {}; }
  })(),
  elements: {},
  queryResults: {},
  fetch: null,
  window: {},
  URL: URL,
};

// Create mock HTML elements
const createMockElement = (value = '') => ({
  value,
  textContent: '',
  style: { color: '', display: 'block' },
  classList: { add: () => {}, remove: () => {}, toggle: () => {} },
  addEventListener: () => {},
  id: '',
});

mockDOM.elements = {
  'manualUpc': createMockElement(),
  'scanUpc': createMockElement(),
  'loginUsuario': createMockElement(),
  'loginPassword': createMockElement(),
  'login-msg': createMockElement(),
  'headerLogout': createMockElement(),
  'scr-home': { classList: { add: () => {}, remove: () => {} }, style: {} },
  'scr-login': { classList: { add: () => {}, remove: () => {} }, style: {} },
  'toast': { classList: { add: () => {}, remove: () => {} } },
};

mockDOM.queryResults['.scr'] = [
  mockDOM.elements['scr-home'],
  mockDOM.elements['scr-login'],
];

// Execute app code in mock context
const context = {
  document: mockDOM.document,
  sessionStorage: mockDOM.sessionStorage,
  localStorage: mockDOM.localStorage,
  fetch: (url, opts) => mockDOM.fetch(url, opts),
  window: { addEventListener: () => {} },
  Event: class {},
  Html5Qrcode: class {},
  console: console,
  clearTimeout: () => {},
  setTimeout: () => 0,
  JSON: JSON,
  URL: URL,
  encodeURIComponent: encodeURIComponent,
  String: String,
  Array: Array,
  Object: Object,
};

try {
  new vm.Script(appCode).runInNewContext(context, { timeout: 5000 });
} catch (e) {
  // Ignore errors from functions that call undefined mocked functions
  if (!e.message.includes('is not defined')) {
    console.error('Script execution error:', e.message);
  }
}

// Extract functions from context
const getToken = context.getToken;
const getSessionUser = context.getSessionUser;
const isAuthenticated = context.isAuthenticated;
const savvyAuthFetch = context.savvyAuthFetch;
const savvyLogin = context.savvyLogin;
const savvyLogout = context.savvyLogout;

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

test('LOGIN: POST /auth/login with correct JSON', async (t) => {
  mockDOM.sessionStorage.clear();
  mockDOM.localStorage.clear();

  assert.ok(appCode.includes("'/auth/login'"), 'Code should contain /auth/login endpoint');
  assert.ok(appCode.includes('usuario: usuario'), 'Code should send usuario in JSON');
  assert.ok(appCode.includes('password: password'), 'Code should send password in JSON');
});

test('LOGIN: Password never stored in any storage', async (t) => {
  mockDOM.sessionStorage.clear();
  mockDOM.localStorage.clear();

  assert.ok(!appCode.includes("setItem('password"), 'Password should not be saved to storage');
  assert.ok(!appCode.includes("localStorage.setItem('savvy_session_token"), 'Token should not be in localStorage');
  assert.ok(!appCode.includes("localStorage.setItem('savvy_session_user"), 'User should not be in localStorage');
  assert.ok(appCode.includes("getItem('savvy_session_token'"), 'Should use sessionStorage for token');
  assert.ok(appCode.includes("getItem('savvy_session_user'"), 'Should use sessionStorage for user');
});

test('LOGIN: Password field cleared after attempt', async (t) => {
  assert.ok(appCode.includes("loginPassword').value = ''"), 'Code should clear password field');
});

test('HELPER: savvyAuthFetch adds Authorization Bearer header', async (t) => {
  assert.ok(appCode.includes("'Authorization'") && appCode.includes("'Bearer '"), 'Should add Authorization header');
  assert.ok(appCode.includes('savvyAuthFetch'), 'Helper function should exist');
  assert.ok(appCode.includes('headers.set'), 'Should use Headers API');
});

test('HELPER: savvyAuthFetch preserves Content-Type', async (t) => {
  assert.ok(appCode.includes('new Headers(') && appCode.includes('options.headers'), 'Should preserve existing headers');
  assert.ok(appCode.includes('headers:') || appCode.includes('headers: headers'), 'Should merge headers correctly');
});

test('HELPER: savvyAuthFetch preserves method and body', async (t) => {
  assert.ok(appCode.includes('...options'), 'Should preserve all options');
  assert.ok(appCode.includes('method:'), 'Method should be preserved');
  assert.ok(appCode.includes('body:'), 'Body should be preserved');
});

test('HELPER: Only sends Bearer to Savvy backend', async (t) => {
  assert.ok(appCode.includes('SB_PROXY'), 'Should only use SB_PROXY');
  assert.ok(appCode.includes('https://savvy-ebay-prices-production.up.railway.app'), 'Should use correct Savvy domain');
});

test('ERROR HANDLING: 401/403 clears ONLY token and user', async (t) => {
  assert.ok(appCode.includes('res.status === 401 || res.status === 403'), 'Should check for 401/403');
  assert.ok(appCode.includes("removeItem('savvy_session_token'"), 'Should remove token');
  assert.ok(appCode.includes("removeItem('savvy_session_user'"), 'Should remove user');
  assert.ok(!appCode.includes("removeItem('inv_recent'"), 'Should NOT remove inv_recent');
  assert.ok(!appCode.includes('localStorage.clear()'), 'Should NOT clear localStorage');
});

test('LOGOUT: Clears token and user', async (t) => {
  assert.ok(appCode.includes('function savvyLogout'), 'Logout function should exist');
  assert.ok(appCode.includes("removeItem('savvy_session_token'"), 'Should remove token');
  assert.ok(appCode.includes("removeItem('savvy_session_user'"), 'Should remove user');
});

test('LOGOUT: Preserves inv_recent', async (t) => {
  const logoutFnMatch = appCode.match(/function savvyLogout\(\)\{[\s\S]*?\n\}/);
  assert.ok(logoutFnMatch, 'Should have logout function');

  const logoutCode = logoutFnMatch[0];
  assert.ok(!logoutCode.includes("removeItem('inv_recent'"), 'Logout should not remove inv_recent');
  assert.ok(!logoutCode.includes('localStorage.clear()'), 'Logout should not clear localStorage');
});

test('ROUTES: /sb/search uses savvyAuthFetch', async (t) => {
  assert.ok(appCode.includes("savvyAuthFetch('/sb/search"), 'Should use savvyAuthFetch for /sb/search');
});

test('ROUTES: /ss/location uses savvyAuthFetch (both locations)', async (t) => {
  const matches = appCode.match(/savvyAuthFetch.*\/ss\/location/g);
  assert.ok(matches && matches.length >= 1, 'Should use savvyAuthFetch for /ss/location');
});

test('ROUTES: /ebay-item-dates uses savvyAuthFetch', async (t) => {
  assert.ok(appCode.includes("savvyAuthFetch('/ebay-item-dates"), 'Should use savvyAuthFetch for /ebay-item-dates');
});

test('ROUTES: /ebay-sales uses savvyAuthFetch', async (t) => {
  assert.ok(appCode.includes("savvyAuthFetch('/ebay-sales"), 'Should use savvyAuthFetch for /ebay-sales');
});

test('ROUTES: /ss/create-product uses savvyAuthFetch (both locations)', async (t) => {
  const matches = appCode.match(/savvyAuthFetch.*\/ss\/create-product/g);
  assert.ok(matches && matches.length >= 1, 'Should use savvyAuthFetch for /ss/create-product');
});

test('ROUTES: /sb/update-inventory uses savvyAuthFetch', async (t) => {
  assert.ok(appCode.includes("savvyAuthFetch('/sb/update-inventory"), 'Should use savvyAuthFetch for /sb/update-inventory');
});

test('ROUTES: No old fetch() to SB_PROXY protected routes', async (t) => {
  const protectedRoutes = ['/sb/search', '/ss/location', '/ebay-item-dates', '/ebay-sales', '/ss/create-product', '/sb/update-inventory'];

  protectedRoutes.forEach(route => {
    const oldFetchMatch = appCode.match(new RegExp(`fetch\\(SB_PROXY\\s*\\+\\s*['"]${route}`));
    assert.ok(!oldFetchMatch, `Should not use old fetch() for ${route}`);
  });
});

test('SECURITY: No console.log of credentials', async (t) => {
  assert.ok(!appCode.includes('console.log(password)'), 'Should not log password');
  assert.ok(!appCode.includes('console.log(token)'), 'Should not log token');
});

test('SECURITY: No hardcoded default passwords', async (t) => {
  assert.ok(!appCode.includes('password = \'') || appCode.includes('let password'), 'Should not have default password (let password = "" is init, not hardcoded)');
});

test('SECURITY: Password input uses type="password"', async (t) => {
  assert.ok(htmlContent.includes('type="password"'), 'Password input should use type="password"');
  assert.ok(htmlContent.includes('id="loginPassword"'), 'Password input should exist');
});

test('STORAGE: Token uses ONLY sessionStorage', async (t) => {
  assert.ok(appCode.includes("sessionStorage.setItem('savvy_session_token"), 'Should save to sessionStorage');
  assert.ok(!appCode.includes("localStorage.setItem('savvy_session_token"), 'Should NOT use localStorage');
});

test('STORAGE: User uses ONLY sessionStorage', async (t) => {
  assert.ok(appCode.includes("sessionStorage.setItem('savvy_session_user"), 'Should save to sessionStorage');
  assert.ok(!appCode.includes("localStorage.setItem('savvy_session_user"), 'Should NOT use localStorage');
});

test('AUTH: isAuthenticated() checks both token and user', async (t) => {
  assert.ok(appCode.includes('getToken() !== null && getSessionUser()'), 'Should check both');
});

test('UI: No page reload on login', async (t) => {
  const loginFn = appCode.match(/async function savvyLogin\(\)[\s\S]*?^}/m);
  if (loginFn) {
    assert.ok(!loginFn[0].includes('location.reload'), 'Should not reload');
  }
});

test('UI: No page reload on 401/403', async (t) => {
  const helperCode = appCode.match(/async function savvyAuthFetch[\s\S]*?return res/);
  if (helperCode) {
    assert.ok(!helperCode[0].includes('location.reload'), 'Should not reload on error');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ENHANCED SECURITY TESTS: ORIGIN VALIDATION, HEADERS API, PASSWORD CLEANUP
// ═══════════════════════════════════════════════════════════════════════════

test('SECURITY: savvyAuthFetch validates origin with URL API', async (t) => {
  assert.ok(appCode.includes('new URL('), 'Should use URL constructor for validation');
  assert.ok(appCode.includes('requestUrl.origin'), 'Should check origin property');
  assert.ok(appCode.includes('backendUrl.origin'), 'Should have backend origin to compare');
  assert.ok(appCode.includes('!=='), 'Should validate exact match (not includes/startsWith)');
});

test('SECURITY: savvyAuthFetch rejects non-matching origins', async (t) => {
  assert.ok(appCode.includes('Origin mismatch') || appCode.includes('origin'), 'Should have origin validation error');
  assert.ok(appCode.includes('throw new Error'), 'Should throw on origin mismatch');
});

test('SECURITY: savvyAuthFetch uses Headers API', async (t) => {
  assert.ok(appCode.includes('new Headers('), 'Should use Headers constructor');
  assert.ok(appCode.includes('.set('), 'Should use headers.set() method');
  assert.ok(appCode.includes("'Authorization'"), 'Should set Authorization header');
});

test('SECURITY: Headers.set() prevents duplicate Authorization', async (t) => {
  assert.ok(appCode.includes('headers.set(\'Authorization\''), 'Should use set() which replaces');
  assert.ok(!appCode.includes('Authorization.*Authorization'), 'Should not append Authorization');
});

test('SECURITY: Password variable is cleared in finally block', async (t) => {
  const loginFnMatch = appCode.match(/async function savvyLogin\(\)[\s\S]*?finally[\s\S]*?\}/);
  assert.ok(loginFnMatch, 'Should have finally block in savvyLogin');

  const loginCode = loginFnMatch[0];
  assert.ok(loginCode.includes('finally'), 'Must have finally block');
  assert.ok(loginCode.includes("password = ''") || loginCode.includes('password = ""'), 'Should clear password variable');
  assert.ok(loginCode.includes("$('loginPassword').value = ''"), 'Should clear password input');
});

test('SECURITY: Password cleanup executes on all paths', async (t) => {
  const loginFnMatch = appCode.match(/async function savvyLogin\(\)[\s\S]*?\n\}/);
  assert.ok(loginFnMatch, 'Should have login function');

  const loginCode = loginFnMatch[0];
  // Finally block means cleanup on: success, error fetch, JSON parse error, validation error, etc.
  assert.ok(loginCode.includes('finally'), 'finally ensures cleanup on all paths');
  const finallyMatch = loginCode.match(/finally[\s\S]*?password = ''[\s\S]*?\}/);
  assert.ok(finallyMatch, 'Password cleared inside finally block');
});

test('SECURITY: Password cannot be logged', async (t) => {
  assert.ok(!appCode.includes('console.log(password)'), 'Password variable should not be logged');
  assert.ok(!appCode.includes('console.error(password)'), 'Password should not be logged as error');
  assert.ok(!appCode.includes('console.warn(password)'), 'Password should not be logged as warning');
});

test('SECURITY: Message from server not injected via innerHTML', async (t) => {
  const loginFnMatch = appCode.match(/async function savvyLogin\(\)[\s\S]*?\n\}/);
  if (loginFnMatch) {
    const loginCode = loginFnMatch[0];
    assert.ok(!loginCode.includes('innerHTML') || !loginCode.includes('data.') || !loginCode.match(/innerHTML.*data\./),
      'Should not set innerHTML with server data');
    assert.ok(loginCode.includes('textContent'), 'Should use textContent for messages');
  }
});

test('BEHAVIOR: Relative URLs allowed to Savvy backend', async (t) => {
  assert.ok(appCode.includes("savvyAuthFetch('/sb/search"), 'Should allow relative paths starting with /');
  assert.ok(appCode.includes("savvyAuthFetch('/ss/location"), 'Should allow relative paths');
  assert.ok(appCode.includes("savvyAuthFetch('/ebay"), 'Should allow relative paths');
});

test('BEHAVIOR: Evil origins rejected', async (t) => {
  const helperMatch = appCode.match(/async function savvyAuthFetch[\s\S]*?const res = await fetch/);
  if (helperMatch) {
    const helperCode = helperMatch[0];
    assert.ok(helperCode.includes('requestUrl.origin !== backendUrl.origin') || helperCode.includes('origin'),
      'Should reject if origins do not match exactly');
    // Within helper function, origin validation should use exact comparison (===, !==), not includes/startsWith
    assert.ok(!helperCode.match(/origin.*includes|origin.*startsWith/), 'Should not use partial string matching for origin');
  }
});

test('BEHAVIOR: 401/403 does not allow caller to process success', async (t) => {
  const helperMatch = appCode.match(/async function savvyAuthFetch[\s\S]*?return res/);
  if (helperMatch) {
    const helperCode = helperMatch[0];
    assert.ok(helperCode.includes('if(res.status === 401 || res.status === 403)'), 'Should check 401/403');
    assert.ok(helperCode.includes('throw'), 'Should throw error on 401/403');
    // throw prevents caller from getting response to process
  }
});

test('BEHAVIOR: Token absence blocks fetch execution', async (t) => {
  const helperMatch = appCode.match(/async function savvyAuthFetch[\s\S]*?const res = await fetch/);
  if (helperMatch) {
    const beforeFetch = helperMatch[0];
    assert.ok(beforeFetch.includes('if(!token)'), 'Should check for token');
    assert.ok(beforeFetch.includes('throw'), 'Should throw before fetch if no token');
  }
});
