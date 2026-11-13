/**
 * Doorway Ops V4.0 — GroupMe field ingest (apps-script/GroupMeBridge.js).
 *
 * STRICTLY READ-ONLY: this module never posts, replies, or sends a bot
 * message to GroupMe. It only parses pasted transcripts (or a GET of recent
 * messages when Cristian has set GROUPME_TOKEN + GROUPME_GROUP_ID in Script
 * Properties) and stages matching field questions / install issues onto
 * Ops_Approval_Queue as PENDING drafts. Nothing is sent.
 *
 * If no token is configured, API fetch is a clean no-op; pasted ingest
 * still works. There is no public webhook that posts back to GroupMe.
 */
var DoorwayGroupMe = (function () {
  var ISSUE_RE = /(cancel|cancelled|canceled|disconnect|missed install|no[ -]?show|reschedul|delay|won'?t be home|permitting|not installed|customer issue|angry|complaint|outage|failed install|tech no[ -]?show)/i;
  var ORDER_RE = /\b(26\d{4}[A-Za-z0-9]{2,6}|DEMO-\d+)\b/i;

  function norm(s) { return String(s == null ? '' : s).trim(); }

  function checkStage(user) {
    if (!user || user.role !== 'Owner') return { ok: false, status: 403, error: 'owner_only' };
    return { ok: true };
  }

  function normalizeMsg(m) {
    m = m || {};
    return {
      id: norm(m.id || m.message_id || m.cid || ''),
      name: norm(m.name || m.nickname || m.user_name || ''),
      text: norm(m.text || m.message || m.body || ''),
      created_at: m.created_at || m.createdAt || m.created || ''
    };
  }

  function parsePlain(text) {
    var lines = String(text || '').split(/\r?\n/);
    var out = [], i, line, m, cur = null;
    for (i = 0; i < lines.length; i++) {
      line = lines[i];
      m = line.match(/^([^:]{2,80}):\s*(.*)$/);
      if (m && !/https?/.test(m[1]) && m[1].length < 60) {
        if (cur && cur.text) out.push(cur);
        cur = { id: '', name: m[1].trim(), text: m[2], created_at: '' };
      } else if (cur) {
        cur.text = (cur.text ? cur.text + ' ' : '') + line.trim();
      } else if (line.trim()) {
        out.push({ id: '', name: '', text: line.trim(), created_at: '' });
      }
    }
    if (cur && cur.text) out.push(cur);
    return out;
  }

  function parseMessages(input) {
    if (input == null || input === '') return [];
    if (Array.isArray(input)) return input.map(normalizeMsg).filter(function (m) { return m.text; });
    if (typeof input === 'object') {
      if (Array.isArray(input.messages)) return parseMessages(input.messages);
      if (input.response && Array.isArray(input.response.messages)) return parseMessages(input.response.messages);
      if (input.text || input.body) {
        if (input.name || input.id) return [normalizeMsg(input)].filter(function (m) { return m.text; });
        return parseMessages(input.text || input.body);
      }
    }
    var raw = String(input);
    var t = raw.trim();
    if (t.charAt(0) === '{' || t.charAt(0) === '[') {
      try { return parseMessages(JSON.parse(t)); } catch (e) { /* fall through to plain text */ }
    }
    return parsePlain(raw).map(normalizeMsg).filter(function (m) { return m.text; });
  }

  function classify(text) {
    var t = String(text || '');
    if (/\?/.test(t)) return 'Field_Question';
    if (ISSUE_RE.test(t)) return 'Field_Issue';
    return null;
  }

  function extractAddress(text) {
    var m = String(text || '').match(/\b(\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,6}\s(?:st|street|rd|road|ave|avenue|dr|drive|ln|lane|ct|court|blvd|way|ter|terrace|cir|circle)\b(?:[,\s]+[A-Za-z .'-]+){0,3})/i);
    return m ? m[1].trim() : '';
  }

  /**
   * Build a staging plan from parsed messages. Does not write or send.
   * linker(text) may return { linkedOrder, linkedRep, summaryTag }.
   */
  function planDigest(messages, existingQueueRows, linker) {
    var staged = [];
    var skipped = [];
    (messages || []).forEach(function (raw) {
      var msg = normalizeMsg(raw);
      if (!msg.text) return;
      var category = classify(msg.text);
      if (!category) {
        skipped.push({ id: msg.id, reason: 'not_issue_or_question' });
        return;
      }
      var link = typeof linker === 'function' ? (linker(msg.name + '\n' + msg.text) || {}) : {};
      var orderId = (link.linkedOrder && link.linkedOrder.Order_ID) || '';
      if (!orderId) {
        var om = msg.text.match(ORDER_RE);
        if (om) orderId = om[1].toUpperCase();
      }
      var repName = (link.linkedRep && link.linkedRep.Rep_Name) || '';
      if (!repName && link.linkedOrder && link.linkedOrder.Rep_Name) repName = link.linkedOrder.Rep_Name;
      if (!repName) repName = msg.name;
      var address = extractAddress(msg.text);
      var description = msg.text.replace(/\s+/g, ' ').trim().slice(0, 500);
      var missing = [];
      if (!orderId) missing.push('Order #');
      if (!repName) missing.push('Rep Name');
      if (!address) missing.push('Customer Address');
      if (!description) missing.push('Short Description');
      var sourceId = 'gm-' + (msg.id || String(msg.name + '|' + msg.text).slice(0, 80));
      if (existingQueueRows && typeof DoorwayCore !== 'undefined' && DoorwayCore.hasSourceThread(existingQueueRows, sourceId)) {
        skipped.push({ id: msg.id, reason: 'duplicate', sourceId: sourceId });
        return;
      }
      if (existingQueueRows && !stagedSourceAlready_(existingQueueRows, sourceId) && hasSource_(existingQueueRows, sourceId)) {
        skipped.push({ id: msg.id, reason: 'duplicate', sourceId: sourceId });
        return;
      }
      staged.push({
        sourceId: sourceId,
        category: category,
        priority: 'P2-OPS',
        orderId: orderId,
        repName: repName,
        address: address,
        description: description,
        missingFields: missing,
        completeForCarrier: missing.length === 0,
        summaryTag: (link && link.summaryTag) || (orderId ? ('Order ' + orderId) : (repName ? ('Rep: ' + repName) : 'Unlinked Intake')),
        fromName: msg.name,
        text: description,
        // Drafts stay empty — GroupMe ingest never sends.
        draftTo: '',
        draftSubject: '',
        draftBody: ''
      });
    });
    return { staged: staged, skipped: skipped, ingested: (messages || []).length };
  }

  function hasSource_(rows, sourceId) {
    var s = String(sourceId || '').trim();
    return !!s && (rows || []).some(function (r) { return String((r && r.Source_Thread_ID) || '').trim() === s; });
  }
  function stagedSourceAlready_(rows, sourceId) { return hasSource_(rows, sourceId); }

  function queueRowFromPlan(item, queueId, createdAt) {
    var missingNote = item.missingFields && item.missingFields.length
      ? ' Missing for carrier packet: ' + item.missingFields.join(', ') + '.'
      : '';
    var ctx = '[' + item.summaryTag + '] GroupMe ' + String(item.category || '').replace(/_/g, ' ').toLowerCase() +
      ' from ' + (item.fromName || 'field') + '. ' + item.text + missingNote + ' (Draft not sent.)';
    return {
      Queue_ID: queueId,
      Created_At: createdAt || '',
      Priority: item.priority || 'P2-OPS',
      Category: item.category,
      Source_Thread_ID: item.sourceId,
      Rep_Or_Sender: item.repName || item.fromName || '',
      Context_Summary: ctx.slice(0, 1500),
      Draft_To: '',
      Draft_Cc: '',
      Draft_Subject: '',
      Draft_Body: '',
      Status: 'PENDING',
      Resolved_At: ''
    };
  }

  return {
    checkStage: checkStage,
    parseMessages: parseMessages,
    classify: classify,
    planDigest: planDigest,
    queueRowFromPlan: queueRowFromPlan,
    extractAddress: extractAddress
  };
})();

function handleStageGroupMeDigest_(user, req, props) {
  var check = DoorwayGroupMe.checkStage(user);
  if (!check.ok) return { status: check.status, error: check.error };
  req = req || {};
  var pasted = req.messages != null ? req.messages : (req.text != null ? req.text : req.body);
  var messages = DoorwayGroupMe.parseMessages(pasted);
  var fetchRequested = !!req.fetchLatest || !!req.fetch;
  var tokenNote = '';
  if (fetchRequested) {
    var token = props && props.getProperty('GROUPME_TOKEN');
    var groupId = props && props.getProperty('GROUPME_GROUP_ID');
    if (!token) {
      tokenNote = 'groupme_token_not_configured';
    } else if (!groupId) {
      tokenNote = 'groupme_group_id_not_configured';
    } else {
      var fetched = fetchGroupMeMessagesReadOnly_(token, groupId);
      if (fetched.error) tokenNote = fetched.error;
      else messages = messages.concat(fetched.messages || []);
    }
  } else if (!messages.length) {
    var hasToken = !!(props && props.getProperty('GROUPME_TOKEN'));
    if (!hasToken) tokenNote = 'groupme_token_not_configured';
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { status: 503, error: 'busy_try_again' };
  try {
    var q = readQueue_(queueSheetId_(props));
    var orders = [];
    var roster = [];
    try {
      var payroll = props.getProperty('PAYROLL_SHEET_ID');
      if (payroll) {
        orders = readTab_(payroll, TABS.orders).map(function (o) {
          return { Order_ID: o.Order_ID, Service_Address: o.Service_Address, C2C_Status: o.C2C_Status, Rep_Name: o.Rep_Name };
        });
        roster = readTab_(payroll, TABS.users).map(function (u) {
          return { Rep_Name: u.Name || u.Rep_Name };
        });
      }
    } catch (err) {
      console.error('GroupMe linker load failed: ' + (err && err.message));
    }
    var linker = function (text) { return enrichEntityContext(text, orders, roster); };
    var plan = DoorwayGroupMe.planDigest(messages, q.rows, linker);
    var today = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
    var added = 0;
    plan.staged.forEach(function (item) {
      if (DoorwayCore.hasSourceThread(q.rows, item.sourceId)) return;
      var row = DoorwayGroupMe.queueRowFromPlan(item, DoorwayCore.nextQueueId(q.rows, today), isoNow_());
      q.sheet.appendRow(DoorwayCore.QUEUE_COLUMNS.map(function (k) { return safeCell_(row[k]); }));
      q.rows.push(row);
      added++;
    });
    if (added > 0) bustBootCache_();
    var out = {
      status: 200,
      ingested: plan.ingested,
      staged: added,
      skipped: plan.skipped.length,
      posted: false
    };
    if (tokenNote) out.note = tokenNote;
    return out;
  } finally {
    lock.releaseLock();
  }
}

/**
 * GET-only GroupMe read. Never uses POST, never sends a bot message.
 * Called only when Script Properties already contain a token Cristian set.
 */
function fetchGroupMeMessagesReadOnly_(token, groupId) {
  if (!token || !groupId) return { messages: [], error: 'groupme_token_not_configured' };
  if (!/^[A-Za-z0-9_-]+$/.test(String(groupId))) return { messages: [], error: 'bad_group_id' };
  var url = 'https://api.groupme.com/v3/groups/' + encodeURIComponent(groupId) +
    '/messages?limit=50&token=' + encodeURIComponent(token);
  var resp = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true, followRedirects: true });
  if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) {
    return { messages: [], error: 'groupme_fetch_failed' };
  }
  var body = {};
  try { body = JSON.parse(resp.getContentText() || '{}'); } catch (e) { return { messages: [], error: 'groupme_fetch_failed' }; }
  var list = body && body.response && body.response.messages ? body.response.messages : [];
  return { messages: DoorwayGroupMe.parseMessages(list) };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DoorwayGroupMe;
}
