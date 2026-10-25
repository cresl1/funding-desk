// Public funding-rate sources for SOL + ETH perps. Read-only market data, no keys, no accounts.
// Used by the agent (scripts/agent.mjs) and by scripts/fetch-rates.mjs. Node 20+, no dependencies.
import { createRequire } from 'node:module';
const FD = createRequire(import.meta.url)('../core.js');

const UA = { 'User-Agent': 'funding-desk/1.0', Accept: 'application/json' };
async function get(url, opt = {}) {
  const r = await fetch(url, { ...opt, headers: { ...UA, ...(opt.headers || {}) }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status + (r.status === 451 || r.status === 403 ? ' (blocked from US)' : ''));
  return r.json();
}
const perCoin = async fn => Object.fromEntries(await Promise.all(FD.COINS.map(async c => [c, await fn(c)])));

export const SOURCES = {
  hyperliquid: () => get('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }) }),
  okx: () => perCoin(async c => ({ fr: await get(`https://www.okx.com/api/v5/public/funding-rate?instId=${c}-USDT-SWAP`), mk: await get(`https://www.okx.com/api/v5/public/mark-price?instType=SWAP&instId=${c}-USDT-SWAP`) })),
  dydx: () => get('https://indexer.dydx.trade/v4/perpetualMarkets'),
  bitget: () => perCoin(async c => ({ fr: await get(`https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${c}USDT&productType=usdt-futures`), px: await get(`https://api.bitget.com/api/v2/mix/market/symbol-price?symbol=${c}USDT&productType=usdt-futures`) })),
  binance: () => perCoin(c => get(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${c}USDT`)),
  bybit: () => perCoin(c => get(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${c}USDT`)),
  coinbase: () => get('https://api.coinbase.com/api/v3/brokerage/market/products?product_type=FUTURE'),
  kraken: () => get('https://futures.kraken.com/derivatives/api/v3/tickers'),
  coinbaseintl: () => get('https://api.coinbase.com/api/v3/brokerage/market/products?product_type=FUTURE&contract_expiry_type=PERPETUAL')
};


// Fetch every venue in parallel. A venue that fails is reported with its error; it never stops the others.
export async function fetchRates() {
  const out = { generatedAt: 0, runner: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local', venues: {} };
  await Promise.all(Object.entries(SOURCES).map(async ([id, fn]) => {
    const ts = Date.now();
    try {
      const quotes = FD.N[id](await fn(), ts);
      const n = Object.keys(quotes).length;
      out.venues[id] = n ? { ok: true, quotes } : { ok: false, error: 'no SOL/ETH data in answer' };
    } catch (e) { out.venues[id] = { ok: false, error: String(e.message || e).slice(0, 120) }; }
  }));
  out.generatedAt = Date.now(); // the run's own fetch time: data age is measured against this
  return out;
}
