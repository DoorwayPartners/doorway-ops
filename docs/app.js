/* Doorway Ops — frontend. Plain JS, no framework. All sheet text is inserted
 * with textContent (never innerHTML) so cell contents cannot inject markup. */
(function () {
  'use strict';
  var CFG = window.DOORWAY_CONFIG || {};
  var params = new URLSearchParams(location.search);
  var DEMO = params.get('demo') === '1';
  var main = document.getElementById('main');
  var idToken = null; // memory only — never stored

  // ---------- DOM helpers ----------
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function usd(n) { n = Number(n) || 0; return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
  function card(title, kids, cls) { return el('section', { class: 'card ' + (cls || '') }, [title ? el('h3', { text: title }) : null].concat(kids)); }
  function stat(label, value, sub, tone) {
    return el('div', { class: 'stat ' + (tone || '') }, [el('div', { class: 'stat-v', text: String(value) }), el('div', { class: 'stat-l', text: label }), sub ? el('div', { class: 'stat-s', text: sub }) : null]);
  }
  function grid(kids, cols) { return el('div', { class: 'grid g' + (cols || kids.length) }, kids); }
  function empty(text) { return el('p', { class: 'muted small', text: text }); }
  function list(rows, render, none) {
    if (!rows || !rows.length) return empty(none || 'Nothing here.');
    return el('ul', { class: 'list' }, rows.map(function (r) { return el('li', null, render(r)); }));
  }
  function line(main, sub, right, tone) {
    return [el('div', { class: 'li-main' }, [el('div', { text: main }), sub ? el('div', { class: 'muted small', text: sub }) : null]),
      right != null ? el('span', { class: 'pill ' + (tone || ''), text: String(right) }) : null];
  }
  function bar(pct, tone) {
    var p = Math.max(0, Math.min(100, pct || 0));
    var fill = el('div', { class: 'bar-fill ' + (tone || (p >= 100 ? 'good' : p >= 50 ? 'warn' : 'bad')) });
    fill.style.width = p + '%'; // CSSOM, allowed by the CSP (inline style attributes are not)
    return el('div', { class: 'bar' }, [fill]);
  }

  // ---------- shared sections ----------
  function pipelineCard(p) {
    return card('Pipeline', [
      el('div', { class: 'funnel' }, [
        stat('Written', p.written), el('div', { class: 'arrow', text: '›' }),
        stat('Installed', p.installed), el('div', { class: 'arrow', text: '›' }),
        stat('Cleared', p.cleared, null, 'good')
      ]),
      el('p', { class: 'muted small', text: p.cancelled + ' cancelled (excluded)' })
    ]);
  }
  function leaderboardCard(title, rows, rules) {
    return card(title, [
      el('p', { class: 'muted small', text: 'Pace target: ' + rules.dealsPerDay + ' deals/day (Mon–Sat) month to date' }),
      list(rows, function (r) {
        return [el('div', { class: 'li-main' }, [
          el('div', { class: 'row-between' }, [el('span', { text: r.rep }), el('span', { class: 'small', text: r.deals + ' / ' + r.target })]),
          bar(r.pacePct),
          el('div', { class: 'muted small', text: r.installs + ' installed · ' + r.pending + ' pending' + (r.greenLight === false ? ' · compliance hold' : '') })
        ])];
      }, 'No reps yet.')
    ]);
  }
  function missingCard(rows, showAddress) {
    return card('Missing orders (2-report rule)', [list(rows, function (m) {
      var where = showAddress && m.Address ? m.Address + ', ' + (m.City || '') : (m.City || 'Unknown town');
      return line(where, (m['SR assigned to'] || '') + ' · ' + (m['SR status'] || '') + ' · since ' + (m['SR status date (Date Updated, ET)'] || ''), (m['Reports since pin'] || '?') + ' reports', 'bad');
    }, 'No missing orders.')]);
  }
  function day14Card(rows) {
    return card('Day-14 first-bill check-ins', [list(rows, function (d) {
      var who = d.Customer_Name ? d.Customer_Name + ' · ' : '';
      return line(who + (d.Service_Address || d.City || ''), d.Rep_Name + ' · installed ' + d.Install_Date, d.Day14_Date, 'warn');
    }, 'No check-ins due today.')]);
  }
  function permitsCard(rows, title) {
    return card(title || 'Permits & knock hours', [list(rows, function (p) {
      var exp = p.Days_To_Expiry !== '' && p.Days_To_Expiry != null ? 'expires in ' + p.Days_To_Expiry + 'd' : '';
      var tone = String(p.Status).toLowerCase().indexOf('unknown') === 0 ? 'warn' : (p.Expiring_14d === 'Y' ? 'bad' : 'good');
      return line(p.Town + ', ' + p.State, [p.Allowed_Knock_Hours ? 'Knock ' + p.Allowed_Knock_Hours : 'Knock hours unknown', p.Civil_Dusk_Cutoff ? 'dusk ' + p.Civil_Dusk_Cutoff : '', exp].filter(Boolean).join(' · '), p.Expiring_14d === 'Y' ? 'Renew soon' : (p.Status || '—'), tone);
    }, 'No towns on file.')]);
  }
  function walletCard(w, rules, title) {
    return card(title || 'My wallet', [
      grid([stat('Pending', usd(w.pending.amount), w.pending.count + ' orders'), stat('Installed', usd(w.installed.amount), w.installed.count + ' awaiting carrier', 'warn'), stat('Cleared', usd(w.cleared.amount), w.cleared.count + ' payable', 'good')], 3),
      el('h4', { text: 'Clawback countdown (' + rules.clawbackDays + ' days from install)' }),
      list(w.clawbackWatch, function (c) { return line(c.Order_ID, 'installed ' + c.Install_Date, c.daysLeft + 'd left', c.daysLeft <= 30 ? 'warn' : ''); }, 'No installed orders in the clawback window.')
    ]);
  }

  // ---------- role screens ----------
  function renderExec(d) {
    var f = d.financials;
    var kids = [
      pipelineCard(d.pipeline),
      card('Money (month to date)', [
        grid([stat('Net spread · cleared', usd(f.netSpreadCleared), null, 'good'), stat('Expenses', usd(f.expensesMTD), null, 'bad'), stat('Net after expenses', usd(f.netAfterExpensesCleared), 'cleared only', f.netAfterExpensesCleared >= 0 ? 'good' : 'bad')], 3),
        el('p', { class: 'muted small', text: 'Installed (not yet cleared) spread: ' + usd(f.netSpreadInstalled) + ' · gross on installed: ' + usd(f.grossAgencyRevInstalled) })
      ]),
      card('Exceptions & holds', [
        list(d.exceptions, function (e) { return line(e.Order_ID + ' · ' + e.Rep_Name, e.Customer_Name + ' · ' + e.C2C_Status, e.Exception_Reason, 'bad'); }, 'No payroll exceptions.'),
        el('h4', { text: 'Compliance holds (' + d.holds.length + ')' }),
        list(d.holds, function (h) { return line(h.rep, 'Missing: ' + (h.missing.join(', ') || '—'), 'HOLD', 'bad'); }, 'Everyone is green.')
      ]),
      leaderboardCard('Pace leaderboard', d.leaderboard, d.rules),
      missingCard(d.missingOrders, true),
      day14Card(d.day14),
      permitsCard(d.permits.filter(function (p) { return p.Expiring_14d === 'Y' || /unknown/i.test(p.Status); }), 'Permits: expiring ≤14d or unknown')
    ];
    if (!d.capabilities.canReleasePayouts) kids.unshift(el('div', { class: 'note', text: 'Admin view: full visibility. Payout release is Owner-only.' }));
    return kids;
  }
  function renderManager(d) {
    return [
      leaderboardCard('Pod scoreboard', d.podScoreboard, d.rules),
      day14Card(d.day14),
      missingCard(d.missingOrders, false),
      walletCard(d.wallet, d.rules, 'My wallet'),
      permitsCard(d.permits)
    ];
  }
  function renderRep(d) {
    var c = d.compliance, t = d.tierProgress;
    return [
      walletCard(d.wallet, d.rules),
      card('Compliance', [
        el('div', { class: 'badge ' + (c.greenLight ? 'good' : 'bad'), text: c.greenLight ? 'GREEN LIGHT — payable' : 'ON HOLD — payouts paused' }),
        c.greenLight ? null : el('p', { class: 'small', text: 'Still needed: ' + c.missing.join(', ') })
      ]),
      card('Tier progress', [
        el('div', { class: 'row-between' }, [el('strong', { text: t.tier }), el('span', { class: 'small', text: t.verifiedInstalls + ' / ' + t.certifiedAt + ' verified installs' })]),
        bar(100 * t.verifiedInstalls / t.certifiedAt, 'good'),
        el('p', { class: 'muted small', text: t.toCertified ? t.toCertified + ' more to Certified Crew Rep · Pod Lead: ' + t.podLeadRule : 'Certified. Pod Lead: ' + t.podLeadRule }),
        el('h4', { text: 'Pace this month' }),
        el('div', { class: 'row-between small' }, [el('span', { text: d.pace.deals + ' deals' }), el('span', { text: 'target ' + d.pace.target })]),
        bar(d.pace.pacePct)
      ]),
      permitsCard(d.permits),
      day14Card(d.day14),
      d.missingOrders.length ? missingCard(d.missingOrders, true) : null,
      card('My scorecard', [list(d.scorecard, function (s) {
        return line(s.Date + ' · graded by ' + s.Grader, 'Approach ' + s.Approach_Tonality + ' · Rebuttal ' + s.Rebuttal_Composure + ' · Pin/Dusk ' + s.Pin_Note_Dusk + ' · RepCard ' + s['RepCard_Send_Rate %'], s.Roleplay_Pass === 'Y' ? 'PASS' : 'RETRY', s.Roleplay_Pass === 'Y' ? 'good' : 'warn');
      }, 'No scorecards yet.')])
    ].filter(Boolean);
  }

  function render(d) {
    main.textContent = '';
    document.getElementById('whoami').textContent = d.me.name + ' · ' + d.role + ' · as of ' + d.asOf;
    var kids = d.role === 'Rep' ? renderRep(d) : d.role === 'Manager' ? renderManager(d) : renderExec(d);
    kids.forEach(function (k) { main.appendChild(k); });
  }
  function showError(title, msg) {
    main.textContent = '';
    main.appendChild(card(title, [el('p', { class: 'muted', text: msg })], 'center'));
  }

  // ---------- live mode ----------
  function onCredential(resp) {
    idToken = resp.credential;
    main.textContent = '';
    main.appendChild(card('Loading…', [el('div', { class: 'skeleton' })]));
    fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ idToken: idToken }), redirect: 'follow', credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.status === 403) return showError('No access', 'This Google account is not on the Doorway Ops access list. Ask Cristian to add you.');
        if (d.status && d.status !== 200) return showError('Sign-in problem', 'Please sign in again. (' + (d.reason || d.error || d.status) + ')');
        document.getElementById('signout').classList.remove('hidden');
        render(d);
      })
      .catch(function () { showError('Connection problem', 'Could not reach the Doorway Ops server. Check your signal and try again.'); });
  }
  function startLive() {
    var msg = document.getElementById('signin-msg');
    if (!CFG.GOOGLE_CLIENT_ID || CFG.GOOGLE_CLIENT_ID.indexOf('REPLACE_') === 0) { msg.textContent = 'Not configured yet. Preview with ?demo=1.'; return; }
    var s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = function () {
      google.accounts.id.initialize({ client_id: CFG.GOOGLE_CLIENT_ID, callback: onCredential, auto_select: false, cancel_on_tap_outside: true });
      google.accounts.id.renderButton(document.getElementById('gsi-button'), { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'signin_with' });
    };
    s.onerror = function () { msg.textContent = 'Could not load Google Sign-In.'; };
    document.head.appendChild(s);
    document.getElementById('signout').addEventListener('click', function () {
      idToken = null;
      if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
      location.reload();
    });
  }

  // ---------- demo mode (fake data, same filtering code as the server) ----------
  function startDemo() {
    var s = document.createElement('script');
    s.src = 'demo-data.js';
    s.onload = function () {
      var role = params.get('role') || 'Owner';
      var banner = document.getElementById('demo-banner');
      banner.classList.remove('hidden');
      banner.appendChild(el('strong', { text: 'DEMO MODE — all names, addresses and amounts are fake.' }));
      var tabs = el('div', { class: 'tabs' }, ['Owner', 'Admin', 'Manager', 'Rep'].map(function (r) {
        return el('a', { class: 'tab' + (r === role ? ' active' : ''), href: '?demo=1&role=' + r, text: r });
      }));
      banner.appendChild(tabs);
      var res = DoorwayCore.buildPayload(DOORWAY_DEMO.emails[role] || DOORWAY_DEMO.emails.Owner, DOORWAY_DEMO.raw, DOORWAY_DEMO.TODAY);
      if (res.status !== 200) return showError('No access', 'Demo user not found.');
      render(res.body);
    };
    document.head.appendChild(s);
  }

  if (DEMO) startDemo(); else startLive();
})();
