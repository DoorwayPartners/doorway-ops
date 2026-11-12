/**
 * DEMO DATA — 100% FAKE. Names, emails, addresses and amounts are invented
 * and do not correspond to real customers or reps. Used by ?demo=1 and tests.
 * Shaped exactly like the raw sheet rows the Apps Script backend reads.
 */
var DOORWAY_DEMO = (function () {
  var TODAY = '2026-11-12';
  var users = [
    { Email: 'owner@demo.example', Name: 'Olivia Owner (Demo)', Role: 'Owner', Manager_Name: '', Active: true },
    { Email: 'admin@demo.example', Name: 'Adam Admin (Demo)', Role: 'Admin', Manager_Name: '', Active: true },
    { Email: 'manager@demo.example', Name: 'Mia Manager (Demo)', Role: 'Manager', Manager_Name: '', Active: true },
    { Email: 'rep@demo.example', Name: 'Riley Rep (Demo)', Role: 'Rep', Manager_Name: 'Mia Manager (Demo)', Active: true, Assigned_Towns: 'Sampleton, Fakeville' },
    { Email: 'rep2@demo.example', Name: 'Parker Pod (Demo)', Role: 'Rep', Manager_Name: 'Mia Manager (Demo)', Active: true },
    { Email: 'outsider@demo.example', Name: 'Oscar Otherpod (Demo)', Role: 'Rep', Manager_Name: 'Nina Northpod (Demo)', Active: true },
    { Email: 'former@demo.example', Name: 'Fran Former (Demo)', Role: 'Rep', Manager_Name: 'Mia Manager (Demo)', Active: false }
  ];
  function o(id, sale, inst, rep, cust, addr, status, cleared, extra) {
    var r = { Order_ID: id, Sale_Date: sale, Install_Date: inst, Cancel_Date: '', Rep_Name: rep,
      Customer_Name: cust, Service_Address: addr, Speed_Tier: '2 Gig', C2C_Status: status,
      Pay_Period: status === 'Installed' ? '2026-11' : '', Previously_Paid: false,
      Base_Comm: '$50.00', Override_Comm: '$0.00', Clawback_Flag: false, Clawback_Deduction: '$0.00',
      Net_Order_Payout: '$50.00', 'Assigned_Manager (helper)': '', 'Override_Clawback (helper)': '$0.00',
      'Exception_Reason (helper)': '', Campaign: 'Fidium', Gross_Agency_Rev: 90, Net_Agency_Spread: '$40.00',
      Carrier_Payout_Cleared: cleared ? 'TRUE' : '', Payout_Eligible: cleared ? 'Y' : 'N' };
    for (var k in (extra || {})) r[k] = extra[k];
    return r;
  }
  var orders = [
    o('DEMO-1001', '2026-11-02', '2026-11-06', 'Riley Rep (Demo)', 'Demo Customer A', '101 Example St, SAMPLETON ME', 'Installed', true),
    o('DEMO-1002', '2026-11-04', '2026-10-29', 'Riley Rep (Demo)', 'Demo Customer B', '202 Placeholder Ave, SAMPLETON ME', 'Installed', false),
    o('DEMO-1003', '2026-11-09', '2026-11-20', 'Riley Rep (Demo)', 'Demo Customer C', '303 Mock Rd, FAKEVILLE ME', 'Pending', false),
    o('DEMO-1004', '2026-11-03', '2026-11-08', 'Parker Pod (Demo)', 'Demo Customer D', '404 Testing Ln, MOCKTON NH', 'Installed', false),
    o('DEMO-1005', '2026-11-10', '2026-11-24', 'Parker Pod (Demo)', 'Demo Customer E', '505 Sample Ct, MOCKTON NH', 'Pending', false),
    o('DEMO-1006', '2026-11-05', '2026-11-09', 'Mia Manager (Demo)', 'Demo Customer F', '606 Dummy Dr, FAKEVILLE ME', 'Installed', true),
    o('DEMO-1007', '2026-11-06', '2026-11-12', 'Oscar Otherpod (Demo)', 'Demo Customer G', '707 Outside Way, ELSEWHERE ME', 'Pending', false),
    o('DEMO-1008', '2026-11-01', '', 'Oscar Otherpod (Demo)', 'Demo Customer H', '808 Elsewhere Blvd, ELSEWHERE ME', 'Cancelled', false, { Cancel_Date: '2026-11-07' }),
    o('DEMO-1009', '2026-11-11', '2026-11-26', 'Riley Rep (Demo)', 'Demo Customer I', '909 Example St, SAMPLETON ME', 'Pending', false, { 'Exception_Reason (helper)': 'COMPLIANCE HOLD' })
  ];
  var compliance = [
    { Rep_Name: 'Riley Rep (Demo)', Manager_Name: 'Mia Manager (Demo)', Certification_Tier: 'Rookie', W9_On_File: 'Y', Contract_1099_Signed: 'Y', NDA_Signed: '', C2C_Portal_Active: 'Y', Compliance_Green_Light: 'FALSE', Verified_Installs: 2, Tier_Eligible: 'Rookie' },
    { Rep_Name: 'Parker Pod (Demo)', Manager_Name: 'Mia Manager (Demo)', Certification_Tier: 'Certified Crew Rep', W9_On_File: 'Y', Contract_1099_Signed: 'Y', NDA_Signed: 'Y', C2C_Portal_Active: 'Y', Compliance_Green_Light: 'TRUE', Verified_Installs: 6, Tier_Eligible: 'Certified Crew Rep' },
    { Rep_Name: 'Mia Manager (Demo)', Manager_Name: '', Certification_Tier: 'Pod Lead', W9_On_File: 'Y', Contract_1099_Signed: 'Y', NDA_Signed: 'Y', C2C_Portal_Active: 'Y', Compliance_Green_Light: 'TRUE', Verified_Installs: 14, Tier_Eligible: 'Pod Lead' },
    { Rep_Name: 'Oscar Otherpod (Demo)', Manager_Name: 'Nina Northpod (Demo)', Certification_Tier: 'Rookie', W9_On_File: '', Contract_1099_Signed: '', NDA_Signed: '', C2C_Portal_Active: '', Compliance_Green_Light: 'FALSE', Verified_Installs: 0, Tier_Eligible: 'Rookie' }
  ];
  var scorecard = [
    { Date: '2026-11-03', Rep: 'Riley Rep (Demo)', Grader: 'Mia Manager (Demo)', Approach_Tonality: 4, Rebuttal_Composure: 3, 'RepCard_Send_Rate %': '100%', Pin_Note_Dusk: 4, Roleplay_Pass: 'Y', Notes: 'Demo note: strong opener' },
    { Date: '2026-11-04', Rep: 'Parker Pod (Demo)', Grader: 'Mia Manager (Demo)', Approach_Tonality: 5, Rebuttal_Composure: 4, 'RepCard_Send_Rate %': '100%', Pin_Note_Dusk: 5, Roleplay_Pass: 'Y', Notes: 'Demo note' },
    { Date: '2026-11-05', Rep: 'Oscar Otherpod (Demo)', Grader: 'Nina Northpod (Demo)', Approach_Tonality: 2, Rebuttal_Composure: 2, 'RepCard_Send_Rate %': '50%', Pin_Note_Dusk: 2, Roleplay_Pass: 'N', Notes: 'Demo note: other pod' }
  ];
  var exceptions = [
    { Order_ID: 'DEMO-1002', Rep_Name: 'Riley Rep (Demo)', Customer_Name: 'Demo Customer B', Service_Address: '202 Placeholder Ave, SAMPLETON ME', Speed_Tier: '2 Gig', C2C_Status: 'Installed', Pay_Period: '2026-11', Exception_Reason: 'Carrier payout not cleared' },
    { Order_ID: 'DEMO-1009', Rep_Name: 'Riley Rep (Demo)', Customer_Name: 'Demo Customer I', Service_Address: '909 Example St, SAMPLETON ME', Speed_Tier: '2 Gig', C2C_Status: 'Pending', Pay_Period: '', Exception_Reason: 'COMPLIANCE HOLD' }
  ];
  var day14 = [
    { Order_ID: 'DEMO-1002', Rep_Name: 'Riley Rep (Demo)', Customer_Name: 'Demo Customer B', Service_Address: '202 Placeholder Ave, SAMPLETON ME', Install_Date: '2026-10-29', Day14_Date: '2026-11-12', Campaign: 'Fidium' },
    { Order_ID: 'DEMO-0990', Rep_Name: 'Oscar Otherpod (Demo)', Customer_Name: 'Demo Customer Z', Service_Address: '999 Outside Way, ELSEWHERE ME', Install_Date: '2026-10-29', Day14_Date: '2026-11-12', Campaign: 'Fidium' }
  ];
  var permits = [
    { Town: 'Sampleton', State: 'ME', Permit_Required: 'Y', Fee: '$25', Turnaround_Days: 3, Badge_Issue_Date: '2026-10-20', Badge_Expiry_Date: '2026-11-20', Allowed_Knock_Hours: '9 AM – 7 PM', Civil_Dusk_Cutoff: '4:36 PM', Status: 'Active', Source_URL: '', Days_To_Expiry: 8, Expiring_14d: 'Y' },
    { Town: 'Fakeville', State: 'ME', Permit_Required: 'N', Fee: '', Turnaround_Days: '', Badge_Issue_Date: '', Badge_Expiry_Date: '', Allowed_Knock_Hours: '10 AM – dusk', Civil_Dusk_Cutoff: '4:38 PM', Status: 'Not required', Source_URL: '', Days_To_Expiry: '', Expiring_14d: '' },
    { Town: 'Elsewhere', State: 'ME', Permit_Required: '', Fee: '', Turnaround_Days: '', Badge_Issue_Date: '', Badge_Expiry_Date: '', Allowed_Knock_Hours: '', Civil_Dusk_Cutoff: '', Status: 'unknown — research', Source_URL: '', Days_To_Expiry: '', Expiring_14d: '' }
  ];
  var phantom = [
    { Market: 'Demo Market', Address: '11 PHANTOM ST', Unit: '', City: 'SAMPLETON', ZIP: '00001', 'SR status': 'Fiber Slap!', 'SR status date (Date Updated, ET)': '2026-11-08 11:00 AM', 'Hours since (at export time)': 78, 'Age flag': '>24h', 'C2C order at address': 'none', 'SR assigned to': 'Riley Rep (Demo)', 'SR rep note': '', 'Reports since pin': 2, 'Business hours since pin': 70, 'Flag method': '2_report_cycles' },
    { Market: 'Demo Market', Address: '22 GHOST RD', Unit: '', City: 'MOCKTON', ZIP: '00002', 'SR status': 'Fiber Slap!', 'SR status date (Date Updated, ET)': '2026-11-07 2:00 PM', 'Hours since (at export time)': 96, 'Age flag': '>24h', 'C2C order at address': 'none', 'SR assigned to': 'Parker Pod (Demo)', 'SR rep note': 'demo note', 'Reports since pin': 3, 'Business hours since pin': 80, 'Flag method': '2_report_cycles' },
    { Market: 'Demo Market', Address: '33 NOWHERE LN', Unit: '', City: 'ELSEWHERE', ZIP: '00003', 'SR status': 'Fiber Slap!', 'SR status date (Date Updated, ET)': '2026-11-06 9:00 AM', 'Hours since (at export time)': 120, 'Age flag': '>24h', 'C2C order at address': 'none', 'SR assigned to': 'Oscar Otherpod (Demo)', 'SR rep note': '', 'Reports since pin': 4, 'Business hours since pin': 90, 'Flag method': '2_report_cycles' }
  ];
  var expenses = [
    { Date: '2026-11-03', Vendor: 'Demo Stays', Category: 'Lodging', 'Trip/Market': 'Demo Market', Amount: '$60.00', Payment_Method: 'Demo card', Source_Email_Id: 'demo', Notes: 'fake' },
    { Date: '2026-11-08', Vendor: 'Demo Fuel', Category: 'Fuel', 'Trip/Market': 'Demo Market', Amount: '$25.00', Payment_Method: 'Demo card', Source_Email_Id: 'demo', Notes: 'fake' }
  ];
  var queue = [
    { Queue_ID: 'Q-20261112-001', Created_At: '2026-11-12T08:05:00', Priority: 'P2-OPS', Category: 'Missed_Install', Source_Thread_ID: 'Order_Ledger!R12', Rep_Or_Sender: 'Riley Rep (Demo) <rep@demo.example>', Context_Summary: 'DEMO-1003 passed its install date yesterday without completion. Check in with the rep before the customer cancels.', Draft_To: 'rep@demo.example', Draft_Cc: '', Draft_Subject: 'DEMO-1003 install follow-up', Draft_Body: 'Hi Riley,\n\nDEMO-1003 passed its install date. Can you check in with the customer today?', Status: 'PENDING', Resolved_At: '' },
    { Queue_ID: 'Q-20261112-002', Created_At: '2026-11-12T09:40:00', Priority: 'P1-URGENT', Category: 'Escalation', Source_Thread_ID: 'demo-thread', Rep_Or_Sender: 'Demo Customer Z (help@)', Context_Summary: 'Customer reports a missed install window. Care was contacted; order DEMO-1009 needs an escalation today.', Draft_To: 'escalations@fidium.example.fidium.com', Draft_Cc: 'office@demo.example', Draft_Subject: 'Escalation: DEMO-1009 missed install', Draft_Body: 'Hello team,\n\nOrder DEMO-1009 missed its install window. Care was contacted. Please advise.', Status: 'PENDING', Resolved_At: '' },
    { Queue_ID: 'Q-20261112-003', Created_At: '2026-11-12T10:15:00', Priority: 'P3-ADMIN', Category: 'Recruit_App', Source_Thread_ID: 'demo-thread-2', Rep_Or_Sender: 'Demo Applicant <applicant@demo.example>', Context_Summary: 'New /join/ application from a demo applicant in Sampleton. Wants interview this week.', Draft_To: 'applicant@demo.example', Draft_Cc: '', Draft_Subject: 'Your Doorway Partners application', Draft_Body: 'Hi,\n\nThanks for applying. Are you free for a 15-minute call tomorrow?', Status: 'PENDING', Resolved_At: '' },
    { Queue_ID: 'Q-20261111-004', Created_At: '2026-11-11T15:00:00', Priority: 'P1-URGENT', Category: 'Escalation', Source_Thread_ID: 'demo-thread-3', Rep_Or_Sender: 'Demo', Context_Summary: 'Already handled.', Draft_To: 'rep@demo.example', Draft_Cc: '', Draft_Subject: 'Done', Draft_Body: 'Done', Status: 'APPROVED_SENT', Resolved_At: '2026-11-11T15:10:00-05:00' }
  ];
  return {
    TODAY: TODAY,
    raw: { users: users, orders: orders, compliance: compliance, scorecard: scorecard, exceptions: exceptions,
      day14: day14, permits: permits, phantom: phantom, expenses: expenses, queue: queue },
    emails: { Owner: 'owner@demo.example', Admin: 'admin@demo.example', Manager: 'manager@demo.example', Rep: 'rep@demo.example' }
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = DOORWAY_DEMO;
