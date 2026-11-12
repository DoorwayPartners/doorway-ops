'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../apps-script/Core.js');
const DEMO = require('../docs/demo-data.js');

const clone = (x) => JSON.parse(JSON.stringify(x));
const raw = () => clone(DEMO.raw);
const T = DEMO.TODAY;

// Deep-collect every key and every string value in a payload.
function walk(v, keys, strings) {
  if (Array.isArray(v)) v.forEach((x) => walk(x, keys, strings));
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) { keys.add(k); walk(v[k], keys, strings); }
  else if (typeof v === 'string') strings.push(v.toLowerCase());
}
function scan(payload) { const keys = new Set(), strings = []; walk(payload, keys, strings); return { keys, strings, json: JSON.stringify(payload).toLowerCase() }; }

const MARGINS = ['Gross_Agency_Rev', 'Net_Agency_Spread', 'grossAgencyRevInstalled', 'netSpreadInstalled', 'netSpreadCleared', 'financials', 'expenses', 'expensesMTD'];

function assertNoMargins(payload) {
  const { keys } = scan(payload);
  for (const m of MARGINS) assert.ok(!keys.has(m), `payload must not contain key ${m}`);
}

test('Rep payload: own rows only, no margins, no other reps', () => {
  const { status, body } = Core.buildPayload('rep@demo.example', raw(), T);
  assert.equal(status, 200);
  assert.equal(body.role, 'Rep');
  assertNoMargins(body);
  const s = scan(body);
  for (const other of ['parker pod', 'mia manager', 'oscar otherpod', 'olivia owner', 'adam admin']) {
    // Manager name may not appear anywhere either (scorecard grader is the only place; it is the rep's own grader)
    if (other === 'mia manager') continue;
    assert.ok(!s.json.includes(other), `rep payload leaked ${other}`);
  }
  for (const addr of ['404 testing', '505 sample', '606 dummy', '707 outside', '808 elsewhere', '999 outside', '22 ghost', '33 nowhere'])
    assert.ok(!s.json.includes(addr), `rep payload leaked address ${addr}`);
  for (const cust of ['customer d', 'customer e', 'customer f', 'customer g', 'customer h', 'customer z'])
    assert.ok(!s.json.includes(cust), `rep payload leaked ${cust}`);
  assert.ok(body.orders.every((o) => o.Rep_Name === 'Riley Rep (Demo)'));
  assert.equal(body.orders.length, 4);
  assert.ok(body.orders.some((o) => o.Service_Address), 'rep sees own addresses');
  assert.ok(!('exceptions' in body) && !('compliance' in body && Array.isArray(body.compliance)));
});

test('Rep wallet, clawback countdown, compliance badge, permits, Day-14, scorecard, tier', () => {
  const { body } = Core.buildPayload('rep@demo.example', raw(), T);
  assert.equal(body.wallet.cleared.count, 1);
  assert.equal(body.wallet.installed.count, 1);
  assert.equal(body.wallet.pending.count, 2);
  // DEMO-1002 installed 2026-10-29 -> 14 days ago -> 76 days left of 90
  const cb = body.wallet.clawbackWatch.find((c) => c.Order_ID === 'DEMO-1002');
  assert.equal(cb.daysLeft, 76);
  assert.equal(body.compliance.greenLight, false);
  assert.deepEqual(body.compliance.missing, ['NDA']);
  assert.deepEqual(body.permits.map((p) => p.Town).sort(), ['Fakeville', 'Sampleton']);
  assert.deepEqual(body.day14.map((d) => d.Order_ID), ['DEMO-1002']);
  assert.deepEqual(body.scorecard.map((s) => s.Rep), ['Riley Rep (Demo)']);
  assert.equal(body.tierProgress.toCertified, 3);
  assert.equal(body.missingOrders.length, 1);
  assert.equal(body.missingOrders[0].Address, '11 PHANTOM ST');
  // Nov 1-12 2026 Mon-Sat = 10 working days -> target 20
  assert.equal(body.pace.target, 20);
  assert.equal(body.pace.deals, 4);
});

test('Manager payload: pod only, no margins, other reps PII stripped', () => {
  const { status, body } = Core.buildPayload('manager@demo.example', raw(), T);
  assert.equal(status, 200);
  assert.equal(body.role, 'Manager');
  assertNoMargins(body);
  const s = scan(body);
  assert.ok(!s.json.includes('oscar otherpod'), 'manager saw another pod');
  assert.ok(!s.json.includes('olivia owner') && !s.json.includes('adam admin'));
  // Pod reps' customer names and street addresses must not appear
  for (const leak of ['customer a', 'customer b', 'customer c', 'customer d', 'customer e', 'customer i', 'customer g', 'customer z',
    '101 example', '202 placeholder', '303 mock', '404 testing', '505 sample', '909 example', '707 outside', '11 phantom', '22 ghost', '33 nowhere'])
    assert.ok(!s.json.includes(leak), `manager payload leaked ${leak}`);
  // Manager's own order keeps its address
  const own = body.orders.find((o) => o.Order_ID === 'DEMO-1006');
  assert.equal(own.Service_Address, '606 Dummy Dr, FAKEVILLE ME');
  assert.deepEqual(body.pod, ['Mia Manager (Demo)', 'Parker Pod (Demo)', 'Riley Rep (Demo)']);
  assert.equal(new Set(body.orders.map((o) => o.Rep_Name)).size, 3);
  assert.ok(body.orders.every((o) => o.City !== undefined));
  assert.equal(body.missingOrders.length, 2);
  assert.ok(body.missingOrders.every((m) => !('Address' in m) && !('ZIP' in m)));
  assert.equal(body.day14.length, 1);
  assert.ok(!('Customer_Name' in body.day14[0]) && !('Service_Address' in body.day14[0]));
  assert.ok(body.podScoreboard.find((r) => r.rep === 'Parker Pod (Demo)').greenLight);
});

test('Unknown, inactive, blank, or invalid-role users get 403 with no data', () => {
  const r = raw();
  assert.equal(Core.buildPayload('nobody@demo.example', r, T).status, 403);
  assert.equal(Core.buildPayload('former@demo.example', r, T).status, 403);
  assert.equal(Core.buildPayload('', r, T).status, 403);
  const bad = raw(); bad.users.push({ Email: 'weird@demo.example', Name: 'X', Role: 'Superuser', Active: true });
  assert.equal(Core.buildPayload('weird@demo.example', bad, T).status, 403);
  const body403 = Core.buildPayload('nobody@demo.example', r, T).body;
  assert.deepEqual(Object.keys(body403).sort(), ['error', 'message']);
});

test('Email match is case-insensitive and trims whitespace; names match case-insensitively', () => {
  const r = raw();
  r.users[3].Email = '  Rep@Demo.Example ';
  r.orders.forEach((o) => { if (o.Rep_Name === 'Riley Rep (Demo)') o.Rep_Name = ' riley  rep (demo) '; });
  const { status, body } = Core.buildPayload('REP@demo.example', r, T);
  assert.equal(status, 200);
  assert.equal(body.orders.length, 4);
  assertNoMargins(body);
});

test('Allowlist: unexpected new sheet columns never reach Rep/Manager', () => {
  const r = raw();
  r.orders.forEach((o) => { o.Secret_New_Margin_Col = 'LEAK-123'; o.gross_agency_rev = 'LEAK-456'; });
  r.phantom.forEach((p) => { p.Lat = 45.1; p.Lon = -67.4; });
  for (const email of ['rep@demo.example', 'manager@demo.example']) {
    const s = scan(Core.buildPayload(email, r, T).body);
    assert.ok(!s.json.includes('leak-123') && !s.json.includes('leak-456'), email);
    assert.ok(!s.keys.has('Lat') && !s.keys.has('Lon'));
  }
});

test('Admin sees everything but cannot release payouts; Owner can', () => {
  const a = Core.buildPayload('admin@demo.example', raw(), T).body;
  const o = Core.buildPayload('owner@demo.example', raw(), T).body;
  assert.equal(a.capabilities.canReleasePayouts, false);
  assert.equal(o.capabilities.canReleasePayouts, true);
  assert.ok(a.orders.some((x) => 'Gross_Agency_Rev' in x));
  assert.equal(a.expenses.length, 2);
  assert.equal(o.pipeline.written, 8);
  assert.equal(o.pipeline.installed, 4);
  assert.equal(o.pipeline.cleared, 2);
  assert.equal(o.financials.netSpreadCleared, 80);
  assert.equal(o.financials.expensesMTD, 85);
  assert.equal(o.financials.netAfterExpensesCleared, -5);
  assert.equal(o.missingOrders.length, 3);
  assert.ok(o.holds.some((h) => h.rep === 'Riley Rep (Demo)'));
});

test('validateClaims: aud, iss, exp, email_verified', () => {
  const cid = 'demo-client.apps.googleusercontent.com';
  const now = 1_800_000_000;
  const good = { aud: cid, iss: 'https://accounts.google.com', exp: String(now + 600), email: 'Rep@Demo.Example', email_verified: 'true' };
  assert.deepEqual(Core.validateClaims(good, cid, now), { ok: true, email: 'rep@demo.example' });
  assert.equal(Core.validateClaims({ ...good, iss: 'accounts.google.com' }, cid, now).ok, true);
  assert.equal(Core.validateClaims({ ...good, aud: 'evil' }, cid, now).reason, 'bad_audience');
  assert.equal(Core.validateClaims({ ...good, iss: 'https://evil.example' }, cid, now).reason, 'bad_issuer');
  assert.equal(Core.validateClaims({ ...good, exp: String(now - 1) }, cid, now).reason, 'expired');
  assert.equal(Core.validateClaims({ ...good, email_verified: 'false' }, cid, now).reason, 'email_not_verified');
  assert.equal(Core.validateClaims({ ...good, email: '' }, cid, now).reason, 'no_email');
  assert.equal(Core.validateClaims(good, '', now).reason, 'server_not_configured');
  assert.equal(Core.validateClaims(null, cid, now).ok, false);
});

test('Site copy of core is identical to the Apps Script core (run npm run build)', () => {
  const a = fs.readFileSync(path.join(__dirname, '../apps-script/Core.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '../docs/core.js'), 'utf8');
  assert.equal(b, a);
});

test('No secrets or real sheet IDs in tracked source', () => {
  const files = ['apps-script/Code.js', 'apps-script/Core.js', 'docs/app.js', 'docs/config.js', 'docs/index.html'];
  for (const f of files) {
    // The public web-app URL (deployment ID) is allowed; nothing else that looks like a Drive/Sheet ID is.
    const t = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
      .replace(/https:\/\/script\.google\.com\/macros\/s\/AKfy[A-Za-z0-9_-]+\/exec/g, '')
      .replace(/[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com/g, ''); // public OAuth client ID
    assert.ok(!/[A-Za-z0-9_-]{40,}/.test(t), `${f} contains a Google-ID-like string (sheet IDs belong in Script Properties)`);
    assert.ok(!/GOCSPX-|AIza[0-9A-Za-z_-]{20,}|-----BEGIN/.test(t), `${f} contains a secret-looking string`);
  }
});
