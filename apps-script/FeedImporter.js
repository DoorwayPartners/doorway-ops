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
    rep_name: ['rep', 'rep name', 'rep_name', 'sr assigned to', 'agent', 'sales rep', 'assigned to', 'assigned to (email)', 'assigned_to'],
    address: ['address', 'service address', 'service_address', 'street', 'portal_address', 'portal address'],
    city: ['city', 'town', 'market'],
    status: ['status', 'c2c status', 'c2c_status', 'sr status', 'disposition'],
    campaign: ['campaign', 'carrier', 'provider'],
    date_updated: ['date updated', 'date_updated', 'sr status date (date updated, et)', 'date updated, et', 'pin date'],
    portal_address: ['portal_address', 'portal address'],
    fiber_serving_location: ['fiber_serving_location', 'fiber serving location', 'fsl'],
    data_broadband_fttp: ['data_broadband_fttp', 'data broadband fttp', 'broadband fttp'],
    wire_center: ['wire_center', 'wire center', 'wirecentre'],
    turf_class: ['turf type', 'turf_type', 'turf class', 'turf_class', 'rework flag']
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
  var FEED_TYPES = ['RAW_UPLOAD', 'CARRIER_EXPORT', 'SALESRABBIT', 'SALESRABBIT_TURF', 'TURF', 'C2C_DAILY_SALES', 'CARRIER_LEAD', 'AUTO'];
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
  var UNWORKED_STATUS = ['', 'not attempted', 'new', 'unworked', 'no knock', 'not knocked', 'open'];
  var SOLD_STATUS = ['sold', 'fiber slap', 'fiber slap!', 'closed', 'installed', 'sale', 'written', 'order submitted', 'completed'];

  function headerSet(headers) {
    var s = {};
    (headers || []).forEach(function (h) { s[normalizeHeader(h)] = true; });
    return s;
  }

  function detectFeedType(rawHeaders) {
    var set = headerSet(rawHeaders);
    var joined = (rawHeaders || []).map(function (h) { return String(h || '').toLowerCase(); }).join(' | ');
    if (set.portal_address || set.fiber_serving_location || set.data_broadband_fttp ||
        /fiber_serving|broadband_fttp|portal_address/.test(joined)) {
      return 'CARRIER_LEAD';
    }
    if ((set.date_updated || /date updated/.test(joined)) && set.status && (set.address || set.portal_address) &&
        (set.city || set.rep_name)) {
      return 'SALESRABBIT_TURF';
    }
    if (set.order_id && (set.status || set.rep_name) && (set.sale_date || set.rep_name || /c2c/.test(joined))) {
      return 'C2C_DAILY_SALES';
    }
    return 'RAW_UPLOAD';
  }

  function isUnworked(status) {
    return UNWORKED_STATUS.indexOf(String(status || '').trim().toLowerCase()) >= 0;
  }
  function isSold(status) {
    var s = String(status || '').trim().toLowerCase();
    return SOLD_STATUS.indexOf(s) >= 0 || s.indexOf('fiber slap') === 0;
  }
  function classifyTurf(status, turfClassRaw) {
    var flag = String(turfClassRaw || '').trim().toLowerCase();
    if (/rework/.test(flag)) return 'REWORK_TURF';
    if (/new/.test(flag)) return 'NEW_TURF';
    return isUnworked(status) ? 'NEW_TURF' : 'REWORK_TURF';
  }

  function streetKey(addr) {
    if (typeof DoorwayEntity !== 'undefined' && DoorwayEntity.normalizeStreet) {
      return DoorwayEntity.normalizeStreet(addr);
    }
    return String(addr || '').toLowerCase().replace(/\bstreet\b/g, 'st').replace(/\broad\b/g, 'rd')
      .replace(/\bavenue\b/g, 'ave').replace(/\bdrive\b/g, 'dr').replace(/[^a-z0-9]/g, '');
  }
  function streetKeys(addr) {
    var full = String(addr || '');
    var keys = [streetKey(full), streetKey(full.split(',')[0])];
    var uniq = [];
    keys.forEach(function (k) { if (k && k.length >= 8 && uniq.indexOf(k) < 0) uniq.push(k); });
    return uniq;
  }
  function addStreetKeys(map, addr) {
    streetKeys(addr).forEach(function (k) { map[k] = true; });
  }
  function hasStreetMatch(map, addr) {
    return streetKeys(addr).some(function (k) { return !!map[k]; });
  }

  function isActiveCustomer(order) {
    if (!order) return false;
    var s = String(order.C2C_Status || order.Install_Status || order.Status || '').toLowerCase();
    if (s.indexOf('cancel') !== -1 || s.indexOf('disconnect') !== -1) return false;
    if (order.Cancel_Date) return false;
    return s === 'installed' || s.indexOf('active') !== -1 || s.indexOf('completed') !== -1 ||
      String(order.DATA_BROADBAND_FTTP || order.data_broadband_fttp || '').toUpperCase() === 'Y';
  }

  function analyzeFeed(check, records, existingRows, opts) {
    opts = opts || {};
    var detected = detectFeedType(check.rows[0] || []);
    var effectiveType = check.feedType;
    if (!effectiveType || effectiveType === 'RAW_UPLOAD' || effectiveType === 'AUTO') effectiveType = detected;
    var turf = { NEW_TURF: 0, REWORK_TURF: 0 };
    var knocked = 0, sold = 0, clean = 0, knockedClean = 0, soldClean = 0;
    records.forEach(function (rec) {
      var klass = classifyTurf(rec.Status, rec._turfClass);
      rec.Turf_Class = klass;
      turf[klass] = (turf[klass] || 0) + 1;
      var unworked = isUnworked(rec.Status);
      var soldRow = isSold(rec.Status);
      if (!unworked) knocked++;
      if (soldRow) sold++;
      clean++;
      if (!unworked) knockedClean++;
      if (soldRow) soldClean++;
    });
    var contactRate = records.length ? knocked / records.length : 0;
    var conversionRate = clean ? soldClean / clean : 0;
    var knockedShare = clean ? knockedClean / clean : 0;
    var reRouteAlert = { flagged: false, knockedShare: Math.round(knockedShare * 1000) / 10, conversionRate: Math.round(conversionRate * 1000) / 10, expectedUptakePct: null };
    if (opts.expectedUptakePct == null || opts.expectedUptakePct === '') {
      reRouteAlert.reason = 'expected_uptake_not_set';
    } else {
      var expected = Number(opts.expectedUptakePct);
      reRouteAlert.expectedUptakePct = expected;
      if (isFinite(expected) && knockedShare >= 0.25 && conversionRate < (expected / 100) * 0.5) {
        reRouteAlert.flagged = true;
        reRouteAlert.reason = 're_route_review';
      } else {
        reRouteAlert.reason = 'within_pace';
      }
    }

    var existing = (existingRows || []).concat(records);
    var c2cBatchesSince = function (pinDate) {
      var pin = String(pinDate || '').slice(0, 10);
      var batches = {};
      existing.forEach(function (r) {
        var ft = String(r.Feed_Type || '').toUpperCase();
        if (ft !== 'C2C_DAILY_SALES' && ft !== 'CARRIER_EXPORT' && check.feedType !== 'C2C_DAILY_SALES' && !/c2c/.test(ft.toLowerCase())) {
          // still count rows we just classified as C2C
        }
        var isC2c = ft === 'C2C_DAILY_SALES' || ft === 'CARRIER_EXPORT' || (r._detectedType === 'C2C_DAILY_SALES');
        if (!isC2c && effectiveType === 'C2C_DAILY_SALES' && r.Import_Batch === (opts.batchId || r.Import_Batch) && r.Order_ID) isC2c = true;
        if (!isC2c) return;
        var d = String(r.Date_Updated || r.Imported_At || '').slice(0, 10);
        if (pin && d && d >= pin) batches[r.Import_Batch || d] = true;
      });
      return Object.keys(batches).length;
    };
    var c2cAddresses = {};
    existing.forEach(function (r) {
      var ft = String(r.Feed_Type || '').toUpperCase();
      if (ft === 'C2C_DAILY_SALES' || ft === 'CARRIER_EXPORT' || r._detectedType === 'C2C_DAILY_SALES' || r.Order_ID) {
        streetKeys(r.Address).forEach(function (k) { c2cAddresses[k] = r; });
      }
    });
    var missingOrders = [];
    if (effectiveType === 'SALESRABBIT_TURF' || effectiveType === 'SALESRABBIT' || effectiveType === 'TURF') {
      records.forEach(function (rec) {
        if (!isSold(rec.Status) && !/fiber slap/.test(String(rec.Status || '').toLowerCase())) return;
        var key = streetKey(rec.Address);
        var reports = c2cBatchesSince(rec.Date_Updated || rec.Imported_At);
        var matched = hasStreetMatch(c2cAddresses, rec.Address);
        if (!matched && reports >= 2) {
          missingOrders.push({
            Address: rec.Address,
            City: rec.City,
            Rep_Name: rec.Rep_Name,
            Status: rec.Status,
            pinDate: rec.Date_Updated || rec.Imported_At || '',
            reportsSincePin: reports
          });
        }
      });
    }
    // When a C2C daily file arrives, also re-check previously imported SR pins.
    if (effectiveType === 'C2C_DAILY_SALES') {
      (existingRows || []).forEach(function (rec) {
        var ft = String(rec.Feed_Type || '').toUpperCase();
        if (ft !== 'SALESRABBIT_TURF' && ft !== 'SALESRABBIT' && ft !== 'TURF') return;
        if (!isSold(rec.Status) && !/fiber slap/.test(String(rec.Status || '').toLowerCase())) return;
        var key = streetKey(rec.Address);
        var reports = c2cBatchesSince(rec.Date_Updated || rec.Imported_At);
        var matched = hasStreetMatch(c2cAddresses, rec.Address);
        if (!matched && reports >= 2) {
          missingOrders.push({
            Address: rec.Address,
            City: rec.City,
            Rep_Name: rec.Rep_Name,
            Status: rec.Status,
            pinDate: rec.Date_Updated || rec.Imported_At || '',
            reportsSincePin: reports
          });
        }
      });
    }

    var droppedActive = 0;
    var cleanByTown = {};
    var activeKeys = {};
    (opts.orders || []).forEach(function (o) {
      if (!isActiveCustomer(o)) return;
      addStreetKeys(activeKeys, o.Service_Address || o.Address || o.PORTAL_ADDRESS);
    });
    if (effectiveType === 'CARRIER_LEAD' || effectiveType === 'CARRIER_EXPORT') {
      records.forEach(function (rec) {
        var existingFlag = String(rec._broadband || rec._existingCustomer || '').toUpperCase();
        var active = existingFlag === 'Y' || existingFlag === 'TRUE' || hasStreetMatch(activeKeys, rec.Address);
        rec.Vet_Status = active ? 'ACTIVE_CUSTOMER' : 'CLEAN';
        if (active) droppedActive++;
        else {
          var town = rec.City || rec._wireCenter || 'Unknown';
          cleanByTown[town] = (cleanByTown[town] || 0) + 1;
        }
      });
    }

    return {
      detectedFeedType: detected,
      effectiveFeedType: effectiveType,
      turfBreakdown: turf,
      contactRate: Math.round(contactRate * 1000) / 10,
      conversionRate: Math.round(conversionRate * 1000) / 10,
      reRouteAlert: reRouteAlert,
      missingOrders: missingOrders,
      carrierVetting: {
        droppedActive: droppedActive,
        cleanByTown: cleanByTown
      }
    };
  }

  function planImport(check, existingRows, nowIso, batchId, opts) {
    opts = opts || {};
    opts.batchId = batchId || opts.batchId;
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
      // Side-channel analysis fields (not written to Raw_Feed_Import).
      for (var x = 0; x < headers.length; x++) {
        var hCanon = headers[x];
        var hv = clip(src[x], MAX_CELL);
        if (hCanon === 'date_updated' && hv) obj.Date_Updated = hv;
        if (hCanon === 'turf_class' && hv) obj._turfClass = hv;
        if (hCanon === 'wire_center' && hv) obj._wireCenter = hv;
        if (hCanon === 'data_broadband_fttp' && hv) obj._broadband = hv;
        if (hCanon === 'fiber_serving_location' && hv) obj._fsl = hv;
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

    var analysis = analyzeFeed(check, records, existingRows, opts);
    records.forEach(function (rec) { rec._detectedType = analysis.effectiveFeedType; });

    // Strip side-channel fields from rows that will be written.
    function writable(row) {
      var out = {};
      FEED_COLUMNS.forEach(function (k) { out[k] = row[k] == null ? '' : row[k]; });
      return out;
    }

    return {
      status: 200,
      campaign: check.campaignId,
      feedType: analysis.effectiveFeedType,
      requestedFeedType: check.feedType,
      detectedFeedType: analysis.detectedFeedType,
      batchId: batchId || '',
      importedCount: records.length,
      appended: append.length,
      updated: updates.length,
      townBreakdown: townCounts,
      headerMismatches: headerMismatches,
      droppedHeaders: droppedHeaders,
      append: append.map(writable),
      updates: updates,
      sample: records.slice(0, 5).map(writable),
      turfBreakdown: analysis.turfBreakdown,
      contactRate: analysis.contactRate,
      conversionRate: analysis.conversionRate,
      reRouteAlert: analysis.reRouteAlert,
      missingOrders: analysis.missingOrders,
      carrierVetting: analysis.carrierVetting
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
    planImport: planImport,
    detectFeedType: detectFeedType,
    classifyTurf: classifyTurf
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
    var existingOrders = [];
    try { existingOrders = readTab_(payroll, TABS.orders) || []; } catch (err) { existingOrders = []; }
    var plan = DoorwayFeed.planImport(check, tab.rows, now, batchId, { orders: existingOrders });
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
      feedType: plan.feedType,
      detectedFeedType: plan.detectedFeedType,
      townBreakdown: plan.townBreakdown,
      sample: plan.sample,
      batchId: batchId,
      turfBreakdown: plan.turfBreakdown,
      contactRate: plan.contactRate,
      conversionRate: plan.conversionRate,
      reRouteAlert: plan.reRouteAlert,
      missingOrders: plan.missingOrders,
      carrierVetting: plan.carrierVetting
    };
  } finally {
    lock.releaseLock();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DoorwayFeed;
}
