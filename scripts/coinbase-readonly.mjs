// READ-ONLY view of Luis's real Coinbase account (Advanced Trade API, CDP key with "View" permission).
// Only GET requests, only balance/permission/position reads. There is no order code anywhere in this repo,
// and this file refuses any method other than GET. Keys come from GitHub Actions secrets and are never written out.
// Totals are encrypted (AES-256-GCM, key = DESK_KEY secret, derived from the dashboard password) before they
// go into the public state.json, so only the unlocked dashboard can read them.
import crypto from 'node:crypto';

const HOST = 'api.coinbase.com';
const b64u = b => Buffer.from(b).toString('base64url');

export function loadKey(name, secret) {
  if (!name || !secret) return null;
  const s = secret.replace(/\\n/g, '\n').trim();
  if (s.includes('BEGIN')) return { name, alg: 'ES256', key: crypto.createPrivateKey(s) };
  const raw = Buffer.from(s, 'base64'); // Ed25519 secret (64 bytes seed+pub, or 32-byte seed)
  if (raw.length !== 64 && raw.length !== 32) throw new Error('private key format not recognised (expected ECDSA PEM or Ed25519 base64)');
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw.subarray(0, 32)]);
  return { name, alg: 'EdDSA', key: crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }) };
}

export function jwtFor(k, method, path, now = Date.now()) {
  const t = Math.floor(now / 1000);
  const header = { alg: k.alg, kid: k.name, nonce: crypto.randomBytes(16).toString('hex'), typ: 'JWT' };
  const payload = { sub: k.name, iss: 'cdp', nbf: t, exp: t + 120, uri: `${method} ${HOST}${path}` };
  const data = b64u(JSON.stringify(header)) + '.' + b64u(JSON.stringify(payload));
  const sig = k.alg === 'ES256'
    ? crypto.sign('sha256', Buffer.from(data), { key: k.key, dsaEncoding: 'ieee-p1363' })
    : crypto.sign(null, Buffer.from(data), k.key);
  return data + '.' + b64u(sig);
}

async function read(k, path) {
  const method = 'GET'; // the only method this module will ever send
  const r = await fetch('https://' + HOST + path, { method, headers: { Authorization: 'Bearer ' + jwtFor(k, method, path.split('?')[0]), Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) { const e = new Error('Coinbase ' + path.split('?')[0].split('/').pop() + ' HTTP ' + r.status); e.status = r.status; throw e; }
  return r.json();
}
const n = v => { const x = parseFloat(v && typeof v === 'object' ? v.value : v); return Number.isFinite(x) ? x : 0; };

export function encrypt(obj, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('DESK_KEY must be 32 bytes hex');
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  return { alg: 'AES-GCM', iv: iv.toString('base64'), ct: ct.toString('base64') };
}

export function decrypt(blob, keyHex) {
  const key = Buffer.from(keyHex.trim(), 'hex'), raw = Buffer.from(blob.ct, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8'));
}

// Returns the public block for state.json. Never throws.
export async function coinbaseSnapshot(env = process.env, now = Date.now()) {
  if (!env.COINBASE_API_KEY_NAME || !env.COINBASE_API_PRIVATE_KEY) return { status: 'not_connected', checkedAt: now };
  const out = { status: 'connected', checkedAt: now };
  try {
    const k = loadKey(env.COINBASE_API_KEY_NAME.trim(), env.COINBASE_API_PRIVATE_KEY);
    const perm = await read(k, '/api/v3/brokerage/key_permissions');
    out.canView = !!perm.can_view; out.canTrade = !!perm.can_trade; out.canTransfer = !!perm.can_transfer;
    out.viewOnly = !out.canTrade && !out.canTransfer;
    if (!out.viewOnly) out.warning = 'This key can ' + [out.canTrade && 'trade', out.canTransfer && 'transfer'].filter(Boolean).join(' and ') +
      '. The agent still never places orders, but replace it with a View-only key.';
    const acc = await read(k, '/api/v3/brokerage/accounts?limit=250');
    const cash = {}; let accounts = 0;
    for (const a of acc.accounts || []) {
      accounts++;
      const amt = n(a.available_balance) + n(a.hold);
      if (amt > 0 && ['USD', 'USDC'].includes(a.currency)) cash[a.currency] = (cash[a.currency] || 0) + amt;
    }
    const totals = { accounts, cashUSD: +(cash.USD || 0).toFixed(2), cashUSDC: +(cash.USDC || 0).toFixed(2), futures: null, positions: [] };
    try { // US futures (perp-style) account; absent if he has not opened Coinbase Financial Markets futures
      const b = (await read(k, '/api/v3/brokerage/cfm/balance_summary')).balance_summary || {};
      totals.futures = { buyingPower: n(b.futures_buying_power), totalUSD: n(b.total_usd_balance), unrealizedPnl: n(b.unrealized_pnl), dailyPnl: n(b.daily_realized_pnl), liquidationBuffer: n(b.liquidation_buffer_amount) };
      const p = await read(k, '/api/v3/brokerage/cfm/positions');
      totals.positions = (p.positions || []).map(x => ({ product: x.product_id, side: x.side, contracts: n(x.number_of_contracts), unrealizedPnl: n(x.unrealized_pnl), avgEntry: n(x.avg_entry_price) }));
    } catch (e) { totals.futuresNote = e.status === 404 || e.status === 403 ? 'no futures account on this key' : String(e.message).slice(0, 80); }
    if (env.DESK_KEY) out.enc = encrypt(totals, env.DESK_KEY.trim());
    else out.note = 'balances hidden: DESK_KEY secret missing';
  } catch (e) {
    out.status = 'error';
    out.error = (e.status === 401 ? 'Coinbase refused the key (401): check the key name/private key, and that it is ECDSA with no IP allowlist' : String(e.message || e)).slice(0, 200);
  }
  return out;
}
