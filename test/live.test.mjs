// LIVE mode gates, with a mocked Coinbase API. No real request is ever sent from these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LIVE_DEFAULTS, newLiveState, liveGates, contractsFor, runLive, allowed, makeClient, liveSummary, edgeFor } from '../scripts/live/coinbase-live.mjs';

const NOW = 1_800_000_000_000;
const cfgOn = (o = {}) => ({ ...LIVE_DEFAULTS, enabled: true, ...o });
// A market where the ETH carry clears every gate (very high funding), SOL contract too big for the $250 cap.
const market = (o = {}) => ({
  perms: { canTrade: true, canTransfer: false, canView: true }, cashUSD: 400, spotHold: {}, futures: { buyingPower: 400, cash: 0, unrealizedPnl: 0 }, perpPositions: [],
  fees: { spot: { maker: 0.004, taker: 0.006 }, perp: { maker: 0.0002, taker: 0.0003 } },
  coins: {
    ETH: { spot: 'ETH-USD', perp: 'ETP-20DEC30-CDE', contractSize: 0.1, fundingHourly: 0.002, spotBid: 2359, spotAsk: 2360, perpBid: 2361, perpAsk: 2362, perpMark: 2361 },
    SOL: { spot: 'SOL-USD', perp: 'SLP-20DEC30-CDE', contractSize: 5, fundingHourly: 0.002, spotBid: 102, spotAsk: 102.1, perpBid: 102.2, perpAsk: 102.3, perpMark: 102.2 } },
  ...o });
const gate = (o = {}) => { const m = o.m || market(); const cfg = o.cfg || cfgOn(); const ls = Object.assign(newLiveState(), o.ls || {});
  const coin = o.coin || 'ETH'; return liveGates({ cfg, ls, m, coin, contracts: o.contracts ?? contractsFor(m, coin, cfg), paused: !!o.paused }); };
const ids = r => r.fails.map(f => f.gate);

// Mock API: records every call; fills orders according to a script.
function mockApi(fillPlan = {}) {
  const calls = [], orders = {};
  return { calls, api: {
    get: async p => { calls.push(['GET', p]); assert.ok(allowed('GET', p), 'not allowed ' + p);
      const id = p.split('/').pop(); return { order: orders[id] }; },
    post: async (p, body) => { calls.push(['POST', p, body]); assert.ok(allowed('POST', p));
      const plan = fillPlan[body.client_order_id.replace(/^fd-[^-]+-\d+-/, '')] ?? 'full';
      const size = +Object.values(body.order_configuration)[0].base_size;
      const filled = plan === 'full' ? size : plan === 'none' ? 0 : plan;
      const oid = 'o' + calls.length; orders[oid] = { status: filled ? 'FILLED' : 'CANCELLED', filled_size: String(filled), average_filled_price: body.product_id.startsWith('ETP') ? '2361' : '2360', total_fees: '0.10' };
      return { success: true, success_response: { order_id: oid } }; } } };
}
const posts = calls => calls.filter(c => c[0] === 'POST').map(c => `${c[2].side} ${c[2].product_id} ${Object.values(c[2].order_configuration)[0].base_size}`);
const sleep = async () => {};

test('baseline: ETH carry with very high funding passes every live gate', () => { const r = gate(); assert.equal(r.ok, true, JSON.stringify(r.fails)); });
test('live is OFF by default in config.json and the gate rejects every order', () => {
  const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url))).live;
  assert.equal(cfg.enabled, false); assert.equal(cfg.maxNotionalUsd, 250); assert.equal(cfg.maxLossUsd, 25); assert.equal(cfg.maxOrdersPerDay, 4);
  assert.ok(ids(gate({ cfg: { ...LIVE_DEFAULTS, ...cfg } })).includes('liveOff'));
});
test('transfer permission: refuses to trade', () => { assert.ok(ids(gate({ m: market({ perms: { canTrade: true, canTransfer: true } }) })).includes('transferPermission')); });
test('no trade permission: rejected', () => { assert.ok(ids(gate({ m: market({ perms: { canTrade: false, canTransfer: false } }) })).includes('permissions')); });
test('notional cap: SOL smallest contract ($511) does not fit $250 → no order', () => {
  const r = gate({ coin: 'SOL' }); assert.equal(r.ok, false); assert.ok(ids(r).includes('contractFit'));
  assert.ok(ids(gate({ contracts: 2 })).includes('notional')); // 2 ETH contracts = $472 > $250
});
test('one position at a time', () => { assert.ok(ids(gate({ ls: { position: { coin: 'ETH', perp: 'ETP-20DEC30-CDE' } } })).includes('onePosition')); });
test('max 4 orders per day: an entry needs room for its own exit', () => { assert.ok(ids(gate({ ls: { ordersToday: 1 } })).includes('ordersPerDay')); });
test('loss cap: realized loss at the cap blocks entries', () => { assert.ok(ids(gate({ ls: { realizedPnl: -25 } })).includes('lossCap')); });
test('halted and paused both block entries', () => { assert.ok(ids(gate({ ls: { halted: true } })).includes('halted')); assert.ok(ids(gate({ paused: true })).includes('paused')); });
test('edge: funding must beat 2× all fees over 24 h; today-like funding (0.0018%/h) fails', () => {
  const m = market(); m.coins.ETH.fundingHourly = 0.000018;
  const r = gate({ m }); assert.ok(ids(r).includes('edge'));
  const e = edgeFor(m, 'ETH', cfgOn(), 1); assert.ok(e.expected < e.need);
  m.coins.ETH.fundingHourly = -0.0001; assert.ok(ids(gate({ m })).includes('edge'));
});
test('no leverage beyond the hedge: futures buying power and USD cash must each cover the leg', () => {
  assert.ok(ids(gate({ m: market({ cashUSD: 100 }) })).includes('funds'));
  assert.ok(ids(gate({ m: market({ futures: { buyingPower: 100 } }) })).includes('funds'));
});
test('a futures position the agent did not open: no trading', () => {
  assert.ok(ids(gate({ m: market({ perpPositions: [{ product: 'BIP-20DEC30-CDE', contracts: 1 }] }) })).includes('unknownPosition'));
});

test('entry: shorts 1 ETH perp contract then buys 0.1 ETH spot, both verified, position recorded', async () => {
  const { api, calls } = mockApi(), ls = newLiveState();
  const r = await runLive({ api, cfg: cfgOn(), ls, m: market(), paused: false, now: NOW, sleep });
  assert.equal(r.decision, 'enter');
  assert.deepEqual(posts(calls), ['SELL ETP-20DEC30-CDE 1', 'BUY ETH-USD 0.1']);
  assert.ok(calls.some(c => c[0] === 'GET' && /orders\/historical/.test(c[1])), 'fills verified from the API');
  assert.equal(ls.position.contracts, 1); assert.equal(ls.position.baseQty, 0.1); assert.equal(ls.ordersToday, 2);
  const ids2 = calls.filter(c => c[0] === 'POST').map(c => c[2].client_order_id);
  assert.equal(new Set(ids2).size, ids2.length); assert.ok(ids2.every(i => /^fd-[0-9a-f]{6}-1-/.test(i)), 'deterministic client order ids');
});
test('leg failure: perp fills, spot fails → perp unwound at once and live halts', async () => {
  const { api, calls } = mockApi({ 'spot-open': 'none' }), ls = newLiveState();
  const r = await runLive({ api, cfg: cfgOn(), ls, m: market(), paused: false, now: NOW, sleep });
  assert.equal(r.decision, 'unwound'); assert.equal(ls.halted, true); assert.equal(ls.position, null);
  assert.deepEqual(posts(calls), ['SELL ETP-20DEC30-CDE 1', 'BUY ETH-USD 0.1', 'BUY ETP-20DEC30-CDE 1']);
});
test('perp does not fill: nothing else is sent', async () => {
  const { api, calls } = mockApi({ 'perp-open': 'none' }), ls = newLiveState();
  await runLive({ api, cfg: cfgOn(), ls, m: market(), paused: false, now: NOW, sleep });
  assert.deepEqual(posts(calls), ['SELL ETP-20DEC30-CDE 1']); assert.equal(ls.position, null);
});
test('loss cap on an open position: both legs closed and live halts', async () => {
  const { api, calls } = mockApi(), ls = Object.assign(newLiveState(), { position: { seq: 'abc123-1', coin: 'ETH', spot: 'ETH-USD', perp: 'ETP-20DEC30-CDE', contracts: 1, contractSize: 0.1, baseQty: 0.1, spotEntry: 2600, perpEntry: 2300, fees: 1, openedAt: NOW - 3600e3 } });
  const r = await runLive({ api, cfg: cfgOn(), ls, m: market(), paused: false, now: NOW, sleep });
  assert.equal(r.decision, 'exit'); assert.equal(ls.halted, true); assert.match(ls.haltReason, /loss cap/);
  assert.deepEqual(posts(calls), ['BUY ETP-20DEC30-CDE 1', 'SELL ETH-USD 0.1']);
});
test('kill switch: live=false while holding closes both legs; live=false with nothing held sends nothing', async () => {
  let { api, calls } = mockApi(); const ls = Object.assign(newLiveState(), { position: { seq: 'abc123-1', coin: 'ETH', spot: 'ETH-USD', perp: 'ETP-20DEC30-CDE', contracts: 1, contractSize: 0.1, baseQty: 0.1, spotEntry: 2360, perpEntry: 2361, fees: 0.2, openedAt: NOW } });
  await runLive({ api, cfg: cfgOn({ enabled: false }), ls, m: market(), paused: false, now: NOW, sleep });
  assert.equal(posts(calls).length, 2); assert.equal(ls.position, null);
  ({ api, calls } = mockApi());
  await runLive({ api, cfg: { ...LIVE_DEFAULTS }, ls: newLiveState(), m: market(), paused: false, now: NOW, sleep });
  assert.equal(posts(calls).length, 0);
});
test('client refuses any endpoint off the allow-list (no transfers, withdrawals, deposits, sweeps)', async () => {
  for (const [m, p] of [['POST', '/v2/accounts/x/transactions'], ['POST', '/api/v3/brokerage/cfm/sweeps/schedule'], ['GET', '/v2/accounts/x/withdrawals'], ['POST', '/api/v3/brokerage/portfolios/move_funds'], ['POST', '/api/v3/brokerage/orders/batch_cancel']])
    assert.equal(allowed(m, p), false, p);
  const api = makeClient(null, async () => { throw new Error('network must not be reached'); });
  await assert.rejects(() => api.post('/api/v3/brokerage/portfolios/move_funds', {}), /allow-list/);
});
test('no money-moving code anywhere in the repo scripts', () => {
  for (const f of ['scripts/live/coinbase-live.mjs', 'scripts/coinbase-readonly.mjs', 'scripts/agent.mjs', 'scripts/agent-lib.mjs'])
    assert.doesNotMatch(fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8'), /withdraw[a-z_]*\(|\/withdrawals|move_funds|\/sweeps|\/deposits|\/transactions|send_money|transfer_money/i, f);
});
test('public summary carries no key names, account ids or order ids', () => {
  const ls = newLiveState(); const s = JSON.stringify(liveSummary(cfgOn(), ls, market(), { decision: 'none', checks: {}, log: [] }, null));
  assert.doesNotMatch(s, /organizations\/|apiKeys|order_id|client_order_id|uuid|portfolio/i);
});
