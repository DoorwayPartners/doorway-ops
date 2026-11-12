'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../apps-script/Core.js');

const OWNER = { role: 'Owner', email: 'owner@demo.example', name: 'Olivia Owner' };
const qrow = (extra) => Object.assign({
  Queue_ID: 'Q-20261112-001', Created_At: '2026-11-12T09:00:00', Priority: 'P2-OPS', Category: 'Follow_Up',
  Source_Thread_ID: '', Rep_Or_Sender: 'Riley Rep (Demo)', Context_Summary: 'demo', Draft_To: 'rep@demo.example', Draft_Cc: '',
  Draft_Subject: 'Follow up', Draft_Body: 'Hi Riley', Status: 'PENDING', Resolved_At: ''
}, extra || {});

test('Campaign_Rules / Payroll_Ledger / Learning_Log headers match the spec', () => {
  assert.deepEqual(Core.CAMPAIGN_RULE_FIELDS, [
    'Campaign_ID', 'Active_Flag', 'Gross_Agency_Rev_Default', 'Rep_Base_Comm',
    'Certified_Bonus_Comm', 'Pod_Lead_Override', 'Clawback_Days', 'Hold_Back_Pct',
    'Tier_Overrides_JSON'
  ]);
  assert.deepEqual(Core.PAYROLL_LEDGER_COLUMNS, [
    'Order_ID', 'Campaign_ID', 'Rep_Name', 'Install_Date', 'Cancel_Date',
    'Carrier_Payout_Cleared', 'Base_Comm', 'Certified_Bonus', 'Override_Comm',
    'Clawback_Deduction', 'Hold_Back_Amt', 'Net_Order_Payout', 'Payout_Eligible',
    'Hold_Reason'
  ]);
  assert.deepEqual(Core.LEARNING_LOG_COLUMNS, [
    'Timestamp', 'Source_Module', 'Entity_ID', 'Before_Value', 'After_Value',
    'Pattern_Tag', 'Applied_To_Rules'
  ]);
  assert.deepEqual(Core.LEARNING_SOURCE_MODULES, ['QUEUE_EDIT', 'PAYROLL_PATCH', 'RULE_UPDATE', 'FEED_IMPORT', 'ENTITY_LINK', 'QUEUE_VOICE_EDIT', 'QUEUE_SOP_RULE']);
});

test('PATCH_CAMPAIGN_RULES is Owner-only', () => {
  const patch = { campaignId: 'FIDIUM', patch: { Active_Flag: 'Y' } };
  for (const role of ['Admin', 'Manager', 'Rep']) {
    assert.equal(Core.checkCampaignPatch({ role }, patch).status, 403);
    assert.equal(Core.checkCampaignPatch({ role }, patch).error, 'owner_only');
    assert.ok(!Core.checkCampaignPatch({ role }, patch).updates);
  }
  assert.equal(Core.checkCampaignPatch(null, patch).status, 403);
});

test('PATCH_CAMPAIGN_RULES allowlist, aliases, and blank-untouched validation', () => {
  const ok = Core.checkCampaignPatch(OWNER, {
    campaignId: 'FIDIUM',
    patch: { Active_Flag: 'y', clawback_window_days: '60', Rep_Base_Comm: '$50.00' }
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.campaignId, 'FIDIUM');
  assert.deepEqual(ok.updates, { Active_Flag: 'Y', Clawback_Days: 60, Rep_Base_Comm: 50 });

  const blanks = Core.checkCampaignPatch(OWNER, {
    Campaign_ID: 'FIDIUM',
    patch: { Rep_Base_Comm: '', Hold_Back_Pct: '  ', Gross_Agency_Rev_Default: null, Active_Flag: 'N' }
  });
  assert.equal(blanks.ok, true);
  assert.deepEqual(blanks.updates, { Active_Flag: 'N' });

  assert.equal(Core.checkCampaignPatch(OWNER, { campaignId: 'FIDIUM', patch: {} }).error, 'no_updates');
  assert.equal(Core.checkCampaignPatch(OWNER, { patch: { Active_Flag: 'Y' } }).error, 'missing_campaign_id');
  assert.equal(Core.checkCampaignPatch(OWNER, { campaignId: 'bad id', patch: { Active_Flag: 'Y' } }).error, 'bad_campaign_id');
  assert.equal(Core.checkCampaignPatch(OWNER, { campaignId: 'FIDIUM', patch: { Active_Flag: 'YES' } }).error, 'bad_active_flag');
  assert.equal(Core.checkCampaignPatch(OWNER, { campaignId: 'FIDIUM', patch: { Rep_Base_Comm: -1 } }).error, 'bad_currency');
  assert.equal(Core.checkCampaignPatch(OWNER, { campaignId: 'FIDIUM', patch: { Clawback_Days: 1.5 } }).error, 'bad_clawback_days');
  assert.equal(Core.checkCampaignPatch(OWNER, { campaignId: 'FIDIUM', patch: { Hold_Back_Pct: 101 } }).error, 'bad_hold_back_pct');
  assert.equal(Core.checkCampaignPatch(OWNER, { campaignId: 'FIDIUM', patch: { Tier_Overrides_JSON: '{not-json' } }).error, 'bad_tier_overrides_json');
  const unknown = Core.checkCampaignPatch(OWNER, { campaignId: 'FIDIUM', patch: { Secret_Margin: 99 } });
  assert.equal(unknown.error, 'unknown_field');
  assert.deepEqual(unknown.detail, ['Secret_Margin']);

  const tier = Core.checkCampaignPatch(OWNER, {
    campaignId: 'FIDIUM',
    patch: { Tier_Overrides_JSON: '{"2Gig": 250}' }
  });
  assert.equal(tier.ok, true);
  assert.equal(tier.updates.Tier_Overrides_JSON, '{"2Gig":250}');
});

test('campaignRuleDiff ignores unchanged values and serializes only the delta', () => {
  const before = { Campaign_ID: 'FIDIUM', Active_Flag: 'Y', Rep_Base_Comm: '', Clawback_Days: 90 };
  const diff = Core.campaignRuleDiff(before, { Active_Flag: 'Y', Clawback_Days: 60, Rep_Base_Comm: 50 });
  assert.deepEqual(diff.fields, ['Clawback_Days', 'Rep_Base_Comm']);
  assert.equal(JSON.parse(diff.beforeValue).Clawback_Days, 90);
  assert.equal(JSON.parse(diff.afterValue).Rep_Base_Comm, 50);
  assert.equal(Core.campaignRuleDiff(before, { Active_Flag: 'Y' }), null);
});

test('queueDraftDiff logs only provided human edits, not auto sign-off', () => {
  const row = qrow();
  assert.equal(Core.queueDraftDiff(row, { confirm: true }), null);
  assert.equal(Core.queueDraftDiff(row, { editedSubject: 'Follow up' }), null);
  const diff = Core.queueDraftDiff(row, { editedSubject: 'New subj', editedBody: 'Hi Riley — edited' });
  assert.deepEqual(diff.fields, ['Draft_Subject', 'Draft_Body']);
  assert.equal(JSON.parse(diff.beforeValue).Draft_Subject, 'Follow up');
  assert.equal(JSON.parse(diff.afterValue).Draft_Body, 'Hi Riley — edited');
  assert.equal(diff.patternTag, 'QUEUE_DRAFT:Draft_Subject,Draft_Body');
  // UPDATE_QUEUE_STATUS-style params with no draft edits produce no log
  assert.equal(Core.queueDraftDiff(row, { newStatus: 'SNOOZED' }), null);
});

test('buildLearningLogRow enforces source modules and Y/N applied flag', () => {
  const row = Core.buildLearningLogRow({
    timestamp: '2026-11-12T17:00:00-05:00',
    sourceModule: 'RULE_UPDATE',
    entityId: 'FIDIUM',
    beforeValue: '{"Clawback_Days":90}',
    afterValue: '{"Clawback_Days":60}',
    patternTag: 'Clawback_Days',
    appliedToRules: true
  });
  assert.deepEqual(row, {
    Timestamp: '2026-11-12T17:00:00-05:00',
    Source_Module: 'RULE_UPDATE',
    Entity_ID: 'FIDIUM',
    Before_Value: '{"Clawback_Days":90}',
    After_Value: '{"Clawback_Days":60}',
    Pattern_Tag: 'Clawback_Days',
    Applied_To_Rules: 'Y'
  });
  assert.equal(Core.buildLearningLogRow({ sourceModule: 'QUEUE_EDIT', appliedToRules: false }).Applied_To_Rules, 'N');
  assert.equal(Core.buildLearningLogRow({ sourceModule: 'NOT_A_MODULE' }).Source_Module, '');
});

test('Dashboard payloads never include Campaign_Rules or Learning_Log data', () => {
  const DEMO = require('../docs/demo-data.js');
  const raw = JSON.parse(JSON.stringify(DEMO.raw));
  raw.campaignRules = [{ Campaign_ID: 'FIDIUM', Rep_Base_Comm: 24680, Gross_Agency_Rev_Default: 13579, Tier_Overrides_JSON: '{"SENTINEL_TIER":1}' }];
  raw.learningLog = [{ Entity_ID: 'FIDIUM', After_Value: 'RATE-SENTINEL-FIDIUM' }];
  function walk(v, keys, strings) {
    if (Array.isArray(v)) v.forEach((x) => walk(x, keys, strings));
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) { keys.add(k); walk(v[k], keys, strings); }
    else if (typeof v === 'string' || typeof v === 'number') strings.push(String(v).toLowerCase());
  }
  for (const email of ['owner@demo.example', 'admin@demo.example', 'manager@demo.example', 'rep@demo.example']) {
    const body = Core.buildPayload(email, raw, DEMO.TODAY).body;
    const keys = new Set(), strings = [];
    walk(body, keys, strings);
    for (const k of ['campaignRules', 'Campaign_Rules', 'learningLog', 'Learning_Log', 'Tier_Overrides_JSON']) {
      assert.ok(!keys.has(k), `${email} payload has ${k}`);
    }
    const json = JSON.stringify(body);
    assert.ok(!json.includes('24680') && !json.includes('13579') && !json.includes('RATE-SENTINEL-FIDIUM') && !json.includes('SENTINEL_TIER'),
      `${email} payload leaked a campaign rate`);
  }
});

test('Code.js routes PATCH_CAMPAIGN_RULES after auth; Rules.js busts the boot cache', () => {
  const code = fs.readFileSync(path.join(__dirname, '../apps-script/Code.js'), 'utf8');
  const findAt = code.indexOf('var user = DoorwayCore.findUser');
  const patchAt = code.indexOf("if (action === 'PATCH_CAMPAIGN_RULES')");
  const queueAt = code.indexOf('handleQueueAction_(');
  assert.ok(findAt > 0 && patchAt > findAt, 'auth must run before PATCH_CAMPAIGN_RULES');
  assert.ok(queueAt > patchAt, 'queue router stays after the campaign patch route');
  assert.match(code, /if \(!idToken\) return json_\(\{ status: 401, error: 'missing_token' \}\)/);
  assert.match(code, /Campaign rates are never added to the boot payload/);

  const rules = fs.readFileSync(path.join(__dirname, '../apps-script/Rules.js'), 'utf8');
  assert.match(rules, /function handleCampaignPatch_/);
  assert.match(rules, /bustBootCache_\(\)/);
  assert.match(rules, /sourceModule: 'RULE_UPDATE'/);
  assert.match(rules, /logLearningSafe_/);
  assert.ok(!/IMPORT_RAW_FEED/.test(rules), 'IMPORT_RAW_FEED is out of scope');

  const scopes = JSON.parse(fs.readFileSync(path.join(__dirname, '../apps-script/appsscript.json'), 'utf8'));
  assert.deepEqual(scopes.oauthScopes, [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/script.external_request',
    'https://mail.google.com/',
    'https://www.googleapis.com/auth/script.scriptapp'
  ]);

  const claspignore = fs.readFileSync(path.join(__dirname, '../apps-script/.claspignore'), 'utf8');
  assert.match(claspignore, /^!Rules\.js$/m);

  const queue = fs.readFileSync(path.join(__dirname, '../apps-script/Queue.js'), 'utf8');
  const sendOk = queue.indexOf("return { status: 200, queueId: queueId, sent: true");
  const logAt = queue.indexOf("sourceModule: 'QUEUE_EDIT'");
  assert.ok(logAt > 0 && logAt < sendOk, 'QUEUE_EDIT is logged only after a successful send');
  assert.match(queue, /logLearningSafe_/);
  // Failed send must still revert without writing a learning row in that path
  const failAt = queue.indexOf("error: 'send_failed'");
  const failBlock = queue.slice(queue.indexOf('send failed'), failAt);
  assert.ok(!/logLearningSafe_|QUEUE_EDIT/.test(failBlock), 'failed send must not write Learning_Log');
});
