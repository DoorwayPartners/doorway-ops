/**
 * Doorway Ops V4.0 — Multi-campaign commission evaluator (apps-script/PayrollEngine.js).
 *
 * Pure evaluation only: payout is calculated when the order is installed AND
 * Carrier_Payout_Cleared is true, using Campaign_Rules values exclusively.
 * Blank rate fields yield note "rates not set" and null amounts — never a
 * hardcoded default matrix. This module never writes Payroll_Ledger, never
 * starts a pay run, and never sends mail. EVALUATE_PAYROLL is Owner-only
 * and must not appear in non-Owner payloads.
 */
var DoorwayPayroll = (function () {
  var COAST_RE = /coast/;

  function norm(s) { return String(s == null ? '' : s).trim(); }

  function campaignKey(order) {
    var raw = norm(order && (order.Campaign_ID || order.Campaign || order.campaign));
    var key = raw.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!key) key = 'FIDIUM';
    if (COAST_RE.test(key.toLowerCase()) || key === 'C2C' || key === 'COAST_2_COAST' || key === 'COAST_TO_COAST') {
      return 'FIDIUM';
    }
    return key;
  }

  function truthy(v) {
    if (v === true) return true;
    var s = norm(v).toLowerCase();
    return s === 'true' || s === 'y' || s === 'yes' || s === '1';
  }

  function isBlankNum(v) {
    return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  }

  function parseRuleNumber(v) {
    if (isBlankNum(v)) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = String(v).trim().replace(/[$,%\s]/g, '');
    if (/^\(.*\)$/.test(s)) s = '-' + s.slice(1, -1);
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  function toDate(v) {
    if (!v) return null;
    if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? null : v;
    var m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  function dayDiff(a, b) {
    var ua = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
    var ub = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
    return Math.round((ub - ua) / 86400000);
  }

  function ruleFromRow(row) {
    if (!row) return null;
    var id = norm(row.Campaign_ID || row.campaignId || row.Campaign);
    if (!id) return null;
    var key = campaignKey({ Campaign: id });
    var claw = parseRuleNumber(row.Clawback_Days);
    return {
      campaignId: key,
      activeFlag: norm(row.Active_Flag || row.Active).toUpperCase(),
      grossRev: parseRuleNumber(row.Gross_Agency_Rev_Default),
      repBase: parseRuleNumber(row.Rep_Base_Comm),
      certifiedBonus: parseRuleNumber(row.Certified_Bonus_Comm),
      podLeadOverride: parseRuleNumber(row.Pod_Lead_Override),
      clawbackDays: claw == null ? 90 : claw,
      holdBackPct: parseRuleNumber(row.Hold_Back_Pct)
    };
  }

  function rulesMapFromRows(rows) {
    var map = {};
    (rows || []).forEach(function (r) {
      var rule = ruleFromRow(r);
      if (rule) map[rule.campaignId] = rule;
    });
    return map;
  }

  function ratesReady(rule) {
    return !!(rule && rule.repBase != null && rule.grossRev != null);
  }

  function statusText(order) {
    return norm(order && (order.Install_Status || order.C2C_Status || order.Status)).toLowerCase();
  }

  function isCancelled(order) {
    if (!order) return false;
    if (order.Cancel_Date) return true;
    var s = statusText(order);
    return s.indexOf('cancel') !== -1 || s.indexOf('disconnect') !== -1;
  }

  function isInstalled(order) {
    if (!order || isCancelled(order)) return false;
    var s = statusText(order);
    return s === 'installed' || s.indexOf('completed') !== -1;
  }

  function isCleared(order) {
    if (!order) return false;
    return truthy(order.Carrier_Payout_Cleared) || truthy(order.Carrier_Cleared);
  }

  function isCertified(order) {
    if (!order) return false;
    if (truthy(order.Certified) || truthy(order.Is_Certified)) return true;
    var tier = norm(order.Certification_Tier || order.Tier).toLowerCase();
    return tier.indexOf('certified') !== -1 || tier.indexOf('pod lead') !== -1 || tier.indexOf('leader') !== -1;
  }

  function blankResult(note, extra) {
    var out = {
      eligible: false,
      ratesSet: false,
      clawbackFlag: false,
      payout: null,
      certifiedBonus: null,
      overrideComm: null,
      holdBackAmt: null,
      clawbackAmount: null,
      netSpread: null,
      note: note || 'rates not set'
    };
    if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  /**
   * Evaluate a single order against Campaign_Rules. Never invents rates.
   * `now` is optional (Date or ISO) for deterministic tests.
   */
  function evaluateOrderPayout(order, rulesMap, now) {
    order = order || {};
    var campKey = campaignKey(order);
    var rule = rulesMap && (rulesMap[campKey] || rulesMap[String(campKey).toUpperCase()]);
    var today = toDate(now) || new Date();
    var installDate = toDate(order.Install_Date);
    var daysSince = installDate ? dayDiff(installDate, today) : null;

    var base = {
      Order_ID: norm(order.Order_ID),
      Campaign_ID: campKey,
      Rep_Name: norm(order.Rep_Name)
    };

    if (!rule || !ratesReady(rule)) {
      return Object.assign(base, blankResult('rates not set', {
        reason: rule ? 'rates_not_set' : 'no_campaign_rule',
        clawbackDays: rule ? rule.clawbackDays : null,
        daysSinceInstall: daysSince
      }));
    }

    var overrideComm = parseRuleNumber(order.Override_Comm);
    if (overrideComm == null) overrideComm = 0;
    var certifiedBonus = 0;
    if (isCertified(order) && rule.certifiedBonus != null) certifiedBonus = rule.certifiedBonus;
    var holdPct = rule.holdBackPct == null ? 0 : rule.holdBackPct;
    var baseComm = rule.repBase;
    var gross = rule.grossRev;

    if (isCancelled(order) && installDate && daysSince != null && daysSince >= 0 && daysSince <= rule.clawbackDays) {
      return Object.assign(base, {
        eligible: false,
        ratesSet: true,
        clawbackFlag: true,
        payout: 0,
        certifiedBonus: 0,
        overrideComm: 0,
        holdBackAmt: 0,
        clawbackAmount: baseComm,
        netSpread: -baseComm,
        clawbackDays: rule.clawbackDays,
        daysSinceInstall: daysSince,
        reason: 'clawback',
        note: rule.clawbackDays + '-day clawback triggered (' + daysSince + 'd post-install)'
      });
    }

    if (!isInstalled(order) || !isCleared(order)) {
      return Object.assign(base, {
        eligible: false,
        ratesSet: true,
        clawbackFlag: false,
        payout: 0,
        certifiedBonus: 0,
        overrideComm: 0,
        holdBackAmt: 0,
        clawbackAmount: 0,
        netSpread: 0,
        clawbackDays: rule.clawbackDays,
        daysSinceInstall: daysSince,
        reason: isInstalled(order) ? 'awaiting_clearance' : 'pending_install',
        note: isInstalled(order) ? 'Awaiting carrier clearance' : 'Pending install'
      });
    }

    var grossPayable = baseComm + certifiedBonus + overrideComm;
    var holdBackAmt = Math.round(grossPayable * (holdPct / 100) * 100) / 100;
    var payout = Math.round((grossPayable - holdBackAmt) * 100) / 100;
    var netSpread = Math.round((gross - grossPayable) * 100) / 100;

    return Object.assign(base, {
      eligible: true,
      ratesSet: true,
      clawbackFlag: false,
      payout: payout,
      certifiedBonus: certifiedBonus,
      overrideComm: overrideComm,
      holdBackAmt: holdBackAmt,
      clawbackAmount: 0,
      netSpread: netSpread,
      clawbackDays: rule.clawbackDays,
      daysSinceInstall: daysSince,
      reason: 'cleared',
      note: 'Cleared & payable'
    });
  }

  function evaluateOrders(orders, rulesRows, now) {
    var map = Array.isArray(rulesRows) && rulesRows.length && !rulesRows[0].repBase
      ? rulesMapFromRows(rulesRows)
      : (rulesRows || {});
    // If caller already passed a map (keys have repBase), use it.
    if (rulesRows && !Array.isArray(rulesRows)) map = rulesRows;
    var results = (orders || []).map(function (o) { return evaluateOrderPayout(o, map, now); });
    var summary = { eligible: 0, clawback: 0, ratesNotSet: 0, pendingInstall: 0, awaitingClearance: 0, other: 0 };
    results.forEach(function (r) {
      if (r.reason === 'cleared') summary.eligible++;
      else if (r.reason === 'clawback') summary.clawback++;
      else if (r.reason === 'rates_not_set' || r.reason === 'no_campaign_rule') summary.ratesNotSet++;
      else if (r.reason === 'pending_install') summary.pendingInstall++;
      else if (r.reason === 'awaiting_clearance') summary.awaitingClearance++;
      else summary.other++;
    });
    return { results: results, summary: summary };
  }

  function checkEvaluate(user) {
    if (!user || user.role !== 'Owner') return { ok: false, status: 403, error: 'owner_only' };
    return { ok: true };
  }

  // Slim the evaluation so customer addresses and campaign rate tables are never returned.
  function publicResult(r) {
    if (!r) return r;
    return {
      Order_ID: r.Order_ID,
      Campaign_ID: r.Campaign_ID,
      Rep_Name: r.Rep_Name,
      eligible: r.eligible,
      ratesSet: r.ratesSet,
      clawbackFlag: r.clawbackFlag,
      payout: r.payout,
      certifiedBonus: r.certifiedBonus,
      overrideComm: r.overrideComm,
      holdBackAmt: r.holdBackAmt,
      clawbackAmount: r.clawbackAmount,
      netSpread: r.netSpread,
      note: r.note,
      reason: r.reason,
      daysSinceInstall: r.daysSinceInstall
    };
  }

  return {
    campaignKey: campaignKey,
    ruleFromRow: ruleFromRow,
    rulesMapFromRows: rulesMapFromRows,
    ratesReady: ratesReady,
    evaluateOrderPayout: evaluateOrderPayout,
    evaluateOrders: evaluateOrders,
    checkEvaluate: checkEvaluate,
    publicResult: publicResult
  };
})();

function evaluateOrderPayout_(order, rulesMap, now) {
  return DoorwayPayroll.evaluateOrderPayout(order, rulesMap, now);
}

function handleEvaluatePayroll_(user, req, props) {
  var check = DoorwayPayroll.checkEvaluate(user);
  if (!check.ok) return { status: check.status, error: check.error };
  var payroll = props && props.getProperty('PAYROLL_SHEET_ID');
  if (!payroll) return { status: 500, error: 'server_error' };
  var orders = readTab_(payroll, TABS.orders);
  var rulesTab = SpreadsheetApp.openById(payroll).getSheetByName('Campaign_Rules');
  if (!rulesTab) return { status: 500, error: 'missing_campaign_rules' };
  var values = rulesTab.getDataRange().getValues();
  var headers = (values[0] || []).map(function (x) { return String(x).trim(); });
  var ruleRows = [];
  for (var r = 1; r < values.length; r++) {
    var o = {}, any = false;
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      o[headers[c]] = values[r][c];
      if (values[r][c] !== '' && values[r][c] != null) any = true;
    }
    if (any) ruleRows.push(o);
  }
  var ev = DoorwayPayroll.evaluateOrders(orders, ruleRows, new Date());
  return {
    status: 200,
    summary: ev.summary,
    results: ev.results.map(DoorwayPayroll.publicResult)
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DoorwayPayroll;
}
