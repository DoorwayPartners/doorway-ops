/**
 * Doorway Ops Command Center — Apps Script web app (STANDALONE project).
 *
 * Deploy as: Execute as = Me (Cristian), Who has access = Anyone.
 * The gate is NOT the deployment setting; it is the Google ID token check below:
 *   1. The browser signs in with Google Identity Services and gets an ID token.
 *   2. It POSTs {idToken} here (Content-Type text/plain to avoid a CORS preflight).
 *   3. We verify the token with Google's tokeninfo endpoint (signature + expiry),
 *      then re-check aud / iss / exp / email_verified ourselves (DoorwayCore.validateClaims).
 *   4. The verified email is looked up in Portal_Users. Unknown or inactive -> 403.
 *   5. DoorwayCore.buildPayload returns ONLY the fields that role may see.
 *
 * The dashboard read path never writes. The only writes are the V2 Owner-only
 * queue actions in Queue.js (Ops_Approval_Queue tab: status, Resolved_At, edited draft).
 *
 * Script Properties (Project Settings > Script properties) — no IDs in code:
 *   OAUTH_CLIENT_ID     e.g. 1234-abc.apps.googleusercontent.com
 *   PAYROLL_SHEET_ID    1099 Commission & Payroll Master
 *   RECON_SHEET_ID      Master Turf Sheet — SalesRabbit Reconciliation
 *   EXPENSE_SHEET_ID    Trip & Ops Expense Ledger
 */

var TABS = {
  users: 'Portal_Users',
  orders: 'Order_Ledger',
  compliance: 'Compliance_Tracker',
  scorecard: 'Field_Scorecard',
  exceptions: 'Payroll_Exceptions',
  day14Range: 'Day14_First_Bill',
  permits: 'Municipal_Permits',
  phantom: 'Phantom_Sales',
  expenses: 'Expense_Ledger'
};
var DAY14_COLUMNS = ['Order_ID', 'Rep_Name', 'Customer_Name', 'Service_Address', 'Install_Date', 'Day14_Date', 'Campaign'];
var TZ = 'America/New_York';

function doGet(e) {
  var token = e && e.parameter && e.parameter.idToken;
  if (!token) return json_({ status: 200, service: 'doorway-ops', message: 'POST {"idToken": "..."} to read your dashboard.' });
  return handle_(token, {}); // GET never runs queue actions
}

function doPost(e) {
  var req = {};
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}') || {}; } catch (err) { req = {}; }
  return handle_(req.idToken, req);
}

function handle_(idToken, req) {
  try {
    if (!idToken) return json_({ status: 401, error: 'missing_token' });
    var props = PropertiesService.getScriptProperties();
    var check = verifyIdToken_(idToken, props.getProperty('OAUTH_CLIENT_ID'));
    if (!check.ok) return json_({ status: 401, error: 'invalid_token', reason: check.reason });

    var raw = { users: readTab_(props.getProperty('PAYROLL_SHEET_ID'), TABS.users) };
    // Fail closed before reading anything else.
    var user = DoorwayCore.findUser(raw.users, check.email);
    if (!user) return json_({ status: 403, error: 'forbidden', message: 'This Google account is not on the Doorway Ops access list.' });

    // V2 Owner Priority Queue actions (POST only). Owner role is re-checked in Queue.js.
    var action = req && req.action ? String(req.action) : '';
    if (action) return json_(handleQueueAction_(action, user, req, props));

    loadData_(raw, props, user.role);
    var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
    var result = DoorwayCore.buildPayload(check.email, raw, today);
    result.body.status = result.status;
    return json_(result.body);
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ status: 500, error: 'server_error' });
  }
}

/** Verify a GIS ID token. Google's tokeninfo checks the signature and expiry. */
function verifyIdToken_(idToken, clientId) {
  if (!clientId) return { ok: false, reason: 'server_not_configured' };
  if (!/^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/.test(idToken)) return { ok: false, reason: 'malformed' };
  var cache = CacheService.getScriptCache();
  var key = 'tok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)).slice(0, 40);
  var cached = cache.get(key);
  var claims;
  if (cached) {
    claims = JSON.parse(cached);
  } else {
    var resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return { ok: false, reason: 'tokeninfo_rejected' };
    claims = JSON.parse(resp.getContentText());
  }
  var nowSec = Math.floor(Date.now() / 1000);
  var v = DoorwayCore.validateClaims(claims, clientId, nowSec);
  if (v.ok && !cached) {
    var ttl = Math.min(300, parseInt(claims.exp, 10) - nowSec);
    if (ttl > 5) cache.put(key, JSON.stringify(claims), ttl);
  }
  return v;
}

/** Only load what the role can ever see (expenses for Owner/Admin only). */
function loadData_(raw, props, role) {
  var payroll = props.getProperty('PAYROLL_SHEET_ID');
  var recon = props.getProperty('RECON_SHEET_ID');
  raw.orders = readTab_(payroll, TABS.orders);
  raw.compliance = readTab_(payroll, TABS.compliance);
  raw.scorecard = readTab_(payroll, TABS.scorecard).filter(function (r) { return r.Date || r.Rep; });
  raw.day14 = readNamedRange_(payroll, TABS.day14Range, DAY14_COLUMNS);
  raw.permits = readTab_(recon, TABS.permits).filter(function (r) { return r.Town; });
  raw.phantom = readTab_(recon, TABS.phantom).filter(function (r) { return r.Address; });
  if (role === 'Owner' || role === 'Admin') {
    raw.exceptions = readTab_(payroll, TABS.exceptions, 3).filter(function (r) { return r.Order_ID; });
    var exp = props.getProperty('EXPENSE_SHEET_ID');
    raw.expenses = exp ? readTab_(exp, TABS.expenses).filter(function (r) { return r.Date; }) : [];
  }
}

/** Read a tab as objects. headerRow is 1-based (Payroll_Exceptions uses row 3). */
function readTab_(spreadsheetId, tabName, headerRow) {
  if (!spreadsheetId) throw new Error('Missing sheet id for ' + tabName);
  var sh = SpreadsheetApp.openById(spreadsheetId).getSheetByName(tabName);
  if (!sh) throw new Error('Missing tab ' + tabName);
  var values = sh.getDataRange().getValues();
  var h = (headerRow || 1) - 1;
  var headers = (values[h] || []).map(function (x) { return String(x).trim(); });
  var out = [];
  for (var r = h + 1; r < values.length; r++) {
    var obj = {}, any = false;
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      var v = values[r][c];
      if (v instanceof Date) v = Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
      obj[headers[c]] = v;
      if (v !== '' && v !== null) any = true;
    }
    if (any) out.push(obj);
  }
  return out;
}

function readNamedRange_(spreadsheetId, name, columns) {
  var rng = SpreadsheetApp.openById(spreadsheetId).getRangeByName(name);
  if (!rng) return [];
  return rng.getValues().filter(function (row) { return row[0]; }).map(function (row) {
    var o = {};
    columns.forEach(function (c, i) { var v = row[i]; o[c] = v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : v; });
    return o;
  });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
