// The 24/7 agent: one step with fixture data produces the expected state. Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { agentStep, settingsFrom, thinCurve, mergeQuotes } from '../scripts/agent-lib.mjs';
const FD = createRequire(import.meta.url)('../core.js');
const T0 = 1_800_000_000_000, H = 3600e3;
const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)));
const q = (venue, coin, rate8h, mark, t) => FD.quote(venue, coin, rate8h / 8, 1, Math.floor(t / H) * H + H, mark, t);
const rates = (t, sol) => ({ generatedAt: t, venues: {
  okx: { ok: true, quotes: { SOL: q('okx', 'SOL', sol.okx, 100, t - 2000), ETH: q('okx', 'ETH', 0.0001, 2400, t - 2000) } },
  hyperliquid: { ok: true, quotes: { SOL: q('hyperliquid', 'SOL', sol.hl, 100.05, t - 1000), ETH: q('hyperliquid', 'ETH', 0.0001, 2400.5, t - 1000) } },
  binance: { ok: false, error: 'HTTP 451 (blocked from US)' } } });

test('config.json defaults: $850 wallet, 0.14% filter, 10% size, 600 s data age, not paused, live off', () => {
  const { settings: s, problems } = settingsFrom(config);
  assert.deepEqual(problems, []);
  assert.equal(s.startWallet, 850); assert.equal(s.entryNetPct, 0.14); assert.equal(s.sizePct, 10); assert.equal(s.staleSec, 600);
  assert.equal(config.paused, false); assert.equal(config.live.enabled, false);
  assert.equal(s.enabled.binance, false); assert.equal(s.enabled.coinbase, true);
});

test('first run with a clean setup: opens one hedged paper position sized 10% of $850', () => {
  const st = agentStep({ prev: null, rates: rates(T0, { okx: 0.0065, hl: 0.0005 }), config, now: T0, run: { event: 'workflow_dispatch' } });
  assert.equal(st.mode, 'paper'); assert.equal(st.agent.runs, 1); assert.equal(st.agent.lastRun, T0); assert.equal(st.agent.ok, true);
  assert.equal(st.engine.positions.length, 1);
  const p = st.engine.positions[0];
  assert.equal(p.coin, 'SOL'); assert.equal(p.shortVenue, 'okx'); assert.equal(p.longVenue, 'hyperliquid'); assert.equal(p.notional, 85);
  assert.match(st.engine.skips.ETH, /net/);
  assert.equal(st.agent.venues.binance.ok, false);
  assert.ok(st.breakers.every(b => !b.tripped), JSON.stringify(st.breakers));
  // second run, funding flipped: the agent closes it and logs the trade
  const st2 = agentStep({ prev: JSON.parse(JSON.stringify(st)), rates: rates(T0 + 300e3, { okx: 0.0001, hl: 0.003 }), config, now: T0 + 300e3 });
  assert.equal(st2.agent.runs, 2); assert.equal(st2.engine.positions.length, 0);
  assert.equal(st2.engine.trades.length, 1); assert.match(st2.engine.trades[0].why, /flipped/);
});

test('pause switch: no new entries while paused', () => {
  const st = agentStep({ prev: null, rates: rates(T0, { okx: 0.0065, hl: 0.0005 }), config: { ...config, paused: true }, now: T0 });
  assert.equal(st.engine.positions.length, 0); assert.match(st.engine.skips.SOL, /paused/); assert.equal(st.agent.paused, true);
});

test('failed gate tests: the step is skipped and the error recorded', () => {
  const st = agentStep({ prev: null, rates: rates(T0, { okx: 0.0065, hl: 0.0005 }), config, now: T0, testsOk: false });
  assert.equal(st.engine.positions.length, 0); assert.equal(st.agent.ok, false); assert.match(st.agent.lastError, /tests failed/);
});

test('stale gate is measured against the run\'s own fetch time', () => {
  const r = rates(T0, { okx: 0.0065, hl: 0.0005 });
  const st = agentStep({ prev: null, rates: r, config: { ...config, staleSec: 1 }, now: T0 }); // quotes 1–2 s old vs 1 s limit
  assert.equal(st.engine.positions.length, 0); assert.match(st.engine.skips.SOL, /old/);
});

test('a venue that blips keeps its last quote with its real age; too old and it is dropped', () => {
  const prevQ = [q('okx', 'SOL', 0.0065, 100, T0)];
  assert.equal(mergeQuotes({ venues: {} }, prevQ, T0 + 300e3).length, 1);
  assert.equal(mergeQuotes({ venues: {} }, prevQ, T0 + 2 * H).length, 0);
});

test('bad config numbers fall back to defaults and are reported, never crash', () => {
  const st = agentStep({ prev: null, rates: rates(T0, { okx: 0.0001, hl: 0.0001 }), config: { ...config, sizePct: 'lots' }, now: T0 });
  assert.match(st.agent.lastError, /sizePct/); assert.equal(st.settings.sizePct, 10);
});

test('logs stay capped: equity curve thinned, fills ≤ 500', () => {
  const curve = Array.from({ length: 5000 }, (_, i) => ({ t: T0 + i * 300e3, e: 850 }));
  const now = T0 + 5000 * 300e3;
  assert.ok(thinCurve(curve, now).length <= 2000);
  let st = agentStep({ prev: null, rates: rates(T0, { okx: 0.0001, hl: 0.0001 }), config, now: T0 });
  st.engine.fills = Array.from({ length: 900 }, (_, i) => ({ t: i, type: 'funding' }));
  st = agentStep({ prev: st, rates: rates(T0 + 300e3, { okx: 0.0001, hl: 0.0001 }), config, now: T0 + 300e3 });
  assert.ok(st.engine.fills.length <= 500);
});

test('reset counter starts a fresh $850 wallet; clearLossStreak clears the streak breaker', () => {
  let st = agentStep({ prev: null, rates: rates(T0, { okx: 0.0001, hl: 0.0001 }), config, now: T0 });
  st.engine.cash = 500; st.engine.consecLosses = 3;
  st = agentStep({ prev: st, rates: rates(T0 + 1, { okx: 0.0001, hl: 0.0001 }), config: { ...config, clearLossStreak: 1 }, now: T0 + 1 });
  assert.equal(st.engine.consecLosses, 0); assert.equal(st.engine.cash, 500);
  st = agentStep({ prev: st, rates: rates(T0 + 2, { okx: 0.0001, hl: 0.0001 }), config: { ...config, clearLossStreak: 1, resetWallet: 1 }, now: T0 + 2 });
  assert.equal(st.engine.cash, 850);
});
