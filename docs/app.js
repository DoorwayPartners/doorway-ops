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
  function collapseList(rows, render, none, limit) {
    limit = limit == null ? 5 : limit;
    var wrap = el('div', { class: 'clist' });
    var expanded = false;
    function draw() {
      wrap.textContent = '';
      var rowsArr = rows || [];
      var slice = expanded ? rowsArr : rowsArr.slice(0, limit);
      wrap.appendChild(list(slice, render, none));
      if (rowsArr.length > limit) {
        wrap.appendChild(el('button', {
          type: 'button',
          class: 'btn line clist-toggle',
          text: expanded ? 'Show top ' + limit : 'View all (' + rowsArr.length + ')',
          onclick: function () { expanded = !expanded; draw(); }
        }));
      }
    }
    draw();
    return wrap;
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
  function dashGrid(kids) { return el('div', { class: 'dash-grid' }, kids); }

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
      collapseList(rows, function (r) {
        return [el('div', { class: 'li-main' }, [
          el('div', { class: 'row-between' }, [el('span', { text: r.rep }), el('span', { class: 'small', text: r.deals + ' / ' + r.target })]),
          bar(r.pacePct),
          el('div', { class: 'muted small', text: r.installs + ' installed · ' + r.pending + ' pending' + (r.greenLight === false ? ' · compliance hold' : '') })
        ])];
      }, 'No reps yet.')
    ]);
  }
  function missingCard(rows, showAddress) {
    return card('Missing orders (2-report rule)', [collapseList(rows, function (m) {
      var where = showAddress && m.Address ? m.Address + ', ' + (m.City || '') : (m.City || 'Unknown town');
      return line(where, (m['SR assigned to'] || '') + ' · ' + (m['SR status'] || '') + ' · since ' + (m['SR status date (Date Updated, ET)'] || ''), (m['Reports since pin'] || '?') + ' reports', 'bad');
    }, 'No missing orders.')]);
  }
  function day14Card(rows) {
    return card('Day-14 first-bill check-ins', [collapseList(rows, function (d) {
      var who = d.Customer_Name ? d.Customer_Name + ' · ' : '';
      return line(who + (d.Service_Address || d.City || ''), d.Rep_Name + ' · installed ' + d.Install_Date, d.Day14_Date, 'warn');
    }, 'No check-ins due today.')]);
  }
  function permitsCard(rows, title) {
    return card(title || 'Permits & knock hours', [collapseList(rows, function (p) {
      var exp = p.Days_To_Expiry !== '' && p.Days_To_Expiry != null ? 'expires in ' + p.Days_To_Expiry + 'd' : '';
      var tone = String(p.Status).toLowerCase().indexOf('unknown') === 0 ? 'warn' : (p.Expiring_14d === 'Y' ? 'bad' : 'good');
      return line(p.Town + ', ' + p.State, [p.Allowed_Knock_Hours ? 'Knock ' + p.Allowed_Knock_Hours : 'Knock hours unknown', p.Civil_Dusk_Cutoff ? 'dusk ' + p.Civil_Dusk_Cutoff : '', exp].filter(Boolean).join(' · '), p.Expiring_14d === 'Y' ? 'Renew soon' : (p.Status || '—'), tone);
    }, 'No towns on file.')]);
  }
  function walletCard(w, rules, title) {
    return card(title || 'My wallet', [
      grid([stat('Pending', usd(w.pending.amount), w.pending.count + ' orders'), stat('Installed', usd(w.installed.amount), w.installed.count + ' awaiting carrier', 'warn'), stat('Cleared', usd(w.cleared.amount), w.cleared.count + ' payable', 'good')], 3),
      el('h4', { text: 'Clawback countdown (' + rules.clawbackDays + ' days from install)' }),
      collapseList(w.clawbackWatch, function (c) { return line(c.Order_ID, 'installed ' + c.Install_Date, c.daysLeft + 'd left', c.daysLeft <= 30 ? 'warn' : ''); }, 'No installed orders in the clawback window.')
    ]);
  }

  // ---------- role screens ----------
  function renderMoney(d) {
    var f = d.financials;
    var kids = [
      pipelineCard(d.pipeline),
      card('Money (month to date)', [
        grid([stat('Net spread · cleared', usd(f.netSpreadCleared), null, 'good'), stat('Expenses', usd(f.expensesMTD), null, 'bad'), stat('Net after expenses', usd(f.netAfterExpensesCleared), 'cleared only', f.netAfterExpensesCleared >= 0 ? 'good' : 'bad')], 3),
        el('p', { class: 'muted small', text: 'Installed (not yet cleared) spread: ' + usd(f.netSpreadInstalled) + ' · gross on installed: ' + usd(f.grossAgencyRevInstalled) })
      ]),
      card('Exceptions & holds', [
        collapseList(d.exceptions, function (e) { return line(e.Order_ID + ' · ' + e.Rep_Name, e.Customer_Name + ' · ' + e.C2C_Status, e.Exception_Reason, 'bad'); }, 'No payroll exceptions.'),
        el('h4', { text: 'Compliance holds (' + d.holds.length + ')' }),
        collapseList(d.holds, function (h) { return line(h.rep, 'Missing: ' + (h.missing.join(', ') || '—'), 'HOLD', 'bad'); }, 'Everyone is green.')
      ])
    ];
    if (!d.capabilities.canReleasePayouts) kids.unshift(el('div', { class: 'note', text: 'Admin view: full visibility. Payout release is Owner-only.' }));
    return kids;
  }
  function renderTeam(d) {
    return [leaderboardCard('Pace leaderboard', d.leaderboard, d.rules)];
  }
  function renderField(d) {
    return [
      missingCard(d.missingOrders, true),
      day14Card(d.day14),
      permitsCard(d.permits.filter(function (p) { return p.Expiring_14d === 'Y' || /unknown/i.test(p.Status); }), 'Permits: expiring ≤14d or unknown')
    ];
  }
  function renderExec(d) {
    return renderMoney(d).concat(renderTeam(d), renderField(d));
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
      card('My scorecard', [collapseList(d.scorecard, function (s) {
        return line(s.Date + ' · graded by ' + s.Grader, 'Approach ' + s.Approach_Tonality + ' · Rebuttal ' + s.Rebuttal_Composure + ' · Pin/Dusk ' + s.Pin_Note_Dusk + ' · RepCard ' + s['RepCard_Send_Rate %'], s.Roleplay_Pass === 'Y' ? 'PASS' : 'RETRY', s.Roleplay_Pass === 'Y' ? 'good' : 'warn');
      }, 'No scorecards yet.')])
    ].filter(Boolean);
  }

  // ---------- V2/V3: Owner Priority Queue (Owner role only) ----------
  var view = 'queue'; // Owner default landing tab
  var lastDash = null;
  var lastQueue = null; // { items, counts } from GET_QUEUE — never taken from the dashboard payload
  var queueFilter = 'all';
  var PRI_TONE = { 'P1-URGENT': 'bad', 'P2-OPS': 'warn', 'P3-ADMIN': 'info' };
  var PRI_LABEL = { 'P1-URGENT': 'P1 Urgent', 'P2-OPS': 'P2 Field Ops', 'P3-ADMIN': 'P3 Admin' };

  function apiPost(payload) {
    payload.idToken = idToken;
    return fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow', credentials: 'omit' })
      .then(function (r) { return r.json(); });
  }
  // Demo mode runs the same server-side checks (DoorwayCore) against fake rows; nothing is sent.
  function demoQueueAction(p) {
    var rows = DOORWAY_DEMO.raw.queue, row = null;
    if (p.action === 'GET_QUEUE') { var q = DoorwayCore.buildQueue(rows); q.status = 200; return q; }
    for (var i = 0; i < rows.length; i++) if (rows[i].Queue_ID === p.queueId) row = rows[i];
    var chk = DoorwayCore.checkQueueAction({ role: 'Owner' }, p.action, row, p);
    if (!chk.ok) return { status: chk.status, error: chk.error, carrier: chk.carrier };
    if (p.action === 'UPDATE_QUEUE_STATUS') { row.Status = chk.newStatus; return { status: 200, newStatus: chk.newStatus }; }
    row.Status = 'APPROVED_SENT';
    return { status: 200, sent: true, demo: true, to: chk.send.to };
  }
  function queueApi(payload) { return DEMO ? Promise.resolve(demoQueueAction(payload)) : apiPost(payload); }

  function toast(text, tone) {
    var t = el('div', { class: 'toast ' + (tone || ''), text: text });
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3500);
  }

  function prettyCat(c) { return String(c || '').replace(/_/g, ' '); }
  function matchFilter(it) {
    if (queueFilter === 'all') return true;
    if (queueFilter === 'p1') return it.Priority === 'P1-URGENT';
    if (queueFilter === 'escalations') return /escalat/i.test(it.Category || '');
    if (queueFilter === 'recruiting') return /recruit/i.test(it.Category || '');
    return true;
  }
  function loadQueue() {
    return queueApi({ action: 'GET_QUEUE' }).then(function (q) {
      if (q.status === 200) {
        lastQueue = q;
        updateHudP1(q.counts.p1);
        updateQueueBadge(q.counts.total);
      }
      return q;
    });
  }
  function updateHudP1(n) {
    var node = document.getElementById('hud-p1');
    if (node) node.textContent = String(n);
  }
  function updateQueueBadge(n) {
    var node = document.getElementById('queue-tab-label');
    if (node) node.textContent = 'Queue (' + n + ')';
  }
  function hudTile(label, value, tone, valueId) {
    var v = el('div', { class: 'hud-v', text: String(value) });
    if (valueId) v.id = valueId;
    return el('div', { class: 'hud-tile ' + (tone || '') }, [v, el('div', { class: 'hud-l', text: label })]);
  }
  function mountHud(d) {
    var host = document.getElementById('hud-host');
    if (!host) return;
    host.textContent = '';
    if (!d || (d.role !== 'Owner' && d.role !== 'Admin')) {
      host.classList.add('hidden');
      return;
    }
    host.classList.remove('hidden');
    var f = d.financials || {};
    var p = d.pipeline || {};
    var holds = ((d.exceptions && d.exceptions.length) || 0) + ((d.holds && d.holds.length) || 0);
    var p1 = (d.role === 'Owner' && lastQueue && lastQueue.counts) ? String(lastQueue.counts.p1) : '—';
    var pipe = (p.installed != null ? p.installed : '—') + ' / ' + (p.written != null ? p.written : '—');
    host.appendChild(el('div', { class: 'hud-strip' }, [
      hudTile('P1 Urgent', p1, p1 !== '—' && Number(p1) > 0 ? 'bad' : '', d.role === 'Owner' ? 'hud-p1' : null),
      hudTile('Net Spread (Cleared)', usd(f.netSpreadCleared), 'good'),
      hudTile('Installed / Pipeline', pipe, ''),
      hudTile('Exceptions & Holds', holds, holds ? 'bad' : 'good')
    ]));
  }

  function viewTabs() {
    function b(label, v, labelId) {
      var attrs = { type: 'button', class: 'vtab' + (view === v ? ' active' : ''), text: label, onclick: function () { view = v; render(lastDash); } };
      var n = el('button', attrs);
      if (labelId) n.id = labelId;
      return n;
    }
    var qn = lastQueue && lastQueue.counts ? lastQueue.counts.total : '…';
    return el('div', { class: 'subtabs' }, [
      b('Queue (' + qn + ')', 'queue', 'queue-tab-label'),
      b('Money & Exceptions', 'money'),
      b('Team Pace', 'team'),
      b('Field & Permits', 'field')
    ]);
  }
  function filterPills(onChange) {
    function b(label, key) {
      return el('button', { type: 'button', class: queueFilter === key ? 'active' : '', text: label, onclick: function () { queueFilter = key; onChange(); } });
    }
    return el('div', { class: 'filter-pills' }, [
      b('All', 'all'), b('P1 Urgent', 'p1'), b('Escalations', 'escalations'), b('Recruiting', 'recruiting')
    ]);
  }
  function renderQueueView() {
    var box = el('div', { class: 'qwrap' }, [card('Loading queue…', [el('div', { class: 'skeleton' })])]);
    main.appendChild(box);
    function paint(q) {
      box.textContent = '';
      if (q.status !== 200) { box.appendChild(card('Queue unavailable', [el('p', { class: 'muted', text: 'Could not load the queue (' + (q.error || q.status) + ').' })])); return; }
      box.appendChild(filterPills(function () { paint(q); }));
      var items = q.items.filter(matchFilter);
      if (!items.length) { box.appendChild(card(null, [empty('Nothing waiting for approval.')], 'center')); return; }
      items.forEach(function (it) { box.appendChild(queueRow(it)); });
    }
    if (lastQueue && lastQueue.status === 200) paint(lastQueue);
    loadQueue().then(function (q) { paint(q); }).catch(function () {
      box.textContent = '';
      box.appendChild(card('Connection problem', [el('p', { class: 'muted', text: 'Could not reach the Doorway Ops server.' })]));
    });
  }
  function field(label, node) { return el('label', { class: 'field' }, [el('span', { class: 'small muted', text: label }), node]); }
  function queueRow(it) {
    var editing = false;
    var open = it.Priority === 'P1-URGENT';
    var inTo = el('input', { type: 'email', multiple: 'multiple', value: it.Draft_To || '' });
    var inCc = el('input', { type: 'text', value: it.Draft_Cc || '' });
    var inSubj = el('input', { type: 'text', value: it.Draft_Subject || '' });
    var inBody = el('textarea', { rows: '8' }); inBody.value = it.Draft_Body || '';
    var editBox = el('div', { class: 'editbox hidden' }, [field('To', inTo), field('Cc', inCc), field('Subject', inSubj), field('Body', inBody)]);
    var msg = el('p', { class: 'small hidden' });
    var carrierPill = el('span', { class: 'pill bad' + (it.carrierConfirmRequired ? '' : ' hidden'), text: 'Carrier recipient · double confirm' });
    var btnSend = el('button', { type: 'button', class: 'btn primary', text: 'Approve & Send' });
    var btnEdit = el('button', { type: 'button', class: 'btn line', text: 'Edit Draft' });
    var btnSnooze = el('button', { type: 'button', class: 'btn line', text: 'Snooze' });
    var btnDismiss = el('button', { type: 'button', class: 'btn line', text: 'Dismiss' });
    var buttons = [btnSend, btnEdit, btnSnooze, btnDismiss];
    var snippet = [it.Rep_Or_Sender || '', prettyCat(it.Category), it.Context_Summary || ''].filter(Boolean).join(' · ');
    var head = el('button', { type: 'button', class: 'qrow-head' }, [
      el('span', { class: 'pill ' + (PRI_TONE[it.Priority] || ''), text: PRI_LABEL[it.Priority] || it.Priority || '—' }),
      el('span', { class: 'qrow-title', text: snippet }),
      el('span', { class: 'qrow-chevron', text: '▾' })
    ]);
    var body = el('div', { class: 'qrow-body' }, [
      el('div', { class: 'qfrom', text: it.Rep_Or_Sender || '' }),
      el('p', { class: 'small', text: it.Context_Summary || '' }),
      el('div', { class: 'small muted', text: 'To: ' + (it.Draft_To || '— (add in Edit Draft)') + (it.Draft_Cc ? ' · Cc: ' + it.Draft_Cc : '') }),
      carrierPill,
      el('details', null, [el('summary', { class: 'small', text: 'Draft: ' + (it.Draft_Subject || '(no subject)') }), el('div', { class: 'pre small', text: it.Draft_Body || '(no draft yet)' })]),
      editBox, msg,
      el('div', { class: 'actions' }, buttons)
    ]);
    var node = el('section', { class: 'card qrow qcard' + (open ? ' open' : '') }, [
      head,
      el('div', { class: 'qrow-body-wrap' }, [body])
    ]);
    if (!open) body.classList.add('hidden');
    head.addEventListener('click', function () {
      open = !open;
      node.classList.toggle('open', open);
      body.classList.toggle('hidden', !open);
    });
    function busy(on) { buttons.forEach(function (b) { b.disabled = on; }); }
    function say(text, tone) { msg.textContent = text; msg.className = 'small ' + (tone || ''); }
    function done(text) { node.classList.add('gone'); toast(text, 'good'); setTimeout(function () { lastQueue = null; render(lastDash); }, 600); }
    btnEdit.addEventListener('click', function () {
      editing = !editing; editBox.classList.toggle('hidden', !editing); btnEdit.textContent = editing ? 'Cancel edit' : 'Edit Draft';
    });
    btnSend.addEventListener('click', function () {
      var to = editing && inTo.value.trim() ? inTo.value.trim() : (it.Draft_To || '');
      var cc = editing ? inCc.value.trim() : (it.Draft_Cc || '');
      var subj = editing && inSubj.value.trim() ? inSubj.value.trim() : (it.Draft_Subject || '');
      if (!to) return say('Add a recipient in Edit Draft first.', 'bad');
      if (!window.confirm('Send this email now from Cristian@doorwaypartners.com?\n\nTo: ' + to + (cc ? '\nCc: ' + cc : '') + '\nSubject: ' + subj)) return;
      var payload = { action: 'APPROVE_AND_SEND', queueId: it.Queue_ID, confirm: true };
      if (editing) { payload.editedTo = inTo.value; payload.editedCc = inCc.value; payload.editedSubject = inSubj.value; payload.editedBody = inBody.value; }
      var carrier = DoorwayCore.carrierRecipients(to, cc);
      if (carrier.length) {
        if (!window.confirm('CARRIER RECIPIENT: ' + carrier.join(', ') + '\n\nThis email goes to a carrier. Tap OK again only if you are sure.')) return;
        payload.confirmCarrier = true;
      }
      busy(true); say('Sending…');
      queueApi(payload).then(function (r) {
        if (r.status === 200) return done((r.demo ? 'Demo: would send to ' : 'Sent to ') + (r.to || to));
        busy(false);
        if (r.status === 428) return say('Carrier recipient needs the second confirm. Nothing was sent.', 'bad');
        if (r.status === 409) return say('Already handled. Nothing was sent again.', 'bad');
        say('Not sent (' + (r.error || r.status) + ').', 'bad');
      }).catch(function () { busy(false); say('Connection problem. Not confirmed as sent; reload before retrying.', 'bad'); });
    });
    function setStatus(ns, verb) {
      busy(true);
      queueApi({ action: 'UPDATE_QUEUE_STATUS', queueId: it.Queue_ID, newStatus: ns }).then(function (r) {
        if (r.status === 200) return done(verb);
        busy(false); say('Could not update (' + (r.error || r.status) + ').', 'bad');
      }).catch(function () { busy(false); say('Connection problem.', 'bad'); });
    }
    btnSnooze.addEventListener('click', function () { setStatus('SNOOZED', 'Snoozed'); });
    btnDismiss.addEventListener('click', function () { if (window.confirm('Dismiss this item?')) setStatus('DISMISSED', 'Dismissed'); });
    return node;
  }

  function render(d) {
    lastDash = d;
    main.textContent = '';
    document.getElementById('whoami').textContent = d.me.name + ' · ' + d.role + ' · as of ' + d.asOf;
    mountHud(d);
    if (d.role === 'Owner') { // queue tab exists for the Owner role only; the API enforces it too
      main.appendChild(viewTabs());
      if (view === 'queue') return renderQueueView();
      var ownerKids = view === 'team' ? renderTeam(d) : view === 'field' ? renderField(d) : renderMoney(d);
      main.appendChild(dashGrid(ownerKids));
      if (view !== 'queue') loadQueue().catch(function () {});
      return;
    }
    var kids = d.role === 'Rep' ? renderRep(d) : d.role === 'Manager' ? renderManager(d) : renderExec(d);
    if (d.role === 'Admin') main.appendChild(dashGrid(kids));
    else kids.forEach(function (k) { main.appendChild(k); });
  }
  function showError(title, msg) {
    main.textContent = '';
    mountHud(null);
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
