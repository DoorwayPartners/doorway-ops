'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../apps-script/Core.js');
const Payroll = require('../apps-script/PayrollEngine.js');
const Feed = require('../apps-script/FeedImporter.js');
const GroupMe = require('../apps-script/GroupMeBridge.js');
const DEMO = require('../docs/demo-data.js');

const OWNER = { role: 'Owner', email: 'owner@demo.example', name: 'Olivia Owner' };
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const BLANK_FIDIUM = {
  Campaign_ID: 'FIDIUM',
  Active_Flag: 'Y',
  Gross_Agency_Rev_Default: '',
  Rep_Base_Comm: '',
  Certified_Bonus_Comm: '',
  Pod_Lead_Override: '',
  Clawback_Days: 90,
  Hold_Back_Pct: ''
};
const SET_ATT = {
  Campaign_ID: 'ATT',
  Active_Flag: 'Y',
  Gross_Agency_Rev_Default: 100,
  Rep_Base_Comm: 40,
  Certified_Bonus_Comm: 10,
  Pod_Lead_Override: 5,
  Clawback_Days: 90,
  Hold_Back_Pct: 0
};

test('EVALUATE_PAYROLL is Owner-only', () => {
  for (const role of ['Admin', 'Manager', 'Rep']) {
    const r = Payroll.checkEvaluate({ role });
    assert.equal(r.status, 403);
    assert.equal(r.error, 'owner_only');
    assert.equal(r.ok, false);
  }
  assert.equal(Payroll.checkEvaluate(null).status, 403);
  assert.equal(Payroll.checkEvaluate(OWNER).ok, true);
});

test('blank Campaign_Rules rates yield rates not set, never invented numbers', () => {
  const map = Payroll.rulesMapFromRows([BLANK_FIDIUM]);
  const ev = Payroll.evaluateOrderPayout({
    Order_ID: '260001AB',
    Campaign: 'FIDIUM',
    Rep_Name: 'Riley Rep',
    C2C_Status: 'Installed',
    Carrier_Payout_Cleared: 'Y',
    Install_Date: '2026-11-01'
  }, map, '2026-11-12');
  assert.equal(ev.eligible, false);
  assert.equal(ev.ratesSet, false);
  assert.equal(ev.payout, null);
  assert.equal(ev.netSpread, null);
  assert.equal(ev.clawbackAmount, null);
  assert.equal(ev.note, 'rates not set');
  assert.equal(ev.reason, 'rates_not_set');
  const json = JSON.stringify(ev);
  assert.ok(!json.includes('140') && !json.includes('"50"') && !/\b90\b/.test(String(ev.payout)));
});

test('payout requires install + Carrier_Payout_Cleared and uses Campaign_Rules only', () => {
  const map = Payroll.rulesMapFromRows([SET_ATT]);
  const base = {
    Order_ID: '260099AA', Campaign: 'ATT', Rep_Name: 'Riley Rep',
    C2C_Status: 'Pending', Carrier_Payout_Cleared: '', Install_Date: ''
  };
  const pending = Payroll.evaluateOrderPayout(base, map, '2026-11-12');
  assert.equal(pending.eligible, false);
  assert.equal(pending.reason, 'pending_install');
  assert.equal(pending.payout, 0);

  const installed = Payroll.evaluateOrderPayout(Object.assign({}, base, {
    C2C_Status: 'Installed', Install_Date: '2026-11-01', Carrier_Payout_Cleared: 'N'
  }), map, '2026-11-12');
  assert.equal(installed.eligible, false);
  assert.equal(installed.reason, 'awaiting_clearance');

  const cleared = Payroll.evaluateOrderPayout(Object.assign({}, base, {
    C2C_Status: 'Installed', Install_Date: '2026-11-01', Carrier_Payout_Cleared: 'Y'
  }), map, '2026-11-12');
  assert.equal(cleared.eligible, true);
  assert.equal(cleared.payout, 40);
  assert.equal(cleared.netSpread, 60);
  assert.equal(cleared.note, 'Cleared & payable');

  const coast = Payroll.evaluateOrderPayout({
    Order_ID: 'X', Campaign: 'Coast to Coast', C2C_Status: 'Installed', Carrier_Payout_Cleared: 'Y'
  }, Payroll.rulesMapFromRows([BLANK_FIDIUM]), '2026-11-12');
  assert.equal(coast.Campaign_ID, 'FIDIUM');
  assert.equal(coast.note, 'rates not set');
});

test('90-day clawback flags a cancelled installed order without writing a ledger', () => {
  const map = Payroll.rulesMapFromRows([SET_ATT]);
  const ev = Payroll.evaluateOrderPayout({
    Order_ID: '260088AA', Campaign: 'ATT', Rep_Name: 'Riley Rep',
    C2C_Status: 'Cancelled', Cancel_Date: '2026-11-10', Install_Date: '2026-09-01',
    Carrier_Payout_Cleared: 'Y'
  }, map, '2026-11-12');
  assert.equal(ev.eligible, false);
  assert.equal(ev.clawbackFlag, true);
  assert.equal(ev.clawbackAmount, 40);
  assert.equal(ev.netSpread, -40);
  assert.match(ev.note, /90-day clawback/);

  const late = Payroll.evaluateOrderPayout({
    Order_ID: '260087AA', Campaign: 'ATT', Rep_Name: 'Riley Rep',
    C2C_Status: 'Cancelled', Cancel_Date: '2026-11-10', Install_Date: '2026-07-01',
    Carrier_Payout_Cleared: 'Y'
  }, map, '2026-11-12');
  assert.equal(late.clawbackFlag, false);
});

test('PayrollEngine hardcodes no default rate matrix and writes no ledger', () => {
  const src = read('apps-script/PayrollEngine.js');
  assert.ok(!/DEFAULT_CAMPAIGN_MATRIX/.test(src));
  assert.ok(!/grossRev:\s*140/.test(src));
  assert.ok(!/leaderRate:\s*90/.test(src));
  assert.ok(!/appendRow|Payroll_Ledger|LockService/.test(src.replace(/never writes Payroll_Ledger[\s\S]*?EVALUATE_PAYROLL/, '')));
  assert.match(src, /rates not set/);
  assert.ok(!/UrlFetchApp|SalesRabbit|salesrabbit/.test(src));
  // Named-person pay exclusions were not copied from Gemini (unverified).
  assert.ok(!/ian barber/i.test(src));
});

test('STAGE_GROUPME_DIGEST is Owner-only, read-only, and never posts', () => {
  for (const role of ['Admin', 'Manager', 'Rep']) {
    const r = GroupMe.checkStage({ role });
    assert.equal(r.status, 403);
    assert.equal(r.error, 'owner_only');
  }
  assert.equal(GroupMe.checkStage(OWNER).ok, true);

  const src = read('apps-script/GroupMeBridge.js');
  assert.match(src, /STRICTLY READ-ONLY/);
  assert.match(src, /groupme_token_not_configured/);
  assert.ok(!/method:\s*'post'/i.test(src));
  assert.ok(!/method:\s*"post"/i.test(src));
  for (const bad of ['bots/post', '/messages POST', 'postBot', 'sendBot', 'callback that posts', 'GroupMeApp.post']) {
    assert.ok(!src.toLowerCase().includes(bad.toLowerCase()) || bad === 'callback that posts', `must not ${bad}`);
  }
  // GET-only fetch helper, if present, must not POST
  const fetchFn = src.indexOf('function fetchGroupMeMessagesReadOnly_');
  assert.ok(fetchFn >= 0);
  const fetchBody = src.slice(fetchFn, src.indexOf('if (typeof module', fetchFn));
  assert.match(fetchBody, /method:\s*'get'/);
  assert.ok(!/method:\s*'post'/.test(fetchBody));

  const msgs = GroupMe.parseMessages('Riley Rep: Is order 260001AB delayed at 123 Main Street?\nParker: All good here');
  const plan = GroupMe.planDigest(msgs, [], function (text) {
    if (/260001AB/.test(text)) return { linkedOrder: { Order_ID: '260001AB', Rep_Name: 'Riley Rep' }, summaryTag: 'Order 260001AB (Installed)' };
    return { summaryTag: 'Unlinked Intake' };
  });
  assert.equal(plan.ingested, 2);
  assert.equal(plan.staged.length, 1);
  assert.equal(plan.staged[0].orderId, '260001AB');
  assert.equal(plan.staged[0].completeForCarrier, true);
  assert.equal(plan.staged[0].draftBody, '');
  const row = GroupMe.queueRowFromPlan(plan.staged[0], 'Q-20261112-009', '2026-11-12T19:00:00');
  assert.equal(row.Status, 'PENDING');
  assert.equal(row.Draft_To, '');
  assert.equal(row.Draft_Body, '');
  assert.equal(row.Priority, 'P2-OPS');
});

test('Code.js routes V4.0 actions after auth; no new OAuth scopes', () => {
  const code = read('apps-script/Code.js');
  const findAt = code.indexOf('var user = DoorwayCore.findUser');
  const payAt = code.indexOf("if (action === 'EVALUATE_PAYROLL')");
  const gmAt = code.indexOf("if (action === 'STAGE_GROUPME_DIGEST')");
  const queueAt = code.indexOf('handleQueueAction_(');
  assert.ok(findAt > 0 && payAt > findAt && gmAt > findAt, 'auth must run before V4.0 actions');
  assert.ok(queueAt > payAt && queueAt > gmAt, 'queue router stays after the new routes');
  assert.match(code, /if \(!idToken\) return json_\(\{ status: 401, error: 'missing_token' \}\)/);

  const scopes = JSON.parse(read('apps-script/appsscript.json'));
  assert.deepEqual(scopes.oauthScopes, [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/script.external_request',
    'https://mail.google.com/',
    'https://www.googleapis.com/auth/script.scriptapp'
  ]);

  const ignore = read('apps-script/.claspignore');
  assert.match(ignore, /^!PayrollEngine\.js$/m);
  assert.match(ignore, /^!GroupMeBridge\.js$/m);

  const feed = read('apps-script/FeedImporter.js');
  assert.ok(!/salesrabbit\.com|api\.salesrabbit/i.test(feed));
  assert.ok(!/UrlFetchApp/.test(feed), 'FeedImporter must not call SalesRabbit or any HTTP API');
});

test('Feed importer detects SR / C2C / carrier schemas, 2-cycle missing orders, and strips active customers', () => {
  const sr = [
    'Assigned to (email),Status,Address,City,Date Updated',
    'riley@demo.example,Fiber Slap!,123 Main Street,Amherst,2026-11-01',
    'parker@demo.example,Not Attempted,9 Oak Road,Milford,2026-11-10'
  ].join('\n');
  const srCheck = Feed.checkImport(OWNER, { campaignId: 'FIDIUM', feedType: 'AUTO', csvText: sr });
  assert.equal(srCheck.ok, true);
  assert.equal(Feed.detectFeedType(srCheck.rows[0]), 'SALESRABBIT_TURF');
  const srPlan = Feed.planImport(srCheck, [], '2026-11-12T18:00:00', 'IMP-SR');
  assert.equal(srPlan.detectedFeedType, 'SALESRABBIT_TURF');
  assert.equal(srPlan.turfBreakdown.NEW_TURF, 1);
  assert.equal(srPlan.turfBreakdown.REWORK_TURF, 1);
  assert.equal(srPlan.missingOrders.length, 0); // only 0 C2C report cycles so far
  srPlan.append.forEach((row) => {
    assert.deepEqual(Object.keys(row).sort(), Feed.FEED_COLUMNS.slice().sort());
  });

  const c2cA = 'Order #,Rep Name,Service Address,City,C2C Status\n260010AA,Other Rep,999 Elsewhere Rd,Concord,Installed\n';
  const existSr = [{
    Feed_Type: 'SALESRABBIT_TURF', Address: '123 Main Street', City: 'Amherst',
    Rep_Name: 'riley@demo.example', Status: 'Fiber Slap!', Date_Updated: '2026-11-01',
    Imported_At: '2026-11-01T12:00:00', Import_Batch: 'IMP-SR'
  }];
  const existC2c = [{
    Feed_Type: 'C2C_DAILY_SALES', Address: '999 Elsewhere Rd', City: 'Concord', Order_ID: '260010AA',
    Status: 'Installed', Imported_At: '2026-11-08T12:00:00', Import_Batch: 'IMP-C2C-1'
  }];
  const c2cCheck = Feed.checkImport(OWNER, { campaignId: 'FIDIUM', feedType: 'AUTO', csvText: c2cA });
  const c2cPlan = Feed.planImport(c2cCheck, existSr.concat(existC2c), '2026-11-12T18:00:00', 'IMP-C2C-2');
  assert.equal(c2cPlan.detectedFeedType, 'C2C_DAILY_SALES');
  assert.ok(c2cPlan.missingOrders.some((m) => /123 Main/.test(m.Address)), 'pin missing after 2 C2C cycles');
  assert.ok(c2cPlan.missingOrders.every((m) => m.reportsSincePin >= 2));

  const leads = [
    'PORTAL_ADDRESS,FIBER_SERVING_LOCATION,DATA_BROADBAND_FTTP,City,Wire Center',
    '101 Example St,FSL-1,N,SAMPLETON,WC-A',
    '202 Placeholder Ave,FSL-2,Y,SAMPLETON,WC-A',
    '50 Clean Lane,FSL-3,N,Amherst,WC-B'
  ].join('\n');
  const leadCheck = Feed.checkImport(OWNER, { campaignId: 'FIDIUM', feedType: 'AUTO', csvText: leads });
  assert.equal(Feed.detectFeedType(leadCheck.rows[0]), 'CARRIER_LEAD');
  const leadPlan = Feed.planImport(leadCheck, [], '2026-11-12T18:00:00', 'IMP-LEAD', {
    orders: [
      { Service_Address: '101 Example St, SAMPLETON ME', C2C_Status: 'Installed' }
    ]
  });
  assert.equal(leadPlan.carrierVetting.droppedActive, 2); // 101 matched ledger + 202 flagged Y
  assert.deepEqual(leadPlan.carrierVetting.cleanByTown, { Amherst: 1 });
  // Pay columns still dropped
  const payCsv = 'Order #,Rep Name,City,Status,Base Comm\n260001AB,Riley,Amherst,Installed,$90\n';
  const payPlan = Feed.planImport(Feed.checkImport(OWNER, { campaignId: 'FIDIUM', csvText: payCsv }), [], 't', 'b');
  assert.ok(payPlan.droppedHeaders.some((h) => /comm/i.test(h)));
});

test('Team Pace leaderboard adds daily/weekly pace and never includes pay, margins, or addresses', () => {
  const raw = JSON.parse(JSON.stringify(DEMO.raw));
  const owner = Core.buildPayload(DEMO.emails.Owner, raw, DEMO.TODAY).body;
  const rep = Core.buildPayload(DEMO.emails.Rep, raw, DEMO.TODAY).body;
  const mgr = Core.buildPayload(DEMO.emails.Manager, raw, DEMO.TODAY).body;
  assert.ok(owner.leaderboard.length);
  owner.leaderboard.forEach((r) => {
    assert.equal(typeof r.dealsToday, 'number');
    assert.equal(typeof r.dealsWeek, 'number');
    assert.equal(r.dailyTarget, 2);
    assert.equal(r.weeklyTarget, 10);
    assert.equal(typeof r.trailingPace, 'boolean');
    for (const k of ['payout', 'Base_Comm', 'Net_Agency_Spread', 'Gross_Agency_Rev', 'Service_Address', 'Customer_Name', 'netSpread']) {
      assert.ok(!(k in r), `leaderboard leaked ${k}`);
    }
  });
  const riley = owner.leaderboard.find((r) => /Riley/.test(r.rep));
  assert.ok(riley);
  assert.equal(riley.deals, 4);
  assert.equal(riley.dealsWeek, 2); // Nov 9 and Nov 11 (week of Nov 9–12)
  assert.equal(riley.trailingPace, true); // expected 8 by Thursday
  assert.equal(riley.shadowFlag, 'Field shadowing');

  // Rep / Manager scoreboards also stay pay-free
  const boards = [rep.pace].concat(mgr.podScoreboard || []);
  boards.forEach((r) => {
    if (!r) return;
    for (const k of ['payout', 'Base_Comm', 'Net_Agency_Spread', 'Gross_Agency_Rev', 'Service_Address']) {
      assert.ok(!(k in r), `non-owner pace leaked ${k}`);
    }
  });

  const app = read('docs/app.js');
  assert.match(app, /Trailing — shadow/);
  assert.match(app, /10\/week/);
  const card = app.slice(app.indexOf('function leaderboardCard'), app.indexOf('function missingCard'));
  assert.ok(!/usd\(|Net_Agency|Service_Address|Base_Comm|Customer_Name/.test(card));

  const html = read('docs/index.html');
  assert.match(html, /V4\.0/);
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.ok(!/unsafe-inline/.test(csp.split('script-src')[1].split(';')[0]));
});
