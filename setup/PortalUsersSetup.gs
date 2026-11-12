/**
 * ONE-TIME, MANUAL setup helper. NOT part of the deployed web app (which only
 * has the read-only Sheets scope). Paste into a throwaway Apps Script project,
 * set PAYROLL_SHEET_ID there, and run once — or create the tab by hand per DEPLOY.md.
 *
 * createPortalUsersTab(): adds a 'Portal_Users' tab to the Payroll Master
 * (PAYROLL_SHEET_ID script property) with headers + validation, and seeds the
 * Owner row. It REFUSES to run if the tab already exists. Run it from the
 * Apps Script editor (Run > createPortalUsersTab) only after Cristian approves.
 */
var PORTAL_USERS_HEADERS = ['Email', 'Name', 'Role', 'Manager_Name', 'Active', 'Assigned_Towns', 'Notes'];

function createPortalUsersTab() {
  var id = PropertiesService.getScriptProperties().getProperty('PAYROLL_SHEET_ID');
  if (!id) throw new Error('Set the PAYROLL_SHEET_ID script property first.');
  var ss = SpreadsheetApp.openById(id);
  if (ss.getSheetByName('Portal_Users')) throw new Error('Portal_Users already exists — not touching it.');
  var sh = ss.insertSheet('Portal_Users');
  sh.getRange(1, 1, 1, PORTAL_USERS_HEADERS.length).setValues([PORTAL_USERS_HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange(2, 1, 1, 7).setValues([[
    'cristian@doorwaypartners.com', 'Cristian Coy', 'Owner', '', true, '', 'Owner — full access incl. payout release'
  ]]);
  var roles = SpreadsheetApp.newDataValidation().requireValueInList(['Owner', 'Admin', 'Manager', 'Rep'], true).build();
  sh.getRange('C2:C500').setDataValidation(roles);
  sh.getRange('E2:E500').insertCheckboxes();
  sh.getRange('A1').setNote('Google account email the person signs in with. Unknown or unchecked Active = 403.');
  sh.getRange('B1').setNote('Must match Rep_Name in Order_Ledger / Compliance_Tracker exactly (case-insensitive).');
  sh.getRange('D1').setNote('For Reps: their Manager\'s Name. A Manager sees every Rep whose Manager_Name is them.');
  sh.getRange('F1').setNote('Optional, comma-separated towns for the Rep permit card. Blank = towns from their own orders.');
  return 'Portal_Users created with ' + PORTAL_USERS_HEADERS.join(', ');
}
