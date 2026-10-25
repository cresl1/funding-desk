// Paper engine behaviour. Run: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const FD = require('../core.js');
const T0 = 1_800_000_000_000, H = 3600e3;
const S = () => JSON.parse(JSON.stringify(FD.DEFAULTS));
const q = (venue, coin, rate8h, mark, t, nextF) => FD.quote(venue, coin, rate8h / 8, 1, nextF ?? (Math.floor(t / H) * H + H), mark, t);

test('enters short on high-funding venue, long on the other, sized 10% of wallet', () => {
  const s = S(), st = FD.newState(s, T0);
  FD.step(st, [q('okx', 'SOL', 0.0065, 100, T0), q('hyperliquid', 'SOL', 0.0005, 100.05, T0)], s, T0);
  assert.equal(st.positions.length, 1);
  const p = st.positions[0];
  assert.equal(p.shortVenue, 'okx'); assert.equal(p.longVenue, 'hyperliquid'); assert.equal(p.notional, 85);
  assert.ok(st.fills.some(f => f.type === 'open'));
});

test('skips and explains when nothing clears the filter', () => {
  const s = S(), st = FD.newState(s, T0);
  FD.step(st, [q('okx', 'SOL', 0.0001, 100, T0), q('hyperliquid', 'SOL', 0.0001, 100, T0)], s, T0);
  assert.equal(st.positions.length, 0); assert.match(st.skips.SOL, /net/);
});

test('accrues funding at funding times, exits when funding flips, logs a win', () => {
  const s = S(), st = FD.newState(s, T0);
  FD.step(st, [q('okx', 'SOL', 0.0065, 100, T0), q('hyperliquid', 'SOL', 0.0005, 100, T0)], s, T0);
  const t1 = T0 + 9 * H; // several hourly periods pass while still in the trade
  FD.step(st, [q('okx', 'SOL', 0.0065, 100, t1), q('hyperliquid', 'SOL', 0.0005, 100, t1)], s, t1);
  assert.ok(st.positions[0].funding > 0);
  const t2 = t1 + 60e3; // funding flips: hyperliquid now pays more
  FD.step(st, [q('okx', 'SOL', 0.0001, 100, t2), q('hyperliquid', 'SOL', 0.003, 100, t2)], s, t2);
  assert.equal(st.positions.length, 0);
  assert.equal(st.trades.length, 1); assert.match(st.trades[0].why, /flipped/);
  assert.equal(st.wins + st.losses, 1);
});

test('does not exit on stale prices', () => {
  const s = S(), st = FD.newState(s, T0);
  FD.step(st, [q('okx', 'SOL', 0.0065, 100, T0), q('hyperliquid', 'SOL', 0.0005, 100, T0)], s, T0);
  const t1 = T0 + 600e3;
  FD.step(st, [q('okx', 'SOL', -0.01, 100, T0), q('hyperliquid', 'SOL', 0.01, 100, T0)], s, t1); // quotes 10 min old
  assert.equal(st.positions.length, 1);
});

test('a losing streak trips the breaker and stops new entries', () => {
  const s = S(), st = FD.newState(s, T0); st.consecLosses = 3;
  FD.step(st, [q('okx', 'SOL', 0.0065, 100, T0), q('hyperliquid', 'SOL', 0.0005, 100, T0)], s, T0);
  assert.equal(st.positions.length, 0); assert.match(st.skips.SOL, /losses in a row/);
  assert.equal(FD.breakers(st, [], s, T0).find(b => b.id === 'lossStreak').tripped, true);
});

test('Coinbase and Kraken normalizers read hourly funding', () => {
  const cb = FD.N.coinbase({ products: [{ price: '102', mid_market_price: '102.1', future_product_details: { contract_code: 'SLP', funding_rate: '0.00002', funding_interval: '3600s', funding_time: '2026-10-25T00:00:00Z' } }] }, T0);
  assert.ok(Math.abs(cb.SOL.rate8h - 0.00016) < 1e-12); assert.equal(cb.SOL.mark, 102.1);
  const kr = FD.N.kraken({ tickers: [{ symbol: 'PF_ETHUSD', relativeFundingRate: 1e-5, markPrice: 2350 }] }, T0);
  assert.ok(Math.abs(kr.ETH.rate8h - 8e-5) < 1e-12);
});
