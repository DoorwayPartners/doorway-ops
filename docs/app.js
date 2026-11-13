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
    var daily = (rules && rules.dealsPerDay) || 2;
    var trailingCount = (rows || []).filter(function (r) { return r.trailingPace; }).length;
    return card(title, [
      el('p', { class: 'muted small', text: 'North star: ' + daily + ' deals/day, 10/week. MTD uses Mon–Sat working days.' }),
      trailingCount ? el('p', { class: 'muted small', text: trailingCount + ' rep' + (trailingCount === 1 ? '' : 's') + ' trailing weekly pace — flagged for field shadowing.' }) : null,
      collapseList(rows, function (r) {
        var trail = !!r.trailingPace;
        var weekBit = 'this week ' + (r.dealsWeek != null ? r.dealsWeek : '—') + '/' + (r.weeklyTarget || 10) +
          ' · today ' + (r.dealsToday != null ? r.dealsToday : '—') + '/' + (r.dailyTarget || daily);
        return [el('div', { class: 'li-main' }, [
          el('div', { class: 'row-between' }, [
            el('span', { text: r.rep }),
            trail ? el('span', { class: 'pill bad', text: 'Trailing — shadow' }) : el('span', { class: 'pill good', text: 'On pace' })
          ]),
          bar(r.weekPacePct != null ? r.weekPacePct : r.pacePct, trail ? 'bad' : 'good'),
          el('div', { class: 'muted small', text: weekBit + ' · MTD ' + r.deals + ' / ' + r.target + ' · ' + r.installs + ' installed · ' + r.pending + ' pending' + (r.greenLight === false ? ' · compliance hold' : '') })
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
  var lastQueue = null; // { items, counts, status } from the Owner boot payload or GET_QUEUE
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
    if (p.action === 'INSTRUCT_DRAFT') {
      var ins = DoorwayCore.checkInstructDraft({ role: 'Owner' }, p);
      if (!ins.ok) return { status: ins.status, error: ins.error };
      var applied = DoorwayCore.applyInstructDraft(p);
      if (row) { row.Draft_Body = applied.updatedBody; row.draft_body = applied.updatedBody; }
      return { status: 200, updatedBody: applied.updatedBody, savedRule: applied.saveAsRule, demo: true };
    }
    var chk = DoorwayCore.checkQueueAction({ role: 'Owner' }, p.action, row, p);
    if (!chk.ok) return { status: chk.status, error: chk.error, carrier: chk.carrier };
    if (p.action === 'UPDATE_QUEUE_STATUS') { row.Status = chk.newStatus; return { status: 200, newStatus: chk.newStatus }; }
    var stale = DoorwayCore.checkStaleThread(p, row);
    if (!stale.ok) {
      return { status: 409, reason: stale.reason, error: stale.error, freshSnapshot: {
        thread_context: row.thread_context, thread_timeline: row.thread_timeline || [],
        thread_msg_count: row.thread_msg_count, last_message_id: row.last_message_id, synced_at_et: row.synced_at_et
      } };
    }
    row.Status = 'APPROVED_SENT';
    return { status: 200, sent: true, demo: true, to: chk.send.to };
  }
  function queueApi(payload) { return DEMO ? Promise.resolve(demoQueueAction(payload)) : apiPost(payload); }

  // V3.4 stale-while-revalidate: last authenticated dashboard + queue in localStorage
  // so a new tab can render the last HUD in <150ms, then sync in the background.
  // Key includes the signed-in email + role. Never written in demo mode.
  // Cleared immediately on Sign out, 401/403, and email/role mismatch.
  var BOOT_PREFIX = 'doorway-ops-boot:';
  function bootCacheKey(email, role) {
    return BOOT_PREFIX + String(email || '').trim().toLowerCase() + ':' + String(role || '');
  }
  function sweepBootKeys(store) {
    try {
      var remove = [];
      for (var i = 0; i < store.length; i++) {
        var k = store.key(i);
        if (k && k.indexOf(BOOT_PREFIX) === 0) remove.push(k);
      }
      remove.forEach(function (k) { store.removeItem(k); });
    } catch (e) {}
  }
  function clearBootCache() {
    sweepBootKeys(localStorage);
    sweepBootKeys(sessionStorage);
  }
  function purgeLegacySessionBootCache() {
    sweepBootKeys(sessionStorage);
  }
  function readBootCache(email) {
    if (DEMO || !email) return null;
    var prefix = BOOT_PREFIX + String(email).trim().toLowerCase() + ':';
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf(prefix) !== 0) continue;
        var obj = JSON.parse(localStorage.getItem(k));
        if (obj && obj.status === 200 && obj.me && String(obj.me.email).toLowerCase() === String(email).trim().toLowerCase()) return obj;
        localStorage.removeItem(k);
      }
    } catch (e) {}
    return null;
  }
  function writeBootCache(dash, queue) {
    if (DEMO) return;
    if (!dash || !dash.me || !dash.me.email || !dash.role) return;
    clearBootCache();
    var stored;
    try { stored = JSON.parse(JSON.stringify(dash)); } catch (e) { return; }
    stored.status = stored.status || 200;
    if (dash.role === 'Owner' && queue && queue.status === 200 && queue.items && queue.counts) {
      stored.queue = { status: 200, items: queue.items, counts: queue.counts };
    } else if (dash.role !== 'Owner') {
      delete stored.queue;
    }
    try { localStorage.setItem(bootCacheKey(dash.me.email, dash.role), JSON.stringify(stored)); } catch (e) {}
  }
  function applyBootQueue(d) {
    if (d && d.role === 'Owner' && d.queue && Array.isArray(d.queue.items) && d.queue.counts) {
      lastQueue = { status: 200, items: d.queue.items, counts: d.queue.counts };
      updateHudP1(lastQueue.counts.p1);
      updateQueueBadge(lastQueue.counts.total);
      return true;
    }
    return false;
  }
  function emailFromToken(token) {
    try {
      var parts = String(token || '').split('.');
      if (parts.length !== 3) return '';
      var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      return String(JSON.parse(atob(b64)).email || '').trim().toLowerCase();
    } catch (e) { return ''; }
  }


  function toast(text, tone) {
    var t = el('div', { class: 'toast ' + (tone || ''), text: text });
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3500);
  }
  // 5s undo toast: delays the callback. Undo cancels BEFORE any server call.
  // Never claims to unsend mail that already went out.
  function startUndoCountdown(onSend, onCancel) {
    var remaining = 5, cancelled = false, timer = null;
    var msg = el('span', { class: 'undo-msg', text: 'Sending in 5s…' });
    var btn = el('button', { type: 'button', class: 'undo-btn', text: 'Undo' });
    var node = el('div', { class: 'toast undo-toast', role: 'status' }, [msg, btn]);
    function remove() { if (node.parentNode) node.parentNode.removeChild(node); }
    function tick() {
      if (cancelled) return;
      remaining -= 1;
      if (remaining <= 0) { remove(); onSend(); return; }
      msg.textContent = 'Sending in ' + remaining + 's…';
      timer = setTimeout(tick, 1000);
    }
    btn.addEventListener('click', function () {
      if (cancelled) return;
      cancelled = true;
      if (timer) clearTimeout(timer);
      remove();
      if (onCancel) onCancel();
    });
    document.body.appendChild(node);
    timer = setTimeout(tick, 1000);
    return function abort() {
      if (cancelled) return;
      cancelled = true;
      if (timer) clearTimeout(timer);
      remove();
    };
  }
  function orderIdOf(it) {
    var blob = [it.Draft_Subject, it.draft_subject, it.Context_Summary, it.Draft_Body, it.draft_body].join(' ');
    var m = blob.match(/\b(?:Order\s+)?([A-Z]{2,}[-_]?\d{3,}[A-Z0-9]*)/i);
    return m ? m[1] : '';
  }
  function syncLabel(it) {
    var parts = [];
    if (it.synced_at_et) parts.push('Synced ' + it.synced_at_et);
    if (it.thread_msg_count != null && it.thread_msg_count !== '') {
      var n = Number(it.thread_msg_count);
      parts.push((isFinite(n) ? n : 0) + ' msg' + (n === 1 ? '' : 's'));
    }
    return parts.join(' · ');
  }
  function paintTimeline(host, items) {
    host.textContent = '';
    host.appendChild(el('summary', { text: 'Thread history' }));
    var list = Array.isArray(items) ? items : [];
    if (!list.length) {
      host.appendChild(el('p', { class: 'muted small', text: 'No earlier messages.' }));
      return;
    }
    host.appendChild(el('ol', { class: 'q-timeline-list' }, list.map(function (m) {
      return el('li', { class: 'q-timeline-item' }, [
        el('div', { class: 'q-timeline-meta small muted', text: (m.date_et || '') + ' · ' + (m.from || '') }),
        el('div', { class: 'q-timeline-snip small', text: m.snippet || '' })
      ]);
    })));
  }
  function startDictation(input, say) {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { say('Voice dictation isn’t available in this browser. Type the instruction instead.', 'bad'); return; }
    var rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = function (ev) {
      var text = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) text += ev.results[i][0].transcript;
      if (text) input.value = text.trim();
    };
    rec.onerror = function (ev) {
      if (ev.error === 'not-allowed') say('Microphone permission was denied. You can still type the instruction.', 'bad');
      else if (ev.error !== 'aborted' && ev.error !== 'no-speech') say('Dictation stopped (' + ev.error + ').', 'bad');
    };
    try { rec.start(); } catch (e) { say('Could not start dictation. Type the instruction instead.', 'bad'); }
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
        writeBootCache(lastDash, lastQueue);
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
    if (d.role === 'Owner') {
      host.appendChild(el('div', { class: 'hud-tools' }, [
        el('button', { type: 'button', id: 'drop-csv-pdf', class: 'btn hud-drop', text: '+ Drop CSV / PDF', onclick: openDropDrawer })
      ]));
    }
  }

  function viewTabs() {
    function b(label, v, labelId) {
      var attrs = { type: 'button', class: 'vtab' + (view === v ? ' active' : ''), text: label, onclick: function () { view = v; switchView(VIEW_FOR[v] || 'view-inbox'); render(lastDash); } };
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
    var host = document.getElementById('queue-feed') || main;
    var box = el('div', { class: 'qwrap' }, [card('Loading queue…', [el('div', { class: 'skeleton' })])]);
    host.textContent = '';
    host.appendChild(box);
    function paint(q) {
      box.textContent = '';
      if (q.status !== 200) { box.appendChild(card('Queue unavailable', [el('p', { class: 'muted', text: 'Could not load the queue (' + (q.error || q.status) + ').' })])); return; }
      box.appendChild(filterPills(function () { paint(q); }));
      var items = q.items.filter(matchFilter);
      if (!items.length) { box.appendChild(card(null, [empty('Nothing waiting for approval.')], 'center')); return; }
      items.forEach(function (it) { box.appendChild(queueRow(it)); });
    }
    if (lastQueue && lastQueue.status === 200) { paint(lastQueue); return; }
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
    var subject = it.draft_subject || it.Draft_Subject || '(no subject)';
    var draftBody = it.draft_body || it.Draft_Body || '(no draft yet)';
    var threadCtx = it.thread_context || it.Context_Summary || '';
    var threadBox = threadCtx ? el('div', { class: 'q-thread-box', text: threadCtx }) : null;
    var badgeText = syncLabel(it);
    var syncBadge = el('div', { class: 'q-sync-badge', text: badgeText || '' });
    if (!badgeText) syncBadge.classList.add('hidden');
    var timelineBox = el('details', { class: 'q-timeline' });
    paintTimeline(timelineBox, it.thread_timeline);
    var staleBanner = el('div', { class: 'q-stale-banner hidden' });
    var draftBodyNode = el('div', { class: 'q-draft-body', text: draftBody });
    var draftBox = el('details', { class: 'q-draft-box', open: 'open' }, [
      el('summary', { text: 'Draft: ' + subject }),
      el('div', { class: 'small', text: 'To: ' + (it.Draft_To || '— (add in Edit Draft)') + (it.Draft_Cc ? ' · Cc: ' + it.Draft_Cc : '') }),
      el('div', { class: 'small', text: 'Subject: ' + subject }),
      draftBodyNode
    ]);
    var instructInput = el('input', { type: 'text', placeholder: 'Dictate or type instruction...' });
    var sopToggle = el('input', { type: 'checkbox' });
    var chipRow = el('div', { class: 'q-chips' });
    var instructBar = el('div', { class: 'q-instruct' }, [
      chipRow,
      el('div', { class: 'q-instruct-row' }, [
        instructInput,
        el('button', { type: 'button', class: 'btn line', text: 'Dictate', onclick: function () { startDictation(instructInput, say); } })
      ]),
      el('label', { class: 'sop' }, [sopToggle, document.createTextNode('Save as permanent SOP rule')]),
      el('button', { type: 'button', class: 'btn line', text: 'Apply to Draft', onclick: function () { applyInstruction(''); } })
    ]);
    var body = el('div', { class: 'qrow-body' }, [
      el('div', { class: 'qfrom', text: it.Rep_Or_Sender || '' }),
      syncBadge,
      staleBanner,
      threadBox,
      timelineBox,
      draftBox,
      instructBar,
      carrierPill,
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
    function applyFreshSnapshot(snap) {
      if (!snap) return;
      if (snap.thread_context) {
        if (threadBox) threadBox.textContent = snap.thread_context;
      }
      if (snap.synced_at_et || snap.thread_msg_count != null) {
        it.synced_at_et = snap.synced_at_et || it.synced_at_et;
        if (snap.thread_msg_count != null) it.thread_msg_count = snap.thread_msg_count;
        if (snap.last_message_id) it.last_message_id = snap.last_message_id;
        var label = syncLabel(it);
        syncBadge.textContent = label;
        syncBadge.classList.toggle('hidden', !label);
      }
      if (snap.thread_timeline) {
        it.thread_timeline = snap.thread_timeline;
        paintTimeline(timelineBox, snap.thread_timeline);
      }
      if (snap.draft_body) {
        it.draft_body = snap.draft_body;
        draftBodyNode.textContent = snap.draft_body;
        if (!editing) inBody.value = snap.draft_body;
      }
    }
    function applyInstruction(chip) {
      var instruction = instructInput.value.trim();
      if (!chip && !instruction) return say('Choose a chip or type an instruction first.', 'bad');
      var payload = {
        action: 'INSTRUCT_DRAFT',
        queueId: it.Queue_ID,
        draftId: it.Draft_ID || it.Gmail_Draft_ID || '',
        orderId: orderIdOf(it),
        currentBody: (editing ? inBody.value : (it.draft_body || it.Draft_Body || '')),
        instruction: chip ? '' : instruction,
        chip: chip || '',
        saveAsRule: sopToggle.checked
      };
      busy(true); say('Updating draft…');
      queueApi(payload).then(function (r) {
        busy(false);
        if (r.status !== 200 || !r.updatedBody) return say('Draft not updated (' + (r.error || r.status) + ').', 'bad');
        it.Draft_Body = r.updatedBody;
        it.draft_body = r.updatedBody;
        draftBodyNode.textContent = r.updatedBody;
        inBody.value = r.updatedBody;
        say(r.savedRule ? 'Draft updated and tagged as an SOP candidate. Nothing was sent.' : 'Draft updated. Nothing was sent.', '');
      }).catch(function () { busy(false); say('Connection problem. Draft was not updated.', 'bad'); });
    }
    [
      { chip: 'SHORTER_FIRMER', label: 'Shorter & Firmer' },
      { chip: 'ASK_ETA', label: 'Ask for ETA' },
      { chip: 'CONFIRM_RESCHEDULE', label: 'Confirm Reschedule' },
      { chip: 'HOLD_REP_INFO', label: 'Hold — Need Rep Info' }
    ].forEach(function (c) {
      chipRow.appendChild(el('button', { type: 'button', class: 'q-chip', text: c.label, onclick: function () { applyInstruction(c.chip); } }));
    });
    var pendingSend = null;
    btnSend.addEventListener('click', function () {
      var to = editing && inTo.value.trim() ? inTo.value.trim() : (it.Draft_To || '');
      var cc = editing ? inCc.value.trim() : (it.Draft_Cc || '');
      var subj = editing && inSubj.value.trim() ? inSubj.value.trim() : (it.Draft_Subject || '');
      if (!to) return say('Add a recipient in Edit Draft first.', 'bad');
      if (!window.confirm('Send this email now from Cristian@doorwaypartners.com?\n\nTo: ' + to + (cc ? '\nCc: ' + cc : '') + '\nSubject: ' + subj)) return;
      var payload = { action: 'SAFE_APPROVE_SEND', queueId: it.Queue_ID, confirm: true };
      if (editing) { payload.editedTo = inTo.value; payload.editedCc = inCc.value; payload.editedSubject = inSubj.value; payload.editedBody = inBody.value; }
      var carrier = DoorwayCore.carrierRecipients(to, cc);
      if (carrier.length) {
        if (!window.confirm('CARRIER RECIPIENT: ' + carrier.join(', ') + '\n\nThis email goes to a carrier. Tap OK again only if you are sure.')) return;
        payload.confirmCarrier = true;
      }
      payload.expectedMsgCount = it.thread_msg_count || 0;
      payload.expectedLastMsgId = it.last_message_id || '';
      payload.threadId = it.thread_id || (it.Source_Thread_ID || '');
      payload.draftId = it.Draft_ID || it.Gmail_Draft_ID || '';
      payload.idempotencyToken = it.Queue_ID + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
      if (pendingSend) return;
      busy(true); say('Sending in 5 seconds. Tap Undo to cancel.');
      pendingSend = startUndoCountdown(function () {
        pendingSend = null;
        say('Sending…');
        queueApi(payload).then(function (r) {
          if (r.status === 200) return done((r.demo ? 'Demo: would send to ' : (r.deduped ? 'Already sent to ' : 'Sent to ')) + (r.to || to));
          busy(false);
          if (r.status === 428) return say('Carrier recipient needs the second confirm. Nothing was sent.', 'bad');
          if (r.status === 409 && r.reason === 'STALE_THREAD_NEW_REPLY') {
            staleBanner.classList.remove('hidden');
            staleBanner.textContent = '';
            staleBanner.appendChild(el('strong', { text: 'New email arrived — send halted.' }));
            staleBanner.appendChild(el('div', { class: 'q-stale-msg small', text: (r.error || '') + (r.freshSnapshot && r.freshSnapshot.thread_context ? ' ' + r.freshSnapshot.thread_context : '') }));
            applyFreshSnapshot(r.freshSnapshot);
            return say('Send halted. A new email arrived on this thread. Review it, then approve again if you still want to send.', 'bad');
          }
          if (r.status === 409) return say('Already handled. Nothing was sent again.', 'bad');
          say('Not sent (' + (r.error || r.status) + ').', 'bad');
        }).catch(function () { busy(false); say('Connection problem. Not confirmed as sent; reload before retrying.', 'bad'); });
      }, function () {
        pendingSend = null;
        busy(false);
        say('Send cancelled. Nothing was sent.', '');
        toast('Send cancelled. Nothing was sent.', '');
      });
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

  // ---------- V3.3 Owner-only "+ Drop CSV / PDF" drawer ----------
  var dropDrawer = null;
  function closeDropDrawer() {
    if (dropDrawer && dropDrawer.parentNode) dropDrawer.parentNode.removeChild(dropDrawer);
    dropDrawer = null;
  }
  function summaryPdfRequest(d, q) {
    var fin = (d && d.financials) || {};
    var pipe = (d && d.pipeline) || {};
    var holdsN = (((d && d.exceptions) && d.exceptions.length) || 0) + (((d && d.holds) && d.holds.length) || 0);
    var p1n = (q && q.counts && q.counts.p1) || 0;
    return {
      action: 'GENERATE_PDF',
      type: 'SUMMARY',
      payload: {
        title: 'Ops Summary',
        summary: 'Command Center snapshot as of ' + ((d && d.asOf) || ''),
        h1: 'Item', h2: 'Detail', h3: 'Value',
        rows: [
          { col1: 'P1 Urgent', col2: 'Priority Queue', col3: String(p1n) },
          { col1: 'Written', col2: 'Pipeline', col3: String(pipe.written || 0) },
          { col1: 'Installed', col2: 'Pipeline', col3: String(pipe.installed || 0) },
          { col1: 'Cleared', col2: 'Pipeline', col3: String(pipe.cleared || 0) },
          { col1: 'Net Spread (Cleared)', col2: 'Month to date', col3: usd(fin.netSpreadCleared) },
          { col1: 'Exceptions & Holds', col2: 'Open', col3: String(holdsN) }
        ]
      }
    };
  }
  function downloadBlob(name, blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.setAttribute('download', name);
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
  }
  function downloadBase64(name, mime, b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    downloadBlob(name, new Blob([bytes], { type: mime || 'application/pdf' }));
  }
  function openDropDrawer() {
    if (dropDrawer) closeDropDrawer();
    var campaign = el('select');
    ['FIDIUM', 'CAMPAIGN_2_PLACEHOLDER'].forEach(function (c) {
      campaign.appendChild(el('option', { value: c, text: c }));
    });
    var fileIn = el('input', { type: 'file', accept: '.csv,text/csv,text/plain' });
    var paste = el('textarea', { rows: '6', placeholder: 'Paste CSV here (header row + data)' });
    var msg = el('p', { class: 'small muted', text: 'Imports append to Raw_Feed_Import only. Pay and rate columns are ignored.' });
    var btnImport = el('button', { type: 'button', class: 'btn primary', text: 'Import CSV' });
    var btnPdf = el('button', { type: 'button', class: 'btn line', text: 'Download summary PDF' });
    var btnClose = el('button', { type: 'button', class: 'btn line', text: 'Close' });
    var panel = el('div', { class: 'drawer', role: 'dialog', 'aria-label': 'Drop CSV / PDF' }, [
      el('h3', { text: 'Drop CSV / PDF' }),
      el('p', { class: 'muted small', text: 'Owner only. CSV is appended to the Raw_Feed_Import tab. The 1-tap PDF is an ops summary of the numbers already on this screen.' }),
      field('Campaign', campaign),
      field('Upload CSV', fileIn),
      field('Or paste CSV', paste),
      msg,
      el('div', { class: 'actions drawer-actions' }, [btnImport, btnPdf, btnClose])
    ]);
    dropDrawer = el('div', { class: 'drawer-back' }, [panel]);
    dropDrawer.addEventListener('click', function (ev) { if (ev.target === dropDrawer) closeDropDrawer(); });
    document.body.appendChild(dropDrawer);
    btnClose.addEventListener('click', closeDropDrawer);
    fileIn.addEventListener('change', function () {
      var f = fileIn.files && fileIn.files[0];
      if (!f) return;
      if (f.size > 800000) { msg.textContent = 'File is too large (800 KB max).'; msg.className = 'small bad'; return; }
      var reader = new FileReader();
      reader.onload = function () { paste.value = String(reader.result || ''); };
      reader.readAsText(f);
    });
    btnImport.addEventListener('click', function () {
      var text = (paste.value || '').trim();
      if (!text) { msg.textContent = 'Paste or upload a CSV first.'; msg.className = 'small bad'; return; }
      var payload = { action: 'IMPORT_RAW_FEED', campaignId: campaign.value, feedType: 'RAW_UPLOAD', csvText: text };
      btnImport.disabled = true;
      msg.textContent = 'Importing…'; msg.className = 'small muted';
      var go = DEMO
        ? Promise.resolve((function () {
            var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
            if (lines.length < 2) return { status: 400, error: 'CSV must contain headers and at least 1 data row.' };
            return { status: 200, importedCount: lines.length - 1, campaign: campaign.value, demo: true, appended: lines.length - 1, updated: 0 };
          })())
        : apiPost(payload);
      go.then(function (r) {
        btnImport.disabled = false;
        if (r.status === 200) {
          var note = (r.demo ? 'Demo: would import ' : 'Imported ') + r.importedCount + ' row' + (r.importedCount === 1 ? '' : 's') + ' for ' + (r.campaign || campaign.value) + (r.updated ? (' (' + r.updated + ' updated)') : '') + '.';
          msg.textContent = note; msg.className = 'small';
          toast(note, 'good');
        } else {
          msg.textContent = 'Import failed (' + (r.error || r.status) + ').'; msg.className = 'small bad';
        }
      }).catch(function () {
        btnImport.disabled = false;
        msg.textContent = 'Connection problem. Nothing was imported.'; msg.className = 'small bad';
      });
    });
    btnPdf.addEventListener('click', function () {
      var req = summaryPdfRequest(lastDash, lastQueue);
      btnPdf.disabled = true;
      msg.textContent = 'Building PDF…'; msg.className = 'small muted';
      if (DEMO) {
        var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Doorway Ops Summary (Demo)</title></head><body><h1>Doorway Partners — Ops Summary (Demo)</h1><p>Fake demo numbers. Not saved to Drive.</p></body></html>';
        downloadBlob('Doorway_SUMMARY_demo.html', new Blob([html], { type: 'text/html' }));
        msg.textContent = 'Demo: downloaded an HTML summary (no Drive upload).'; msg.className = 'small';
        toast(msg.textContent, 'good');
        btnPdf.disabled = false;
        return;
      }
      apiPost(req).then(function (r) {
        btnPdf.disabled = false;
        if (r.status === 200 && r.base64) {
          downloadBase64(r.title || 'Doorway_SUMMARY.pdf', r.mimeType || 'application/pdf', r.base64);
          msg.textContent = 'Downloaded ' + (r.title || 'PDF') + '. It was not saved to Drive.'; msg.className = 'small';
          toast(msg.textContent, 'good');
        } else {
          msg.textContent = 'PDF failed (' + (r.error || r.status) + ').'; msg.className = 'small bad';
        }
      }).catch(function () {
        btnPdf.disabled = false;
        msg.textContent = 'Connection problem. No PDF was generated.'; msg.className = 'small bad';
      });
    });
  }

  // ---------- V5 Mobile OS shell (bottom nav, campaign chips, view router) ----------
  var selectedCampaign = 'ALL';
  var VIEW_FOR = { queue: 'view-inbox', field: 'view-turf', team: 'view-team', money: 'view-ledger', config: 'view-config' };
  var VIEW_TO_TAB = { 'view-inbox': 'queue', 'view-turf': 'field', 'view-team': 'team', 'view-ledger': 'money', 'view-config': 'config' };

  function canSeeView(role, viewId) {
    if (viewId === 'view-ledger' || viewId === 'view-config') return role === 'Owner' || role === 'Admin';
    return true;
  }
  function defaultViewId(role) {
    if (role === 'Manager' || role === 'Admin') return 'view-team';
    return 'view-inbox';
  }
  function fill(id, nodes) {
    var host = document.getElementById(id);
    if (!host) return;
    host.textContent = '';
    (nodes || []).forEach(function (n) { if (n) host.appendChild(n); });
  }
  function switchView(targetId) {
    var role = lastDash && lastDash.role;
    if (!targetId || !document.getElementById(targetId)) return;
    if (role && !canSeeView(role, targetId)) return;
    document.querySelectorAll('.nav-item').forEach(function (nav) {
      nav.classList.toggle('active', nav.getAttribute('data-target') === targetId);
    });
    document.querySelectorAll('.view-container').forEach(function (v) {
      v.classList.toggle('active', v.id === targetId);
    });
    if (VIEW_TO_TAB[targetId]) view = VIEW_TO_TAB[targetId];
  }
  function gateNav(role) {
    document.querySelectorAll('#sidebar .nav-item[data-target]').forEach(function (item) {
      var target = item.getAttribute('data-target');
      if (canSeeView(role, target)) item.classList.remove('hidden');
      else item.classList.add('hidden');
    });
    var financeVisible = canSeeView(role, 'view-ledger') || canSeeView(role, 'view-config');
    document.querySelectorAll('#sidebar [data-nav-group="finance"]').forEach(function (h) {
      if (financeVisible) h.classList.remove('hidden');
      else h.classList.add('hidden');
    });
  }
  function showAppShell(d) {
    var signin = document.getElementById('signin');
    if (signin) signin.classList.remove('active');
    var menuBtn = document.getElementById('menu-btn');
    var chips = document.getElementById('campaign-filter');
    if (menuBtn) menuBtn.classList.remove('hidden');
    if (chips) chips.classList.remove('hidden');
    gateNav(d && d.role);
    var current = document.querySelector('.view-container.active');
    var currentId = current && current.id;
    if (!currentId || currentId === 'signin' || (d && !canSeeView(d.role, currentId))) {
      switchView(VIEW_FOR[view] && canSeeView(d.role, VIEW_FOR[view]) ? VIEW_FOR[view] : defaultViewId(d && d.role));
    } else {
      switchView(currentId);
    }
  }
  function hideAppShell() {
    closeSidebar();
    var menuBtn = document.getElementById('menu-btn');
    var chips = document.getElementById('campaign-filter');
    if (menuBtn) menuBtn.classList.add('hidden');
    if (chips) chips.classList.add('hidden');
    document.querySelectorAll('.view-container').forEach(function (v) { v.classList.remove('active'); });
    var signin = document.getElementById('signin');
    if (signin) signin.classList.add('active');
  }
  function showLoading() {
    var signin = document.getElementById('signin');
    if (signin) signin.classList.remove('active');
    fill('queue-feed', [card('Loading…', [el('div', { class: 'skeleton' })])]);
    switchView('view-inbox');
  }

  function render(d) {
    lastDash = d;
    showAppShell(d);
    document.getElementById('whoami').textContent = d.me.name + ' · ' + d.role + ' · as of ' + d.asOf;
    mountHud(d);
    var authErr = document.getElementById('auth-error');
    if (authErr) { authErr.textContent = ''; authErr.classList.add('hidden'); }
    fill('queue-feed');
    fill('team-pace-feed');
    fill('turf-feed');
    fill('ledger-feed');
    if (d.role === 'Owner') { // queue tab exists for the Owner role only; the API enforces it too
      applyBootQueue(d);
      var tabHost = document.getElementById('owner-subtabs');
      if (tabHost) { tabHost.textContent = ''; tabHost.appendChild(viewTabs()); }
      renderQueueView();
      fill('team-pace-feed', [dashGrid(renderTeam(d))]);
      fill('turf-feed', renderField(d));
      fill('ledger-feed', [dashGrid(renderMoney(d))]);
      if (view !== 'queue' && !lastQueue) loadQueue().catch(function () {});
      switchView(VIEW_FOR[view] || 'view-inbox');
      return;
    }
    if (d.role === 'Admin') {
      fill('queue-feed', [el('div', { class: 'note', text: 'The Priority Queue is Owner-only.' })]);
      fill('team-pace-feed', [dashGrid(renderTeam(d))]);
      fill('turf-feed', renderField(d));
      fill('ledger-feed', [dashGrid(renderMoney(d))]);
      switchView(VIEW_FOR[view] && canSeeView('Admin', VIEW_FOR[view]) ? VIEW_FOR[view] : defaultViewId('Admin'));
      return;
    }
    if (d.role === 'Manager') {
      fill('queue-feed', [walletCard(d.wallet, d.rules, 'My wallet')]);
      fill('team-pace-feed', [leaderboardCard('Pod scoreboard', d.podScoreboard, d.rules)]);
      fill('turf-feed', [day14Card(d.day14), missingCard(d.missingOrders, false), permitsCard(d.permits)]);
      switchView(VIEW_FOR[view] && canSeeView('Manager', VIEW_FOR[view]) ? VIEW_FOR[view] : defaultViewId('Manager'));
      return;
    }
    var c = d.compliance, t = d.tierProgress;
    fill('queue-feed', [
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
      card('My scorecard', [collapseList(d.scorecard, function (s) {
        return line(s.Date + ' · graded by ' + s.Grader, 'Approach ' + s.Approach_Tonality + ' · Rebuttal ' + s.Rebuttal_Composure + ' · Pin/Dusk ' + s.Pin_Note_Dusk + ' · RepCard ' + s['RepCard_Send_Rate %'], s.Roleplay_Pass === 'Y' ? 'PASS' : 'RETRY', s.Roleplay_Pass === 'Y' ? 'good' : 'warn');
      }, 'No scorecards yet.')])
    ]);
    fill('turf-feed', [
      permitsCard(d.permits),
      day14Card(d.day14),
      d.missingOrders.length ? missingCard(d.missingOrders, true) : null
    ]);
    fill('team-pace-feed', [
      card('My pace this month', [
        el('div', { class: 'row-between small' }, [el('span', { text: d.pace.deals + ' deals' }), el('span', { text: 'target ' + d.pace.target })]),
        bar(d.pace.pacePct)
      ])
    ]);
    switchView(VIEW_FOR[view] && canSeeView('Rep', VIEW_FOR[view]) ? VIEW_FOR[view] : defaultViewId('Rep'));
  }
  function showError(title, msg) {
    mountHud(null);
    hideAppShell();
    var authErr = document.getElementById('auth-error');
    if (authErr) {
      authErr.textContent = '';
      authErr.classList.remove('hidden');
      authErr.appendChild(card(title, [el('p', { class: 'muted', text: msg })], 'center'));
    } else {
      var signinMsg = document.getElementById('signin-msg');
      if (signinMsg) signinMsg.textContent = title + ' — ' + msg;
    }
  }

  // ---------- live mode ----------
  function onCredential(resp) {
    idToken = resp.credential;
    var email = emailFromToken(idToken);
    var cached = readBootCache(email);
    if (cached) {
      document.getElementById('signout').classList.remove('hidden');
      applyBootQueue(cached);
      render(cached);
    } else {
      showLoading();
    }
    fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ idToken: idToken }), redirect: 'follow', credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.status === 401 || d.status === 403) {
          clearBootCache();
          idToken = null;
          lastDash = null;
          lastQueue = null;
          document.getElementById('signout').classList.add('hidden');
          if (d.status === 403) return showError('No access', 'This Google account is not on the Doorway Ops access list. Ask Cristian to add you.');
          return showError('Sign-in problem', 'Please sign in again. (' + (d.reason || d.error || d.status) + ')');
        }
        if (d.status && d.status !== 200) return showError('Sign-in problem', 'Please sign in again. (' + (d.reason || d.error || d.status) + ')');
        var freshEmail = String((d.me && d.me.email) || '').trim().toLowerCase();
        if (cached && (d.role !== cached.role || freshEmail !== String((cached.me && cached.me.email) || '').toLowerCase() || (email && freshEmail !== email))) {
          clearBootCache();
          lastQueue = null;
        }
        applyBootQueue(d);
        writeBootCache(d, lastQueue);
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
      clearBootCache();
      idToken = null;
      lastDash = null;
      lastQueue = null;
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

  // V8 Sidebar Router Logic
  var sidebar = document.getElementById('sidebar');
  var overlay = document.getElementById('sidebar-overlay');
  var menuBtn = document.getElementById('menu-btn');
  var closeBtn = document.getElementById('close-menu-btn');

  function setSidebarOpen(open) {
    if (!sidebar || !overlay) return;
    sidebar.classList.toggle('open', !!open);
    overlay.classList.toggle('open', !!open);
    sidebar.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (menuBtn) {
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    }
  }
  function closeSidebar() { setSidebarOpen(false); }
  function toggleSidebar() { setSidebarOpen(!(sidebar && sidebar.classList.contains('open'))); }

  if (menuBtn) menuBtn.addEventListener('click', toggleSidebar);
  if (closeBtn) closeBtn.addEventListener('click', closeSidebar);
  if (overlay) overlay.addEventListener('click', closeSidebar);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && sidebar && sidebar.classList.contains('open')) closeSidebar();
  });

  document.querySelectorAll('#sidebar .nav-item').forEach(function (item) {
    item.addEventListener('click', function (e) {
      e.preventDefault();
      if (item.classList.contains('hidden')) return;
      switchView(item.getAttribute('data-target'));
      if (window.innerWidth < 820) closeSidebar();
    });
  });
  document.querySelectorAll('.chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      document.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('active'); });
      chip.classList.add('active');
      selectedCampaign = chip.getAttribute('data-campaign') || 'ALL';
      // Campaign-scoped re-render is deferred: queue and pace rows have no campaign field yet.
    });
  });

  purgeLegacySessionBootCache();
  if (DEMO) startDemo(); else startLive();
})();
