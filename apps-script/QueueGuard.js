/**
 * Doorway Ops V3.6 — QueueGuard.
 *
 *   getFullThreadSnapshot_(draftId, threadId, fallbackSummary)
 *   checkThreadFreshness_(payload, row)
 *   instructDraftAndLogRule_(payload, user, props)
 *
 * SECURITY (changes from the Gemini Code Drop, which are intentional):
 *   - The doc's safeApproveAndSend_ is not used as a send path. It would have
 *     sent the Gmail draft without confirm / confirmCarrier / 428 / the
 *     PENDING-row claim, and it busted a global unkeyed boot-cache entry.
 *     Approve & Send stays in handleQueueAction_ (existing lock, confirm,
 *     428, 409 already_sent, claim-then-send). This file only supplies the
 *     snapshot and the pre-send stale-thread check (409 STALE_THREAD_NEW_REPLY).
 *   - Cache bust uses bustBootCache_() (role/email keyed generation).
 *   - instructDraftAndLogRule_ is Owner-only, edits the staged draft only
 *     (never sends), and writes Learning_Log through the existing columns
 *     via logLearningSafe_ / buildLearningLogRow.
 *   - HOLD_REP_INFO is implemented (listed in the spec, missing from the
 *     doc's if/else).
 *
 * Read paths never send mail and never mark messages read.
 */

function getFullThreadSnapshot_(draftId, threadId, fallbackSummary) {
  var snap = {
    draft_subject: '',
    draft_body: '',
    thread_id: threadId || '',
    thread_msg_count: 0,
    last_message_id: '',
    synced_at_et: Utilities.formatDate(new Date(), 'America/New_York', 'h:mm:ss a'),
    thread_timeline: [],
    thread_context: String(fallbackSummary || '').trim()
  };
  try {
    if (draftId) {
      var draft = GmailApp.getDraft(draftId);
      if (draft) {
        var dMsg = draft.getMessage();
        snap.draft_subject = dMsg.getSubject() || '';
        snap.draft_body = String(dMsg.getPlainBody() || '').trim().slice(0, 1500);
        if (!snap.thread_id) snap.thread_id = dMsg.getThread().getId();
      }
    }
    if (snap.thread_id) {
      var thread = GmailApp.getThreadById(snap.thread_id);
      if (thread) {
        var msgs = thread.getMessages();
        var nonDrafts = msgs.filter(function (m) { return !m.isDraft(); });
        snap.thread_msg_count = nonDrafts.length;
        if (nonDrafts.length > 0) {
          var latest = nonDrafts[nonDrafts.length - 1];
          snap.last_message_id = latest.getId();
          var dt = Utilities.formatDate(latest.getDate(), 'America/New_York', 'MMM d, h:mm a');
          var snippet = String(latest.getPlainBody() || '').replace(/\s+/g, ' ').trim().slice(0, 280);
          snap.thread_context = 'Latest (' + dt + ' · ' + latest.getFrom() + '): ' + snippet;
        }
        snap.thread_timeline = nonDrafts.slice(-5).map(function (m) {
          return {
            id: m.getId(),
            from: m.getFrom(),
            date_et: Utilities.formatDate(m.getDate(), 'America/New_York', 'MMM d, h:mm a'),
            snippet: String(m.getPlainBody() || '').replace(/\s+/g, ' ').trim().slice(0, 220)
          };
        });
      }
    }
  } catch (e) {}
  return snap;
}

function checkThreadFreshness_(payload, row) {
  payload = payload || {};
  row = row || {};
  var threadId = String(payload.threadId || '').trim();
  if (!threadId && isGmailThreadId_(row.Source_Thread_ID)) threadId = String(row.Source_Thread_ID).trim();
  var draftId = String(payload.draftId || row.Draft_ID || row.Gmail_Draft_ID || '').trim();
  if (!threadId && !payload.expectedLastMsgId && !Number(payload.expectedMsgCount || 0)) {
    return { ok: true };
  }
  var snap = getFullThreadSnapshot_(draftId, threadId, row.Context_Summary);
  var stale = DoorwayCore.checkStaleThread(payload, snap);
  if (!stale.ok) {
    return {
      status: 409,
      reason: 'STALE_THREAD_NEW_REPLY',
      error: stale.error,
      freshSnapshot: snap
    };
  }
  return { ok: true, snapshot: snap };
}

function sendIdempotencyKey_(payload) {
  var token = String((payload && (payload.idempotencyToken || payload.queueId)) || '').trim();
  if (!token) return '';
  return 'IDEM_SEND_' + token;
}

function instructDraftAndLogRule_(payload, user, props) {
  if (!DoorwayCore.isOwner(user)) return { status: 403, error: 'forbidden', message: 'Owner only.' };
  var check = DoorwayCore.checkInstructDraft(user, payload || {});
  if (!check.ok) return { status: check.status, error: check.error };

  var applied = DoorwayCore.applyInstructDraft(payload || {});
  var updatedBody = applied.updatedBody;
  var queueId = String((payload && payload.queueId) || '').trim();
  var draftId = String((payload && payload.draftId) || '').trim();

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { status: 503, error: 'busy_try_again' };
  try {
    if (draftId && updatedBody) {
      try {
        var draft = GmailApp.getDraft(draftId);
        if (draft) {
          var msg = draft.getMessage();
          var opts = {};
          var cc = msg.getCc();
          var bcc = msg.getBcc();
          if (cc) opts.cc = cc;
          if (bcc) opts.bcc = bcc;
          draft.update(msg.getTo(), msg.getSubject(), updatedBody, opts);
        }
      } catch (err) {
        console.error('instruct draft.update failed: ' + (err && err.message));
      }
    }

    var sheetId = queueSheetId_(props);
    var q = readQueue_(sheetId);
    var hit = null;
    for (var i = 0; i < q.rows.length; i++) {
      if (String(q.rows[i].Queue_ID).trim() === queueId) { hit = q.rows[i]; break; }
    }
    if (!hit) return { status: 404, error: 'queue_item_not_found' };
    if (String(hit.Status || '').trim().toUpperCase() !== 'PENDING') {
      return { status: 409, error: 'not_pending' };
    }
    if (!draftId) draftId = String(hit.Draft_ID || hit.Gmail_Draft_ID || '').trim();
    setCells_(q, hit._row, { Draft_Body: updatedBody });
    SpreadsheetApp.flush();

    logLearningSafe_(props, DoorwayCore.buildLearningLogRow({
      timestamp: isoNow_(),
      sourceModule: applied.saveAsRule ? 'QUEUE_SOP_RULE' : 'QUEUE_VOICE_EDIT',
      entityId: queueId,
      beforeValue: String((payload && payload.currentBody) || hit.Draft_Body || '').slice(0, 300),
      afterValue: String(updatedBody || '').slice(0, 300),
      patternTag: applied.saveAsRule
        ? ('CANDIDATE_Y:' + (applied.chip || applied.instruction || ''))
        : (applied.chip || applied.instruction || 'N'),
      appliedToRules: false
    }));
    bustBootCache_();
    return { status: 200, updatedBody: updatedBody, savedRule: applied.saveAsRule, queueId: queueId };
  } finally {
    lock.releaseLock();
  }
}
