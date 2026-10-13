// ═══════════════════════════════════════════════════════════════
// ShiftComp — Payroll Regression Suite
// ═══════════════════════════════════════════════════════════════
// Loads the REAL index.html sitting next to this file and calls its
// actual pay-calculation functions (calcGross, isHolidayDate, ...)
// directly. No copied-out math, no build step, no npm install — just
// Node's built-in `vm` and `assert` modules.
//
// Run it:
//   node regression-tests.js
//
// It exits with code 0 if every case passes, 1 if anything fails —
// safe to run before every push as a "did I break anything" check.
//
// ADDING A NEW CASE: every time a new payroll rule is discovered,
// add a case to the TEST CASES list at the bottom. Each case gets:
//   - a settings object (rates, bid schedule)
//   - a shifts map for calcGross(shifts, settings, rateChangeDate)
//   - expected { regHrs, otHrs, dtHrs, gross }
// Use the setBidSchedule()/baseSettings() helpers below to build the
// settings object — they handle the "is this date a scheduled workday"
// wiring so you don't have to hand-compute day-of-week.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// ── Minimal in-memory localStorage/sessionStorage stub ───────────
function makeStorage() {
  const store = new Map();
  return {
    getItem:    k => (store.has(k) ? store.get(k) : null),
    setItem:    (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear:      () => store.clear(),
  };
}

// ── Minimal fake DOM element/document — just enough that the app's
//    init() doesn't throw *before* it reaches the point where every
//    top-level function we care about already exists. Function
//    declarations are hoisted for the whole script, so even if init()
//    throws partway through (because our DOM stub is intentionally
//    thin), calcGross/isHolidayDate/etc. are already defined and
//    callable by the time we read them off the sandbox. ─────────────
function makeFakeElement() {
  const el = {
    classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    style: {},
    dataset: {},
    children: [],
    addEventListener(){},
    removeEventListener(){},
    appendChild(){},
    querySelector: () => makeFakeElement(),
    querySelectorAll: () => [],
    remove(){},
  };
  Object.defineProperty(el, 'textContent', { get(){ return ''; }, set(){} });
  Object.defineProperty(el, 'innerHTML',   { get(){ return ''; }, set(){} });
  Object.defineProperty(el, 'value',       { get(){ return ''; }, set(){} });
  return el;
}

function loadAppContext() {
  const htmlPath = path.join(__dirname, 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>\s*<!--[^>]*offline indicator/i)
             || html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Could not find the inline <script> block in index.html');
  const source = match[1];

  const fakeDocument = {
    getElementById: () => makeFakeElement(),
    createElement:  () => makeFakeElement(),
    querySelector:  () => makeFakeElement(),
    querySelectorAll: () => [],
    addEventListener(){},
  };

  const sandbox = {
    console,
    document: fakeDocument,
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    navigator: { onLine: true },
    setTimeout,
    clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.self   = sandbox;
  vm.createContext(sandbox);

  try {
    vm.runInContext(source, sandbox, { filename: 'index.html (inline script)' });
  } catch (e) {
    // Expected: our DOM stub is deliberately thin and init() will hit
    // something it doesn't like near the very end of the script. That's
    // fine — see the comment on makeFakeElement() above.
  }

  return sandbox;
}

const app = loadAppContext();
for (const fn of ['calcGross', 'isHolidayDate', 'getHolidayName', 'getBidForDate']) {
  if (typeof app[fn] !== 'function') {
    console.error(`FATAL: index.html did not expose ${fn}() — app structure may have changed.`);
    process.exit(1);
  }
}

// ── Test settings helpers ─────────────────────────────────────────
const RATE_NEW = 40.31;   // Apr 1 2026 onward
const RATE_OLD = 39.14;   // pre-Apr 1 2026
const RATE_CHANGE_DATE = '2026-04-01';

function baseSettings(overrides = {}) {
  return Object.assign({
    'rate-regular':     RATE_NEW,
    'rate-regular-old': RATE_OLD,
    'ot-mult':          1.5,
    'dt-mult':          2.0,
    'bid-curr-start':   '2000-01-01',
    'bid-curr-times':   ['08:00','08:00','08:00','08:00','08:00','08:00','08:00'],
  }, overrides);
}

// Writes settings into the sandbox's localStorage (getBidForDate() reads
// bid times from there via getSettings()) and returns the same object,
// for passing directly as calcGross()'s settings argument.
function useSettings(settings) {
  app.localStorage.setItem('shiftpay-settings', JSON.stringify(settings));
  return settings;
}

// Returns a settings object with the given date's day-of-week marked as
// a scheduled day off (blank start time), everything else worked.
function settingsWithDayOff(dateStr, overrides = {}) {
  const dow = new Date(dateStr + 'T12:00:00').getDay();
  const times = ['08:00','08:00','08:00','08:00','08:00','08:00','08:00'];
  times[dow] = '';
  return baseSettings(Object.assign({ 'bid-curr-times': times }, overrides));
}

function getRateChangeDateObj() {
  return new Date(RATE_CHANGE_DATE + 'T00:00:00');
}

// For cases that aren't testing the rate-change feature itself, pass a
// rate-change date far in the past so every shift simply uses the
// "current" rate — mirrors a settings object with no rate change configured.
function getNoRateChangeDateObj() {
  return new Date('2000-01-01T00:00:00');
}

function closeEnough(a, b, eps = 0.01) {
  return Math.abs(a - b) < eps;
}

// ═══════════════════════════════════════════════════════════════
// TEST CASES
// ═══════════════════════════════════════════════════════════════
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

test('Normal scheduled day → 8 REG', () => {
  const settings = useSettings(baseSettings());
  const date = '2026-03-10'; // Tuesday, not a holiday
  const shifts = { [date]: { otHrs: 0, dtHrs: 0, lwopHrs: 0 } };
  const r = app.calcGross(shifts, settings, getNoRateChangeDateObj());
  assert.ok(closeEnough(r.regHrs, 8), `regHrs expected 8, got ${r.regHrs}`);
  assert.ok(closeEnough(r.otHrs, 0), `otHrs expected 0, got ${r.otHrs}`);
  assert.ok(closeEnough(r.dtHrs, 0), `dtHrs expected 0, got ${r.dtHrs}`);
  assert.ok(closeEnough(r.gross, 8 * RATE_NEW), `gross expected ${8 * RATE_NEW}, got ${r.gross}`);
});

test('OT logged on a scheduled day off → correct REG/OT split (Item 2 fix, regression-locked)', () => {
  const date = '2026-03-08'; // a Sunday — off day in this test's bid schedule
  const settings = useSettings(settingsWithDayOff(date));
  const shifts = { [date]: { otHrs: 4, dtHrs: 0, lwopHrs: 0 } };
  const r = app.calcGross(shifts, settings, getNoRateChangeDateObj());
  assert.ok(closeEnough(r.regHrs, 0), `regHrs expected 0, got ${r.regHrs}`);
  assert.ok(closeEnough(r.otHrs, 4), `otHrs expected 4, got ${r.otHrs}`);
  assert.ok(closeEnough(r.gross, 4 * RATE_NEW * 1.5), `gross expected ${4 * RATE_NEW * 1.5}, got ${r.gross}`);
});

test('8 regular + 2 voluntary OT → correct pay', () => {
  const settings = useSettings(baseSettings());
  const date = '2026-03-10';
  const shifts = { [date]: { otHrs: 2, dtHrs: 0, lwopHrs: 0 } };
  const r = app.calcGross(shifts, settings, getNoRateChangeDateObj());
  const expectedGross = (8 * RATE_NEW) + (2 * RATE_NEW * 1.5);
  assert.ok(closeEnough(r.regHrs, 8), `regHrs expected 8, got ${r.regHrs}`);
  assert.ok(closeEnough(r.otHrs, 2), `otHrs expected 2, got ${r.otHrs}`);
  assert.ok(closeEnough(r.gross, expectedGross), `gross expected ${expectedGross}, got ${r.gross}`);
});

test('Gave away complete shift → 0 REG', () => {
  const settings = useSettings(baseSettings());
  const date = '2026-03-10';
  const shifts = { [date]: { otHrs: 0, dtHrs: 0, lwopHrs: 0, gaveHrs: 8 } };
  const r = app.calcGross(shifts, settings, getNoRateChangeDateObj());
  assert.ok(closeEnough(r.regHrs, 0), `regHrs expected 0, got ${r.regHrs}`);
  assert.ok(closeEnough(r.gross, 0), `gross expected 0, got ${r.gross}`);
});

test('Gave away partial (4 hrs) → correct remaining hours', () => {
  const settings = useSettings(baseSettings());
  const date = '2026-03-10';
  const shifts = { [date]: { otHrs: 0, dtHrs: 0, lwopHrs: 0, gaveHrs: 4 } };
  const r = app.calcGross(shifts, settings, getNoRateChangeDateObj());
  assert.ok(closeEnough(r.regHrs, 4), `regHrs expected 4, got ${r.regHrs}`);
  assert.ok(closeEnough(r.gross, 4 * RATE_NEW), `gross expected ${4 * RATE_NEW}, got ${r.gross}`);
});

test('Picked up shift on a day off → correct pay classification', () => {
  const date = '2026-03-08'; // Sunday, off day
  const settings = useSettings(settingsWithDayOff(date));
  const shifts = { [date]: { otHrs: 0, dtHrs: 0, lwopHrs: 0, pickupHrs: 6 } };
  const r = app.calcGross(shifts, settings, getNoRateChangeDateObj());
  // Pickup hours are paid at regular rate and land in the regHrs bucket
  assert.ok(closeEnough(r.regHrs, 6), `regHrs expected 6, got ${r.regHrs}`);
  assert.ok(closeEnough(r.otHrs, 0), `otHrs expected 0, got ${r.otHrs}`);
  assert.ok(closeEnough(r.gross, 6 * RATE_NEW), `gross expected ${6 * RATE_NEW}, got ${r.gross}`);
});

test('Mandatory DT → correct 2x classification', () => {
  const settings = useSettings(baseSettings());
  const date = '2026-03-10';
  const shifts = { [date]: { otHrs: 0, dtHrs: 3, lwopHrs: 0 } };
  const r = app.calcGross(shifts, settings, getNoRateChangeDateObj());
  const expectedGross = (8 * RATE_NEW) + (3 * RATE_NEW * 2.0);
  assert.ok(closeEnough(r.regHrs, 8), `regHrs expected 8, got ${r.regHrs}`);
  assert.ok(closeEnough(r.dtHrs, 3), `dtHrs expected 3, got ${r.dtHrs}`);
  assert.ok(closeEnough(r.gross, expectedGross), `gross expected ${expectedGross}, got ${r.gross}`);
});

test('Rate change mid-pay-period → correct rate applied per shift', () => {
  const settings = useSettings(baseSettings({ 'rate-change-date': RATE_CHANGE_DATE }));
  const beforeDate = '2026-03-31'; // pre-change → old rate
  const afterDate  = '2026-04-01'; // change date itself → new rate
  const shifts = {
    [beforeDate]: { otHrs: 0, dtHrs: 0, lwopHrs: 0 },
    [afterDate]:  { otHrs: 0, dtHrs: 0, lwopHrs: 0 },
  };
  const r = app.calcGross(shifts, settings, getRateChangeDateObj());
  const expectedGross = (8 * RATE_OLD) + (8 * RATE_NEW);
  assert.ok(closeEnough(r.regHrs, 16), `regHrs expected 16, got ${r.regHrs}`);
  assert.ok(closeEnough(r.gross, expectedGross), `gross expected ${expectedGross}, got ${r.gross}`);
});

test("Holiday worked (Mother's Day) → hours land in OT bucket, not Regular, at 1.5x", () => {
  const date = '2026-05-10'; // Mother's Day 2026 — a Sunday, scheduled worked in this test
  assert.ok(app.isHolidayDate(date), 'expected 2026-05-10 to be recognized as a holiday');
  const settings = useSettings(baseSettings()); // all 7 days scheduled, including Sunday
  const shifts = { [date]: { otHrs: 0, dtHrs: 0, lwopHrs: 0 } };
  const r = app.calcGross(shifts, settings, getNoRateChangeDateObj());
  assert.ok(closeEnough(r.regHrs, 0), `regHrs expected 0, got ${r.regHrs}`);
  assert.ok(closeEnough(r.otHrs, 8), `otHrs expected 8, got ${r.otHrs}`);
  assert.ok(closeEnough(r.gross, 8 * RATE_NEW * 1.5), `gross expected ${8 * RATE_NEW * 1.5}, got ${r.gross}`);
});

test('Holiday date recognition → all four qualifying holidays for a sample year', () => {
  const expected = {
    '2026-01-01': "New Year's Day",
    '2026-07-04': 'Independence Day',
    '2026-05-10': "Mother's Day",
    '2026-06-21': "Father's Day",
  };
  for (const [date, name] of Object.entries(expected)) {
    assert.ok(app.isHolidayDate(date), `expected ${date} to be a recognized holiday`);
    assert.strictEqual(app.getHolidayName(date), name, `expected ${date} to be named "${name}"`);
  }
  assert.ok(!app.isHolidayDate('2026-05-17'), 'the Sunday after Mother\'s Day should not be a holiday');
});

// ── Install gate (onboarding, not payroll, but cheap to lock down) ──
const UA = {
  iosSafari:   'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iosChrome:   'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.0.0 Mobile/15E148 Safari/604.1',
  iosFacebook: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/500.0.0.0]',
  ipadOS:      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  android:     'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
  androidIG:   'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.0.0 Mobile Safari/537.36 Instagram 350.0.0.0',
  desktop:     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
};

test('Install gate → user agent picks the right screen', () => {
  const d = app.detectInstallEnv;
  assert.strictEqual(d(UA.iosFacebook, 'iPhone', 5, false), 'inapp');
  assert.strictEqual(d(UA.androidIG, 'Linux armv8l', 5, true), 'inapp');
  assert.strictEqual(d(UA.iosSafari, 'iPhone', 5, false), 'ios-safari');
  assert.strictEqual(d(UA.iosChrome, 'iPhone', 5, false), 'ios-other');
  assert.strictEqual(d(UA.ipadOS, 'MacIntel', 5, false), 'ios-safari');
  assert.strictEqual(d(UA.ipadOS, 'MacIntel', 0, false), 'desktop', 'a real Mac (no touch) is desktop');
  assert.strictEqual(d(UA.android, 'Linux armv8l', 5, true), 'android-prompt');
  assert.strictEqual(d(UA.android, 'Linux armv8l', 5, false), 'android-manual');
  assert.strictEqual(d(UA.desktop, 'Win32', 0, true), 'desktop');
});

test('Install gate → only for new, non-installed, non-skipped phone visitors', () => {
  const g = app.shouldShowInstallGate;
  assert.strictEqual(g(false, false, false, 'ios-safari'), true);
  assert.strictEqual(g(true,  false, false, 'ios-safari'), false, 'existing settings: no gate');
  assert.strictEqual(g(false, true,  false, 'android-manual'), false, 'running installed: wizard instead');
  assert.strictEqual(g(false, false, true,  'inapp'), false, 'already skipped: wizard instead');
  assert.strictEqual(g(false, false, false, 'desktop'), false, 'desktop: wizard instead');
});

// ── Gross-only mode (deductions skipped in setup) ─────────────────
test('Gross-only → settings with no gross-only key stay in net mode (existing users)', () => {
  const legacy = baseSettings({ medical: 120, 'fed-wh': 300 }); // no 'gross-only' key at all
  assert.strictEqual(app.isGrossOnly(legacy), false);
  assert.strictEqual(app.isGrossOnly({}), false);
  assert.strictEqual(app.isGrossOnly(null), false);
  // getSettings() fills the default for a stored object that predates the key
  app.localStorage.setItem('shiftpay-settings', JSON.stringify(legacy));
  assert.strictEqual(app.isGrossOnly(app.getSettings()), false);
});

test('Gross-only → true reports gross-only, false does not', () => {
  assert.strictEqual(app.isGrossOnly(baseSettings({ 'gross-only': true })), true);
  assert.strictEqual(app.isGrossOnly(baseSettings({ 'gross-only': false })), false);
  assert.strictEqual(app.isGrossOnly(baseSettings({ 'gross-only': 'true' })), false, 'only a real boolean true counts');
});

test('Gross-only → saving any nonzero deduction or withholding clears it', () => {
  const r = app.resolveGrossOnlyOnSave;
  assert.strictEqual(r(true, baseSettings()), true, 'still nothing entered: stays gross-only');
  for (const k of ['medical', 'dental', 'vision', 'add', '401k-pct', '401k-loan',
                   'stock', 'union', 'other-aftertax', 'casdi', 'fed-wh', 'ca-wh']) {
    assert.strictEqual(r(true, baseSettings({ [k]: 5 })), false, `${k} > 0 should clear gross-only`);
  }
  assert.strictEqual(r(false, baseSettings()), false, 'net-mode users never get switched into gross-only');
});

test('Wizard bid step → needs a start date and at least one working day', () => {
  const e = app.wizBidStepError;
  const blank = ['', '', '', '', '', '', ''];
  const oneDay = ['', '08:00', '', '', '', '', ''];
  assert.ok(e('', blank), 'empty step is blocked');
  assert.ok(e('2026-10-04', blank), 'no working days is blocked');
  assert.ok(e('', oneDay), 'no start date is blocked');
  assert.strictEqual(e('2026-10-04', oneDay), '');
});

// ═══════════════════════════════════════════════════════════════
// RUNNER
// ═══════════════════════════════════════════════════════════════
let failed = 0;
for (const { name, fn } of cases) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
  }
}

console.log('');
console.log(`${cases.length - failed}/${cases.length} passed`);
process.exit(failed > 0 ? 1 : 0);