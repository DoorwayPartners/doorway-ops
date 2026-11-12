'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Pdf = require('../apps-script/PdfEngine.js');
const Feed = require('../apps-script/FeedImporter.js');
const Entity = require('../apps-script/EntityLinker.js');
const Core = require('../apps-script/Core.js');

const OWNER = { role: 'Owner', email: 'owner@demo.example', name: 'Olivia Owner' };
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('GENERATE_PDF is Owner-only and rejects bad or oversized payloads', () => {
  const okReq = { type: 'SUMMARY', payload: { title: 'Ops', rows: [{ col1: 'A', col2: 'B', col3: '1' }] } };
  for (const role of ['Admin', 'Manager', 'Rep']) {
    const r = Pdf.checkGeneratePdf({ role }, okReq);
    assert.equal(r.status, 403);
    assert.equal(r.error, 'owner_only');
    assert.ok(!r.payload);
  }
  assert.equal(Pdf.checkGeneratePdf(null, okReq).status, 403);
  assert.equal(Pdf.checkGeneratePdf(OWNER, { type: 'NUKE' }).error, 'bad_pdf_type');
  const tooBig = { type: 'SUMMARY', payload: { rows: Array.from({ length: Pdf.MAX_ROWS + 1 }, () => ({ col1: 'x' })) } };
  assert.equal(Pdf.checkGeneratePdf(OWNER, tooBig).error, 'too_many_rows');
  const ok = Pdf.checkGeneratePdf(OWNER, okReq);
  assert.equal(ok.ok, true);
  assert.equal(ok.type, 'SUMMARY');
  assert.equal(ok.payload.rows.length, 1);
});

test('PDF HTML escapes untrusted payload text (no raw markup)', () => {
  const html = Pdf.buildPdfHtml('SUMMARY', {
    title: '<script>alert(1)</script>',
    summary: 'A & B <img>',
    h1: '"Item"',
    rows: [{ col1: '<b>x</b>', col2: "y'", col3: '1&2' }],
    generatedAt: '2026-11-12 18:00'
  });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('A &amp; B &lt;img&gt;'));
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.ok(html.includes('1&amp;2'));
  assert.ok(!/DriveApp|getUrl\(|createFolder/.test(html));
});

test('PdfEngine.js does not call DriveApp or add a Drive scope', () => {
  const src = read('apps-script/PdfEngine.js');
  assert.ok(!/DriveApp\s*\./.test(src), 'DriveApp would require a new OAuth scope');
  assert.ok(!/\.getUrl\(/.test(src));
  const scopes = JSON.parse(read('apps-script/appsscript.json'));
  assert.ok(!scopes.oauthScopes.some((s) => /auth\/drive/.test(s)));
  assert.deepEqual(scopes.oauthScopes, [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/script.external_request',
    'https://mail.google.com/',
    'https://www.googleapis.com/auth/script.scriptapp'
  ]);
});

test('IMPORT_RAW_FEED is Owner-only and validates size, campaign, and headers', () => {
  const csv = 'Order ID,Rep Name,City,Status\n260001AB,Riley Rep,Amherst,Installed\n';
  const okReq = { campaignId: 'FIDIUM', feedType: 'RAW_UPLOAD', csvText: csv };
  for (const role of ['Admin', 'Manager', 'Rep']) {
    const r = Feed.checkImport({ role }, okReq);
    assert.equal(r.status, 403);
    assert.equal(r.error, 'owner_only');
    assert.ok(!r.rows);
  }
  assert.equal(Feed.checkImport(null, okReq).status, 403);
  assert.equal(Feed.checkImport(OWNER, { csvText: '' }).error, 'empty_csv');
  assert.equal(Feed.checkImport(OWNER, { csvText: 'only-headers\n' }).error, 'CSV must contain headers and at least 1 data row.');
  assert.equal(Feed.checkImport(OWNER, { campaignId: 'bad id', csvText: csv }).error, 'bad_campaign_id');
  assert.equal(Feed.checkImport(OWNER, { feedType: 'HACK', csvText: csv }).error, 'bad_feed_type');
  const huge = { campaignId: 'FIDIUM', csvText: 'h\n' + 'x'.repeat(Feed.MAX_CSV_CHARS) };
  assert.equal(Feed.checkImport(OWNER, huge).error, 'csv_too_large');
  const ok = Feed.checkImport(OWNER, okReq);
  assert.equal(ok.ok, true);
  assert.equal(ok.campaignId, 'FIDIUM');
});

test('Feed import appends/upserts allowlisted columns only and drops pay/rate headers', () => {
  const csv = [
    'Order #,Rep,Service Address,Town,C2C Status,Base Comm,Payout,Mystery_Col',
    '260001AB,Riley Rep,123 Main Street,Amherst,Installed,$90,500,keep-me-out',
    '260002CD,Parker Pod,9 Oak Rd,Milford,Pending,40,0,nope'
  ].join('\n');
  const check = Feed.checkImport(OWNER, { campaignId: 'FIDIUM', csvText: csv });
  const plan = Feed.planImport(check, [], '2026-11-12T18:00:00', 'IMP-TEST');
  assert.equal(plan.status, 200);
  assert.equal(plan.importedCount, 2);
  assert.equal(plan.appended, 2);
  assert.equal(plan.updated, 0);
  assert.deepEqual(plan.townBreakdown, { Amherst: 1, Milford: 1 });
  assert.ok(plan.droppedHeaders.some((h) => /comm/i.test(h)));
  assert.ok(plan.droppedHeaders.some((h) => /payout/i.test(h)));
  assert.ok(plan.headerMismatches.some((h) => h.normalized === 'mystery_col'));
  plan.append.forEach((row) => {
    assert.deepEqual(Object.keys(row).sort(), Feed.FEED_COLUMNS.slice().sort());
    assert.equal(row.Campaign_ID, 'FIDIUM');
    assert.ok(!('Base_Comm' in row) && !('Payout' in row) && !('Mystery_Col' in row) && !('keep-me-out' in Object.values(row)));
  });
  assert.equal(plan.append[0].Order_ID, '260001AB');
  assert.equal(plan.append[0].Address, '123 Main Street');

  const existing = [{ _row: 4, Order_ID: '260001AB', Campaign_ID: 'FIDIUM', Rep_Name: 'Old', City: 'Amherst' }];
  const plan2 = Feed.planImport(check, existing, '2026-11-12T19:00:00', 'IMP-TEST-2');
  assert.equal(plan2.updated, 1);
  assert.equal(plan2.appended, 1);
  assert.equal(plan2.updates[0]._row, 4);
  assert.equal(plan2.updates[0].fields.Rep_Name, 'Riley Rep');
  assert.ok(!('Order_ID' in plan2.updates[0].fields));
});

test('Header aliases match the spec (order, rep, address, city, status, campaign)', () => {
  assert.equal(Feed.normalizeHeader('Order #'), 'order_id');
  assert.equal(Feed.normalizeHeader('SR assigned to'), 'rep_name');
  assert.equal(Feed.normalizeHeader('Service Address'), 'address');
  assert.equal(Feed.normalizeHeader('Market'), 'city');
  assert.equal(Feed.normalizeHeader('Disposition'), 'status');
  assert.equal(Feed.normalizeHeader('Provider'), 'campaign');
});

test('enrichEntityContext matches order id or street, slims the result, and flags unlinked', () => {
  const orders = [
    { Order_ID: '260001AB', Service_Address: '123 Main Street, Amherst NH', C2C_Status: 'Installed', Rep_Name: 'Riley Rep', Gross_Agency_Rev: 999, Customer_Name: 'Secret Cust' },
    { Order_ID: '260002CD', Service_Address: '9 Oak Road', C2C_Status: 'Pending', Rep_Name: 'Parker Pod' }
  ];
  const roster = [{ Rep_Name: 'Riley Rep' }, { Name: 'Parker Pod' }];

  const byId = Entity.enrichEntityContext('Please check order 260001AB today', orders, roster);
  assert.equal(byId.linkedOrder.Order_ID, '260001AB');
  assert.equal(byId.summaryTag, 'Order 260001AB (Installed)');
  assert.ok(!('Service_Address' in byId.linkedOrder));
  assert.ok(!('Gross_Agency_Rev' in byId.linkedOrder));
  assert.ok(!('Customer_Name' in byId.linkedOrder));
  assert.deepEqual(Object.keys(byId.linkedOrder).sort(), ['C2C_Status', 'Order_ID', 'Rep_Name']);

  const byAddr = Entity.enrichEntityContext('Customer at 123 Main Street called about service', orders, roster);
  assert.equal(byAddr.linkedOrder.Order_ID, '260001AB');

  const byRep = Entity.enrichEntityContext('Need a follow-up with Parker Pod tomorrow', [], roster);
  assert.equal(byRep.linkedOrder, null);
  assert.equal(byRep.linkedRep.Rep_Name, 'Parker Pod');
  assert.equal(byRep.summaryTag, 'Rep: Parker Pod');
  assert.deepEqual(Object.keys(byRep.linkedRep), ['Rep_Name']);

  const none = Entity.enrichEntityContext('Random newsletter', orders, roster);
  assert.equal(none.summaryTag, 'Unlinked Intake');
  assert.equal(none.linkedOrder, null);
  assert.equal(none.linkedRep, null);
});

test('Code.js routes GENERATE_PDF and IMPORT_RAW_FEED after auth; import busts cache', () => {
  const code = read('apps-script/Code.js');
  const findAt = code.indexOf('var user = DoorwayCore.findUser');
  const pdfAt = code.indexOf("if (action === 'GENERATE_PDF')");
  const impAt = code.indexOf("if (action === 'IMPORT_RAW_FEED')");
  const queueAt = code.indexOf('handleQueueAction_(');
  assert.ok(findAt > 0 && pdfAt > findAt && impAt > findAt, 'auth must run before new actions');
  assert.ok(queueAt > pdfAt && queueAt > impAt, 'queue router stays after the new routes');
  assert.match(code, /if \(!idToken\) return json_\(\{ status: 401, error: 'missing_token' \}\)/);

  const feed = read('apps-script/FeedImporter.js');
  const fn = feed.indexOf('function handleImportRawFeed_');
  assert.ok(fn >= 0);
  assert.ok(feed.indexOf('bustBootCache_()', fn) > fn, 'successful import must bust the boot cache');
  assert.ok(!/OWNER_BOOT_PAYLOAD_V3/.test(feed), 'must not use the stale hardcoded cache key');
  assert.match(feed, /FEED_TAB = 'Raw_Feed_Import'/);
  assert.match(feed, /sourceModule: 'FEED_IMPORT'/);

  const ignore = read('apps-script/.claspignore');
  assert.match(ignore, /^!PdfEngine\.js$/m);
  assert.match(ignore, /^!FeedImporter\.js$/m);
  assert.match(ignore, /^!EntityLinker\.js$/m);
});

test('urgentIntakeSweep calls enrichEntityContext and never sends or marks mail read', () => {
  const q = read('apps-script/Queue.js');
  const start = q.indexOf('function urgentIntakeSweep()');
  const end = q.indexOf('function installUrgentIntakeTrigger()');
  assert.ok(start >= 0 && end > start);
  const body = q.slice(start, end);
  assert.match(body, /enrichEntityContext\(/);
  assert.match(body, /sourceModule: 'ENTITY_LINK'/);
  assert.match(body, /UNLINKED_INTAKE/);
  for (const bad of ['markRead', 'markUnread', 'setRead', 'sendEmail', 'GmailApp.send', '.reply(', 'moveToTrash']) {
    assert.ok(!body.includes(bad), `urgentIntakeSweep must not ${bad}`);
  }
  // Labeling existing threads is allowed; messages stay unread
  assert.match(body, /t\.addLabel\(label\)/);
});

test('Frontend drawer is Owner-only, uses no innerHTML, and does not change CSP', () => {
  const app = read('docs/app.js');
  assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(app));
  assert.match(app, /id: 'drop-csv-pdf'/);
  assert.match(app, /text: '\+ Drop CSV \/ PDF'/);
  const mount = app.slice(app.indexOf('function mountHud(d)'), app.indexOf('function viewTabs()'));
  assert.match(mount, /if \(d\.role === 'Owner'\) \{[\s\S]*drop-csv-pdf/);
  assert.ok(!/role === 'Admin'[\s\S]{0,80}drop-csv-pdf/.test(mount));
  assert.ok(!/role === 'Rep'[\s\S]{0,80}drop-csv-pdf/.test(app));
  assert.match(app, /action: 'IMPORT_RAW_FEED'/);
  assert.match(app, /action: 'GENERATE_PDF'/);

  const html = read('docs/index.html');
  assert.match(html, /Content-Security-Policy/);
  assert.ok(!/cdn\.|unpkg|jsdelivr|googleapis\.com\/maps/.test(html));
  // CSP still has no unsafe-inline in script-src
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.ok(!/unsafe-inline/.test(csp.split('script-src')[1].split(';')[0]));
});

test('Learning_Log accepts the new FEED_IMPORT and ENTITY_LINK source modules', () => {
  assert.ok(Core.LEARNING_SOURCE_MODULES.includes('FEED_IMPORT'));
  assert.ok(Core.LEARNING_SOURCE_MODULES.includes('ENTITY_LINK'));
  assert.equal(Core.buildLearningLogRow({ sourceModule: 'FEED_IMPORT' }).Source_Module, 'FEED_IMPORT');
  assert.equal(Core.buildLearningLogRow({ sourceModule: 'ENTITY_LINK' }).Source_Module, 'ENTITY_LINK');
});
