/* Agent view: read-only dashboard of the 24/7 agent's state (data branch, state.json). */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const V = FD.VENUES;
  const OWNER = /github\.io$/.test(location.hostname) ? location.hostname.split('.')[0] : 'cresl1';
  const REPO = (/github\.io$/.test(location.hostname) && location.pathname.split('/')[1]) || 'funding-desk';
  const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}/data/state.json`;
  const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/state.json?ref=data`;
  const GH = `https://github.com/${OWNER}/${REPO}`;
  const EDIT = `${GH}/edit/main/config.json`, RUNS = `${GH}/actions/workflows/agent.yml`, SECRETS = `${GH}/settings/secrets/actions`;
  const KEY = 'fd.dk.v1', STALL_MS = 20 * 60e3, EVERY_MS = 5 * 60e3;
  let ST = null, lastApi = 0, fetchedAt = 0, err = null, PRIV = null, started = false;

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = x => (x < 0 ? '−$' : '$') + Math.abs(+x || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const p3 = x => Math.abs(x) < 5e-7 ? '0%' : (x * 100).toFixed(3) + '%';
  const ago = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? s + 's' : s < 5400 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1) + ' h'; };
  const tm = t => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const vn = id => (V[id] && V[id].name) || id;

  // ---- private block (real Coinbase totals) is AES-GCM encrypted with a key derived from the desk password
  async function rememberKey(pw) {
    try {
      const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode('funding-desk-v1'), iterations: 200000 }, base, 256);
      localStorage.setItem(KEY, [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join(''));
    } catch (e) {}
  }
  async function decrypt(blob) {
    const hex = localStorage.getItem(KEY); if (!hex || !blob) return null;
    const key = await crypto.subtle.importKey('raw', new Uint8Array(hex.match(/../g).map(h => parseInt(h, 16))), 'AES-GCM', false, ['decrypt']);
    const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(blob.iv) }, key, b64(blob.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  // ---- data: raw file (CDN copy, can lag up to 5 min) plus, when that looks old, the API copy (fresh; max every 2.5 min
  //      to stay inside GitHub's 60 requests/hour for visitors); keep whichever is newer
  async function getJSON(url, headers) {
    const r = await fetch(url, { cache: 'no-store', headers }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
  }
  async function load() {
    const got = await Promise.allSettled([getJSON(RAW + '?t=' + Date.now()), (!ST || Date.now() - ST.agent.lastRun > 5.5 * 60e3) && Date.now() - lastApi > 150e3 ? (lastApi = Date.now(), getJSON(API, { Accept: 'application/vnd.github.raw+json' })) : Promise.reject(0)]);
    const ok = got.filter(g => g.status === 'fulfilled' && g.value && g.value.agent).map(g => g.value).sort((a, b) => b.agent.lastRun - a.agent.lastRun);
    if (ok.length) { if (!ST || ok[0].agent.lastRun >= ST.agent.lastRun) ST = ok[0]; err = null; fetchedAt = Date.now(); }
    else if (!ST) err = 'Agent has not saved any state yet';
    PRIV = null;
    if (ST && ST.coinbase && ST.coinbase.enc) { try { PRIV = await decrypt(ST.coinbase.enc); } catch (e) { PRIV = { locked: true }; } }
    render();
  }

  function status() {
    if (!ST) return { cls: 'stalled', txt: 'AGENT: WAITING', sub: err || 'loading…' };
    const since = Date.now() - ST.agent.lastRun, next = ST.agent.lastRun + EVERY_MS - Date.now();
    const stalled = since > STALL_MS;
    return { cls: stalled ? 'stalled' : 'running', txt: stalled ? 'AGENT: STALLED' : 'AGENT: RUNNING',
      sub: `last ran ${ago(since)} ago · ` + (stalled ? 'GitHub has not run it for over 20 min' : next > 0 ? `next run ~${ago(next)}` : 'next run due now (GitHub can run late)') };
  }

  function render() {
    const s = status();
    $('aPill').className = 'pill ' + s.cls; $('aPill').textContent = s.txt; $('aWhen').textContent = s.sub;
    if (!ST) return;
    const A = ST.agent, E = ST.engine, cfg = ST.settings || {};
    $('aPaused').hidden = !A.paused;
    $('aRuns').textContent = `run #${A.runs}${A.run && A.run.event === 'schedule' ? ' (scheduled)' : A.run ? ' (manual)' : ''}`;
    $('aEquity').textContent = money(ST.equity);
    const pnl = ST.equity - E.startWallet;
    $('aPnl').className = 'sub ' + (pnl >= 0 ? 'pos' : 'neg'); $('aPnl').textContent = `${pnl >= 0 ? '+' : ''}${money(pnl)} (${(pnl / E.startWallet * 100).toFixed(2)}%) since ${money(E.startWallet)}`;
    $('aOpen').textContent = E.positions.length; $('aWL').textContent = `${E.wins} / ${E.losses}`; $('aTrades').textContent = E.trades.length;
    $('aSince').textContent = new Date(A.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' });
    const recentErr = A.lastError && A.lastErrorAt === A.lastRun;
    $('aErr').hidden = !recentErr; $('aErr').textContent = recentErr ? 'Last run: ' + A.lastError : '';
    drawCurve(E.curve, E.startWallet);
    // breakers
    const br = (ST.breakers || []).slice();
    br.unshift({ name: 'Pause switch', tripped: !!A.paused, detail: A.paused ? 'paused in config.json: no new entries' : 'running (config.json paused=false)' });
    br.push({ name: 'Gate tests', tripped: !A.testsOk, detail: A.testsOk ? 'passed before this run' : 'failed: agent did not trade' });
    $('aBreakers').innerHTML = br.map(b => `<li class="${b.tripped ? 'tripped' : 'armed'}"><span class="st">${b.tripped ? 'TRIPPED' : 'ARMED'}</span><div class="nm">${esc(b.name)}</div><div class="dt">${esc(b.detail)}</div></li>`).join('');
    // setups seen on the last run
    let h = '';
    for (const [c, pairs] of Object.entries(ST.scan || {})) {
      h += `<div class="coin">${c}-PERP</div>`;
      if (E.skips && E.skips[c]) h += `<div class="skipline">${esc(E.skips[c])}</div>`;
      h += pairs.slice(0, 3).map(p => `<div class="opp"><div>short ${esc(vn(p.short))} / long ${esc(vn(p.long))}<div class="why">gap ${p3(p.gap)}/8h · net ${p3(p.net)}${p.reason && !/^net /.test(p.reason) ? ' · ' + esc(p.reason) : ''}</div></div><span class="tag ${p.pass ? 't-pass' : 't-skip'}">${p.pass ? 'PASS' : 'SKIP'}</span></div>`).join('') || '<div class="empty">no venue pair with data</div>';
    }
    $('aScan').innerHTML = h; $('aScanHint').textContent = `need net > ${cfg.entryNetPct}%`;
    // positions
    $('aPos').className = E.positions.length ? '' : 'empty';
    $('aPos').innerHTML = E.positions.length ? E.positions.map(p => `<div class="opp"><div><b>${p.coin}</b> short ${esc(vn(p.shortVenue))} / long ${esc(vn(p.longVenue))} · ${money(p.notional)}/leg<div class="why">opened ${tm(p.opened)} · funding ${money(p.funding)} · fees ${money(p.entryFee)}</div></div></div>`).join('') : 'None';
    // log: closed trades first, then recent fills
    const tr = E.trades.slice().reverse().slice(0, 30).map(t => `<div><span class="mut">${tm(t.closed)}</span> <b>CLOSE</b> ${t.coin} · <b class="${t.pnl > 0 ? 'pos' : 'neg'}">${money(t.pnl)}</b> · ${esc(t.why)}</div>`);
    const fl = E.fills.slice().reverse().slice(0, 60).map(f => {
      const t = `<span class="mut">${tm(f.t)}</span> `;
      if (f.type === 'open') return `<div>${t}<b>OPEN</b> ${f.coin} short ${esc(vn(f.short))} / long ${esc(vn(f.long))} · ${money(f.notional)}/leg · net ${f.net}%</div>`;
      if (f.type === 'close') return `<div>${t}<b>CLOSE</b> ${f.coin} · <b class="${f.pnl > 0 ? 'pos' : 'neg'}">${money(f.pnl)}</b> · ${esc(f.why)}</div>`;
      return `<div>${t}funding ${f.coin} ${esc(vn(f.venue))} ${esc(f.side || '')} · ${money(f.amount)}</div>`;
    });
    $('aLog').className = 'log' + (fl.length ? '' : ' empty');
    $('aLog').innerHTML = fl.length ? fl.join('') : `No trades yet. The agent checks every 5 min and only trades when a gap clears ${cfg.entryNetPct}% after fees.`;
    $('aTradeCount').textContent = tr.length ? `${E.trades.length} closed` : '';
    // venues
    $('aVenues').innerHTML = Object.entries(A.venues || {}).map(([id, v]) => `<div class="opp"><div><span class="dot ${v.ok && v.on ? 'd-live' : 'd-off'}"></span>${esc(vn(id))}</div><span class="mut">${v.on ? (v.ok ? 'live' : esc(v.error)) : 'off'}</span></div>`).join('');
    // settings (read-only)
    const row = (k, v) => `<div class="opp"><span>${k}</span><b>${v}</b></div>`;
    $('aSettings').innerHTML = row('Starting wallet', money(cfg.startWallet)) + row('Enter when net gap >', cfg.entryNetPct + '%') + row('Size per leg', cfg.sizePct + '% of wallet (max 25)') +
      row('Daily loss cap', cfg.dailyLossPct + '%') + row('Pause after losses in a row', cfg.maxConsecLosses) + row('Max data age', cfg.staleSec + ' s') +
      row('Max mark price gap', cfg.maxPriceGapPct + '%') + row('Paused', A.paused ? 'yes' : 'no');
    renderLive();
  }

  function renderLive() {
    const cb = ST.coinbase || { status: 'not_connected' }, lc = ST.liveConfig || {}, L = PRIV && PRIV.live, Bal = PRIV && PRIV.balances;
    const live = lc.enabled && cb.status === 'connected' && cb.live && !cb.live.halted;
    $('aLiveTag').className = 'tag ' + (live ? 't-live' : 't-skip'); $('aLiveTag').textContent = live ? 'LIVE ON' : 'LIVE OFF';
    let h = `<div class="opp"><span>Coinbase</span><b>${cb.status === 'connected' ? 'connected' + (cb.viewOnly ? ' (view-only)' : cb.canTrade ? ' (view + trade)' : '') : cb.status === 'error' ? 'error' : 'not connected'}</b></div>`;
    if (cb.warning) h += `<div class="warn">${esc(cb.warning)}</div>`;
    if (cb.error) h += `<div class="warn">${esc(cb.error)}</div>`;
    if (cb.status === 'connected' && PRIV && PRIV.locked) h += `<div class="skipline">Balances are encrypted. <button class="link" id="aRelock">Re-enter password</button> to see them.</div>`;
    if (cb.status === 'connected' && !PRIV) h += `<div class="skipline">Balances are encrypted. <button class="link" id="aRelock">Enter password</button> to see them.</div>`;
    if (Bal) {
      h += `<div class="opp"><span>USD cash</span><b>${money(Bal.cashUSD)}</b></div>` + (Bal.cashUSDC ? `<div class="opp"><span>USDC</span><b>${money(Bal.cashUSDC)}</b></div>` : '');
      h += Bal.futures ? `<div class="opp"><span>Futures buying power</span><b>${money(Bal.futures.buyingPower)}</b></div><div class="opp"><span>Futures unrealized P&amp;L</span><b class="${Bal.futures.unrealizedPnl >= 0 ? 'pos' : 'neg'}">${money(Bal.futures.unrealizedPnl)}</b></div>` : `<div class="skipline">${esc(Bal.futuresNote || 'no futures account')}</div>`;
    }
    if (L) {
      h += `<div class="opp"><span>Live P&amp;L (realized)</span><b class="${L.realizedPnl >= 0 ? 'pos' : 'neg'}">${money(L.realizedPnl)}</b></div>`;
      if (L.position) h += `<div class="opp"><div><b>${L.position.coin}</b> carry: long ${L.position.baseQty} spot / short ${L.position.contracts} perp<div class="why">opened ${tm(L.position.openedAt)}</div></div><b class="${L.position.unrealizedPnl >= 0 ? 'pos' : 'neg'}">${money(L.position.unrealizedPnl)}</b></div>`;
      if (L.halted) h += `<div class="warn">HALTED: ${esc(L.haltReason)}. Bump live.rearm in config.json to re-arm.</div>`;
      for (const [c, why] of Object.entries(L.checks || {})) h += `<div class="skipline">${c}: ${esc(why)}</div>`;
      if (L.error) h += `<div class="warn">${esc(L.error)}</div>`;
    }
    h += `<div class="opp"><span>Caps</span><b>${money(lc.maxNotionalUsd || 250)} max position · ${money(lc.maxLossUsd || 25)} max loss · ${lc.maxOrdersPerDay || 4} orders/day</b></div>`;
    h += `<div class="opp"><span>Kill switch</span><b>${lc.enabled ? 'armed (live.enabled = true)' : 'OFF: live.enabled = false'}</b></div>`;
    if (cb.status !== 'connected') h += `<div class="setup"><b>Needs ~$500 USD in a regular Coinbase account with futures on</b> (≈$250 per leg; the Coinbase Wallet app can't trade).
      <ol><li>coinbase.com → turn on Futures (Settings → Futures / "Trade perpetual futures").</li>
      <li><a href="https://portal.cdp.coinbase.com/" target="_blank" rel="noopener">portal.cdp.coinbase.com</a> → API Keys → Secret API Keys → Create API key. Permissions: View + Trade only (never Transfer). Advanced settings → signature algorithm <b>ECDSA</b>. No IP allowlist.</li>
      <li>Add 2 secrets at <a href="${SECRETS}" target="_blank" rel="noopener">repo → Settings → Secrets → Actions</a>: <code>COINBASE_API_KEY_NAME</code> and <code>COINBASE_API_PRIVATE_KEY</code>.</li>
      <li>To trade, set <code>"live": { "enabled": true }</code> in <a href="${EDIT}" target="_blank" rel="noopener">config.json</a>.</li></ol></div>`;
    $('aLive').innerHTML = h;
    const rb = $('aRelock'); if (rb) rb.onclick = async () => { const pw = prompt('Desk password'); if (pw) { await rememberKey(pw.trim()); load(); } };
  }

  function drawCurve(pts, base) {
    const cv = $('aCurve'), dpr = window.devicePixelRatio || 1, w = cv.clientWidth || 300, hh = 90;
    cv.width = w * dpr; cv.height = hh * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, hh);
    if (!pts || pts.length < 2) { g.fillStyle = '#8b98a7'; g.font = '12px -apple-system,sans-serif'; g.fillText('Equity curve fills in as the agent runs', 4, 50); return; }
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t; let lo = Math.min(...pts.map(p => p.e), base), hi = Math.max(...pts.map(p => p.e), base);
    if (hi - lo < 0.5) { hi += 0.25; lo -= 0.25; }
    const X = t => (t - t0) / Math.max(1, t1 - t0) * (w - 2) + 1, Y = e => hh - 6 - (e - lo) / (hi - lo) * (hh - 12);
    g.strokeStyle = '#1f2a36'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(0, Y(base)); g.lineTo(w, Y(base)); g.stroke(); g.setLineDash([]);
    g.strokeStyle = pts[pts.length - 1].e >= base ? '#2fd27a' : '#ff5d5d'; g.lineWidth = 2; g.beginPath();
    pts.forEach((p, i) => i ? g.lineTo(X(p.t), Y(p.e)) : g.moveTo(X(p.t), Y(p.e))); g.stroke();
  }

  function showTab(which, simStart) {
    $('agentView').hidden = which !== 'agent'; $('simView').hidden = which !== 'sim';
    $('tabAgent').setAttribute('aria-selected', which === 'agent'); $('tabSim').setAttribute('aria-selected', which === 'sim');
    if (which === 'sim' && simStart) simStart();
  }

  function start(simStart) {
    if (started) return; started = true;
    $('tabAgent').onclick = () => showTab('agent');
    $('tabSim').onclick = () => showTab('sim', simStart);
    $('aEdit').href = EDIT; $('aRunsLink').href = RUNS; $('aPauseLink').href = EDIT;
    $('aReload').onclick = load;
    load(); setInterval(() => { if (!document.hidden) load(); }, 60e3);
    setInterval(() => { if (ST) { const s = status(); $('aPill').className = 'pill ' + s.cls; $('aPill').textContent = s.txt; $('aWhen').textContent = s.sub; } }, 15e3);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  }
  window.AgentView = { start, rememberKey };
})();
