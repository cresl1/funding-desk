// Risk gates must REJECT the order when they should. Run: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const FD = require('../core.js');

const NOW = 1_800_000_000_000;
const S = () => JSON.parse(JSON.stringify(FD.DEFAULTS));
const q = (venue, coin, rate8h, mark, ageSec = 5) => FD.quote(venue, coin, rate8h / 8, 1, NOW + 3600e3, mark, NOW - ageSec * 1000);
// A setup that clears every gate: 0.60%/8h gap on SOL, fees ~0.19% round trip -> net ~0.41% > 0.14%
const good = () => ({ short: q('okx', 'SOL', 0.0065, 100), long: q('hyperliquid', 'SOL', 0.0005, 100.1) });
function ctx(over = {}) {
  const s = Object.assign(S(), over.settings || {});
  const state = Object.assign(FD.newState(s, NOW), over.state || {});
  const quotes = over.quotes || good();
  const order = Object.assign({ coin: 'SOL', shortVenue: quotes.short && quotes.short.venue, longVenue: quotes.long && quotes.long.venue, notional: FD.sizeFor(FD.equityOf(state), s.sizePct, s.maxSizePct) }, over.order || {});
  return { order, state, quotes, settings: s, now: NOW };
}
const gates = r => r.fails.map(f => f.gate);

test('baseline: a clean setup passes every gate', () => {
  const r = FD.riskCheck(ctx());
  assert.equal(r.ok, true, JSON.stringify(r.fails));
});

test('size: order bigger than the fixed % of the CURRENT wallet is rejected', () => {
  const r = FD.riskCheck(ctx({ order: { notional: 323 } })); // 38% of $850, the viral post's sizing
  assert.equal(r.ok, false); assert.ok(gates(r).includes('size'));
});
test('size: setting above the 25% max is rejected, not clipped', () => {
  const r = FD.riskCheck(ctx({ settings: { sizePct: 38 }, order: { notional: 323 } }));
  assert.equal(r.ok, false); assert.ok(gates(r).includes('size'));
});
test('size: never a function of the last trade (no sizing up after 3 wins)', () => {
  const s = S();
  const fresh = FD.newState(s, NOW), hot = Object.assign(FD.newState(s, NOW), { wins: 3, consecLosses: 0, trades: [{ pnl: 50 }, { pnl: 60 }, { pnl: 70 }] });
  assert.equal(FD.sizeFor(FD.equityOf(fresh), s.sizePct), FD.sizeFor(FD.equityOf(hot), s.sizePct));
  assert.equal(FD.sizeFor.length <= 3, true); // signature: (equity, pct, max) — no trade history argument exists
  assert.equal(FD.sizeFor(1000, 10), 100);
  assert.equal(FD.sizeFor(1000, 90), 250); // hard ceiling 25%
  const r = FD.riskCheck(ctx({ state: { wins: 3 }, order: { notional: 85 * 1.5 } })); // 1.5x after wins
  assert.ok(gates(r).includes('size'));
});

test('daily loss cap: no new entries once down 3% today', () => {
  const r = FD.riskCheck(ctx({ state: { cash: 824, dayStartEquity: 850 } })); // -3.06%
  assert.equal(r.ok, false); assert.ok(gates(r).includes('dailyLoss'));
});
test('daily loss cap: still open when down less than cap', () => {
  const r = FD.riskCheck(ctx({ state: { cash: 840, dayStartEquity: 850 } }));
  assert.ok(!gates(r).includes('dailyLoss'));
});

test('consecutive-loss breaker: 3 losses in a row pauses entries', () => {
  const r = FD.riskCheck(ctx({ state: { consecLosses: 3 } }));
  assert.equal(r.ok, false); assert.ok(gates(r).includes('lossStreak'));
});

test('stale-data breaker: a feed older than 120s blocks the entry', () => {
  const qs = good(); qs.long = q('hyperliquid', 'SOL', 0.0005, 100.1, 121);
  const r = FD.riskCheck(ctx({ quotes: qs }));
  assert.equal(r.ok, false); assert.ok(gates(r).includes('stale'));
});
test('stale-data breaker: a missing feed blocks the entry', () => {
  const r = FD.riskCheck(ctx({ quotes: { short: good().short, long: null }, order: { shortVenue: 'okx', longVenue: 'hyperliquid' } }));
  assert.equal(r.ok, false); assert.ok(gates(r).includes('stale'));
});

test('price-gap breaker: marks more than 0.5% apart block the entry', () => {
  const qs = good(); qs.long = q('hyperliquid', 'SOL', 0.0005, 100.6);
  const r = FD.riskCheck(ctx({ quotes: qs }));
  assert.equal(r.ok, false); assert.ok(gates(r).includes('priceGap'));
});

test('one position per coin: second SOL position is rejected', () => {
  const r = FD.riskCheck(ctx({ state: { positions: [{ coin: 'SOL', shortVenue: 'bitget', longVenue: 'dydx', notional: 85, entryS: 100, entryL: 100, lastMarkS: 100, lastMarkL: 100, funding: 0, entryFee: 0 }] } }));
  assert.equal(r.ok, false); assert.ok(gates(r).includes('onePerCoin'));
});

test('filter gate: net gap under 0.14% after fees is rejected', () => {
  const qs = { short: q('okx', 'SOL', 0.002, 100), long: q('hyperliquid', 'SOL', 0.0005, 100) }; // 0.15% gap - 0.19% fees
  const r = FD.riskCheck(ctx({ quotes: qs }));
  assert.equal(r.ok, false); assert.ok(gates(r).includes('filter'));
});
test('filter gate: shorting the LOW-funding leg is rejected', () => {
  const g = good(), r = FD.riskCheck(ctx({ quotes: { short: g.long, long: g.short } }));
  assert.ok(gates(r).includes('filter'));
});
test('manual pause blocks entries', () => {
  const r = FD.riskCheck(ctx({ state: { paused: true } }));
  assert.ok(gates(r).includes('manual'));
});
