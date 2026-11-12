/**
 * Doorway Ops Command Center — pure core logic (no Google APIs).
 *
 * Shared verbatim by:
 *   - the Apps Script backend (apps-script/Core.js, pushed by clasp)
 *   - the static site demo mode (docs/core.js, copied by scripts/build.mjs)
 *   - the Node unit tests (test/core.test.js)
 *
 * SECURITY MODEL: every payload is built from ALLOWLISTS of fields. Anything
 * not explicitly listed for a role is never copied into the response.
 * Rep and Manager payloads never contain agency margin fields
 * (Gross_Agency_Rev, Net_Agency_Spread), other reps' customer names or
 * addresses, or any row belonging to a rep outside their scope.
 */
var DoorwayCore = (function () {
  'use strict';

  var ROLES = ['Owner', 'Admin', 'Manager', 'Rep'];
  var MARGIN_FIELDS = ['Gross_Agency_Rev', 'Net_Agency_Spread'];
  var DEALS_PER_DAY = 2;
  var CLAWBACK_DAYS = 90;
  var CERTIFIED_INSTALLS = 5;

  // Fields a Rep or Manager may ever see on an order row (no margins).
  var ORDER_FIELDS_LIMITED = [
    'Order_ID', 'Sale_Date', 'Install_Date', 'Cancel_Date', 'Rep_Name',
    'Speed_Tier', 'C2C_Status', 'Pay_Period', 'Base_Comm', 'Override_Comm',
    'Clawback_Flag', 'Clawback_Deduction', 'Net_Order_Payout', 'Campaign',
    'Carrier_Payout_Cleared', 'Payout_Eligible', 'Exception_Reason (helper)'
  ];
  // Only added when the row belongs to the requesting user.
  var ORDER_FIELDS_OWN_PII = ['Customer_Name', 'Service_Address'];

  var COMPLIANCE_FIELDS = [
    'Rep_Name', 'Manager_Name', 'Certification_Tier', 'W9_On_File',
    'Contract_1099_Signed', 'NDA_Signed', 'C2C_Portal_Active',
    'Compliance_Green_Light', 'Verified_Installs', 'Tier_Eligible'
  ];
  var SCORECARD_FIELDS = [
    'Date', 'Rep', 'Grader', 'Approach_Tonality', 'Rebuttal_Composure',
    'RepCard_Send_Rate %', 'Pin_Note_Dusk', 'Roleplay_Pass', 'Notes'
  ];
  var PERMIT_FIELDS = [
    'Town', 'State', 'Permit_Required', 'Fee', 'Turnaround_Days',
    'Badge_Issue_Date', 'Badge_Expiry_Date', 'Allowed_Knock_Hours',
    'Civil_Dusk_Cutoff', 'Status', 'Source_URL', 'Days_To_Expiry', 'Expiring_14d'
  ];
  var DAY14_FIELDS = ['Order_ID', 'Rep_Name', 'Customer_Name', 'Service_Address',
    'Install_Date', 'Day14_Date', 'Campaign'];
  var PHANTOM_FIELDS_FULL = ['Market', 'Address', 'Unit', 'City', 'ZIP', 'SR status',
    'SR status date (Date Updated, ET)', 'Hours since (at export time)', 'Age flag',
    'C2C order at address', 'SR assigned to', 'SR rep note', 'Reports since pin',
    'Business hours since pin', 'Flag method'];
  var PHANTOM_FIELDS_LIMITED = ['Market', 'City', 'SR status',
    'SR status date (Date Updated, ET)', 'Age flag', 'SR assigned to',
    'Reports since pin', 'Flag method'];
  var EXPENSE_FIELDS = ['Date', 'Vendor', 'Category', 'Trip/Market', 'Amount',
    'Payment_Method', 'Notes'];
  var EXCEPTION_FIELDS = ['Order_ID', 'Rep_Name', 'Customer_Name', 'Service_Address',
    'Speed_Tier', 'C2C_Status', 'Pay_Period', 'Exception_Reason'];

  // ---------- small helpers ----------
  function norm(s) { return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase(); }
  function pick(row, fields) {
    var out = {};
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (row && Object.prototype.hasOwnProperty.call(row, f)) out[f] = row[f];
    }
    return out;
  }
  function truthy(v) {
    if (v === true) return true;
    var s = norm(v);
    return s === 'true' || s === 'y' || s === 'yes' || s === '1';
  }
  function money(v) {
    if (typeof v === 'number') return v;
    var s = String(v == null ? '' : v).replace(/[$,\s]/g, '');
    if (/^\(.*\)$/.test(s)) s = '-' + s.slice(1, -1);
    var n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }
  function toDate(v) {
    if (!v) return null;
    if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? null : v;
    var m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function ymd(d) {
    return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
  }
  function dayDiff(a, b) { // whole days from a to b
    var ua = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
    var ub = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
    return Math.round((ub - ua) / 86400000);
  }
  function cityOf(address) {
    // "6 BALDWIN DR, BROOKLINE NH" -> "BROOKLINE NH"
    var parts = String(address || '').split(',');
    return parts.length > 1 ? parts[parts.length - 1].trim() : '';
  }
  function townOf(address) { return cityOf(address).replace(/\s+[A-Z]{2}$/i, '').trim(); }

  function isCancelled(o) { return !!o.Cancel_Date || norm(o.C2C_Status).indexOf('cancel') === 0; }
  function isInstalled(o) { return norm(o.C2C_Status) === 'installed' && !isCancelled(o); }
  function isCleared(o) { return truthy(o.Carrier_Payout_Cleared) && isInstalled(o); }

  // Mon–Sat working days from the 1st of today's month through today.
  function workingDaysMTD(today) {
    var n = 0;
    for (var d = 1; d <= today.getUTCDate(); d++) {
      var dow = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), d)).getUTCDay();
      if (dow !== 0) n++;
    }
    return n;
  }
  function inMonth(dateVal, today) {
    var d = toDate(dateVal);
    return !!d && d.getUTCFullYear() === today.getUTCFullYear() && d.getUTCMonth() === today.getUTCMonth();
  }

  // ---------- ID token claim validation (signature checked by Google tokeninfo) ----------
  var VALID_ISS = ['accounts.google.com', 'https://accounts.google.com'];
  function validateClaims(claims, clientId, nowSec) {
    if (!claims || typeof claims !== 'object') return { ok: false, reason: 'no_claims' };
    if (!clientId) return { ok: false, reason: 'server_not_configured' };
    if (claims.aud !== clientId) return { ok: false, reason: 'bad_audience' };
    if (VALID_ISS.indexOf(claims.iss) < 0) return { ok: false, reason: 'bad_issuer' };
    var exp = parseInt(claims.exp, 10);
    if (!exp || exp <= nowSec) return { ok: false, reason: 'expired' };
    if (!(claims.email_verified === true || claims.email_verified === 'true')) return { ok: false, reason: 'email_not_verified' };
    if (!claims.email) return { ok: false, reason: 'no_email' };
    return { ok: true, email: String(claims.email).toLowerCase() };
  }

  // ---------- user lookup ----------
  function findUser(users, email) {
    var e = norm(email);
    for (var i = 0; i < (users || []).length; i++) {
      var u = users[i];
      if (norm(u.Email) === e && e) {
        if (!truthy(u.Active)) return null;
        var role = String(u.Role || '').trim();
        role = role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
        if (ROLES.indexOf(role) < 0) return null;
        return {
          email: e,
          name: String(u.Name || '').trim(),
          role: role,
          managerName: String(u.Manager_Name || '').trim(),
          assignedTowns: String(u.Assigned_Towns || '').split(/[;,]/).map(function (t) { return t.trim(); }).filter(Boolean)
        };
      }
    }
    return null;
  }

  // Names in a manager's pod: the manager plus anyone whose Manager_Name is them
  // in Portal_Users or Compliance_Tracker.
  function podNames(user, raw) {
    var me = norm(user.name);
    var set = {}; set[me] = true;
    (raw.users || []).forEach(function (u) { if (truthy(u.Active) && norm(u.Manager_Name) === me && u.Name) set[norm(u.Name)] = true; });
    (raw.compliance || []).forEach(function (c) { if (norm(c.Manager_Name) === me && c.Rep_Name) set[norm(c.Rep_Name)] = true; });
    return set;
  }

  // ---------- derived blocks ----------
  function limitedOrder(o, viewerName) {
    var out = pick(o, ORDER_FIELDS_LIMITED);
    out.City = cityOf(o.Service_Address);
    if (norm(o.Rep_Name) === norm(viewerName)) {
      var pii = pick(o, ORDER_FIELDS_OWN_PII);
      for (var k in pii) out[k] = pii[k];
    }
    return out;
  }

  function wallet(orders, today) {
    var w = { pending: { count: 0, amount: 0 }, installed: { count: 0, amount: 0 },
      cleared: { count: 0, amount: 0 }, cancelled: { count: 0 }, clawbackWatch: [] };
    orders.forEach(function (o) {
      var pay = money(o.Net_Order_Payout) || money(o.Base_Comm);
      if (isCancelled(o)) { w.cancelled.count++; return; }
      if (isCleared(o)) { w.cleared.count++; w.cleared.amount += pay; }
      else if (isInstalled(o)) { w.installed.count++; w.installed.amount += pay; }
      else { w.pending.count++; w.pending.amount += pay; }
      var inst = toDate(o.Install_Date);
      if (isInstalled(o) && inst) {
        var left = CLAWBACK_DAYS - dayDiff(inst, today);
        if (left > 0) w.clawbackWatch.push({ Order_ID: o.Order_ID, Install_Date: o.Install_Date, daysLeft: left });
      }
    });
    w.clawbackWatch.sort(function (a, b) { return a.daysLeft - b.daysLeft; });
    return w;
  }

  function leaderboard(orders, names, today) {
    var target = DEALS_PER_DAY * workingDaysMTD(today);
    var by = {};
    names.forEach(function (n) { by[norm(n)] = { rep: n, deals: 0, installs: 0, pending: 0 }; });
    orders.forEach(function (o) {
      var k = norm(o.Rep_Name);
      if (!by[k] || isCancelled(o) || !inMonth(o.Sale_Date, today)) return;
      by[k].deals++;
      if (isInstalled(o)) by[k].installs++; else by[k].pending++;
    });
    return Object.keys(by).map(function (k) {
      var r = by[k]; r.target = target; r.pacePct = target ? Math.round(100 * r.deals / target) : 0; return r;
    }).sort(function (a, b) { return b.deals - a.deals || a.rep.localeCompare(b.rep); });
  }

  function complianceBadge(c) {
    if (!c) return { found: false, greenLight: false, missing: ['W-9', '1099 contract', 'NDA', 'C2C portal'] };
    var missing = [];
    if (!truthy(c.W9_On_File)) missing.push('W-9');
    if (!truthy(c.Contract_1099_Signed)) missing.push('1099 contract');
    if (!truthy(c.NDA_Signed)) missing.push('NDA');
    if (!truthy(c.C2C_Portal_Active)) missing.push('C2C portal');
    return { found: true, greenLight: truthy(c.Compliance_Green_Light) && missing.length === 0, missing: missing,
      tier: c.Certification_Tier || 'Rookie', verifiedInstalls: money(c.Verified_Installs), tierEligible: c.Tier_Eligible || '' };
  }

  function tierProgress(badge, myBoard) {
    var installs = badge.verifiedInstalls || 0;
    return { tier: badge.tier || 'Rookie', verifiedInstalls: installs, certifiedAt: CERTIFIED_INSTALLS,
      toCertified: Math.max(0, CERTIFIED_INSTALLS - installs),
      podLeadRule: 'Steady 2+ deals/day plus recruits', pacePct: myBoard ? myBoard.pacePct : 0 };
  }

  function sumMoney(rows, field) { return rows.reduce(function (s, r) { return s + money(r[field]); }, 0); }

  // ---------- payload builders ----------
  function buildRepPayload(user, raw, today) {
    var me = norm(user.name);
    var mine = (raw.orders || []).filter(function (o) { return norm(o.Rep_Name) === me; });
    var comp = (raw.compliance || []).filter(function (c) { return norm(c.Rep_Name) === me; })[0];
    var badge = complianceBadge(comp);
    var towns = {};
    (user.assignedTowns.length ? user.assignedTowns : mine.map(function (o) { return townOf(o.Service_Address); }))
      .forEach(function (t) { if (t) towns[norm(t)] = true; });
    var board = leaderboard(mine, [user.name], today)[0];
    return {
      role: 'Rep',
      me: { name: user.name, email: user.email, role: 'Rep' },
      wallet: wallet(mine, today),
      orders: mine.map(function (o) { return limitedOrder(o, user.name); }),
      compliance: badge,
      tierProgress: tierProgress(badge, board),
      pace: board,
      permits: (raw.permits || []).filter(function (p) { return towns[norm(p.Town)]; }).map(function (p) { return pick(p, PERMIT_FIELDS); }),
      day14: (raw.day14 || []).filter(function (d) { return norm(d.Rep_Name) === me; }).map(function (d) { return pick(d, DAY14_FIELDS); }),
      scorecard: (raw.scorecard || []).filter(function (s) { return norm(s.Rep) === me; }).map(function (s) { return pick(s, SCORECARD_FIELDS); }),
      missingOrders: (raw.phantom || []).filter(function (p) { return norm(p['SR assigned to']) === me; }).map(function (p) { return pick(p, PHANTOM_FIELDS_FULL); })
    };
  }

  function buildManagerPayload(user, raw, today) {
    var me = norm(user.name);
    var pod = podNames(user, raw);
    var inPod = function (n) { return !!pod[norm(n)]; };
    var podOrders = (raw.orders || []).filter(function (o) { return inPod(o.Rep_Name); });
    var mine = podOrders.filter(function (o) { return norm(o.Rep_Name) === me; });
    var displayNames = {};
    (raw.users || []).concat([]).forEach(function (u) { if (inPod(u.Name)) displayNames[norm(u.Name)] = String(u.Name).trim(); });
    (raw.compliance || []).forEach(function (c) { if (inPod(c.Rep_Name)) displayNames[norm(c.Rep_Name)] = String(c.Rep_Name).trim(); });
    displayNames[me] = user.name;
    var names = Object.keys(displayNames).map(function (k) { return displayNames[k]; });
    var board = leaderboard(podOrders, names, today);
    var compByName = {};
    (raw.compliance || []).forEach(function (c) { if (inPod(c.Rep_Name)) compByName[norm(c.Rep_Name)] = complianceBadge(c); });
    board.forEach(function (r) {
      var b = compByName[norm(r.rep)];
      r.greenLight = !!(b && b.greenLight);
      r.tier = b ? b.tier : 'Rookie';
    });
    return {
      role: 'Manager',
      me: { name: user.name, email: user.email, role: 'Manager' },
      pod: names.sort(),
      podScoreboard: board,
      wallet: wallet(mine, today),
      orders: podOrders.map(function (o) { return limitedOrder(o, user.name); }),
      day14: (raw.day14 || []).filter(function (d) { return inPod(d.Rep_Name); }).map(function (d) {
        var own = norm(d.Rep_Name) === me;
        var r = pick(d, own ? DAY14_FIELDS : ['Order_ID', 'Rep_Name', 'Install_Date', 'Day14_Date', 'Campaign']);
        r.City = cityOf(d.Service_Address);
        return r;
      }),
      missingOrders: (raw.phantom || []).filter(function (p) { return inPod(p['SR assigned to']); }).map(function (p) {
        return pick(p, norm(p['SR assigned to']) === me ? PHANTOM_FIELDS_FULL : PHANTOM_FIELDS_LIMITED);
      }),
      permits: (raw.permits || []).map(function (p) { return pick(p, PERMIT_FIELDS); }),
      scorecard: (raw.scorecard || []).filter(function (s) { return inPod(s.Rep); }).map(function (s) { return pick(s, SCORECARD_FIELDS); })
    };
  }

  function buildExecPayload(user, raw, today, role) {
    var orders = raw.orders || [];
    var live = orders.filter(function (o) { return !isCancelled(o); });
    var installed = live.filter(isInstalled);
    var cleared = live.filter(isCleared);
    var mtdExpenses = (raw.expenses || []).filter(function (e) { return inMonth(e.Date, today); });
    var repNames = {};
    (raw.compliance || []).forEach(function (c) { if (c.Rep_Name) repNames[norm(c.Rep_Name)] = String(c.Rep_Name).trim(); });
    orders.forEach(function (o) { if (o.Rep_Name && !repNames[norm(o.Rep_Name)]) repNames[norm(o.Rep_Name)] = String(o.Rep_Name).trim(); });
    var spreadCleared = sumMoney(cleared, 'Net_Agency_Spread');
    var spreadInstalled = sumMoney(installed, 'Net_Agency_Spread');
    var expenseTotal = sumMoney(mtdExpenses, 'Amount');
    return {
      role: role,
      me: { name: user.name, email: user.email, role: role },
      capabilities: { canReleasePayouts: role === 'Owner', readOnly: true },
      pipeline: { written: live.length, installed: installed.length, cleared: cleared.length,
        cancelled: orders.length - live.length },
      financials: {
        grossAgencyRevInstalled: sumMoney(installed, 'Gross_Agency_Rev'),
        netSpreadInstalled: spreadInstalled,
        netSpreadCleared: spreadCleared,
        expensesMTD: expenseTotal,
        netAfterExpensesCleared: spreadCleared - expenseTotal,
        netAfterExpensesInstalled: spreadInstalled - expenseTotal
      },
      leaderboard: leaderboard(orders, Object.keys(repNames).map(function (k) { return repNames[k]; }), today),
      orders: orders.map(function (o) { var r = pick(o, ORDER_FIELDS_LIMITED.concat(ORDER_FIELDS_OWN_PII, MARGIN_FIELDS)); r.City = cityOf(o.Service_Address); return r; }),
      exceptions: (raw.exceptions || []).map(function (e) { return pick(e, EXCEPTION_FIELDS); }),
      holds: (raw.compliance || []).map(complianceBadgeWithName).filter(function (b) { return !b.greenLight; }),
      compliance: (raw.compliance || []).map(function (c) { return pick(c, COMPLIANCE_FIELDS); }),
      day14: (raw.day14 || []).map(function (d) { return pick(d, DAY14_FIELDS); }),
      missingOrders: (raw.phantom || []).map(function (p) { return pick(p, PHANTOM_FIELDS_FULL); }),
      permits: (raw.permits || []).map(function (p) { return pick(p, PERMIT_FIELDS); }),
      scorecard: (raw.scorecard || []).map(function (s) { return pick(s, SCORECARD_FIELDS); }),
      expenses: mtdExpenses.map(function (e) { return pick(e, EXPENSE_FIELDS); })
    };
  }
  function complianceBadgeWithName(c) { var b = complianceBadge(c); b.rep = c.Rep_Name; return b; }

  /**
   * Entry point. Returns {status, body}. status 403 for unknown/inactive users.
   */
  function buildPayload(email, raw, todayInput) {
    var today = toDate(todayInput) || new Date();
    var user = findUser(raw.users, email);
    if (!user) return { status: 403, body: { error: 'forbidden', message: 'This Google account is not on the Doorway Ops access list.' } };
    var body;
    if (user.role === 'Rep') body = buildRepPayload(user, raw, today);
    else if (user.role === 'Manager') body = buildManagerPayload(user, raw, today);
    else body = buildExecPayload(user, raw, today, user.role);
    body.asOf = ymd(today);
    body.rules = { dealsPerDay: DEALS_PER_DAY, clawbackDays: CLAWBACK_DAYS, certifiedInstalls: CERTIFIED_INSTALLS };
    return { status: 200, body: body };
  }

  // ---------- V2: Owner Priority Queue (Ops_Approval_Queue tab, columns A–M) ----------
  var QUEUE_COLUMNS = ['Queue_ID', 'Created_At', 'Priority', 'Category', 'Source_Thread_ID',
    'Rep_Or_Sender', 'Context_Summary', 'Draft_To', 'Draft_Cc', 'Draft_Subject', 'Draft_Body',
    'Status', 'Resolved_At'];
  var PRIORITY_RANK = { 'P1-URGENT': 1, 'P2-OPS': 2, 'P3-ADMIN': 3 };
  var QUEUE_STATUSES = ['PENDING', 'APPROVED_SENT', 'SNOOZED', 'DISMISSED'];
  var SIGNOFF = 'Cristian Coy, Coast 2 Coast / Doorway Partners';
  // Recipient domains that count as a carrier / carrier partner. Any match needs a
  // second explicit confirmation before APPROVE_AND_SEND (UI and server both check).
  var CARRIER_DOMAIN_RE = /(^|[.@-])(fidium|consolidated|consolidatedcommunications|metronet|brightspeed|frontier|frontiercomm|ftr|att|t-mobile|tmobile|gonetspeed|verizon|spectrum|charter|comcast|xfinity|breezeline|tds|tdstelecom|cox|lumen|centurylink|windstream|kinetic|ziply|optimum|altice|mountainhigh|mtnhigh)\.[a-z.]+$/i;
  var EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[A-Za-z]{2,}$/;

  function isOwner(user) { return !!user && user.role === 'Owner'; }
  function splitEmails(v) {
    return String(v == null ? '' : v).split(/[,;\s]+/).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function carrierRecipients(to, cc) {
    return splitEmails(to).concat(splitEmails(cc)).filter(function (e) {
      var at = e.lastIndexOf('@');
      return at > 0 && CARRIER_DOMAIN_RE.test(e.slice(at).toLowerCase());
    });
  }
  function isCarrierRecipient(to, cc) { return carrierRecipients(to, cc).length > 0; }
  function ensureSignoff(body) {
    var b = String(body == null ? '' : body).replace(/\s+$/, '');
    if (norm(b).indexOf(norm('Cristian Coy')) >= 0 && norm(b).indexOf(norm('Doorway Partners')) >= 0) return b;
    return b + '\n\n' + SIGNOFF;
  }
  function priorityRank(p) { return PRIORITY_RANK[String(p || '').trim().toUpperCase()] || 9; }
  function queueStatus(row) { return String((row && row.Status) || '').trim().toUpperCase(); }

  /** Owner-only view: PENDING rows sorted P1 -> P2 -> P3, then oldest first. */
  function buildQueue(rows) {
    var pending = (rows || []).filter(function (r) { return r && r.Queue_ID && queueStatus(r) === 'PENDING'; });
    pending.sort(function (a, b) {
      return priorityRank(a.Priority) - priorityRank(b.Priority) ||
        String(a.Created_At || '').localeCompare(String(b.Created_At || '')) ||
        String(a.Queue_ID).localeCompare(String(b.Queue_ID));
    });
    var items = pending.map(function (r) {
      var o = pick(r, QUEUE_COLUMNS);
      o.Priority = String(r.Priority || '').trim().toUpperCase();
      o.carrierConfirmRequired = isCarrierRecipient(r.Draft_To, r.Draft_Cc);
      return o;
    });
    var counts = { p1: 0, p2: 0, p3: 0, total: items.length };
    items.forEach(function (i) { var k = priorityRank(i.Priority); if (k === 1) counts.p1++; else if (k === 2) counts.p2++; else if (k === 3) counts.p3++; });
    return { items: items, counts: counts };
  }

  /**
   * Validate a queue write BEFORE anything is changed or sent. Pure; the backend
   * calls it inside a script lock with the freshly re-read row.
   * action: 'APPROVE_AND_SEND' | 'UPDATE_QUEUE_STATUS'
   * Returns {ok:true, send:{to,cc,subject,body}, carrier:[...]} or {ok:false, status, error}.
   */
  function checkQueueAction(user, action, row, params) {
    params = params || {};
    if (!isOwner(user)) return { ok: false, status: 403, error: 'owner_only' };
    if (!row) return { ok: false, status: 404, error: 'queue_item_not_found' };
    var st = queueStatus(row);
    if (st === 'APPROVED_SENT') return { ok: false, status: 409, error: 'already_sent' };
    if (action === 'UPDATE_QUEUE_STATUS') {
      var ns = String(params.newStatus || '').trim().toUpperCase();
      if (ns !== 'SNOOZED' && ns !== 'DISMISSED') return { ok: false, status: 400, error: 'bad_status' };
      if (st !== 'PENDING' && st !== 'SNOOZED') return { ok: false, status: 409, error: 'not_pending' };
      return { ok: true, newStatus: ns };
    }
    if (action !== 'APPROVE_AND_SEND') return { ok: false, status: 400, error: 'bad_action' };
    if (st !== 'PENDING') return { ok: false, status: 409, error: 'not_pending' };
    if (params.confirm !== true) return { ok: false, status: 400, error: 'explicit_confirm_required' };
    var pickField = function (edited, staged) { return edited != null && String(edited).trim() !== '' ? String(edited).trim() : String(staged == null ? '' : staged).trim(); };
    var to = splitEmails(pickField(params.editedTo, row.Draft_To));
    var cc = splitEmails(params.editedCc != null ? params.editedCc : row.Draft_Cc);
    var subject = pickField(params.editedSubject, row.Draft_Subject);
    var body = pickField(params.editedBody, row.Draft_Body);
    if (!to.length) return { ok: false, status: 400, error: 'no_recipient' };
    var bad = to.concat(cc).filter(function (e) { return !EMAIL_RE.test(e); });
    if (bad.length) return { ok: false, status: 400, error: 'bad_recipient', detail: bad };
    if (!subject) return { ok: false, status: 400, error: 'no_subject' };
    if (!body) return { ok: false, status: 400, error: 'no_body' };
    var carrier = carrierRecipients(to.join(','), cc.join(','));
    if (carrier.length && params.confirmCarrier !== true) return { ok: false, status: 428, error: 'carrier_confirm_required', carrier: carrier };
    return { ok: true, carrier: carrier, send: { to: to.join(', '), cc: cc.join(', '), subject: subject, body: ensureSignoff(body) } };
  }

  /** Next Queue_ID for a day: Q-YYYYMMDD-### (dedupe-safe against existing IDs). */
  function nextQueueId(rows, ymdCompact) {
    var prefix = 'Q-' + ymdCompact + '-', max = 0;
    (rows || []).forEach(function (r) {
      var id = String((r && r.Queue_ID) || '');
      if (id.indexOf(prefix) === 0) { var n = parseInt(id.slice(prefix.length), 10); if (n > max) max = n; }
    });
    return prefix + ('00' + (max + 1)).slice(-3);
  }
  function hasSourceThread(rows, sourceId) {
    var s = String(sourceId || '').trim();
    return !!s && (rows || []).some(function (r) { return String((r && r.Source_Thread_ID) || '').trim() === s; });
  }

  return {
    buildPayload: buildPayload, validateClaims: validateClaims, findUser: findUser,
    MARGIN_FIELDS: MARGIN_FIELDS, ROLES: ROLES,
    QUEUE_COLUMNS: QUEUE_COLUMNS, QUEUE_STATUSES: QUEUE_STATUSES, SIGNOFF: SIGNOFF,
    isOwner: isOwner, buildQueue: buildQueue, checkQueueAction: checkQueueAction,
    isCarrierRecipient: isCarrierRecipient, carrierRecipients: carrierRecipients,
    ensureSignoff: ensureSignoff, nextQueueId: nextQueueId, hasSourceThread: hasSourceThread,
    _internals: { money: money, toDate: toDate, cityOf: cityOf, townOf: townOf, workingDaysMTD: workingDaysMTD, truthy: truthy }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DoorwayCore;
