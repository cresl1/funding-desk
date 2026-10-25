(function () {
  'use strict';
  const PW_HASH = '162c8e48e83400fb9cac9947ab71ea63e5e27490040529ddae7283fda6991d64'; // SHA-256 of the desk password; the password itself is not in this code
  const $ = id => document.getElementById(id);
  const V = FD.VENUES, COINS = FD.COINS;
  const OWNER = /github\.io$/.test(location.hostname) ? location.hostname.split('.')[0] : 'cresl1';
  const REPO = (/github\.io$/.test(location.hostname) && location.pathname.split('/')[1]) || 'funding-desk';
  const SNAPSHOT_URL = `https://raw.githubusercontent.com/${OWNER}/${REPO}/data/rates.json`;
  const LS = { s: 'fd.settings.v1', st: 'fd.state.v1', u: 'fd.unlock.v1' };

  // ---------- gate
  async function sha256(t) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
  function unlock() { $('gate').hidden = true; $('gate').style.display = 'none'; $('app').hidden = false; AgentView.start(start); } // simulator starts when its view is opened
  $('gateForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (await sha256($('pw').value.trim()) === PW_HASH) { localStorage.setItem(LS.u, PW_HASH); await AgentView.rememberKey($('pw').value.trim()); unlock(); }
    else { $('gateErr').textContent = 'Wrong password'; $('pw').select(); }
  });
  $('btnLock').onclick = () => { localStorage.removeItem(LS.u); location.reload(); };

  // ---------- settings + state
  function loadSettings() {
    const s = JSON.parse(JSON.stringify(FD.DEFAULTS));
    try { const x = JSON.parse(localStorage.getItem(LS.s) || '{}'); Object.assign(s, x, { fees: { ...s.fees, ...(x.fees || {}) }, enabled: { ...s.enabled, ...(x.enabled || {}) } }); } catch (e) {}
    s.maxSizePct = 25; return s;
  }
  let S = loadSettings(), ST, QUOTES = [], STATUS = {}, busy = false, timer = null, started = false;
  try { ST = JSON.parse(localStorage.getItem(LS.st)); } catch (e) {}
  if (!ST || !ST.curve) ST = FD.newState(S, Date.now());
  const save = () => { localStorage.setItem(LS.s, JSON.stringify(S)); localStorage.setItem(LS.st, JSON.stringify(ST)); };

  // ---------- data
  async function j(url, opt) {
    const r = await fetch(url, { ...opt, cache: 'no-store', signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined });
    if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
  }
  const perCoin = async fn => Object.fromEntries(await Promise.all(COINS.map(async c => [c, await fn(c)])));
  const LIVE = {
    hyperliquid: () => j('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":"metaAndAssetCtxs"}' }),
    okx: () => perCoin(async c => ({ fr: await j(`https://www.okx.com/api/v5/public/funding-rate?instId=${c}-USDT-SWAP`), mk: await j(`https://www.okx.com/api/v5/public/mark-price?instType=SWAP&instId=${c}-USDT-SWAP`) })),
    dydx: () => j('https://indexer.dydx.trade/v4/perpetualMarkets'),
    bitget: () => perCoin(async c => ({ fr: await j(`https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${c}USDT&productType=usdt-futures`), px: await j(`https://api.bitget.com/api/v2/mix/market/symbol-price?symbol=${c}USDT&productType=usdt-futures`) }))
    // Binance and Bybit refuse US connections and send no CORS headers, so the browser does not try them;
    // the scheduled job attempts them every run and the scanner shows its answer.
  };
  async function fetchAll() {
    const snapP = j(SNAPSHOT_URL + '?t=' + Date.now()).catch(() => j('data/rates.json?t=' + Date.now())).catch(() => null);
    const live = {};
    await Promise.all(Object.entries(LIVE).map(async ([id, fn]) => {
      const ts = Date.now();
      try { const q = FD.N[id](await fn(), ts); live[id] = Object.keys(q).length ? { ok: true, quotes: q } : { ok: false, error: 'empty answer' }; }
      catch (e) { live[id] = { ok: false, error: /HTTP/.test(e.message) ? e.message : 'no answer from this location' }; }
    }));
    const snap = await snapP, qs = [], st = {};
    for (const id of Object.keys(V)) {
      const l = live[id], s = snap && snap.venues && snap.venues[id];
      if (l && l.ok) { st[id] = { src: 'live', err: null }; qs.push(...Object.values(l.quotes)); }
      else if (s && s.ok) { st[id] = { src: 'snapshot', err: l ? l.error : null }; qs.push(...Object.values(s.quotes)); }
      else st[id] = { src: 'off', err: (s && s.error) || (l && l.error) || 'no data' };
    }
    st._snapAt = snap && snap.generatedAt;
    return { qs, st };
  }

  // ---------- run
  async function refresh() {
    if (busy) return; busy = true; $('btnStep').textContent = '…';
    try {
      const r = await fetchAll(); QUOTES = r.qs; STATUS = r.st;
      FD.step(ST, QUOTES.filter(q => S.enabled[q.venue] !== false), S, Date.now());
      save();
    } catch (e) { console.error(e); }
    busy = false; $('btnStep').textContent = 'Refresh'; render();
  }
  function schedule() { clearInterval(timer); if ($('auto').checked) timer = setInterval(() => { if (!document.hidden && !$('simView').hidden) refresh(); }, 30000); }
  function start() {
    if (started) return; started = true;
    buildSettings(); render(); refresh(); schedule();
    $('btnStep').onclick = refresh; $('auto').onchange = schedule;
    document.addEventListener('visibilitychange', () => { if (!document.hidden && $('auto').checked && !$('simView').hidden) refresh(); });
    $('btnPause').onclick = () => { ST.paused = !ST.paused; save(); render(); };
    setInterval(renderClock, 1000);
  }

  // ---------- render
  const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const p3 = x => Math.abs(x) < 5e-7 ? '0%' : (x * 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '') + '%';
  const ago = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? s + 's' : s < 5400 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h'; };
  const until = t => { if (!t) return '—'; const m = Math.round((t - Date.now()) / 60000); return m <= 0 ? 'now' : m < 90 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; };
  const tm = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function render() {
    const now = Date.now(), active = QUOTES.filter(q => S.enabled[q.venue] !== false), byVC = FD.indexQuotes(active);
    const e = FD.equityOf(ST, byVC), pnl = e - ST.startWallet;
    $('equity').textContent = money(e);
    $('pnl').textContent = `${pnl >= 0 ? '+' : ''}${money(pnl)} (${(pnl / ST.startWallet * 100).toFixed(2)}%) since start ${money(ST.startWallet)}`;
    $('pnl').className = 'sub ' + (pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : 'mut');
    $('openCount').textContent = ST.positions.length; $('wl').textContent = ST.wins + ' / ' + ST.losses;
    $('fillCount').textContent = ST.fills.filter(f => f.type !== 'funding').length;
    renderClock(); drawCurve();
    // breakers
    const br = FD.breakers(ST, active, S, now);
    br.unshift({ name: 'Desk', tripped: !!ST.paused, detail: ST.paused ? 'paused by you' : 'running' });
    $('breakers').innerHTML = br.map(b => `<li class="${b.tripped ? 'tripped' : 'armed'}"><span class="st">${b.tripped ? 'TRIPPED' : 'ARMED'}</span><div class="nm">${esc(b.name)}</div><div class="dt">${esc(b.detail)}</div></li>`).join('');
    $('btnPause').textContent = ST.paused ? 'Resume desk' : 'Pause desk';
    // scanner
    let h = '';
    for (const c of COINS) {
      h += `<div class="coin">${c}-PERP</div><table><thead><tr><th>Venue</th><th>/8h</th><th>APR</th><th>Next</th><th>Mark</th></tr></thead><tbody>`;
      for (const id of Object.keys(V)) {
        if (S.enabled[id] === false) continue;
        const q = byVC[id + ':' + c], st = STATUS[id] || { src: 'off', err: 'loading' };
        const dot = !q ? 'd-off' : st.src === 'live' ? 'd-live' : 'd-snap';
        const age = q ? (st.src === 'live' ? 'live · ' : 'delayed · ') + ago(now - q.ts) : esc(st.err || V[id].note);
        const us = V[id].us ? '<span class="us">US</span>' : '';
        h += q ? `<tr><td><span class="dot ${dot}"></span>${V[id].name}${us}<small>${age}</small></td><td class="${q.rate8h > 0 ? 'pos' : q.rate8h < 0 ? 'neg' : ''}">${p3(q.rate8h)}</td><td>${(q.apr * 100).toFixed(1)}%</td><td>${until(q.nextFunding)}</td><td>${q.mark.toLocaleString('en-US', { maximumFractionDigits: q.mark > 1000 ? 1 : 3 })}</td></tr>`
          : `<tr><td colspan="5"><span class="dot d-off"></span>${V[id].name}${us}<small>unavailable · ${age}</small></td></tr>`;
      }
      h += '</tbody></table>';
    }
    $('scanner').innerHTML = h;
    // setups
    const sc = FD.scan(FD.groupByCoin(active), S); let oh = '', nPass = 0, nAll = 0;
    for (const c of COINS) {
      oh += `<div class="coin">${c}</div>`;
      if (ST.skips && ST.skips[c]) oh += `<div class="skipline">Engine: ${esc(ST.skips[c])}</div>`;
      sc[c].slice(0, 6).forEach(p => {
        nAll++; if (p.pass) nPass++;
        oh += `<div class="opp"><div>Short <b>${V[p.shortVenue].name}</b> / Long <b>${V[p.longVenue].name}</b><div class="why">gap ${p3(p.gap)} − fees ${p3(p.fees)} = net <b class="${p.net > 0 ? 'pos' : 'neg'}">${p3(p.net)}</b>${p.pass ? '' : ' · need &gt; ' + S.entryNetPct + '%'}</div></div><span class="tag ${p.pass ? 't-pass' : 't-skip'}">${p.pass ? 'PASS' : 'SKIP'}</span></div>`;
      });
      if (sc[c].length > 6) oh += `<div class="skipline">+${sc[c].length - 6} more pairs skipped</div>`;
    }
    $('opps').innerHTML = oh; $('oppHint').textContent = `${nPass} pass · ${nAll - nPass} skipped · need > ${S.entryNetPct}%`;
    // positions
    $('positions').className = ST.positions.length ? '' : 'empty';
    $('positions').innerHTML = ST.positions.length ? ST.positions.map(p => {
      const qs = byVC[p.shortVenue + ':' + p.coin], ql = byVC[p.longVenue + ':' + p.coin];
      const u = FD.equityOf({ cash: 0, positions: [p] }, byVC), gap = qs && ql ? p3(qs.rate8h - ql.rate8h) : '—';
      return `<div class="opp"><div><b>${esc(p.coin)}</b> short ${V[p.shortVenue].name} / long ${V[p.longVenue].name} · ${money(p.notional)}/leg<div class="why">opened ${tm(p.opened)} · funding ${money(p.funding)} · gap now ${gap}</div></div><b class="${u >= 0 ? 'pos' : 'neg'}">${money(u - p.entryFee)}</b></div>`;
    }).join('') : 'None';
    // log
    const lg = ST.fills.slice().reverse().slice(0, 120);
    $('log').className = 'log' + (lg.length ? '' : ' empty');
    $('log').innerHTML = lg.length ? lg.map(f => {
      const t = `<span class="mut">${new Date(f.t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span> `;
      if (f.type === 'open') return `<div>${t}<b>OPEN</b> ${esc(f.coin)} short ${V[f.short].name} / long ${V[f.long].name} · ${money(f.notional)}/leg · fees ${money(f.fee)} · net ${f.net}%</div>`;
      if (f.type === 'close') return `<div>${t}<b>CLOSE</b> ${esc(f.coin)} · <b class="${f.pnl > 0 ? 'pos' : 'neg'}">${money(f.pnl)}</b> · ${esc(f.why)}</div>`;
      return `<div>${t}funding ${esc(f.coin)} ${V[f.venue].name} ${f.side} · ${f.periods} period${f.periods > 1 ? 's' : ''} · total ${money(f.amount)}</div>`;
    }).join('') : 'No fills yet';
  }
  function renderClock() { $('updated').textContent = ST.lastStep ? ago(Date.now() - ST.lastStep) + ' ago' : '—'; }
  function drawCurve() {
    const cv = $('curve'), dpr = window.devicePixelRatio || 1, w = cv.clientWidth || 300, hh = 90;
    cv.width = w * dpr; cv.height = hh * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, hh);
    const pts = ST.curve; if (pts.length < 2) { g.fillStyle = '#8b98a7'; g.font = '12px -apple-system,sans-serif'; g.fillText('Equity curve fills in as the desk runs', 4, 50); return; }
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1; let lo = Math.min(...pts.map(p => p.e), ST.startWallet), hi = Math.max(...pts.map(p => p.e), ST.startWallet);
    if (hi - lo < 0.5) { hi += 0.25; lo -= 0.25; }
    const X = t => (t - t0) / Math.max(1, t1 - t0) * (w - 2) + 1, Y = e => hh - 6 - (e - lo) / (hi - lo) * (hh - 12);
    g.strokeStyle = '#1f2a36'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(0, Y(ST.startWallet)); g.lineTo(w, Y(ST.startWallet)); g.stroke(); g.setLineDash([]);
    g.strokeStyle = pts[pts.length - 1].e >= ST.startWallet ? '#2fd27a' : '#ff5d5d'; g.lineWidth = 2; g.beginPath();
    pts.forEach((p, i) => i ? g.lineTo(X(p.t), Y(p.e)) : g.moveTo(X(p.t), Y(p.e))); g.stroke();
  }

  // ---------- settings form
  function buildSettings() {
    const num = (k, label, step, min, max) => `<label>${label}<input type="number" data-k="${k}" value="${S[k]}" step="${step}" min="${min}" max="${max}" inputmode="decimal"></label>`;
    let h = num('startWallet', 'Starting wallet ($)', 1, 1, 1e7) + num('sizePct', 'Size per leg (% of wallet, max 25)', 0.5, 0.5, 25) +
      num('entryNetPct', 'Enter when net gap > (%)', 0.01, 0, 5) + num('exitGapPct', 'Exit when gap < (% per 8h)', 0.01, 0, 5) +
      num('holdPeriods', 'Expected hold (8h periods)', 1, 1, 30) + num('dailyLossPct', 'Daily loss cap (%)', 0.5, 0.5, 50) +
      num('maxConsecLosses', 'Pause after losses in a row', 1, 1, 20) + num('staleSec', 'Max data age (s)', 10, 10, 3600) +
      num('maxPriceGapPct', 'Max mark price gap (%)', 0.1, 0.1, 5);
    h += '<fieldset><legend>Venues · taker fee % (base tier, tap source)</legend>' + Object.entries(V).map(([id, v]) =>
      `<div class="fee"><input type="checkbox" data-en="${id}" ${S.enabled[id] !== false ? 'checked' : ''} aria-label="Use ${esc(v.name)}"><span>${esc(v.name)}${v.us ? ' <span class="us">US</span>' : ''} <a href="${v.feeSrc}" target="_blank" rel="noopener">source</a></span><input type="number" data-fee="${id}" value="${S.fees[id]}" step="0.005" min="0" max="1" inputmode="decimal" aria-label="${esc(v.name)} taker fee"></div>`).join('') + '</fieldset>';
    h += '<div class="full"><button type="button" id="btnReset">Reset paper account</button><button type="button" id="btnStreak">Clear loss streak</button></div>';
    $('settings').innerHTML = h;
    $('settings').addEventListener('change', ev => {
      const t = ev.target;
      if (t.dataset.k) { let v = parseFloat(t.value); if (!isFinite(v)) return; if (t.dataset.k === 'sizePct') v = Math.min(25, Math.max(0.5, v)); S[t.dataset.k] = v; t.value = v; }
      if (t.dataset.fee) { const v = parseFloat(t.value); if (isFinite(v) && v >= 0) S.fees[t.dataset.fee] = v; }
      if (t.dataset.en) S.enabled[t.dataset.en] = t.checked;
      save(); render();
    });
    $('btnReset').onclick = () => { if (confirm('Reset the paper account to ' + money(S.startWallet) + '? This clears positions and the log.')) { ST = FD.newState(S, Date.now()); save(); refresh(); } };
    $('btnStreak').onclick = () => { ST.consecLosses = 0; save(); render(); };
  }
  if (localStorage.getItem(LS.u) === PW_HASH) unlock(); // returning visitor: stays unlocked on this device
})();
