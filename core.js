/* Funding Desk core: venue metadata, normalizers, opportunity filter, risk gates, paper engine.
   Pure functions, no DOM. Works in the browser (window.FD) and in Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FD = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const HOUR = 3600e3;
  const COINS = ['SOL', 'ETH'];

  // Taker fees are base-tier defaults (percent). Edit them in Settings to match your account tier.
  const VENUES = {
    hyperliquid: { name: 'Hyperliquid', us: false, live: true, fee: 0.045, feeSrc: 'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees', note: 'Blocks US persons' },
    okx: { name: 'OKX', us: false, live: true, fee: 0.05, feeSrc: 'https://www.okx.com/fees', note: 'Perps not offered to US users' },
    dydx: { name: 'dYdX', us: false, live: true, fee: 0.05, feeSrc: 'https://docs.dydx.xyz/concepts/trading/rewards-fees-and-parameters', note: 'Front end blocks US' },
    bitget: { name: 'Bitget', us: false, live: true, fee: 0.06, feeSrc: 'https://www.bitget.com/fee', note: 'Not licensed in US' },
    binance: { name: 'Binance', us: false, live: true, fee: 0.05, feeSrc: 'https://www.binance.com/en/fee/futureFee', note: 'Blocks US (HTTP 451)' },
    bybit: { name: 'Bybit', us: false, live: true, fee: 0.055, feeSrc: 'https://www.bybit.com/en/help-center/article/Trading-Fee-Structure', note: 'Blocks US (HTTP 403)' },
    coinbase: { name: 'Coinbase US', us: true, live: false, fee: 0.05, feeSrc: 'https://www.coinbase.com/derivatives', note: 'US perp-style futures (CFM). Fee is an estimate, check your tier' },
    kraken: { name: 'Kraken Futures', us: true, live: false, fee: 0.05, feeSrc: 'https://www.kraken.com/features/fee-schedule', note: 'US access for eligible clients' },
    coinbaseintl: { name: 'Coinbase Intl', us: false, live: false, fee: 0.05, feeSrc: 'https://www.coinbase.com/international-exchange/fees', note: 'Non-US only' }
  };

  const DEFAULTS = {
    startWallet: 850, sizePct: 10, maxSizePct: 25, entryNetPct: 0.14, exitGapPct: 0.05, holdPeriods: 1,
    dailyLossPct: 3, maxConsecLosses: 3, staleSec: 120, maxPriceGapPct: 0.5,
    fees: Object.fromEntries(Object.entries(VENUES).map(([k, v]) => [k, v.fee])),
    enabled: Object.fromEntries(Object.keys(VENUES).map(k => [k, k !== 'coinbaseintl']))
  };

  const nextHour = now => Math.floor(now / HOUR) * HOUR + HOUR;
  function quote(venue, coin, ratePerInterval, intervalH, nextFunding, mark, ts) {
    const r = Number(ratePerInterval), m = Number(mark), iv = Number(intervalH) || 8;
    if (!isFinite(r) || !isFinite(m) || m <= 0) return null;
    const rateHour = r / iv;
    return { venue, coin, rateHour, rate8h: rateHour * 8, apr: rateHour * 24 * 365, intervalH: iv,
      nextFunding: Number(nextFunding) || null, mark: m, ts };
  }

  // ---- normalizers: raw venue JSON -> {SOL: quote, ETH: quote}
  const N = {
    hyperliquid(raw, ts) {
      const [meta, ctxs] = raw, out = {};
      meta.universe.forEach((u, i) => { if (COINS.includes(u.name)) out[u.name] = quote('hyperliquid', u.name, ctxs[i].funding, 1, nextHour(ts), ctxs[i].markPx, ts); });
      return out;
    },
    okx(rawByCoin, ts) { // {SOL:{fr, mk}}
      const out = {};
      for (const c of COINS) {
        const f = rawByCoin[c] && rawByCoin[c].fr.data[0], m = rawByCoin[c] && rawByCoin[c].mk.data[0];
        if (!f || !m) continue;
        const iv = (Number(f.fundingTime) - Number(f.prevFundingTime)) / HOUR || 8;
        out[c] = quote('okx', c, f.fundingRate, iv, f.fundingTime, m.markPx, ts);
      }
      return out;
    },
    dydx(raw, ts) {
      const out = {};
      for (const c of COINS) { const m = raw.markets[c + '-USD']; if (m) out[c] = quote('dydx', c, m.nextFundingRate, 1, nextHour(ts), m.oraclePrice, ts); }
      return out;
    },
    bitget(rawByCoin, ts) {
      const out = {};
      for (const c of COINS) {
        const f = rawByCoin[c] && rawByCoin[c].fr.data[0], p = rawByCoin[c] && rawByCoin[c].px.data[0];
        if (f && p) out[c] = quote('bitget', c, f.fundingRate, f.fundingRateInterval || 8, f.nextUpdate, p.markPrice, ts);
      }
      return out;
    },
    binance(rawByCoin, ts) {
      const out = {};
      for (const c of COINS) { const r = rawByCoin[c]; if (r && r.markPrice) out[c] = quote('binance', c, r.lastFundingRate, 8, r.nextFundingTime, r.markPrice, ts); }
      return out;
    },
    bybit(rawByCoin, ts) {
      const out = {};
      for (const c of COINS) {
        const r = rawByCoin[c] && rawByCoin[c].result && rawByCoin[c].result.list[0];
        if (r) out[c] = quote('bybit', c, r.fundingRate, r.fundingIntervalHour || 8, r.nextFundingTime, r.markPrice, ts);
      }
      return out;
    },
    coinbase(raw, ts) { // Advanced Trade public products, product_type=FUTURE; perp-style = SLP/ETP-20DEC30-CDE
      const out = {}, map = { SOL: 'SLP', ETH: 'ETP' };
      for (const c of COINS) {
        const p = raw.products.find(x => x.future_product_details && x.future_product_details.contract_code === map[c]);
        if (!p) continue;
        const d = p.future_product_details, iv = parseInt(d.funding_interval || '3600', 10) / 3600 || 1;
        const last = Date.parse(d.funding_time);
        out[c] = quote('coinbase', c, d.funding_rate, iv, isFinite(last) ? Math.max(last + iv * HOUR, nextHour(ts)) : nextHour(ts), p.mid_market_price && Number(p.mid_market_price) > 0 ? p.mid_market_price : p.price, ts);
      }
      return out;
    },
    kraken(raw, ts) {
      const out = {};
      for (const c of COINS) { const t = raw.tickers.find(x => x.symbol === 'PF_' + c + 'USD'); if (t) out[c] = quote('kraken', c, t.relativeFundingRate, 1, nextHour(ts), t.markPrice, ts); }
      return out;
    },
    coinbaseintl(raw, ts) { // same public products list, venue INTX; Coinbase stopped updating these for US callers
      const out = {};
      for (const c of COINS) {
        const p = raw.products.find(x => x.product_id === c + '-PERP-INTX');
        if (!p) continue;
        const d = p.future_product_details.perpetual_details || {}, at = Date.parse(d.funding_time);
        const q = quote('coinbaseintl', c, d.funding_rate, 1, null, p.price, isFinite(at) ? at : ts);
        if (q) out[c] = q;
      }
      return out;
    }
  };

  // ---- opportunity filter
  const pct = x => x / 100;
  function roundTripFee(s, a, b) { return 2 * (pct(s.fees[a] ?? VENUES[a].fee) + pct(s.fees[b] ?? VENUES[b].fee)); }
  function evaluatePair(qa, qb, s) {
    const [hi, lo] = qa.rate8h >= qb.rate8h ? [qa, qb] : [qb, qa];
    const gap = hi.rate8h - lo.rate8h, fees = roundTripFee(s, hi.venue, lo.venue);
    const net = gap * (s.holdPeriods || 1) - fees;
    const pass = net > pct(s.entryNetPct);
    let reason = pass ? 'passes filter' : `net ${(net * 100).toFixed(3)}% ≤ ${s.entryNetPct}%`;
    if (!pass && hi.rate8h <= 0 && lo.rate8h <= 0) reason += ' (both negative)';
    return { coin: qa.coin, shortVenue: hi.venue, longVenue: lo.venue, gap, fees, net, pass, reason };
  }
  function scan(quotesByCoin, s) { // quotesByCoin: {SOL:[q...], ETH:[...]}
    const out = {};
    for (const c of COINS) {
      const qs = (quotesByCoin[c] || []).filter(q => q && s.enabled[q.venue] !== false), pairs = [];
      for (let i = 0; i < qs.length; i++) for (let j = i + 1; j < qs.length; j++) pairs.push(evaluatePair(qs[i], qs[j], s));
      out[c] = pairs.sort((a, b) => b.net - a.net);
    }
    return out;
  }

  // ---- sizing: ONLY current wallet x fixed percent. No trade history goes in, by design.
  function sizeFor(equity, sizePct, maxSizePct = 25) {
    const p = Math.min(Math.max(Number(sizePct) || 0, 0), Math.min(maxSizePct, 25));
    return Math.floor(equity * p) / 100;
  }

  // ---- risk gates: every entry passes ALL of these or is rejected. Order matters only for display.
  function riskCheck({ order, state, quotes, settings: s, now }) {
    const fails = [], f = (gate, msg) => fails.push({ gate, msg });
    const equity = equityOf(state, quotes.byVenueCoin || null);
    if (state.paused) f('manual', 'desk paused by you');
    if (!(s.sizePct > 0) || s.sizePct > 25 || s.sizePct > s.maxSizePct) f('size', `size ${s.sizePct}% outside 0–${Math.min(25, s.maxSizePct)}%`);
    const want = sizeFor(equity, s.sizePct, s.maxSizePct);
    if (!(order.notional > 0) || Math.abs(order.notional - want) > 0.01) f('size', `order $${(+order.notional).toFixed(2)} ≠ ${s.sizePct}% of wallet ($${want.toFixed(2)})`);
    const dayPnl = equity - state.dayStartEquity;
    if (dayPnl <= -pct(s.dailyLossPct) * state.dayStartEquity) f('dailyLoss', `down $${(-dayPnl).toFixed(2)} today (cap ${s.dailyLossPct}%)`);
    if (state.consecLosses >= s.maxConsecLosses) f('lossStreak', `${state.consecLosses} losses in a row (limit ${s.maxConsecLosses})`);
    const qs = quotes.short, ql = quotes.long;
    if (!qs || !ql) f('stale', 'missing feed');
    else {
      for (const q of [qs, ql]) { const age = (now - q.ts) / 1000; if (!(age <= s.staleSec)) f('stale', `${VENUES[q.venue].name} data ${Math.round(age)}s old (max ${s.staleSec}s)`); }
      const mid = (qs.mark + ql.mark) / 2, dev = Math.abs(qs.mark - ql.mark) / mid * 100;
      if (!(dev <= s.maxPriceGapPct)) f('priceGap', `marks differ ${dev.toFixed(2)}% (max ${s.maxPriceGapPct}%)`);
      const ev = evaluatePair(qs, ql, s);
      if (!ev.pass || ev.shortVenue !== qs.venue) f('filter', ev.pass ? 'short leg is not the high-funding venue' : ev.reason);
    }
    if ((state.positions || []).some(p => p.coin === order.coin)) f('onePerCoin', `already holding ${order.coin}`);
    if (!(equity > 0)) f('size', 'wallet empty');
    return { ok: fails.length === 0, fails };
  }

  // ---- paper engine
  function newState(s, now) {
    return { cash: s.startWallet, startWallet: s.startWallet, positions: [], fills: [], trades: [], curve: [{ t: now, e: s.startWallet }],
      wins: 0, losses: 0, consecLosses: 0, paused: false, day: dayKey(now), dayStartEquity: s.startWallet, skips: {}, lastStep: now };
  }
  function dayKey(t) { const d = new Date(t); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function legPnl(p, qs, ql) {
    const ms = qs ? qs.mark : p.lastMarkS, ml = ql ? ql.mark : p.lastMarkL;
    return p.notional * (p.entryS - ms) / p.entryS + p.notional * (ml - p.entryL) / p.entryL;
  }
  function unrealized(p, byVC) {
    const qs = byVC && byVC[p.shortVenue + ':' + p.coin], ql = byVC && byVC[p.longVenue + ':' + p.coin];
    return legPnl(p, qs, ql) + p.funding;
  }
  function equityOf(state, byVC) { return state.cash + (state.positions || []).reduce((a, p) => a + unrealized(p, byVC), 0); }
  function indexQuotes(list) { const m = {}; for (const q of list) if (q) m[q.venue + ':' + q.coin] = q; return m; }

  function accrue(p, leg, q, now, log) {
    const k = leg === 'S' ? 'nextS' : 'nextL';
    if (!q || !p[k]) return;
    let n = 0;
    while (now >= p[k] && n < 500) {
      const pay = p.notional * q.rateHour * q.intervalH * (leg === 'S' ? 1 : -1);
      p.funding += pay; p[k] += q.intervalH * HOUR; n++;
    }
    if (n) log.push({ t: now, type: 'funding', coin: p.coin, venue: q.venue, side: leg === 'S' ? 'short' : 'long', amount: +(p.funding).toFixed(4), periods: n });
  }

  function step(state, quoteList, s, now) {
    const byVC = indexQuotes(quoteList), events = [];
    if (dayKey(now) !== state.day) { state.day = dayKey(now); state.dayStartEquity = equityOf(state, byVC); }
    // 1) manage open positions
    for (const p of [...state.positions]) {
      const qs = byVC[p.shortVenue + ':' + p.coin], ql = byVC[p.longVenue + ':' + p.coin];
      accrue(p, 'S', qs, now, events); accrue(p, 'L', ql, now, events);
      if (qs) p.lastMarkS = qs.mark; if (ql) p.lastMarkL = ql.mark;
      const fresh = qs && ql && (now - qs.ts) / 1000 <= s.staleSec && (now - ql.ts) / 1000 <= s.staleSec;
      if (!fresh) continue; // never exit on stale prices; hold and wait for fresh data
      const gap = qs.rate8h - ql.rate8h;
      let why = null;
      if (gap <= 0) why = 'funding flipped';
      else if (gap < pct(s.exitGapPct)) why = `gap compressed to ${(gap * 100).toFixed(3)}%`;
      if (why) close(state, p, qs, ql, s, now, why);
    }
    // 2) look for entries
    const scanned = scan(groupByCoin(quoteList), s);
    state.skips = {};
    for (const c of COINS) {
      const pairs = scanned[c], best = pairs.find(x => x.pass);
      if (!best) { state.skips[c] = pairs.length ? pairs[0].reason : 'no venue pair with data'; continue; }
      const order = { coin: c, shortVenue: best.shortVenue, longVenue: best.longVenue, notional: sizeFor(equityOf(state, byVC), s.sizePct, s.maxSizePct) };
      const quotes = { short: byVC[best.shortVenue + ':' + c], long: byVC[best.longVenue + ':' + c], byVenueCoin: byVC };
      const chk = riskCheck({ order, state, quotes, settings: s, now });
      if (!chk.ok) { state.skips[c] = 'blocked: ' + chk.fails.map(x => x.msg).join('; '); continue; }
      open(state, order, quotes, s, now, best);
    }
    const e = equityOf(state, byVC), last = state.curve[state.curve.length - 1];
    if (!last || now - last.t >= 60e3 || Math.abs(last.e - e) > 0.005) state.curve.push({ t: now, e: +e.toFixed(4) });
    if (state.curve.length > 3000) state.curve.splice(0, state.curve.length - 3000);
    state.lastStep = now;
    state.fills.push(...events.slice(-20));
    if (state.fills.length > 500) state.fills.splice(0, state.fills.length - 500);
    return state;
  }
  function open(state, o, q, s, now, ev) {
    const fee = o.notional * (pct(s.fees[o.shortVenue]) + pct(s.fees[o.longVenue]));
    state.cash -= fee;
    state.positions.push({ id: now.toString(36), coin: o.coin, shortVenue: o.shortVenue, longVenue: o.longVenue, notional: o.notional,
      entryS: q.short.mark, entryL: q.long.mark, lastMarkS: q.short.mark, lastMarkL: q.long.mark, opened: now, entryFee: fee, funding: 0,
      nextS: q.short.nextFunding || nextHour(now), nextL: q.long.nextFunding || nextHour(now), entryNet: ev.net });
    state.fills.push({ t: now, type: 'open', coin: o.coin, short: o.shortVenue, long: o.longVenue, notional: o.notional, fee: +fee.toFixed(4), net: +(ev.net * 100).toFixed(3) });
  }
  function close(state, p, qs, ql, s, now, why) {
    const exitFee = p.notional * (pct(s.fees[p.shortVenue]) + pct(s.fees[p.longVenue]));
    const price = legPnl(p, qs, ql), pnl = price + p.funding - p.entryFee - exitFee;
    state.cash += price + p.funding - exitFee;
    state.positions = state.positions.filter(x => x !== p);
    if (pnl > 0) { state.wins++; state.consecLosses = 0; } else { state.losses++; state.consecLosses++; }
    state.trades.push({ coin: p.coin, short: p.shortVenue, long: p.longVenue, notional: p.notional, opened: p.opened, closed: now, funding: +p.funding.toFixed(4), price: +price.toFixed(4), fees: +(p.entryFee + exitFee).toFixed(4), pnl: +pnl.toFixed(4), why });
    state.fills.push({ t: now, type: 'close', coin: p.coin, short: p.shortVenue, long: p.longVenue, notional: p.notional, fee: +exitFee.toFixed(4), pnl: +pnl.toFixed(4), why });
  }
  function groupByCoin(list) { const g = {}; for (const q of list) if (q) (g[q.coin] = g[q.coin] || []).push(q); return g; }

  function breakers(state, quoteList, s, now) {
    const byVC = indexQuotes(quoteList), e = equityOf(state, byVC), dayPnl = e - state.dayStartEquity;
    const stale = quoteList.filter(q => q && s.enabled[q.venue] !== false && (now - q.ts) / 1000 > s.staleSec).map(q => VENUES[q.venue].name).filter((n, i, a) => a.indexOf(n) === i);
    const gaps = [];
    for (const c of COINS) {
      const qs = quoteList.filter(q => q && q.coin === c && s.enabled[q.venue] !== false && (now - q.ts) / 1000 <= s.staleSec);
      for (let i = 0; i < qs.length; i++) for (let j = i + 1; j < qs.length; j++) {
        const d = Math.abs(qs[i].mark - qs[j].mark) / ((qs[i].mark + qs[j].mark) / 2) * 100;
        if (d > s.maxPriceGapPct) gaps.push(`${c} ${VENUES[qs[i].venue].name}/${VENUES[qs[j].venue].name} ${d.toFixed(2)}%`);
      }
    }
    return [
      { id: 'size', name: 'Fixed size', tripped: !(s.sizePct > 0 && s.sizePct <= Math.min(25, s.maxSizePct)), detail: `${s.sizePct}% of wallet = $${sizeFor(e, s.sizePct, s.maxSizePct).toFixed(2)}/leg` },
      { id: 'dailyLoss', name: 'Daily loss cap', tripped: dayPnl <= -pct(s.dailyLossPct) * state.dayStartEquity, detail: `today ${dayPnl >= 0 ? '+' : '−'}$${Math.abs(dayPnl).toFixed(2)} / cap ${s.dailyLossPct}%` },
      { id: 'lossStreak', name: 'Loss streak', tripped: state.consecLosses >= s.maxConsecLosses, detail: `${state.consecLosses} of ${s.maxConsecLosses}` },
      { id: 'stale', name: 'Stale data', tripped: stale.length > 0, detail: stale.length ? stale.join(', ') + ` older than ${s.staleSec}s, their pairs blocked` : `all feeds < ${s.staleSec}s` },
      { id: 'priceGap', name: 'Price gap', tripped: gaps.length > 0, detail: gaps.length ? gaps.join('; ') : `marks within ${s.maxPriceGapPct}%` },
      { id: 'onePerCoin', name: '1 per coin', tripped: false, detail: `${state.positions.length} open` }
    ];
  }

  return { HOUR, COINS, VENUES, DEFAULTS, N, quote, nextHour, scan, evaluatePair, roundTripFee, sizeFor, riskCheck, newState, step, equityOf, indexQuotes, breakers, groupByCoin };
});
