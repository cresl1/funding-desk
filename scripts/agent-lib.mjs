// Funding Desk agent: one autonomous PAPER step. Pure function of (previous state, fetched rates, config, time).
// All trading logic and every risk gate come from core.js (the same code the dashboard simulator runs);
// this file only loads settings, carries data between runs, and caps the stored logs. Paper only:
// no keys, no accounts, nothing here can place a real trade.
import { createRequire } from 'node:module';
const FD = createRequire(import.meta.url)('../core.js');

export const VERSION = 1;
export const SCHEDULE = '*/5 * * * *';
const NUM_KEYS = ['startWallet', 'sizePct', 'entryNetPct', 'exitGapPct', 'holdPeriods', 'dailyLossPct', 'maxConsecLosses', 'staleSec', 'maxPriceGapPct'];
export const AGENT_DEFAULTS = { staleSec: 600 }; // the agent waits up to 10 min for slower venues (see README)
const CARRY_MAX_MS = 3600e3;   // a venue that blips keeps its last quote (with its real age) for up to 1 h
const MAX_TRADES = 500, MAX_FILLS = 500, MAX_CURVE = 2000;
const clone = o => JSON.parse(JSON.stringify(o));
const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : undefined);

// config.json -> engine settings. Unknown keys are ignored; bad numbers fall back to the default and are reported.
export function settingsFrom(cfg = {}) {
  const s = Object.assign(clone(FD.DEFAULTS), AGENT_DEFAULTS), problems = [];
  for (const k of NUM_KEYS) {
    if (cfg[k] === undefined) continue;
    const v = num(cfg[k]);
    if (v === undefined || v < 0) problems.push(`${k} "${cfg[k]}" is not a number, using ${s[k]}`); else s[k] = v;
  }
  s.maxSizePct = 25; // hard ceiling, not configurable: a sizePct above it makes the size gate reject every entry
  for (const [v, f] of Object.entries(cfg.fees || {})) {
    if (!FD.VENUES[v]) continue;
    const x = num(f); if (x === undefined || x < 0) problems.push(`fee for ${v} is not a number`); else s.fees[v] = x;
  }
  for (const [v, on] of Object.entries(cfg.venues || {})) if (FD.VENUES[v]) s.enabled[v] = on === true;
  return { settings: s, problems };
}

// Equity curve: full detail for the last 48 h, one point per 30 min before that, at most MAX_CURVE points.
export function thinCurve(curve, now) {
  const cut = now - 48 * 3600e3, out = [];
  let bucket = null;
  for (const p of curve) {
    if (p.t >= cut) { out.push(p); continue; }
    const b = Math.floor(p.t / 1800e3);
    if (b === bucket) out[out.length - 1] = p; else { out.push(p); bucket = b; }
  }
  return out.length > MAX_CURVE ? out.slice(out.length - MAX_CURVE) : out;
}

// This run's quotes, plus the last good quote of any venue that failed this run (kept with its real timestamp,
// so the stale-data gate still judges it by its true age against this run's fetch time).
export function mergeQuotes(rates, prevQuotes = [], now) {
  const fresh = [], seen = new Set();
  for (const [id, v] of Object.entries(rates.venues || {})) {
    if (!v.ok) continue;
    for (const q of Object.values(v.quotes || {})) { fresh.push(q); seen.add(q.venue + ':' + q.coin); }
  }
  const carried = prevQuotes.filter(q => q && !seen.has(q.venue + ':' + q.coin) && now - q.ts <= CARRY_MAX_MS);
  return fresh.concat(carried);
}

function newAgent(config, now) {
  return { createdAt: now, runs: 0, lastRun: null, lastOkStep: null, lastError: null, lastErrorAt: null, errorStreak: 0,
    resetWallet: num(config.resetWallet) || 0, clearLossStreak: num(config.clearLossStreak) || 0 };
}

/**
 * One agent run. Never throws: anything that goes wrong is written into agent.lastError and the run still saves.
 * @param prev      previous state.json (or null on the very first run)
 * @param rates     output of fetchRates() for this run
 * @param config    parsed config.json from main (or null if it could not be read)
 * @param now       the run's fetch time (ms); data age and the stale gate are measured against it
 * @param testsOk   false when the gate tests failed this run: the engine step is then skipped
 */
export function agentStep({ prev = null, rates, config, now, testsOk = true, run = {}, configError = null }) {
  const cfg = config || (prev && prev.config) || {};
  const { settings: s, problems } = settingsFrom(cfg);
  const errors = [];
  if (configError) errors.push('config.json unreadable (' + configError + '), using last good settings');
  errors.push(...problems.map(p => 'config: ' + p));

  const state = prev && prev.v === VERSION && prev.engine ? clone(prev) : { v: VERSION, mode: 'paper', agent: newAgent(cfg, now), engine: FD.newState(s, now), quotes: [] };
  const a = state.agent;
  a.runs = (a.runs || 0) + 1;
  a.lastRun = now;
  a.run = { event: run.event || 'manual', url: run.url || null, sha: run.sha || null };
  a.schedule = SCHEDULE;
  a.testsOk = !!testsOk;
  a.paused = cfg.paused === true;

  // Owner controls in config.json (counters: bump the number to trigger once).
  const rw = num(cfg.resetWallet) || 0, cl = num(cfg.clearLossStreak) || 0;
  if (rw !== (a.resetWallet || 0)) { state.engine = FD.newState(s, now); a.resetWallet = rw; a.walletResetAt = now; }
  if (cl !== (a.clearLossStreak || 0)) { state.engine.consecLosses = 0; a.clearLossStreak = cl; a.lossStreakClearedAt = now; }

  // Venue status for this run.
  a.venues = {};
  for (const [id, v] of Object.entries(rates.venues || {})) a.venues[id] = v.ok ? { ok: true, on: s.enabled[id] !== false } : { ok: false, on: s.enabled[id] !== false, error: v.error };

  const quotes = mergeQuotes(rates, state.quotes, now);
  const active = quotes.filter(q => s.enabled[q.venue] !== false);
  state.quotes = quotes;

  if (!testsOk) errors.push('gate tests failed this run, so the agent did not trade (positions held as they were)');
  else {
    try {
      const eng = clone(state.engine);
      eng.paused = a.paused;            // the pause switch is the engine's manual gate: no new entries, exits still managed
      FD.step(eng, active, s, now);     // the same step + riskCheck the browser simulator uses
      if (eng.trades.length > MAX_TRADES) eng.trades.splice(0, eng.trades.length - MAX_TRADES);
      if (eng.fills.length > MAX_FILLS) eng.fills.splice(0, eng.fills.length - MAX_FILLS);
      eng.curve = thinCurve(eng.curve, now);
      state.engine = eng;
      a.lastOkStep = now;
    } catch (e) { errors.push('engine step failed: ' + String(e && e.message || e).slice(0, 200)); }
  }

  // Snapshot for the dashboard.
  const byVC = FD.indexQuotes(active), eng = state.engine;
  state.equity = +FD.equityOf(eng, byVC).toFixed(4);
  state.breakers = FD.breakers(eng, active, s, now);
  const scanned = FD.scan(FD.groupByCoin(active), s);
  state.scan = Object.fromEntries(Object.entries(scanned).map(([c, pairs]) => [c, pairs.slice(0, 5).map(p => ({
    short: p.shortVenue, long: p.longVenue, gap: p.gap, net: p.net, pass: !!p.pass, reason: p.reason || null }))]));
  state.settings = { startWallet: s.startWallet, sizePct: s.sizePct, maxSizePct: s.maxSizePct, entryNetPct: s.entryNetPct, exitGapPct: s.exitGapPct,
    holdPeriods: s.holdPeriods, dailyLossPct: s.dailyLossPct, maxConsecLosses: s.maxConsecLosses, staleSec: s.staleSec, maxPriceGapPct: s.maxPriceGapPct,
    fees: s.fees, venues: s.enabled, paused: a.paused };
  if (config) state.config = config; // last good config, used if the next read fails

  if (errors.length) { a.lastError = errors.join(' | ').slice(0, 600); a.lastErrorAt = now; a.errorStreak = (a.errorStreak || 0) + 1; }
  else { a.errorStreak = 0; }
  a.ok = errors.length === 0;
  return state;
}
