# Funding Desk

A password-locked dashboard plus a **24/7 agent** that scans perpetual-futures **funding rates** for SOL and ETH across venues, flags funding-rate arbitrage setups, and **paper-trades** them with a fake $850 wallet.

> **PAPER MODE — no real money** by default. A live mode for your own Coinbase account exists but is **off** (`live.enabled = false` in `config.json`) and needs your own API key in GitHub secrets. See *Live mode* below.

## The agent (runs on its own)

`.github/workflows/agent.yml` runs **every 5 minutes** on GitHub Actions (plus a manual "Run workflow" button). Your phone does not need to be on. Each run:

1. runs the gate tests (`node --test`). If any test fails, the agent **does not trade** that run and writes the failure into its state;
2. fetches funding + mark prices from every venue that answers from GitHub's US servers (Hyperliquid, OKX, dYdX, Bitget, Coinbase US perps, Kraken Futures);
3. runs **one engine step** with exactly the same code and risk gates as the browser (`core.js`: `step()` → `riskCheck()`): enter / hold / exit, accrue funding. Data age is measured against the run's own fetch time;
4. saves `state.json` (wallet, open positions, trade log, equity curve, breakers, last run, last error) and `rates.json` to the `data` branch as a single small commit (the branch is overwritten each run, so the repo never grows). Logs are capped: last 500 fills, 500 trades, equity curve thinned to ≤ 2,000 points.

Two runs never overlap (`concurrency: funding-desk-agent`). A failed fetch or engine error is written into `state.json` (`agent.lastError`) and the next run carries on. If the previous state can't be read, the run stops **without** overwriting it, so a hiccup can never wipe the wallet.

GitHub runs scheduled workflows on a best-effort basis: runs are often 5–15 min late and can be skipped when GitHub is busy. The dashboard shows **AGENT: RUNNING** while the last run is under 20 min old and **AGENT: STALLED** after that.

### Settings without code: `config.json`

Open [config.json](../../edit/main/config.json) on GitHub, tap the pencil, change a value, **Commit changes**. The agent picks it up on its next run.

| Key | Default | Meaning |
|---|---|---|
| `paused` | `false` | `true` = **pause agent**: no new entries; open positions still managed and closed by the exit rules. |
| `startWallet` | 850 | Paper wallet for a fresh start (used when you bump `resetWallet`). |
| `sizePct` | 10 | Fixed % of the *current* wallet per leg. Above 25 the size gate rejects every entry (not clipped). |
| `entryNetPct` | 0.14 | Enter only when the net gap after round-trip fees is above this %. |
| `exitGapPct` | 0.05 | Exit when the gap per 8h falls below this %, or funding flips. |
| `dailyLossPct` | 3 | Daily loss cap (resets at midnight Eastern). |
| `maxConsecLosses` | 3 | Losing-streak breaker. |
| `staleSec` | **600** | Max data age. The agent fetches every venue itself each run, so its data is seconds old; 600 s lets a venue that fails one run keep its last quote (at its true age) for one more run instead of tripping the breaker. Coinbase and Kraken only reach the browser through this 5-min job, which is why the browser simulator's 120 s limit was too tight for them. |
| `maxPriceGapPct` | 0.5 | Price-gap breaker. |
| `fees`, `venues` | | Taker fee % per venue; which venues the agent trades. Binance and Bybit are off: they refuse US connections (HTTP 451/403). |
| `resetWallet` | 0 | Bump the number (0 → 1) to restart the paper wallet at `startWallet`. |
| `clearLossStreak` | 0 | Bump the number to clear a tripped losing-streak breaker. |
| `live` | off | Real-money mode, see below. |

Bad values are ignored (the default is used) and reported on the dashboard.

### Dashboard

The **Agent** view is read-only: it reads `state.json` from the `data` branch every minute (status, last run, next run, wallet, P&L, equity curve, breakers ARMED/TRIPPED, last scan, positions, trade log, venues, settings). The **Simulator** view is the original in-browser engine (runs only while the page is open, keeps its own wallet on that phone).

## How the strategy works (agent and simulator)

1. **Scanner** — current funding per venue, normalized to **% per 8h** and APR, next funding time, mark price, and how old each number is (green = live from the browser, amber = delayed snapshot, grey = unavailable and why).
2. **Setup filter** — for every venue pair on each coin:
   `net = (high rate − low rate) per 8h × expected hold periods − round-trip taker fees (2 × (fee A + fee B))`.
   A setup passes only when `net > 0.14%` (editable). Every skipped pair is listed with its reason.
3. **Paper engine** — the agent runs it every 5 min on GitHub; the Simulator view runs the same engine in the browser while open. On a pass it shorts the high-funding venue and hedges with a long on the other, accrues funding at each venue's funding times, and exits when funding flips or the gap compresses below the exit level (default 0.05% per 8h). Every fill, funding payment and closed trade is logged; equity curve and win/loss count are kept in `localStorage` on the device.

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

The agent workflow also publishes `rates.json` (all venues) to the `data` branch every run; the Simulator view reads it for Coinbase and Kraken. `scripts/sources.mjs` holds the fetchers; `scripts/fetch-rates.mjs` prints a snapshot by hand.

Taker fees are base-tier defaults with a source link next to each in Settings; edit them to your real tier. The Coinbase figure is an estimate.

## Coinbase: read-only view and live mode

### Connect your Coinbase account (you do this; nobody else should hold the key)

Needs a regular **Coinbase** account (coinbase.com), not the Coinbase Wallet app. For live mode it also needs **futures turned on** and about **$500 USD** in it (≈ $250 for the spot leg + ≈ $250 to fully collateralise the short; nothing is leveraged beyond the hedge).

1. Turn on futures: in Coinbase, open **Settings → Futures** (or tap *Trade → Futures* and follow "Get started with perpetual-style futures"). Coinbase asks a few eligibility questions.
2. Create the key at **[portal.cdp.coinbase.com](https://portal.cdp.coinbase.com/) → API Keys → Secret API Keys → Create API key**. Give it a nickname, expand **API restrictions**: tick **View** (read-only view) or **View + Trade** (live mode). **Never tick Transfer** (the agent refuses to trade with a key that can transfer). Leave the IP allowlist empty (GitHub's servers change IP). Expand **Advanced settings** and set the signature algorithm to **ECDSA**. Click **Create API key**.
3. Copy the two values Coinbase shows once: the **API key name** (looks like `organizations/…/apiKeys/…`) and the **private key** (a multi-line block that starts with `BEGIN EC PRIVATE KEY`).
4. In this repo: **[Settings → Secrets and variables → Actions](../../settings/secrets/actions) → New repository secret**, twice:
   - `COINBASE_API_KEY_NAME` = the key name
   - `COINBASE_API_PRIVATE_KEY` = the whole private key, including the BEGIN/END lines

That's all. On its next run the agent shows "Coinbase: connected (view-only)" with your USD cash, futures buying power and open futures positions. Keys exist only in GitHub's encrypted secrets; they are never written to a file, the data branch or the page. The repo is public, so the balances are **encrypted** (AES-GCM, key `DESK_KEY` derived from the desk password, stored as a secret) before they go into `state.json`; only the unlocked dashboard can read them. Nothing in state carries a key name, account id or order id. `.gitignore` keeps `.env`, `*.pem`, `*.key`, `secrets*` and `config.local.json` out of git, and `test/secrets.test.js` fails the build if a key-like string is ever committed.

### Live mode (real money, OFF)

Strategy (works on one account): **Coinbase same-account cash-and-carry**. When the Coinbase US perp (ETH or SOL) pays positive hourly funding high enough, the agent buys spot and shorts the same amount of the perp, collects funding, and exits both legs when funding flips negative. Price moves cancel out between the two legs; the profit is the funding minus fees.

Hard gates in `scripts/live/coinbase-live.mjs` (each **rejects** the order and has a test in `test/live.test.mjs`):

| Gate | Default | Rule |
|---|---|---|
| Kill switch | `live.enabled = false` | Off = no entries; if a position is open it is closed (both legs). `paused: true` also stops new entries. |
| Max position | $250 | Contracts = floor($250 ÷ contract value). SOL's smallest contract (5 SOL ≈ $510) does not fit, so only ETH (0.1 ETH ≈ $236) can trade. |
| Max loss | $25 | Realized + unrealized ≤ −$25 → close both legs and **halt**. Bump `live.rearm` to re-arm. |
| One position | 1 | Only one carry position at a time. |
| Orders per day | 4 | An entry needs room for its own exit (2 + 2). Exits/unwinds are never blocked. |
| Edge | 2× fees over 24 h | Expected funding over 24 h must be ≥ 2 × all fees (spot + perp, in and out, taker, at your real fee tier read from Coinbase). |
| No leverage | 1× | Short size = spot size exactly; USD cash must cover the spot leg and futures buying power must cover the full short. |
| Permissions | View+Trade | No Trade permission → no orders. **Transfer permission → refuses to trade.** |
| Unknown positions | none | Any futures position the agent didn't open → no trading. |

Order path: perp short first (limit IOC, at most 0.15% through the bid), fill verified from Coinbase, then the same amount of spot (limit IOC); if the second leg fails, the first is unwound at once and live mode halts. Client order ids are deterministic so a retried run can't double-order. The API client has an allow-list: it can read balances/products/positions/fills and create orders; there is no transfer, withdrawal, deposit or sweep call anywhere in the code.

**Honest math (Oct 25, 2026):** ETH perp funding on Coinbase was +0.0018%/h. One contract (0.1 ETH ≈ $236) earns ≈ $0.10 per day. Fees to open and close both legs at a 0.5% spot taker tier ≈ $2.50, so the 2× gate needs ≈ $5 of funding in 24 h: about 50× today's rate. At today's funding, a position would take ~25 days just to pay its fees. Expect live mode to sit idle most of the time; that is the gate working, not a bug.

To turn it on later: fund the account, add the two secrets (View + Trade key), then set `"live": { "enabled": true, … }` in config.json.

## Honest caveats

Funding arbitrage earns small, slow carry; after fees most hours show **no** setup. Hedged positions still carry basis, liquidation and venue risk. One good day proves nothing. Not financial advice.
