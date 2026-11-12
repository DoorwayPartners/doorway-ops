'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
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

test('applyQueuePreview copies timeline, msg count, last id, and synced time', () => {
  const item = qrow();
  Core.applyQueuePreview(item, {
    draft_subject: 'Gmail subject',
    draft_body: 'Gmail body',
    thread_context: 'Latest (Nov 12, 1:00 PM · Pat): Incoming.',
    thread_msg_count: 3,
    last_message_id: 'msg-3',
    synced_at_et: '6:40:00 PM',
    thread_timeline: [
      { id: 'msg-1', from: '<b>Pat</b>', date_et: 'Nov 11, 4:00 PM', snippet: 'First <i>note</i>' },
      { id: 'msg-2', from: 'Alex', date_et: 'Nov 12, 9:00 AM', snippet: 'Second' },
      { id: 'msg-3', from: 'Pat', date_et: 'Nov 12, 1:00 PM', snippet: 'Incoming.' }
    ]
  });
  assert.equal(item.draft_subject, 'Gmail subject');
  assert.equal(item.thread_msg_count, 3);
  assert.equal(item.last_message_id, 'msg-3');
  assert.equal(item.synced_at_et, '6:40:00 PM');
  assert.equal(item.thread_timeline.length, 3);
  assert.equal(item.thread_timeline[0].from, 'Pat');
  assert.equal(item.thread_timeline[0].snippet, 'First note');
  assert.ok(!item.thread_timeline[0].from.includes('<'));
});

test('buildQueue surfaces timeline fields from the raw row', () => {
  const q = Core.buildQueue([qrow({
    thread_context: 'Latest note',
    thread_msg_count: 2,
    last_message_id: 'abc',
    synced_at_et: '1:00:00 PM',
    thread_timeline: [{ id: 'abc', from: 'Pat', date_et: 'Nov 12, 1:00 PM', snippet: 'Hi' }]
  })]);
  const it = q.items[0];
  assert.equal(it.thread_msg_count, 2);
  assert.equal(it.last_message_id, 'abc');
  assert.equal(it.synced_at_et, '1:00:00 PM');
  assert.equal(it.thread_timeline.length, 1);
  assert.equal(it.thread_context, 'Latest note');
});

test('SAFE_APPROVE_SEND uses the same confirm, 409 and 428 rules as APPROVE_AND_SEND', () => {
  const carrier = qrow({ Draft_To: 'DSREscalations@fidium.com' });
  assert.equal(Core.checkQueueAction(OWNER, 'SAFE_APPROVE_SEND', carrier, { confirm: true }).status, 428);
  assert.equal(Core.checkQueueAction(OWNER, 'SAFE_APPROVE_SEND', qrow({ Status: 'APPROVED_SENT' }), { confirm: true }).status, 409);
  assert.equal(Core.checkQueueAction({ role: 'Rep' }, 'SAFE_APPROVE_SEND', qrow(), { confirm: true }).status, 403);
  assert.equal(Core.checkQueueAction({ role: 'Admin' }, 'SAFE_APPROVE_SEND', qrow(), { confirm: true }).status, 403);
  assert.equal(Core.checkQueueAction(OWNER, 'SAFE_APPROVE_SEND', qrow(), {}).error, 'explicit_confirm_required');
  const ok = Core.checkQueueAction(OWNER, 'SAFE_APPROVE_SEND', qrow(), { confirm: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.send.to, 'rep@demo.example');
});

test('checkStaleThread returns 409 STALE_THREAD_NEW_REPLY when the live thread moved', () => {
  const fresh = Core.checkStaleThread(
    { expectedMsgCount: 2, expectedLastMsgId: 'msg-2' },
    { thread_msg_count: 2, last_message_id: 'msg-2' }
  );
  assert.equal(fresh.ok, true);

  const byCount = Core.checkStaleThread(
    { expectedMsgCount: 2, expectedLastMsgId: 'msg-2' },
    { thread_msg_count: 3, last_message_id: 'msg-3' }
  );
  assert.equal(byCount.ok, false);
  assert.equal(byCount.status, 409);
  assert.equal(byCount.reason, 'STALE_THREAD_NEW_REPLY');

  const byId = Core.checkStaleThread(
    { expectedMsgCount: 2, expectedLastMsgId: 'msg-2' },
    { thread_msg_count: 2, last_message_id: 'msg-2-new' }
  );
  assert.equal(byId.ok, false);
  assert.equal(byId.reason, 'STALE_THREAD_NEW_REPLY');

  const noExpect = Core.checkStaleThread({}, { thread_msg_count: 5, last_message_id: 'x' });
  assert.equal(noExpect.ok, true);
});

test('applyInstructDraft chips rewrite the body; free text only appends a note', () => {
  const base = { currentBody: 'Hello team,\nPlease advise.', orderId: 'DEMO-1009' };
  const shorter = Core.applyInstructDraft(Object.assign({ chip: 'SHORTER_FIRMER' }, base));
  assert.match(shorter.updatedBody, /Following up urgently on Order DEMO-1009/);
  assert.match(shorter.updatedBody, /Doorway Partners Ops/);

  const eta = Core.applyInstructDraft(Object.assign({ chip: 'ASK_ETA' }, base));
  assert.match(eta.updatedBody, /confirmed technician\/drop ETA/);

  const resched = Core.applyInstructDraft(Object.assign({ chip: 'CONFIRM_RESCHEDULE' }, base));
  assert.match(resched.updatedBody, /customer confirmed rescheduled/);

  const hold = Core.applyInstructDraft(Object.assign({ chip: 'HOLD_REP_INFO' }, base));
  assert.match(hold.updatedBody, /additional information from the assigned rep/);

  const note = Core.applyInstructDraft(Object.assign({ instruction: 'Ask them to call today' }, base));
  assert.match(note.updatedBody, /Hello team/);
  assert.match(note.updatedBody, /\[Ops Update Note: Ask them to call today\]/);
  assert.equal(note.saveAsRule, false);
});

test('checkInstructDraft is Owner-only and never a send action', () => {
  assert.equal(Core.checkInstructDraft({ role: 'Rep' }, { queueId: 'Q-20261112-001', chip: 'ASK_ETA' }).status, 403);
  assert.equal(Core.checkInstructDraft({ role: 'Admin' }, { queueId: 'Q-20261112-001', instruction: 'Tighten this' }).status, 403);
  assert.equal(Core.checkInstructDraft(OWNER, { queueId: 'Q-20261112-001' }).error, 'no_instruction');
  assert.equal(Core.checkInstructDraft(OWNER, { queueId: 'bad', chip: 'ASK_ETA' }).error, 'bad_queue_id');
  assert.equal(Core.checkInstructDraft(OWNER, { queueId: 'Q-20261112-001', chip: 'NUKE' }).error, 'bad_chip');
  const ok = Core.checkInstructDraft(OWNER, { queueId: 'Q-20261112-001', chip: 'HOLD_REP_INFO', saveAsRule: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.saveAsRule, true);
  assert.ok(!Object.prototype.hasOwnProperty.call(ok, 'send'));
});

test('Learning_Log accepts QUEUE_VOICE_EDIT and QUEUE_SOP_RULE; Applied_To_Rules stays Y/N', () => {
  assert.deepEqual(Core.LEARNING_SOURCE_MODULES.slice(-2), ['QUEUE_VOICE_EDIT', 'QUEUE_SOP_RULE']);
  const voice = Core.buildLearningLogRow({ sourceModule: 'QUEUE_VOICE_EDIT', entityId: 'Q-20261112-001', appliedToRules: false, patternTag: 'ASK_ETA' });
  assert.equal(voice.Source_Module, 'QUEUE_VOICE_EDIT');
  assert.equal(voice.Applied_To_Rules, 'N');
  const sop = Core.buildLearningLogRow({ sourceModule: 'QUEUE_SOP_RULE', appliedToRules: false, patternTag: 'CANDIDATE_Y:ASK_ETA' });
  assert.equal(sop.Source_Module, 'QUEUE_SOP_RULE');
  assert.equal(sop.Applied_To_Rules, 'N', 'save-as-rule tags a candidate; it does not apply the rule');
});

test('QueueGuard + router keep confirm/lock/409/428 and role/email cache keying', () => {
  const guard = read('apps-script/QueueGuard.js');
  assert.match(guard, /function getFullThreadSnapshot_\(draftId, threadId, fallbackSummary\)/);
  assert.match(guard, /function checkThreadFreshness_/);
  assert.match(guard, /function instructDraftAndLogRule_/);
  assert.match(guard, /function sendIdempotencyKey_/);
  assert.match(guard, /HOLD_REP_INFO/);
  assert.match(guard, /bustBootCache_\(\)/);
  assert.doesNotMatch(guard, /OWNER_BOOT_PAYLOAD_V3/);
  assert.doesNotMatch(guard, /draft\.send\s*\(/);
  assert.doesNotMatch(guard, /GmailApp\.sendEmail/);
  assert.match(guard, /DoorwayCore\.isOwner/);
  assert.match(guard, /logLearningSafe_/);

  const queue = read('apps-script/Queue.js');
  assert.match(queue, /if \(action === 'INSTRUCT_DRAFT'\) return instructDraftAndLogRule_/);
  assert.match(queue, /if \(action === 'SAFE_APPROVE_SEND'\) action = 'APPROVE_AND_SEND'/);
  assert.match(queue, /checkThreadFreshness_/);
  assert.match(queue, /sendIdempotencyKey_/);
  assert.match(queue, /confirmCarrier/);
  assert.match(queue, /LockService\.getScriptLock\(\)/);
  assert.match(queue, /APPROVED_SENT/);
  assert.match(queue, /getFullThreadSnapshot_/);
  // Stale check must happen before the row is claimed.
  const approveAt = queue.indexOf('// APPROVE_AND_SEND / SAFE_APPROVE_SEND');
  const claimAt = queue.indexOf("Status: 'APPROVED_SENT'", approveAt);
  const staleAt = queue.indexOf('checkThreadFreshness_', approveAt);
  const idemAt = queue.indexOf('sendIdempotencyKey_', approveAt);
  assert.ok(approveAt >= 0 && staleAt > approveAt && staleAt < claimAt && idemAt < claimAt);

  const code = read('apps-script/Code.js');
  const tokenAt = code.indexOf("if (!idToken) return json_({ status: 401, error: 'missing_token' })");
  const findAt = code.indexOf('var user = DoorwayCore.findUser');
  const actionAt = code.indexOf("action === 'SAFE_APPROVE_SEND'");
  assert.ok(tokenAt >= 0 && findAt > tokenAt && actionAt > findAt);
  assert.doesNotMatch(code, /OWNER_BOOT_PAYLOAD_V3/);

  const ignore = read('apps-script/.claspignore');
  assert.match(ignore, /!QueueGuard\.js/);

  const scopes = JSON.parse(read('apps-script/appsscript.json'));
  assert.deepEqual(scopes.oauthScopes, [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/script.external_request',
    'https://mail.google.com/',
    'https://www.googleapis.com/auth/script.scriptapp'
  ]);
});

test('Frontend: v=3.6 cache-buster, timeline, instruct bar, 5s undo, Web Speech only, no innerHTML', () => {
  const html = read('docs/index.html');
  assert.match(html, /styles\.css\?v=3\.6/);
  assert.match(html, /app\.js\?v=3\.6/);
  assert.match(html, /config\.js\?v=3\.6/);
  assert.match(html, /core\.js\?v=3\.6/);
  assert.match(html, />V3\.6 ·/);
  assert.doesNotMatch(html, /\?v=3\.5/);
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.ok(!/unsafe-inline/.test(csp.split('script-src')[1].split(';')[0]));
  assert.ok(!/speech\.googleapis|wss?:|mediastream/.test(csp), 'CSP must not add speech or mic origins');
  // No Permissions-Policy / microphone change
  assert.doesNotMatch(html, /Permissions-Policy|microphone=/);

  const app = read('docs/app.js');
  assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(app));
  assert.match(app, /class: 'q-timeline'/);
  assert.match(app, /class: 'q-instruct'/);
  assert.match(app, /Shorter & Firmer/);
  assert.match(app, /Ask for ETA/);
  assert.match(app, /Confirm Reschedule/);
  assert.match(app, /Hold — Need Rep Info/);
  assert.match(app, /Save as permanent SOP rule/);
  assert.match(app, /Apply to Draft/);
  assert.match(app, /Dictate or type instruction/);
  assert.match(app, /window\.SpeechRecognition \|\| window\.webkitSpeechRecognition/);
  assert.doesNotMatch(app, /webkitSpeechRecognitionService|speech\.googleapis|getUserMedia/);
  assert.ok(!/new Audio\(/.test(app));
  assert.match(app, /action: 'SAFE_APPROVE_SEND'/);
  assert.match(app, /action: 'INSTRUCT_DRAFT'/);
  assert.match(app, /startUndoCountdown/);
  assert.match(app, /Sending in 5s/);
  assert.match(app, /Send cancelled\. Nothing was sent\./);
  // Confirm must happen before the 5s delay, and the server call only after the countdown.
  const sendAt = app.indexOf("btnSend.addEventListener('click'");
  const confirmAt = app.indexOf('window.confirm', sendAt);
  const carrierAt = app.indexOf('confirmCarrier', sendAt);
  const undoAt = app.indexOf('startUndoCountdown', sendAt);
  const apiAt = app.indexOf('queueApi(payload)', sendAt);
  assert.ok(confirmAt > sendAt && carrierAt > confirmAt && undoAt > carrierAt && apiAt > undoAt);
  // Voice/chip path must not send
  const instructAt = app.indexOf('function applyInstruction');
  const instructFn = app.slice(instructAt, app.indexOf('btnSend.addEventListener', instructAt));
  assert.doesNotMatch(instructFn, /SAFE_APPROVE_SEND|APPROVE_AND_SEND/);
  assert.match(instructFn, /Nothing was sent/);

  const css = read('docs/styles.css');
  assert.match(css, /\.q-timeline\s*\{/);
  assert.match(css, /\.q-instruct\s*\{/);
  assert.match(css, /\.undo-toast/);
  assert.match(css, /\.q-stale-banner/);
});
