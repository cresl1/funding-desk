// Funding Desk agent runner (GitHub Actions, every 5 min). PAPER ONLY.
// node scripts/agent.mjs --prev /tmp/prev.json --config config.json --out /tmp/out
// Exits non-zero ONLY when the previous state exists but cannot be read, so a bad read never wipes the wallet.
import fs from 'node:fs';
import path from 'node:path';
import { fetchRates } from './sources.mjs';
import { agentStep } from './agent-lib.mjs';
import { coinbaseSnapshot, loadKey, encrypt, decrypt } from './coinbase-readonly.mjs';
import { LIVE_DEFAULTS, newLiveState, makeClient, readMarket, runLive, liveSummary } from './live/coinbase-live.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const prevPath = arg('prev', '/tmp/prev.json'), cfgPath = arg('config', 'config.json'), outDir = arg('out', '/tmp/out');

let prev = null;
if (fs.existsSync(prevPath)) {
  try { prev = JSON.parse(fs.readFileSync(prevPath, 'utf8')); }
  catch (e) { console.error('previous state.json exists but is unreadable; refusing to overwrite it:', e.message); process.exit(1); }
}
let config = null, configError = null;
try { config = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { configError = String(e.message || e).slice(0, 120); }

let rates;
try { rates = await fetchRates(); } catch (e) { rates = { generatedAt: Date.now(), venues: {}, error: String(e.message || e) }; }
const now = rates.generatedAt;

const state = agentStep({
  prev, rates, config, configError, now,
  testsOk: (process.env.TESTS_OK || 'success') === 'success',
  run: { event: process.env.RUN_EVENT, url: process.env.RUN_URL, sha: (process.env.GITHUB_SHA || '').slice(0, 7) || null }
});

// ---- Coinbase (his real account). Skipped entirely when the two secrets are not set.
const env = process.env, liveCfg = Object.assign({}, LIVE_DEFAULTS, (config || state.config || {}).live || {});
const cb = await coinbaseSnapshot(env, now); // balances (read-only)
const priv = { balances: null, live: null };
if (cb.status === 'connected' && env.DESK_KEY) {
  let ls = null;
  try { ls = prev && prev.liveEnc ? decrypt(prev.liveEnc, env.DESK_KEY) : newLiveState(); }
  catch (e) { console.error('live state unreadable; refusing to trade this run'); }
  let res = null, m = null, err = null;
  if (ls) {
    try {
      const api = makeClient(loadKey(env.COINBASE_API_KEY_NAME.trim(), env.COINBASE_API_PRIVATE_KEY));
      m = await readMarket(api, liveCfg);
      res = await runLive({ api, cfg: liveCfg, ls, m, paused: state.agent.paused, now });
    } catch (e) { err = String(e.message || e).slice(0, 200); }
    state.liveEnc = encrypt(ls, env.DESK_KEY);
    priv.live = liveSummary(liveCfg, ls, m, res, err);
    cb.live = { enabled: liveCfg.enabled === true, halted: !!ls.halted, holding: !!ls.position };
  } else { state.liveEnc = prev && prev.liveEnc; cb.live = { enabled: liveCfg.enabled === true, error: 'live state unreadable' }; }
  if (cb.enc) { try { priv.balances = decrypt(cb.enc, env.DESK_KEY); } catch {} }
  cb.enc = encrypt(priv, env.DESK_KEY);
} else if (prev && prev.liveEnc) state.liveEnc = prev.liveEnc; // keep live history if the key is removed for a while
state.coinbase = cb;
state.liveConfig = { enabled: liveCfg.enabled === true, maxNotionalUsd: liveCfg.maxNotionalUsd, maxLossUsd: liveCfg.maxLossUsd, maxOrdersPerDay: liveCfg.maxOrdersPerDay, coins: liveCfg.coins };

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'state.json'), JSON.stringify(state));
fs.writeFileSync(path.join(outDir, 'rates.json'), JSON.stringify(rates, null, 1) + '\n'); // the simulator view reads this
const e = state.engine;
console.log(`run ${state.agent.runs} · equity $${state.equity} · open ${e.positions.length} · trades ${e.trades.length} · ` +
  `venues ok ${Object.entries(state.agent.venues).filter(([, v]) => v.ok).map(([k]) => k).join(',')} · ` +
  `coinbase ${state.coinbase.status} · skips ${JSON.stringify(e.skips)} · error ${state.agent.lastError && state.agent.lastErrorAt === now ? state.agent.lastError : 'none'}`);
