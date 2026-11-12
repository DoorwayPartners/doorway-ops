/**
 * Doorway Ops V2 — Owner Priority Queue backend (Ops_Approval_Queue tab, columns A–M).
 *
 * Actions (POST {idToken, action, ...}; dispatched from Code.js handle_ AFTER the ID
 * token is verified and the user is found in Portal_Users):
 *   GET_QUEUE            -> PENDING rows sorted P1 -> P2 -> P3
 *   APPROVE_AND_SEND     -> {queueId, confirm:true, confirmCarrier?, editedTo?, editedCc?, editedSubject?, editedBody?}
 *   UPDATE_QUEUE_STATUS  -> {queueId, newStatus: 'SNOOZED' | 'DISMISSED'}
 *
 * Guarantees:
 *   - Owner role only (non-Owner -> 403). Checked here AND in DoorwayCore.checkQueueAction.
 *   - Nothing is ever sent automatically: only APPROVE_AND_SEND, which the UI fires on
 *     the Owner's explicit click + confirm, can send, and only the row's staged draft
 *     (any Owner edits are written back to the row first, so the row = what was sent).
 *   - Exactly once: inside a script lock the row is re-read, must be PENDING, and is
 *     stamped APPROVED_SENT + Resolved_At BEFORE sending (at-most-once). A failed send
 *     reverts the row to PENDING with the original draft. A sent row is refused (409).
 *   - Carrier recipients (fidium, consolidated, metronet, brightspeed, frontier, att,
 *     t-mobile, gonetspeed, ...) require confirmCarrier:true (second UI confirm) -> else 428.
 *   - Sender = the deploying account (Execute as: Me = cristian@doorwaypartners.com).
 *
 * Script Properties: QUEUE_SHEET_ID (optional; defaults to PAYROLL_SHEET_ID).
 */
var QUEUE_TAB = 'Ops_Approval_Queue';
var INTAKE_LABEL = 'ops-queued';
var INTAKE_QUERY = 'is:unread (label:help-intake OR subject:"New Rep Application") newer_than:2d -label:' + INTAKE_LABEL;

function queueSheetId_(props) {
  return props.getProperty('QUEUE_SHEET_ID') || props.getProperty('PAYROLL_SHEET_ID');
}

function handleQueueAction_(action, user, req, props) {
  if (!DoorwayCore.isOwner(user)) return { status: 403, error: 'forbidden', message: 'Owner only.' };
  var sheetId = queueSheetId_(props);
  if (action === 'GET_QUEUE') {
    var q = DoorwayCore.buildQueue(readQueue_(sheetId).rows);
    attachQueuePreviews_(q);
    q.status = 200;
    return q;
  }
  if (action !== 'APPROVE_AND_SEND' && action !== 'UPDATE_QUEUE_STATUS') return { status: 400, error: 'bad_action' };
  var queueId = String((req && req.queueId) || '').trim();
  if (!/^Q-\d{8}-\d{3,}$/.test(queueId)) return { status: 400, error: 'bad_queue_id' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { status: 503, error: 'busy_try_again' };
  try {
    var q2 = readQueue_(sheetId);
    var hit = null;
    for (var i = 0; i < q2.rows.length; i++) if (String(q2.rows[i].Queue_ID).trim() === queueId) { hit = q2.rows[i]; break; }
    var check = DoorwayCore.checkQueueAction(user, action, hit, req || {});
    if (!check.ok) return { status: check.status, error: check.error, carrier: check.carrier, detail: check.detail };
    var now = isoNow_();

    if (action === 'UPDATE_QUEUE_STATUS') {
      setCells_(q2, hit._row, { Status: check.newStatus, Resolved_At: now });
      bustBootCache_();
      return { status: 200, queueId: queueId, newStatus: check.newStatus, resolvedAt: now };
    }

    // APPROVE_AND_SEND: claim first (at-most-once), with the exact message that goes out.
    var original = { Draft_To: hit.Draft_To, Draft_Cc: hit.Draft_Cc, Draft_Subject: hit.Draft_Subject, Draft_Body: hit.Draft_Body };
    var m = check.send;
    setCells_(q2, hit._row, { Draft_To: m.to, Draft_Cc: m.cc, Draft_Subject: m.subject, Draft_Body: m.body, Status: 'APPROVED_SENT', Resolved_At: now });
    SpreadsheetApp.flush();
    bustBootCache_();
    var how;
    try {
      how = sendStaged_(hit.Source_Thread_ID, m);
    } catch (err) {
      console.error('send failed ' + queueId + ': ' + (err && err.message));
      original.Status = 'PENDING'; original.Resolved_At = '';
      setCells_(q2, hit._row, original);
      SpreadsheetApp.flush();
      bustBootCache_();
      return { status: 502, error: 'send_failed', message: 'Not sent. The item is back in the queue.' };
    }
    var draftDiff = DoorwayCore.queueDraftDiff(hit, req || {});
    if (draftDiff) {
      logLearningSafe_(props, DoorwayCore.buildLearningLogRow({
        timestamp: now,
        sourceModule: 'QUEUE_EDIT',
        entityId: queueId,
        beforeValue: draftDiff.beforeValue,
        afterValue: draftDiff.afterValue,
        patternTag: draftDiff.patternTag,
        appliedToRules: false
      }));
    }
    return { status: 200, queueId: queueId, sent: true, via: how, to: m.to, cc: m.cc, resolvedAt: now };
  } finally {
    lock.releaseLock();
  }
}

/** Reply in-thread when the staged recipient is the thread's last sender; otherwise a new email. */
function sendStaged_(sourceId, m) {
  var opts = { name: 'Cristian Coy' };
  if (m.cc) opts.cc = m.cc;
  var sid = String(sourceId || '').trim();
  if (/^[0-9a-f]{12,20}$/i.test(sid)) {
    var thread = null;
    try { thread = GmailApp.getThreadById(sid); } catch (e) { thread = null; }
    if (thread) {
      var msgs = thread.getMessages();
      var last = msgs[msgs.length - 1];
      var lastAddr = bareEmail_(last.getReplyTo() || last.getFrom());
      var to = m.to.split(/\s*,\s*/);
      if (to.length === 1 && lastAddr && bareEmail_(to[0]) === lastAddr) {
        last.reply(m.body, opts);
        return 'thread_reply';
      }
    }
  }
  GmailApp.sendEmail(m.to, m.subject, m.body, opts);
  return 'new_email';
}

function bareEmail_(s) {
  var mm = String(s || '').match(/<([^>]+)>/);
  return String(mm ? mm[1] : s || '').trim().toLowerCase();
}


/**
 * V3.5: enrich Owner queue items with the Gmail draft body and the latest
 * inbound thread snippet so the UI can render them with no extra round-trip.
 * Read-only: never sends, never marks mail read. Falls back to the sheet
 * Context_Summary / staged Draft_* when Gmail is unavailable.
 */
function extractThreadAndDraftPreview_(draftId, threadId, fallbackSummary) {
  var preview = {
    draft_subject: '',
    draft_body: '',
    thread_context: String(fallbackSummary || '').trim()
  };
  try {
    if (draftId) {
      var draft = GmailApp.getDraft(draftId);
      if (draft) {
        var msg = draft.getMessage();
        preview.draft_subject = msg.getSubject() || '';
        preview.draft_body = String(msg.getPlainBody() || '').trim().slice(0, 1200);
        if (!threadId) threadId = msg.getThread().getId();
      }
    }
    if (threadId) {
      var thread = GmailApp.getThreadById(threadId);
      if (thread) {
        var msgs = thread.getMessages();
        // If no draft id was stored, use the latest draft message on the thread.
        if (!preview.draft_body) {
          for (var d = msgs.length - 1; d >= 0; d--) {
            if (msgs[d].isDraft()) {
              preview.draft_subject = msgs[d].getSubject() || '';
              preview.draft_body = String(msgs[d].getPlainBody() || '').trim().slice(0, 1200);
              break;
            }
          }
        }
        // Find latest non-draft message for context
        for (var i = msgs.length - 1; i >= 0; i--) {
          if (!msgs[i].isDraft()) {
            var from = msgs[i].getFrom();
            var dt = Utilities.formatDate(msgs[i].getDate(), 'America/New_York', 'MMM d, h:mm a');
            var snippet = String(msgs[i].getPlainBody() || '').replace(/\s+/g, ' ').trim().slice(0, 260);
            preview.thread_context = 'Last msg (' + dt + ' from ' + from + '): ' + snippet;
            break;
          }
        }
      }
    }
  } catch (err) {
    // Keep fallbackSummary safely on error
  }
  return preview;
}

function isGmailThreadId_(id) {
  return /^[0-9a-f]{12,20}$/i.test(String(id || '').trim());
}

function attachQueuePreviews_(q) {
  (q && q.items || []).forEach(function (it) {
    var threadId = isGmailThreadId_(it.Source_Thread_ID) ? String(it.Source_Thread_ID).trim() : '';
    var draftId = String(it.Draft_ID || it.Gmail_Draft_ID || '').trim();
    var preview = extractThreadAndDraftPreview_(draftId, threadId, it.Context_Summary);
    DoorwayCore.applyQueuePreview(it, preview);
  });
  return q;
}

/** Read the queue tab with row numbers. Header row 1 must be the A–M columns. */
function readQueue_(sheetId) {
  if (!sheetId) throw new Error('Missing queue sheet id');
  var sh = SpreadsheetApp.openById(sheetId).getSheetByName(QUEUE_TAB);
  if (!sh) throw new Error('Missing tab ' + QUEUE_TAB);
  var values = sh.getDataRange().getValues();
  var headers = (values[0] || []).map(function (x) { return String(x).trim(); });
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var o = { _row: r + 1 }, any = false;
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      var v = values[r][c];
      if (v instanceof Date) v = Utilities.formatDate(v, TZ, "yyyy-MM-dd'T'HH:mm:ss");
      o[headers[c]] = v;
      if (v !== '' && v !== null) any = true;
    }
    if (any) rows.push(o);
  }
  return { sheet: sh, headers: headers, rows: rows };
}

/** Write named cells on one row. Text that Sheets would parse as a formula is escaped. */
function setCells_(q, rowNum, fields) {
  Object.keys(fields).forEach(function (k) {
    var c = q.headers.indexOf(k);
    if (c < 0) throw new Error('Missing column ' + k);
    q.sheet.getRange(rowNum, c + 1).setValue(safeCell_(fields[k]));
  });
}
function safeCell_(v) {
  var s = v == null ? '' : String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
function isoNow_() { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"); }

// ==========================================================================
// Spec §3.3 optional real-time push: 5-minute urgent intake.
// NOT INSTALLED. Nothing runs until Cristian runs installUrgentIntakeTrigger()
// once from the Apps Script editor. It never sends mail and never marks mail
// read; it only adds a PENDING row (no draft) and the Gmail label "ops-queued".
// ==========================================================================
function urgentIntakeSweep() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 'busy';
  try {
    var props = PropertiesService.getScriptProperties();
    var q = readQueue_(queueSheetId_(props));
    var threads = GmailApp.search(INTAKE_QUERY, 0, 25);
    if (!threads.length) return 'added 0';
    var label = GmailApp.getUserLabelByName(INTAKE_LABEL) || GmailApp.createLabel(INTAKE_LABEL);
    var today = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
    var added = 0;
    var orders = null;
    var roster = null;
    function loadLinkData_() {
      if (orders) return;
      orders = []; roster = [];
      try {
        var payroll = props.getProperty('PAYROLL_SHEET_ID');
        if (!payroll) return;
        orders = readTab_(payroll, TABS.orders).map(function (o) {
          return { Order_ID: o.Order_ID, Service_Address: o.Service_Address, C2C_Status: o.C2C_Status, Rep_Name: o.Rep_Name };
        });
        roster = readTab_(payroll, TABS.users).map(function (u) {
          return { Rep_Name: u.Name || u.Rep_Name };
        });
      } catch (err) {
        console.error('entity linker load failed: ' + (err && err.message));
        orders = []; roster = [];
      }
    }
    threads.forEach(function (t) {
      var tid = t.getId();
      if (!DoorwayCore.hasSourceThread(q.rows, tid)) {
        var msgs = t.getMessages();
        var last = msgs[msgs.length - 1];
        var subject = t.getFirstMessageSubject() || '(no subject)';
        var isApp = /new rep application/i.test(subject);
        var bodyText = String(last.getPlainBody() || '').replace(/\s+/g, ' ').trim();
        var snippet = bodyText.slice(0, 220);
        loadLinkData_();
        var link = enrichEntityContext(subject + '\n' + bodyText.slice(0, 4000), orders, roster);
        var tag = (link && link.summaryTag) ? '[' + link.summaryTag + '] ' : '';
        var row = {
          Queue_ID: DoorwayCore.nextQueueId(q.rows, today),
          Created_At: isoNow_(),
          Priority: isApp ? 'P3-ADMIN' : 'P1-URGENT',
          Category: isApp ? 'Recruit_App' : 'Escalation',
          Source_Thread_ID: tid,
          Rep_Or_Sender: last.getFrom(),
          Context_Summary: tag + 'New ' + (isApp ? 'rep application' : 'help@ intake') + ': "' + subject + '". ' + snippet + ' (No draft yet; Brooklynn\'s sweep writes it.)',
          Draft_To: '', Draft_Cc: '', Draft_Subject: '', Draft_Body: '',
          Status: 'PENDING', Resolved_At: ''
        };
        q.sheet.appendRow(DoorwayCore.QUEUE_COLUMNS.map(function (k) { return safeCell_(row[k]); }));
        q.rows.push(row);
        added++;
        if (link && link.summaryTag === 'Unlinked Intake') {
          logLearningSafe_(props, DoorwayCore.buildLearningLogRow({
            timestamp: row.Created_At,
            sourceModule: 'ENTITY_LINK',
            entityId: tid,
            beforeValue: '',
            afterValue: String(subject || '').slice(0, 180),
            patternTag: 'UNLINKED_INTAKE',
            appliedToRules: false
          }));
        }
      }
      t.addLabel(label);
    });
    if (added > 0) bustBootCache_();
    return 'added ' + added;
  } finally {
    lock.releaseLock();
  }
}

/** Run ONCE from the editor to turn on the 5-minute intake (Cristian only). */
function installUrgentIntakeTrigger() {
  removeUrgentIntakeTrigger();
  ScriptApp.newTrigger('urgentIntakeSweep').timeBased().everyMinutes(5).create();
  return 'urgentIntakeSweep trigger installed (every 5 minutes)';
}
function removeUrgentIntakeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'urgentIntakeSweep') ScriptApp.deleteTrigger(tr);
  });
  return 'urgentIntakeSweep triggers removed';
}
