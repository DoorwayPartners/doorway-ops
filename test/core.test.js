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
  const files = ['apps-script/Code.js', 'apps-script/Core.js', 'apps-script/Queue.js', 'apps-script/BootCache.js', 'apps-script/PdfEngine.js', 'apps-script/FeedImporter.js', 'apps-script/EntityLinker.js', 'docs/demo-data.js', 'docs/app.js', 'docs/config.js', 'docs/index.html'];
  for (const f of files) {
    // The public web-app URL (deployment ID) is allowed; nothing else that looks like a Drive/Sheet ID is.
    const t = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
      .replace(/https:\/\/script\.google\.com\/macros\/s\/AKfy[A-Za-z0-9_-]+\/exec/g, '')
      .replace(/[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com/g, ''); // public OAuth client ID
    assert.ok(!/[A-Za-z0-9_-]{40,}/.test(t), `${f} contains a Google-ID-like string (sheet IDs belong in Script Properties)`);
    assert.ok(!/GOCSPX-|AIza[0-9A-Za-z_-]{20,}|-----BEGIN/.test(t), `${f} contains a secret-looking string`);
  }
});

// ---------------- V2 Owner Priority Queue ----------------
const OWNER = { role: 'Owner', email: 'owner@demo.example', name: 'Olivia Owner (Demo)' };
const qrow = (extra) => Object.assign({ Queue_ID: 'Q-20261112-001', Created_At: '2026-11-12T09:00:00', Priority: 'P2-OPS', Category: 'Missed_Install',
  Source_Thread_ID: '', Rep_Or_Sender: 'Riley Rep (Demo)', Context_Summary: 'demo', Draft_To: 'rep@demo.example', Draft_Cc: '',
  Draft_Subject: 'Follow up', Draft_Body: 'Hi Riley', Status: 'PENDING', Resolved_At: '' }, extra || {});

test('Queue has exactly the A–M spec columns', () => {
  assert.deepEqual(Core.QUEUE_COLUMNS, ['Queue_ID', 'Created_At', 'Priority', 'Category', 'Source_Thread_ID', 'Rep_Or_Sender',
    'Context_Summary', 'Draft_To', 'Draft_Cc', 'Draft_Subject', 'Draft_Body', 'Status', 'Resolved_At']);
});

test('buildQueue: PENDING only, sorted P1 -> P2 -> P3 then oldest, counts, carrier flag', () => {
  const q = Core.buildQueue(DEMO.raw.queue);
  assert.ok(q.items.every((i) => i.Status === 'PENDING'));
  const ranks = q.items.map((i) => i.Priority);
  assert.deepEqual(ranks, [...ranks].sort());
  assert.equal(q.counts.total, q.items.length);
  assert.equal(q.counts.p1 + q.counts.p2 + q.counts.p3, q.items.length);
  assert.ok(!q.items.some((i) => i.Queue_ID === 'Q-20261111-004'), 'sent row hidden');
  const carrierItem = q.items.find((i) => /fidium/i.test(i.Draft_To));
  assert.equal(carrierItem.carrierConfirmRequired, true);
  assert.ok(q.items.some((i) => i.carrierConfirmRequired === false));
});

test('Carrier domains need a second confirm; lookalikes do not', () => {
  for (const e of ['DSREscalations@fidium.com', 'x@consolidated.com', 'a@metronet.net', 'b@brightspeed.com', 'c@frontier.com',
    'd@att.com', 'e@t-mobile.com', 'f@gonetspeed.com', 'g@mail.fidium.net'])
    assert.ok(Core.isCarrierRecipient(e, ''), e);
  assert.ok(Core.isCarrierRecipient('rep@demo.example', 'brian.dorton@fidium.com'), 'cc counts');
  for (const e of ['bob@matt.com', 'randy@coast2coasttechnologies.org', 'office@doorwaypartners.com', 'x@frontierdemo.example'])
    assert.ok(!Core.isCarrierRecipient(e, ''), e);
});

test('Queue actions are Owner-only (Admin/Manager/Rep/none -> 403)', () => {
  for (const role of ['Admin', 'Manager', 'Rep']) {
    assert.equal(Core.checkQueueAction({ role }, 'APPROVE_AND_SEND', qrow(), { confirm: true }).status, 403);
    assert.equal(Core.checkQueueAction({ role }, 'UPDATE_QUEUE_STATUS', qrow(), { newStatus: 'DISMISSED' }).status, 403);
  }
  assert.equal(Core.checkQueueAction(null, 'APPROVE_AND_SEND', qrow(), { confirm: true }).status, 403);
  assert.equal(Core.isOwner(Core.findUser([{ Email: 'o@x.example', Role: 'OWNER', Active: true, Name: 'O' }], 'o@x.example')), true, "spec 'OWNER' spelling works");
});

test('APPROVE_AND_SEND: explicit confirm, staged draft only, exactly once, sign-off', () => {
  assert.equal(Core.checkQueueAction(OWNER, 'APPROVE_AND_SEND', qrow(), {}).error, 'explicit_confirm_required');
  const ok = Core.checkQueueAction(OWNER, 'APPROVE_AND_SEND', qrow(), { confirm: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.send.to, 'rep@demo.example');
  assert.ok(ok.send.body.endsWith(Core.SIGNOFF));
  const signed = Core.checkQueueAction(OWNER, 'APPROVE_AND_SEND', qrow({ Draft_Body: 'Hi\n\nCristian Coy\nCoast 2 Coast / Doorway Partners' }), { confirm: true });
  assert.ok(!signed.send.body.endsWith('\n\n' + Core.SIGNOFF), 'no double sign-off');
  assert.equal(Core.checkQueueAction(OWNER, 'APPROVE_AND_SEND', qrow({ Status: 'APPROVED_SENT' }), { confirm: true }).status, 409);
  assert.equal(Core.checkQueueAction(OWNER, 'APPROVE_AND_SEND', qrow({ Status: 'DISMISSED' }), { confirm: true }).status, 409);
  assert.equal(Core.checkQueueAction(OWNER, 'APPROVE_AND_SEND', null, { confirm: true }).status, 404);
  assert.equal(Core.checkQueueAction(OWNER, 'APPROVE_AND_SEND', qrow({ Draft_To: '' }), { confirm: true }).error, 'no_recipient');
  assert.equal(Core.checkQueueAction(OWNER, 'APPROVE_AND_SEND', qrow({ Draft_To: 'not-an-email' }), { confirm: true }).error, 'bad_recipient');
  assert.equal(Core.checkQueueAction(OWNER, 'APPROVE_AND_SEND', qrow({ Draft_Body: '' }), { confirm: true }).error, 'no_body');
  const edited = Core.checkQueueAction(OWNER, 'APPROVE_AND_SEND', qrow(), { confirm: true, editedSubject: 'New subj', editedCc: 'x@demo.example' });
  assert.equal(edited.send.subject, 'New subj');
  assert.equal(edited.send.cc, 'x@demo.example');
});

test('APPROVE_AND_SEND to a carrier needs confirmCarrier (also when added by an edit)', () => {
  const row = qrow({ Draft_To: 'DSREscalations@fidium.com' });
  const r = Core.checkQueueAction(OWNER, 'APPROVE_AND_SEND', row, { confirm: true });
  assert.equal(r.status, 428);
  assert.deepEqual(r.carrier, ['DSREscalations@fidium.com']);
  assert.equal(Core.checkQueueAction(OWNER, 'APPROVE_AND_SEND', row, { confirm: true, confirmCarrier: true }).ok, true);
  assert.equal(Core.checkQueueAction(OWNER, 'APPROVE_AND_SEND', qrow(), { confirm: true, editedCc: 'brian.dorton@fidium.com' }).status, 428);
});

test('UPDATE_QUEUE_STATUS: only SNOOZED/DISMISSED, never on a sent row', () => {
  assert.equal(Core.checkQueueAction(OWNER, 'UPDATE_QUEUE_STATUS', qrow(), { newStatus: 'snoozed' }).newStatus, 'SNOOZED');
  assert.equal(Core.checkQueueAction(OWNER, 'UPDATE_QUEUE_STATUS', qrow({ Status: 'SNOOZED' }), { newStatus: 'DISMISSED' }).ok, true);
  assert.equal(Core.checkQueueAction(OWNER, 'UPDATE_QUEUE_STATUS', qrow(), { newStatus: 'APPROVED_SENT' }).error, 'bad_status');
  assert.equal(Core.checkQueueAction(OWNER, 'UPDATE_QUEUE_STATUS', qrow(), { newStatus: 'PENDING' }).error, 'bad_status');
  assert.equal(Core.checkQueueAction(OWNER, 'UPDATE_QUEUE_STATUS', qrow({ Status: 'APPROVED_SENT' }), { newStatus: 'DISMISSED' }).status, 409);
  assert.equal(Core.checkQueueAction(OWNER, 'NUKE', qrow(), {}).status, 400);
});

test('Queue IDs and duplicate detection', () => {
  assert.equal(Core.nextQueueId([], '20261112'), 'Q-20261112-001');
  assert.equal(Core.nextQueueId([{ Queue_ID: 'Q-20261112-009' }, { Queue_ID: 'Q-20261111-050' }], '20261112'), 'Q-20261112-010');
  assert.equal(Core.hasSourceThread([{ Source_Thread_ID: '18abc' }], '18abc'), true);
  assert.equal(Core.hasSourceThread([{ Source_Thread_ID: '18abc' }], ''), false);
});

test('Dashboard payloads never include queue data, for any role', () => {
  for (const email of ['owner@demo.example', 'admin@demo.example', 'manager@demo.example', 'rep@demo.example']) {
    const s = scan(Core.buildPayload(email, raw(), T).body);
    for (const k of ['queue', 'items', 'Draft_Body', 'Draft_To', 'Queue_ID']) assert.ok(!s.keys.has(k), `${email} payload has ${k}`);
  }
});

test('Frontend: queue tab is gated to the Owner role and never uses innerHTML', () => {
  const app = fs.readFileSync(path.join(__dirname, '../docs/app.js'), 'utf8');
  assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(app), 'app.js must not inject HTML');
  assert.match(app, /if \(d\.role === 'Owner'\) \{[^}]*viewTabs\(\)/, 'viewTabs only for Owner');
  assert.equal((app.match(/appendChild\(viewTabs\(\)\)/g) || []).length, 1, 'viewTabs rendered in one place');
  assert.match(app, /carrierRecipients\(to, cc\)[\s\S]*confirmCarrier = true/, 'second confirm for carriers');
  assert.match(app, /confirm: true/, 'explicit confirm flag sent');
});
