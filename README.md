# Funding Desk

A password-locked dashboard that scans perpetual-futures **funding rates** for SOL and ETH across venues, flags funding-rate arbitrage setups, and **paper-trades** them with a fake wallet.

> **PAPER MODE — no real money.** There is no live trading in this repo: no exchange API keys, no order endpoints, nothing that can move funds.

## What it does

1. **Scanner** — current funding per venue, normalized to **% per 8h** and APR, next funding time, mark price, and how old each number is (green = live from the browser, amber = delayed snapshot, grey = unavailable and why).
2. **Setup filter** — for every venue pair on each coin:
   `net = (high rate − low rate) per 8h × expected hold periods − round-trip taker fees (2 × (fee A + fee B))`.
   A setup passes only when `net > 0.14%` (editable). Every skipped pair is listed with its reason.
3. **Paper engine** — runs in the browser while the page is open (auto every 30 s, or tap Refresh). On a pass it shorts the high-funding venue and hedges with a long on the other, accrues funding at each venue's funding times, and exits when funding flips or the gap compresses below the exit level (default 0.05% per 8h). Every fill, funding payment and closed trade is logged; equity curve and win/loss count are kept in `localStorage` on the device.

## Risk rules (hard gates in the order path)

Every entry goes through `riskCheck()` in `core.js`; any failing gate **rejects the order** (nothing is resized or "softened").

| Gate | Default | Rule |
|---|---|---|
| Fixed size | 10% of current wallet per leg, max 25% | Size = wallet × fixed % only. `sizeFor(equity, pct)` takes no trade history, so it can never size up after wins. An order of any other size is rejected. |
| Daily loss cap | 3% | Once today's equity is down 3% from the day's start, no new entries until tomorrow. |
| Loss streak | 3 | Three losing trades in a row pauses entries (clear it manually in Settings). |
| Stale data | 120 s | No entry if either leg's data is older than this. Open positions are never closed on stale prices either. |
| Price gap | 0.5% | No entry if the two venues' mark prices differ by more than this. |
| One per coin | 1 | Max one open position per coin. |
| Filter | 0.14% net | The setup must still pass the filter at order time, with the short on the higher-funding venue. |

Tests that prove each gate fires live in `test/` — run `node --test` (Node 18+). A failing gate test fails the build.

## Data sources (tested from the US, Oct 2026)

| Venue | Endpoint | From a US browser |
|---|---|---|
| Hyperliquid | `POST api.hyperliquid.xyz/info` (`metaAndAssetCtxs`) | ✅ live (hourly funding) |
| OKX | `www.okx.com/api/v5/public/funding-rate`, `/mark-price` | ✅ live (8h funding) |
| dYdX v4 | `indexer.dydx.trade/v4/perpetualMarkets` | ✅ live (hourly) |
| Bitget | `api.bitget.com/api/v2/mix/market/current-fund-rate`, `/symbol-price` | ✅ live (8h) |
| Coinbase US (perp-style futures, `SLP`/`ETP-20DEC30-CDE`) | `api.coinbase.com/api/v3/brokerage/market/products?product_type=FUTURE` | ⏱ no CORS → fetched by GitHub Actions every ~5 min |
| Kraken Futures (`PF_SOLUSD`, `PF_ETHUSD`) | `futures.kraken.com/derivatives/api/v3/tickers` | ⏱ no CORS → GitHub Actions |
| Binance | `fapi.binance.com/fapi/v1/premiumIndex` | ❌ HTTP 451 from US |
| Bybit | `api.bybit.com/v5/market/tickers` | ❌ HTTP 403 from US |
| Coinbase International | perpetual list via Coinbase public API | ❌ data frozen for US callers (off by default) |

`scripts/fetch-rates.mjs` runs in `.github/workflows/rates.yml` and force-pushes a single `rates.json` to the `data` branch (no history growth). The page reads it from `raw.githubusercontent.com`; delayed numbers are labelled with their age and usually trip the 120 s stale gate (raise "Max data age" in Settings to let slower US venues trade on paper).

Taker fees are base-tier defaults with a source link next to each in Settings; edit them to your real tier. The Coinbase figure is an estimate.

## Not built

Live trading. If paper results hold up over weeks (not one day), live execution would need a US-legal venue and your own API keys, added only with your explicit OK.

## Honest caveats

Funding arbitrage earns small, slow carry; after fees most hours show **no** setup. Hedged positions still carry basis, liquidation and venue risk. One good day proves nothing. Not financial advice.
