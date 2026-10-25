// LIVE mode for Luis's own Coinbase account: same-account cash-and-carry (long spot + short the same size of the
// Coinbase US perp, collect hourly funding). OFF by default (config.json live.enabled = false).
// Hard gates below REJECT orders; they are not sliders. Every gate has a test in test/live.test.js.
// What this code can do on Coinbase: read balances/permissions/products/positions/fills, and create orders.
// What it cannot do: move money. There is no transfer, withdrawal, deposit or sweep call, and the client below
// refuses any endpoint that is not on its allow-list.
import crypto from 'node:crypto';
import { jwtFor } from '../coinbase-readonly.mjs';

export const LIVE_DEFAULTS = { enabled: false, maxNotionalUsd: 250, maxLossUsd: 25, maxOrdersPerDay: 4, coins: ['ETH', 'SOL'],
  horizonHours: 24, safetyFactor: 2, maxSlippagePct: 0.15, rearm: 0 };
export const PRODUCTS = { ETH: { spot: 'ETH-USD', code: 'ETP' }, SOL: { spot: 'SOL-USD', code: 'SLP' } };

// ---- the only endpoints this client will call
const B = '/api/v3/brokerage';
export const ALLOWED = [
  ['GET', new RegExp(`^${B}/key_permissions$`)], ['GET', new RegExp(`^${B}/accounts$`)],
  ['GET', new RegExp(`^${B}/transaction_summary$`)], ['GET', new RegExp(`^${B}/products$`)],
  ['GET', new RegExp(`^${B}/best_bid_ask$`)], ['GET', new RegExp(`^${B}/cfm/balance_summary$`)],
  ['GET', new RegExp(`^${B}/cfm/positions$`)], ['GET', new RegExp(`^${B}/orders/historical/[A-Za-z0-9-]+$`)],
  ['POST', new RegExp(`^${B}/orders$`)]
];
export function allowed(method, path) { return ALLOWED.some(([m, re]) => m === method && re.test(path.split('?')[0])); }

export function makeClient(key, fetchImpl = fetch) {
  async function call(method, path, body) {
    if (!allowed(method, path)) throw new Error(`blocked: ${method} ${path.split('?')[0]} is not on the allow-list`);
    const r = await fetchImpl('https://api.coinbase.com' + path, { method, signal: AbortSignal.timeout(15000),
      headers: { Authorization: 'Bearer ' + jwtFor(key, method, path.split('?')[0]), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(`Coinbase ${method} ${path.split('?')[0].split('/').slice(-1)[0]} HTTP ${r.status}`); e.status = r.status; throw e; }
    return j;
  }
  return { get: p => call('GET', p), post: (p, b) => call('POST', p, b) };
}

const n = v => { const x = parseFloat(v && typeof v === 'object' ? v.value : v); return Number.isFinite(x) ? x : 0; };
const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
export const newLiveState = () => ({ v: 1, idp: crypto.randomBytes(3).toString('hex'), day: null, ordersToday: 0, entries: 0, halted: false, haltReason: null, rearm: 0, position: null, realizedPnl: 0, trades: [] });

// ---- read everything the decision needs (GET only)
export async function readMarket(api, cfg) {
  const perm = await api.get(`${B}/key_permissions`);
  const acc = await api.get(`${B}/accounts?limit=250`);
  let cashUSD = 0; const spotHold = {};
  for (const a of acc.accounts || []) {
    if (a.currency === 'USD') cashUSD += n(a.available_balance);
    if (PRODUCTS[a.currency]) spotHold[a.currency] = (spotHold[a.currency] || 0) + n(a.available_balance);
  }
  const ts = await api.get(`${B}/transaction_summary?product_type=SPOT`);
  const tf = await api.get(`${B}/transaction_summary?product_type=FUTURE`).catch(() => ({}));
  let futures = null, perpPositions = [];
  try {
    const b = (await api.get(`${B}/cfm/balance_summary`)).balance_summary || {};
    futures = { buyingPower: n(b.futures_buying_power), cash: n(b.cfm_usd_balance), unrealizedPnl: n(b.unrealized_pnl) };
    perpPositions = ((await api.get(`${B}/cfm/positions`)).positions || []).map(p => ({ product: p.product_id, side: p.side, contracts: n(p.number_of_contracts) }));
  } catch (e) { futures = null; }
  const fut = await api.get(`${B}/products?product_type=FUTURE&contract_expiry_type=PERPETUAL`);
  const coins = {};
  for (const c of cfg.coins) {
    const P = PRODUCTS[c]; if (!P) continue;
    const perp = (fut.products || []).find(p => (p.future_product_details || {}).contract_code === P.code);
    if (!perp) continue;
    const d = perp.future_product_details;
    const bba = await api.get(`${B}/best_bid_ask?product_ids=${P.spot}&product_ids=${perp.product_id}`);
    const book = id => (bba.pricebooks || []).find(b => b.product_id === id) || {};
    const sb = book(P.spot), pb = book(perp.product_id);
    coins[c] = { spot: P.spot, perp: perp.product_id, contractSize: n(d.contract_size), fundingHourly: n(d.funding_rate),
      spotBid: n((sb.bids || [])[0] && sb.bids[0].price), spotAsk: n((sb.asks || [])[0] && sb.asks[0].price),
      perpBid: n((pb.bids || [])[0] && pb.bids[0].price), perpAsk: n((pb.asks || [])[0] && pb.asks[0].price), perpMark: n(perp.price) };
  }
  const tier = x => x && x.fee_tier ? { maker: n(x.fee_tier.maker_fee_rate), taker: n(x.fee_tier.taker_fee_rate) } : null;
  return { perms: { canTrade: !!perm.can_trade, canTransfer: !!perm.can_transfer, canView: !!perm.can_view },
    cashUSD, spotHold, futures, perpPositions, fees: { spot: tier(ts), perp: tier(tf) }, coins };
}

// Perp fee: Coinbase US futures charge per contract; when the API gives no rate we assume 0.10% per side (conservative).
const PERP_FEE_FALLBACK = 0.001;
export function edgeFor(m, coin, cfg, contracts) {
  const c = m.coins[coin];
  const notional = contracts * c.contractSize * c.perpMark;
  const spotTaker = m.fees.spot ? m.fees.spot.taker : 0.012, perpTaker = m.fees.perp && m.fees.perp.taker > 0 ? m.fees.perp.taker : PERP_FEE_FALLBACK;
  const fees = notional * 2 * (spotTaker + perpTaker); // both legs, in and out, taker
  const expected = notional * c.fundingHourly * cfg.horizonHours;
  return { notional, fees, expected, need: fees * cfg.safetyFactor, spotTaker, perpTaker };
}

// ---- hard gates for an ENTRY. Any failure rejects the order.
export function liveGates({ cfg, ls, m, coin, contracts, paused }) {
  const fails = [], f = (gate, msg) => fails.push({ gate, msg });
  if (cfg.enabled !== true) f('liveOff', 'live mode is off');
  if (paused) f('paused', 'agent paused');
  if (ls.halted) f('halted', 'halted: ' + (ls.haltReason || 'safety stop'));
  if (!m.perms.canTrade) f('permissions', 'key has no Trade permission');
  if (m.perms.canTransfer) f('transferPermission', 'key has Transfer permission: refusing to trade until it is replaced with a View+Trade key');
  if (ls.position) f('onePosition', 'already holding a position');
  if (ls.ordersToday + 4 > cfg.maxOrdersPerDay) f('ordersPerDay', `${ls.ordersToday} orders today; an entry needs 2 + 2 for its exit (max ${cfg.maxOrdersPerDay})`);
  if (ls.realizedPnl <= -cfg.maxLossUsd) f('lossCap', `realized loss $${(-ls.realizedPnl).toFixed(2)} ≥ cap $${cfg.maxLossUsd}`);
  if (!m.futures) f('futures', 'no Coinbase futures account on this key (enable futures in Coinbase)');
  const c = m.coins[coin];
  if (!c) { f('market', `${coin} perp not found`); return { ok: false, fails }; }
  if (!(contracts >= 1)) f('contractFit', `smallest ${coin} contract (${c.contractSize} ${coin} ≈ $${(c.contractSize * c.perpMark).toFixed(0)}) is above the $${cfg.maxNotionalUsd} cap`);
  const e = edgeFor(m, coin, cfg, Math.max(contracts, 1));
  if (contracts >= 1 && e.notional > cfg.maxNotionalUsd) f('notional', `$${e.notional.toFixed(2)} > cap $${cfg.maxNotionalUsd}`);
  if (!(c.fundingHourly > 0)) f('edge', `funding ${(c.fundingHourly * 100).toFixed(4)}%/h is not positive`);
  else if (e.expected < e.need) f('edge', `expected funding $${e.expected.toFixed(2)} over ${cfg.horizonHours}h < ${cfg.safetyFactor}× fees $${e.need.toFixed(2)}`);
  // 1x: the short is fully collateralised and exactly the size of the spot leg, never more.
  if (m.futures && m.futures.buyingPower < e.notional) f('funds', `futures buying power $${m.futures.buyingPower.toFixed(2)} < hedge $${e.notional.toFixed(2)}`);
  if (m.cashUSD < e.notional * (1 + e.spotTaker) + 1) f('funds', `USD cash $${m.cashUSD.toFixed(2)} < spot leg $${(e.notional * (1 + e.spotTaker)).toFixed(2)}`);
  const known = ls.position ? [ls.position.perp] : [];
  const stray = (m.perpPositions || []).filter(p => p.contracts > 0 && !known.includes(p.product));
  if (stray.length) f('unknownPosition', 'account holds futures positions the agent did not open; not trading');
  return { ok: fails.length === 0, fails, edge: e };
}

export function contractsFor(m, coin, cfg) {
  const c = m.coins[coin]; if (!c || !(c.contractSize * c.perpMark > 0)) return 0;
  return Math.floor(cfg.maxNotionalUsd / (c.contractSize * c.perpMark));
}

// ---- orders: limit IOC with a price cap for entries, market IOC for exits/unwinds. Fills verified from the API.
const px = (x, inc = 0.01) => (Math.round(x / inc) * inc).toFixed(2);
async function placeAndVerify(api, { id, product, side, size, limit }, sleep) {
  const cfgO = limit ? { sor_limit_ioc: { base_size: String(size), limit_price: px(limit) } } : { market_market_ioc: { base_size: String(size) } };
  const r = await api.post(`${B}/orders`, { client_order_id: id, product_id: product, side, order_configuration: cfgO });
  const oid = r.success_response && r.success_response.order_id || r.order_id;
  if (!r.success || !oid) return { filled: 0, avg: 0, fee: 0, error: (r.error_response && (r.error_response.message || r.error_response.error)) || 'order rejected' };
  for (let i = 0; i < 8; i++) {
    const o = (await api.get(`${B}/orders/historical/${oid}`)).order || {};
    if (['FILLED', 'CANCELLED', 'EXPIRED', 'FAILED'].includes(o.status) || i === 7)
      return { filled: n(o.filled_size), avg: n(o.average_filled_price), fee: n(o.total_fees), status: o.status };
    await sleep(1500);
  }
}

export async function runLive({ api, cfg, ls, m, paused, now, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const log = [];
  if (ls.day !== dayKey(now)) { ls.day = dayKey(now); ls.ordersToday = 0; }
  if ((cfg.rearm || 0) !== (ls.rearm || 0)) { ls.rearm = cfg.rearm || 0; ls.halted = false; ls.haltReason = null; log.push('re-armed by config'); }
  const halt = why => { ls.halted = true; ls.haltReason = why; log.push('HALT: ' + why); };
  const place = async o => { ls.ordersToday++; return placeAndVerify(api, o, sleep); };

  // 1) manage an open position (exits are never blocked by the order cap: they only reduce risk)
  if (ls.position) {
    const p = ls.position, c = m.coins[p.coin];
    const pnl = c ? p.baseQty * ((c.spotBid || c.perpMark) - p.spotEntry) + p.contracts * p.contractSize * (p.perpEntry - (c.perpAsk || c.perpMark)) - p.fees : 0;
    p.unrealizedPnl = +pnl.toFixed(2);
    let why = null;
    if (pnl + ls.realizedPnl <= -cfg.maxLossUsd) why = 'loss cap';
    else if (cfg.enabled !== true) why = 'kill switch (live off)';
    else if (c && !(c.fundingHourly > 0)) why = 'funding flipped';
    if (why) {
      const seq = p.seq;
      const a = await place({ id: `fd-${seq}-perp-close`, product: p.perp, side: 'BUY', size: p.contracts });
      const b = await place({ id: `fd-${seq}-spot-close`, product: p.spot, side: 'SELL', size: p.baseQty });
      if (a.filled + 1e-9 < p.contracts || b.filled + 1e-9 < p.baseQty) halt('exit not fully filled: check Coinbase positions by hand');
      const real = b.filled * b.avg - p.baseQty * p.spotEntry + a.filled * p.contractSize * (p.perpEntry - a.avg) - p.fees - a.fee - b.fee;
      ls.realizedPnl = +(ls.realizedPnl + real).toFixed(2);
      ls.trades.push({ coin: p.coin, opened: p.openedAt, closed: now, notional: +(p.baseQty * p.spotEntry).toFixed(2), pnl: +real.toFixed(2), why });
      if (ls.trades.length > 200) ls.trades.splice(0, ls.trades.length - 200);
      ls.position = null; log.push(`closed ${p.coin}: ${why}, P&L $${real.toFixed(2)}`);
      if (why === 'loss cap') halt('loss cap reached ($' + cfg.maxLossUsd + ')');
    }
    return { log, decision: why ? 'exit' : 'hold' };
  }

  // 2) look for an entry
  let best = null; const checks = {};
  for (const coin of cfg.coins) {
    const contracts = contractsFor(m, coin, cfg);
    const g = liveGates({ cfg, ls, m, coin, contracts, paused });
    checks[coin] = g.ok ? 'ready' : g.fails.map(x => x.msg).join('; ');
    if (g.ok && (!best || g.edge.expected - g.edge.need > best.g.edge.expected - best.g.edge.need)) best = { coin, contracts, g };
  }
  if (!best) return { log, decision: 'none', checks };
  const { coin, contracts } = best, c = m.coins[coin], seq = `${ls.idp || 'x'}-${ls.entries + 1}`, slip = cfg.maxSlippagePct / 100;
  // short the perp first (limit IOC, never below bid − slippage), then buy exactly that much spot
  const s = await place({ id: `fd-${seq}-perp-open`, product: c.perp, side: 'SELL', size: contracts, limit: c.perpBid * (1 - slip) });
  if (!(s.filled > 0)) { ls.entries++; log.push(`${coin} perp short did not fill; nothing held`); return { log, decision: 'no fill', checks }; }
  const baseQty = +(s.filled * c.contractSize).toFixed(8);
  const l = await place({ id: `fd-${seq}-spot-open`, product: c.spot, side: 'BUY', size: baseQty, limit: c.spotAsk * (1 + slip) });
  ls.entries++;
  if (l.filled + 1e-9 < baseQty) {
    // one leg failed: unwind what filled, at once, and halt
    await place({ id: `fd-${seq}-perp-unwind`, product: c.perp, side: 'BUY', size: s.filled });
    if (l.filled > 0) await place({ id: `fd-${seq}-spot-unwind`, product: c.spot, side: 'SELL', size: l.filled });
    halt(`${coin} spot leg failed after the perp filled; both legs unwound`);
    return { log, decision: 'unwound', checks };
  }
  ls.position = { seq, coin, spot: c.spot, perp: c.perp, contracts: s.filled, contractSize: c.contractSize, baseQty,
    spotEntry: l.avg, perpEntry: s.avg, fees: +(s.fee + l.fee).toFixed(4), openedAt: now };
  log.push(`opened ${coin} carry: long ${baseQty} spot @ ${l.avg}, short ${s.filled} perp @ ${s.avg}`);
  return { log, decision: 'enter', checks };
}

// Public summary for state.json: no key names, account ids or order ids, ever.
export function liveSummary(cfg, ls, m, res, err) {
  return { enabled: cfg.enabled === true, halted: !!ls.halted, haltReason: ls.haltReason, caps: { maxNotionalUsd: cfg.maxNotionalUsd, maxLossUsd: cfg.maxLossUsd, maxOrdersPerDay: cfg.maxOrdersPerDay },
    ordersToday: ls.ordersToday, realizedPnl: ls.realizedPnl, position: ls.position ? { coin: ls.position.coin, baseQty: ls.position.baseQty, contracts: ls.position.contracts,
      spotEntry: ls.position.spotEntry, perpEntry: ls.position.perpEntry, unrealizedPnl: ls.position.unrealizedPnl || 0, openedAt: ls.position.openedAt } : null,
    trades: ls.trades.slice(-20), decision: res ? res.decision : null, checks: res ? res.checks : null, log: res ? res.log : [],
    permissions: m ? m.perms : null, error: err || null,
    funding: m ? Object.fromEntries(Object.entries(m.coins).map(([k, c]) => [k, { hourlyPct: +(c.fundingHourly * 100).toFixed(5), contractUsd: +(c.contractSize * c.perpMark).toFixed(2) }])) : null,
    fees: m ? m.fees : null };
}
