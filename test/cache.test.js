'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const Boot = require('../apps-script/BootCache.js');

const TODAY = '2026-11-12';
const owner = { role: 'Owner', email: 'owner@demo.example' };
const admin = { role: 'Admin', email: 'admin@demo.example' };
const rep = { role: 'Rep', email: 'rep@demo.example' };
const payload = (user, extra) => Object.assign({
  status: 200,
  role: user.role,
  me: { name: 'X', email: user.email, role: user.role }
}, extra || {});

test('Boot cache key includes generation, role, normalized email, and date', () => {
  const k = Boot.key('3', 'Owner', '  Owner@Demo.Example ', TODAY);
  assert.equal(k, 'boot_3_Owner_owner@demo.example_2026-11-12');
  assert.ok(k.includes('Owner') && k.includes('owner@demo.example') && k.includes(TODAY));
});

test('Cache keys never collide across roles or users', () => {
  const gen = '0';
  const ownerKey = Boot.key(gen, owner.role, owner.email, TODAY);
  const adminSameEmail = Boot.key(gen, 'Admin', owner.email, TODAY);
  const otherOwner = Boot.key(gen, owner.role, 'other@demo.example', TODAY);
  const repKey = Boot.key(gen, rep.role, rep.email, TODAY);
  const keys = [ownerKey, adminSameEmail, otherOwner, repKey];
  assert.equal(new Set(keys).size, keys.length);
  assert.notEqual(ownerKey, adminSameEmail, 'same email, different role must not share a key');
  assert.notEqual(ownerKey, otherOwner, 'same role, different email must not share a key');
});

test('Busting advances the generation so previous keys miss', () => {
  const before = Boot.key('0', owner.role, owner.email, TODAY);
  const after = Boot.key(Boot.nextGen('0'), owner.role, owner.email, TODAY);
  assert.notEqual(before, after);
  assert.equal(Boot.nextGen(''), '1');
  assert.equal(Boot.nextGen('999999'), '0');
});

test('Payloads over the 100 KB-safe cap are not stored', () => {
  assert.equal(Boot.canStore('{"ok":true}'), true);
  assert.equal(Boot.canStore(''), false);
  assert.equal(Boot.canStore('x'.repeat(Boot.MAX_CHARS)), true);
  assert.equal(Boot.canStore('x'.repeat(Boot.MAX_CHARS + 1)), false);
  assert.ok(Boot.MAX_CHARS < 100 * 1024);
  assert.equal(Boot.TTL_SEC, 180);
});

test('accept() requires an already-authenticated matching role and email', () => {
  const hit = Boot.accept(payload(owner), owner);
  assert.ok(hit);
  assert.equal(hit.role, 'Owner');
  assert.equal(hit.me.email, owner.email);
  assert.equal(Boot.accept(payload(owner), admin), null, 'role mismatch must not be served');
  assert.equal(Boot.accept(payload(owner), { role: 'Owner', email: 'other@demo.example' }), null);
  assert.equal(Boot.accept({ status: 403, role: 'Owner', me: { email: owner.email } }, owner), null);
  assert.equal(Boot.accept({ status: 200, role: 'Owner' }, owner), null, 'missing me.email');
  assert.equal(Boot.accept(null, owner), null);
});

test('accept() strips a queue field from non-Owner payloads and keeps it for Owner', () => {
  const q = { status: 200, items: [{ Queue_ID: 'Q-1' }], counts: { total: 1, p1: 0, p2: 1, p3: 0 } };
  const ownerHit = Boot.accept(payload(owner, { queue: q }), owner);
  assert.ok(ownerHit.queue && ownerHit.queue.items[0].Queue_ID === 'Q-1');
  const adminHit = Boot.accept(payload(admin, { queue: q }), admin);
  assert.ok(adminHit);
  assert.ok(!('queue' in adminHit), 'Admin must never receive a cached queue');
  const repHit = Boot.accept(payload(rep, { queue: q }), rep);
  assert.ok(repHit && !('queue' in repHit));
});

test('Code.js checks auth and role before any boot-cache read, and attaches queue for Owner only', () => {
  const code = fs.readFileSync(path.join(__dirname, '../apps-script/Code.js'), 'utf8');
  const findAt = code.indexOf('var user = DoorwayCore.findUser');
  const cacheAt = code.indexOf('readBootCache_(');
  assert.ok(findAt > 0 && cacheAt > findAt, 'findUser must run before readBootCache_');
  assert.match(code, /if \(!user\) return json_\(\{ status: 403/);
  assert.match(code, /if \(user\.role === 'Owner'\) \{[^}]*result\.body\.queue = q/);
  assert.match(code, /GET_QUEUE always reads the sheet/);
});

test('Queue mutations and intake row appends bust the boot cache', () => {
  const q = fs.readFileSync(path.join(__dirname, '../apps-script/Queue.js'), 'utf8');
  const updateAt = q.indexOf("if (action === 'UPDATE_QUEUE_STATUS')");
  const sendAt = q.indexOf('APPROVE_AND_SEND: claim first');
  const intakeAt = q.indexOf('if (added > 0) bustBootCache_()');
  assert.ok(updateAt > 0 && q.indexOf('bustBootCache_()', updateAt) > updateAt);
  assert.ok(sendAt > 0 && q.indexOf('bustBootCache_()', sendAt) > sendAt);
  assert.ok(intakeAt > 0, 'urgentIntakeSweep busts only when it appends rows');
  // The failed-send revert path also busts
  assert.match(q, /send_failed[\s\S]*bustBootCache_\(\)/);
});

test('Frontend: sessionStorage is cleared on Sign out and auth errors; demo mode does not cache', () => {
  const app = fs.readFileSync(path.join(__dirname, '../docs/app.js'), 'utf8');
  assert.match(app, /var BOOT_PREFIX = 'doorway-ops-boot:'/);
  assert.match(app, /function bootCacheKey\(email, role\)/);
  assert.match(app, /function clearBootCache\(/);
  assert.match(app, /if \(DEMO\) return;/);
  // Sign-out handler clears before reload
  const so = app.indexOf("getElementById('signout').addEventListener('click'");
  const soEnd = app.indexOf('location.reload()', so);
  assert.ok(so > 0 && soEnd > so);
  const handler = app.slice(so, soEnd);
  assert.match(handler, /clearBootCache\(\)/);
  // 401/403 path clears the cache and hides sign-out
  assert.match(app, /if \(d\.status === 401 \|\| d\.status === 403\) \{[\s\S]*clearBootCache\(\)/);
  // Cached payload is only reused when the email matches; role mismatch clears
  assert.match(app, /d\.role !== cached\.role[\s\S]*clearBootCache\(\)/);
  // Demo start path never writes sessionStorage
  const demo = app.slice(app.indexOf('function startDemo()'), app.indexOf('if (DEMO) startDemo()'));
  assert.ok(!/sessionStorage|writeBootCache|readBootCache/.test(demo), 'startDemo must not touch the live cache');
  // Combined boot queue is applied on Owner render
  assert.match(app, /applyBootQueue\(d\)/);
});
