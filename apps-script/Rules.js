/**
 * Doorway Ops V3.2 — Campaign_Rules patches + Learning_Log writes.
 *
 * PATCH_CAMPAIGN_RULES is Owner-only (re-checked in DoorwayCore.checkCampaignPatch).
 * It never adds rates to the boot payload. Cache is busted after a successful
 * mutation. Blank / omitted patch fields are left untouched.
 *
 * Learning_Log appends also run after a successful APPROVE_AND_SEND that
 * included a human draft edit (see Queue.js). A failed log write is swallowed
 * so it cannot block or revert a send.
 */
var RULES_TAB = 'Campaign_Rules';
var LEARNING_TAB = 'Learning_Log';

function handleCampaignPatch_(user, req, props) {
  var check = DoorwayCore.checkCampaignPatch(user, req);
  if (!check.ok) return { status: check.status, error: check.error, detail: check.detail };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { status: 503, error: 'busy_try_again' };
  try {
    var payroll = props.getProperty('PAYROLL_SHEET_ID');
    if (!payroll) throw new Error('Missing payroll sheet id');
    var tab = readCampaignRules_(payroll);
    var want = String(check.campaignId).toLowerCase();
    var hit = null;
    for (var i = 0; i < tab.rows.length; i++) {
      if (String(tab.rows[i].Campaign_ID || '').trim().toLowerCase() === want) { hit = tab.rows[i]; break; }
    }
    var updates = {};
    Object.keys(check.updates).forEach(function (k) { updates[k] = check.updates[k]; });
    if (!hit) {
      if (updates.Active_Flag == null) updates.Active_Flag = 'N';
      if (updates.Clawback_Days == null) updates.Clawback_Days = 90;
    }
    var before = hit || {};
    var diff = DoorwayCore.campaignRuleDiff(before, updates);
    if (!diff) return { status: 200, campaignId: check.campaignId, changed: [], created: false };
    var campaignId = hit ? String(hit.Campaign_ID).trim() : check.campaignId;
    if (!hit) {
      var row = {};
      DoorwayCore.CAMPAIGN_RULE_FIELDS.forEach(function (k) { row[k] = ''; });
      row.Campaign_ID = campaignId;
      Object.keys(updates).forEach(function (k) { row[k] = updates[k]; });
      tab.sheet.appendRow(DoorwayCore.CAMPAIGN_RULE_FIELDS.map(function (k) { return safeCell_(row[k]); }));
    } else {
      setCells_(tab, hit._row, updates);
    }
    SpreadsheetApp.flush();
    logLearningSafe_(props, DoorwayCore.buildLearningLogRow({
      timestamp: isoNow_(),
      sourceModule: 'RULE_UPDATE',
      entityId: campaignId,
      beforeValue: diff.beforeValue,
      afterValue: diff.afterValue,
      patternTag: diff.patternTag,
      appliedToRules: true
    }));
    bustBootCache_();
    return { status: 200, campaignId: campaignId, changed: diff.fields, created: !hit };
  } finally {
    lock.releaseLock();
  }
}

function readCampaignRules_(spreadsheetId) {
  var sh = SpreadsheetApp.openById(spreadsheetId).getSheetByName(RULES_TAB);
  if (!sh) throw new Error('Missing tab ' + RULES_TAB);
  var values = sh.getDataRange().getValues();
  var headers = (values[0] || []).map(function (x) { return String(x).trim(); });
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var o = { _row: r + 1 }, any = false;
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      var v = values[r][c];
      o[headers[c]] = v;
      if (v !== '' && v !== null) any = true;
    }
    if (any) rows.push(o);
  }
  return { sheet: sh, headers: headers, rows: rows };
}

function appendLearningLog_(spreadsheetId, row) {
  var sh = SpreadsheetApp.openById(spreadsheetId).getSheetByName(LEARNING_TAB);
  if (!sh) throw new Error('Missing tab ' + LEARNING_TAB);
  sh.appendRow(DoorwayCore.LEARNING_LOG_COLUMNS.map(function (k) { return safeCell_(row[k]); }));
}

/** Best-effort Learning_Log write. Never throws — must not block Approve & Send. */
function logLearningSafe_(props, row) {
  try {
    var payroll = props && props.getProperty('PAYROLL_SHEET_ID');
    if (payroll) appendLearningLog_(payroll, row);
  } catch (err) {
    console.error('Learning_Log write failed: ' + (err && err.message));
  }
}
