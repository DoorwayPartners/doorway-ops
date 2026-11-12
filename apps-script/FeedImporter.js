/**
 * Doorway Ops V3.3 — Module 2: universal raw feed importer (apps-script/FeedImporter.js).
 *
 * Accepts raw CSV (carrier exports, SalesRabbit pins, turf files), normalizes
 * headers via aliases, and appends or upserts into the Raw_Feed_Import tab
 * only. Never writes pay/rate/commission columns, never touches Order_Ledger,
 * Payroll_Ledger, Campaign_Rules, or any other tab, and never deletes rows.
 * IMPORT_RAW_FEED is Owner-only. Cache is busted after a successful write.
 */
var DoorwayFeed = (function () {
  var HEADER_ALIASES = {
    order_id: ['order id', 'order_id', 'order #', 'confirmation', 'c2c order'],
    rep_name: ['rep', 'rep name', 'rep_name', 'sr assigned to', 'agent', 'sales rep'],
    address: ['address', 'service address', 'service_address', 'street'],
    city: ['city', 'town', 'market'],
    status: ['status', 'c2c status', 'c2c_status', 'sr status', 'disposition'],
    campaign: ['campaign', 'carrier', 'provider']
  };
  var FEED_COLUMNS = [
    'Imported_At', 'Campaign_ID', 'Feed_Type', 'Order_ID', 'Rep_Name',
    'Address', 'City', 'Status', 'Import_Batch'
  ];
  var FEED_TAB = 'Raw_Feed_Import';
  var CANON_TO_COL = {
    order_id: 'Order_ID',
    rep_name: 'Rep_Name',
    address: 'Address',
    city: 'City',
    status: 'Status',
    campaign: 'Campaign_ID'
  };
  var FEED_TYPES = ['RAW_UPLOAD', 'CARRIER_EXPORT', 'SALESRABBIT', 'TURF'];
  var MAX_ROWS = 2000;
  var MAX_CSV_CHARS = 800000;
  var MAX_CELL = 500;
  var CAMPAIGN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_]{0,63}$/;
  // Pay, rate, margin, and commission-like headers are dropped, never written.
  var PAY_HEADER_RE = /(pay|payout|payroll|commission|^comm$|_comm$|comm_|rate|margin|wage|salary|bonus|override|clawback|hold_back|holdback|gross_agency|net_order|net_payout)/i;

  function normalizeHeader(h) {
    var clean = String(h || '').trim().toLowerCase();
    for (var canonical in HEADER_ALIASES) {
      if (HEADER_ALIASES[canonical].indexOf(clean) !== -1) return canonical;
    }
    return clean.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  function clip(s, n) {
    var t = String(s == null ? '' : s).trim();
    return t.length > n ? t.slice(0, n) : t;
  }

  function parseCsv(text) {
    if (typeof Utilities !== 'undefined' && Utilities.parseCsv) return Utilities.parseCsv(text || '');
    text = String(text || '');
    if (!text) return [];
    var rows = [], row = [], field = '', i = 0, quoted = false;
    while (i < text.length) {
      var ch = text.charAt(i);
      if (quoted) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i++; }
          else quoted = false;
        } else field += ch;
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ',') {
        row.push(field); field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text.charAt(i + 1) === '\n') i++;
        row.push(field); field = '';
        if (row.some(function (c) { return String(c) !== ''; })) rows.push(row);
        row = [];
      } else {
        field += ch;
      }
      i++;
    }
    if (field !== '' || row.length) { row.push(field); if (row.some(function (c) { return String(c) !== ''; })) rows.push(row); }
    return rows;
  }

  function checkImport(user, params) {
    if (!user || user.role !== 'Owner') return { ok: false, status: 403, error: 'owner_only' };
    params = params || {};
    var csvText = params.csvText != null ? String(params.csvText) : (params.csv != null ? String(params.csv) : '');
    if (csvText.length > MAX_CSV_CHARS) return { ok: false, status: 400, error: 'csv_too_large', detail: MAX_CSV_CHARS };
    var campaignId = String(params.campaignId || params.campaign || 'FIDIUM').trim();
    if (!CAMPAIGN_ID_RE.test(campaignId)) return { ok: false, status: 400, error: 'bad_campaign_id' };
    var feedType = String(params.feedType || 'RAW_UPLOAD').trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (FEED_TYPES.indexOf(feedType) < 0) return { ok: false, status: 400, error: 'bad_feed_type' };
    if (!csvText.trim()) return { ok: false, status: 400, error: 'empty_csv' };
    var rows = parseCsv(csvText);
    if (!rows.length || rows.length < 2) return { ok: false, status: 400, error: 'CSV must contain headers and at least 1 data row.' };
    if (rows.length - 1 > MAX_ROWS) return { ok: false, status: 400, error: 'too_many_rows', detail: MAX_ROWS };
    return { ok: true, campaignId: campaignId, feedType: feedType, rows: rows };
  }

  /**
   * Pure planner: maps CSV rows onto FEED_COLUMNS, splits append vs upsert
   * (upsert key = Order_ID + Campaign_ID when Order_ID is present), and lists
   * header mismatches / dropped pay columns for Learning_Log.
   * existingRows are objects with FEED_COLUMNS plus optional _row.
   */
  function planImport(check, existingRows, nowIso, batchId) {
    var headers = (check.rows[0] || []).map(normalizeHeader);
    var headerMismatches = [];
    var droppedHeaders = [];
    var seen = {};
    (check.rows[0] || []).forEach(function (raw, i) {
      var canon = headers[i];
      if (seen[canon]) return;
      seen[canon] = true;
      if (PAY_HEADER_RE.test(canon)) {
        droppedHeaders.push(String(raw || canon));
        return;
      }
      if (!CANON_TO_COL[canon] && canon !== 'feed_type' && canon !== 'imported_at' && canon !== 'import_batch') {
        headerMismatches.push({ raw: String(raw || ''), normalized: canon });
      }
    });

    var existingByKey = {};
    (existingRows || []).forEach(function (r) {
      var oid = String(r.Order_ID || '').trim().toUpperCase();
      var cid = String(r.Campaign_ID || '').trim().toUpperCase();
      if (oid) existingByKey[cid + '|' + oid] = r;
    });

    var append = [];
    var updates = [];
    var townCounts = {};
    var records = [];

    for (var i = 1; i < check.rows.length; i++) {
      var src = check.rows[i] || [];
      var obj = {
        Imported_At: nowIso || '',
        Campaign_ID: check.campaignId,
        Feed_Type: check.feedType,
        Order_ID: '',
        Rep_Name: '',
        Address: '',
        City: '',
        Status: '',
        Import_Batch: batchId || ''
      };
      for (var j = 0; j < headers.length; j++) {
        var canon = headers[j];
        if (PAY_HEADER_RE.test(canon)) continue;
        var col = CANON_TO_COL[canon];
        if (!col) continue;
        var val = clip(src[j], MAX_CELL);
        if (!val) continue;
        if (col === 'Campaign_ID') {
          if (CAMPAIGN_ID_RE.test(val)) obj.Campaign_ID = val;
          continue;
        }
        obj[col] = val;
      }
      var town = obj.City || 'Unknown';
      townCounts[town] = (townCounts[town] || 0) + 1;
      records.push(obj);

      var key = String(obj.Campaign_ID || '').toUpperCase() + '|' + String(obj.Order_ID || '').toUpperCase();
      var hit = obj.Order_ID && existingByKey[key];
      if (hit) {
        var fields = {};
        FEED_COLUMNS.forEach(function (k) {
          if (k === 'Imported_At' || k === 'Import_Batch' || k === 'Campaign_ID' || k === 'Order_ID') return;
          if (obj[k]) fields[k] = obj[k];
        });
        fields.Imported_At = obj.Imported_At;
        fields.Import_Batch = obj.Import_Batch;
        fields.Feed_Type = obj.Feed_Type;
        updates.push({ _row: hit._row, Order_ID: obj.Order_ID, Campaign_ID: obj.Campaign_ID, fields: fields });
        // prevent a later row in the same batch from also appending this key
        existingByKey[key]._row = hit._row;
      } else {
        append.push(obj);
        if (obj.Order_ID) existingByKey[key] = obj;
      }
    }

    return {
      status: 200,
      campaign: check.campaignId,
      feedType: check.feedType,
      batchId: batchId || '',
      importedCount: records.length,
      appended: append.length,
      updated: updates.length,
      townBreakdown: townCounts,
      headerMismatches: headerMismatches,
      droppedHeaders: droppedHeaders,
      append: append,
      updates: updates,
      sample: records.slice(0, 5)
    };
  }

  return {
    HEADER_ALIASES: HEADER_ALIASES,
    FEED_COLUMNS: FEED_COLUMNS,
    FEED_TAB: FEED_TAB,
    FEED_TYPES: FEED_TYPES,
    MAX_ROWS: MAX_ROWS,
    MAX_CSV_CHARS: MAX_CSV_CHARS,
    normalizeHeader: normalizeHeader,
    parseCsv: parseCsv,
    checkImport: checkImport,
    planImport: planImport
  };
})();

function normalizeHeader_(h) { return DoorwayFeed.normalizeHeader(h); }

function importRawCsvFeed(campaignId, feedType, csvText) {
  var check = DoorwayFeed.checkImport({ role: 'Owner' }, { campaignId: campaignId, feedType: feedType, csvText: csvText });
  if (!check.ok) return { status: check.status, error: check.error, detail: check.detail };
  var plan = DoorwayFeed.planImport(check, [], '', '');
  return {
    status: 200,
    importedCount: plan.importedCount,
    campaign: plan.campaign,
    townBreakdown: plan.townBreakdown,
    sample: plan.sample
  };
}

function ensureFeedTab_(spreadsheetId) {
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sh = ss.getSheetByName(DoorwayFeed.FEED_TAB);
  if (!sh) {
    sh = ss.insertSheet(DoorwayFeed.FEED_TAB);
    sh.appendRow(DoorwayFeed.FEED_COLUMNS.slice());
  }
  var values = sh.getDataRange().getValues();
  var headers = (values[0] || []).map(function (x) { return String(x).trim(); });
  DoorwayFeed.FEED_COLUMNS.forEach(function (col) {
    if (headers.indexOf(col) < 0) {
      var next = headers.length + 1;
      sh.getRange(1, next).setValue(col);
      headers.push(col);
    }
  });
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

function handleImportRawFeed_(user, req, props) {
  var check = DoorwayFeed.checkImport(user, req);
  if (!check.ok) return { status: check.status, error: check.error, detail: check.detail };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { status: 503, error: 'busy_try_again' };
  try {
    var payroll = props.getProperty('PAYROLL_SHEET_ID');
    if (!payroll) throw new Error('Missing payroll sheet id');
    var tab = ensureFeedTab_(payroll);
    var now = isoNow_();
    var batchId = 'IMP-' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmmss');
    var plan = DoorwayFeed.planImport(check, tab.rows, now, batchId);
    plan.append.forEach(function (row) {
      tab.sheet.appendRow(DoorwayFeed.FEED_COLUMNS.map(function (k) { return safeCell_(row[k]); }));
    });
    plan.updates.forEach(function (u) {
      if (u._row) setCells_({ sheet: tab.sheet, headers: tab.headers }, u._row, u.fields);
    });
    SpreadsheetApp.flush();
    if (plan.headerMismatches.length || plan.droppedHeaders.length) {
      logLearningSafe_(props, DoorwayCore.buildLearningLogRow({
        timestamp: now,
        sourceModule: 'FEED_IMPORT',
        entityId: batchId,
        beforeValue: JSON.stringify(plan.droppedHeaders),
        afterValue: JSON.stringify(plan.headerMismatches),
        patternTag: 'HEADER_MISMATCH',
        appliedToRules: false
      }));
    }
    bustBootCache_();
    return {
      status: 200,
      importedCount: plan.importedCount,
      appended: plan.appended,
      updated: plan.updated,
      campaign: plan.campaign,
      townBreakdown: plan.townBreakdown,
      sample: plan.sample,
      batchId: batchId
    };
  } finally {
    lock.releaseLock();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DoorwayFeed;
}
