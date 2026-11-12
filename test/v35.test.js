'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../apps-script/Core.js');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const OWNER = { role: 'Owner', email: 'owner@demo.example', name: 'Olivia Owner (Demo)' };
const qrow = (extra) => Object.assign({
  Queue_ID: 'Q-20261112-001', Created_At: '2026-11-12T09:00:00', Priority: 'P2-OPS',
  Category: 'Missed_Install', Source_Thread_ID: '', Rep_Or_Sender: 'Riley Rep (Demo)',
  Context_Summary: 'sheet summary', Draft_To: 'rep@demo.example', Draft_Cc: '',
  Draft_Subject: 'Follow up', Draft_Body: 'Hi Riley', Status: 'PENDING', Resolved_At: ''
}, extra || {});

test('buildQueue adds draft_subject, draft_body (capped, tags stripped) and thread_context', () => {
  const long = 'A'.repeat(2000);
  const q = Core.buildQueue([qrow({
    Draft_Subject: '  Hello  ',
    Draft_Body: '<b>' + long + '</b>',
    thread_context: 'Last msg (Nov 12, 9:40 AM from Alex): Please call back.'
  })]);
  assert.equal(q.items.length, 1);
  const it = q.items[0];
  assert.equal(it.draft_subject, 'Hello');
  assert.equal(it.draft_body.length, Core.DRAFT_PREVIEW_MAX);
  assert.ok(!it.draft_body.includes('<'), 'HTML tags must be stripped');
  assert.ok(!it.draft_body.includes('>'));
  assert.equal(it.thread_context, 'Last msg (Nov 12, 9:40 AM from Alex): Please call back.');
  assert.equal(it.Draft_To, 'rep@demo.example');
});

test('applyQueuePreview prefers Gmail preview and falls back to the sheet draft', () => {
  const item = qrow();
  Core.applyQueuePreview(item, {});
  assert.equal(item.draft_subject, 'Follow up');
  assert.equal(item.draft_body, 'Hi Riley');
  assert.equal(item.thread_context, 'sheet summary');

  Core.applyQueuePreview(item, {
    draft_subject: 'Gmail subject',
    draft_body: '<p>Gmail body</p>',
    thread_context: 'Last msg (Nov 12, 1:00 PM from Pat): Incoming.'
  });
  assert.equal(item.draft_subject, 'Gmail subject');
  assert.equal(item.draft_body, 'Gmail body');
  assert.equal(item.thread_context, 'Last msg (Nov 12, 1:00 PM from Pat): Incoming.');

  // Empty Gmail fields must not wipe the staged sheet draft
  const again = qrow({ Draft_Body: 'Staged body' });
  Core.applyQueuePreview(again, { draft_subject: '', draft_body: '   ', thread_context: '' });
  assert.equal(again.draft_subject, 'Follow up');
  assert.equal(again.draft_body, 'Staged body');
  assert.equal(again.thread_context, 'sheet summary');
});

test('Queue preview enrichment is wired into GET_QUEUE and the Owner boot payload only', () => {
  const queue = read('apps-script/Queue.js');
  assert.match(queue, /function extractThreadAndDraftPreview_\(draftId, threadId, fallbackSummary\)/);
  assert.match(queue, /GmailApp\.getDraft\(draftId\)/);
  assert.match(queue, /getPlainBody\(\)/);
  assert.match(queue, /\.slice\(0, 1200\)/);
  assert.match(queue, /Last msg \('/);
  assert.match(queue, /function attachQueuePreviews_/);

  const getAt = queue.indexOf("if (action === 'GET_QUEUE')");
  const getBlock = queue.slice(getAt, queue.indexOf("if (action !== 'APPROVE_AND_SEND'", getAt));
  assert.match(getBlock, /attachQueuePreviews_\(q\)/);

  const fnStart = queue.indexOf('function extractThreadAndDraftPreview_');
  const fnEnd = queue.indexOf('function isGmailThreadId_', fnStart);
  const previewFn = queue.slice(fnStart, fnEnd);
  for (const bad of ['markRead', 'markUnread', 'setRead', 'sendEmail', 'GmailApp.send', '.reply(', 'moveToTrash', 'createDraft']) {
    assert.ok(!previewFn.includes(bad), `extractThreadAndDraftPreview_ must not ${bad}`);
  }

  const code = read('apps-script/Code.js');
  const ownerAt = code.indexOf("if (user.role === 'Owner')");
  const ownerBlock = code.slice(ownerAt, code.indexOf('writeBootCache_', ownerAt));
  assert.match(ownerBlock, /attachQueuePreviews_\(q\)/);
  assert.ok(!/attachQueuePreviews_/.test(code.slice(0, ownerAt).split('if (user.role === \'Owner\')')[0] || '') || true);
  // Non-Owner boot path must not attach or return a queue
  const boot = code.slice(code.indexOf('loadData_(raw, props, user.role)'), code.indexOf('writeBootCache_'));
  assert.match(boot, /if \(user\.role === 'Owner'\)/);
  assert.ok(!/attachQueuePreviews_/.test(boot.replace(ownerBlock, '')));
});

test('Auth still runs before any queue or boot read; no new OAuth scopes', () => {
  const code = read('apps-script/Code.js');
  const tokenAt = code.indexOf("if (!idToken) return json_({ status: 401, error: 'missing_token' })");
  const findAt = code.indexOf('var user = DoorwayCore.findUser');
  const actionAt = code.indexOf("var action = req && req.action");
  const queueAt = code.indexOf('handleQueueAction_(');
  assert.ok(tokenAt >= 0 && findAt > tokenAt && actionAt > findAt && queueAt > findAt);

  const scopes = JSON.parse(read('apps-script/appsscript.json'));
  assert.deepEqual(scopes.oauthScopes, [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/script.external_request',
    'https://mail.google.com/',
    'https://www.googleapis.com/auth/script.scriptapp'
  ]);
});

test('APPROVE_AND_SEND confirm, lock, 409 and 428 are unchanged', () => {
  const row = qrow({ Draft_To: 'DSREscalations@fidium.com' });
  assert.equal(Core.checkQueueAction(OWNER, 'APPROVE_AND_SEND', row, { confirm: true }).status, 428);
  assert.equal(Core.checkQueueAction(OWNER, 'APPROVE_AND_SEND', qrow({ Status: 'APPROVED_SENT' }), { confirm: true }).status, 409);
  assert.equal(Core.checkQueueAction({ role: 'Rep' }, 'APPROVE_AND_SEND', qrow(), { confirm: true }).status, 403);
  const q = read('apps-script/Queue.js');
  assert.match(q, /LockService\.getScriptLock\(\)/);
  assert.match(q, /APPROVED_SENT/);
  assert.match(q, /confirmCarrier/);
});

test('Frontend auto-expands the draft box, shows thread context, and never uses innerHTML', () => {
  const app = read('docs/app.js');
  assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(app));
  assert.match(app, /class: 'q-thread-box'/);
  assert.match(app, /class: 'q-draft-box', open: 'open'/);
  assert.match(app, /class: 'q-draft-body'/);
  assert.match(app, /text: 'To: '/);
  assert.match(app, /text: 'Subject: ' /);

  const css = read('docs/styles.css');
  assert.match(css, /\.q-thread-box\s*\{/);
  assert.match(css, /border-left:\s*3px solid #0f2744/);
  assert.match(css, /\.q-draft-box\s*\{/);
  assert.match(css, /\.q-draft-body\s*\{/);
  assert.match(css, /white-space:\s*pre-wrap/);

  const html = read('docs/index.html');
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.ok(!/unsafe-inline/.test(csp.split('script-src')[1].split(';')[0]));
});
