// Static checks on the shipped page. Run: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('page has title, viewport, paper banner, gate, local assets', () => {
  const h = read('index.html');
  assert.match(h, /<title>Funding Desk<\/title>/);
  assert.match(h, /name="viewport" content="width=device-width/);
  assert.match(h, /PAPER MODE — no real money/);
  assert.match(h, /id="gate"/);
  for (const m of h.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    if (/^https?:/.test(m[1])) continue;
    assert.ok(fs.existsSync(path.join(root, m[1])), 'missing asset ' + m[1]);
  }
});
test('password is stored only as a SHA-256 hash', () => {
  const a = read('app.js');
  assert.match(a, /const PW_HASH = '[0-9a-f]{64}'/);
  const pwFile = '/home/user/tab/state/hq/password.txt';
  if (fs.existsSync(pwFile)) {
    const pw = fs.readFileSync(pwFile, 'utf8').trim();
    for (const f of ['index.html', 'app.js', 'core.js', 'README.md', 'styles.css']) assert.ok(!read(f).includes(pw), 'plain password found in ' + f);
  }
});
test('no live trading code: no order endpoints, no API key fields', () => {
  const all = ['app.js', 'core.js', 'scripts/fetch-rates.mjs'].map(read).join('\n');
  assert.doesNotMatch(all, /\/order|placeOrder|apiKey|api_key|X-MBX-APIKEY|signature=/i);
});
test('no placeholder text left', () => {
  for (const f of ['index.html', 'app.js', 'README.md']) assert.doesNotMatch(read(f), /lorem ipsum|TODO|__PWH__|FIXME/i);
});
test('UI text never mentions the assistant', () => {
  const h = read('index.html').replace(/<script[\s\S]*?<\/script>/g, '');
  assert.doesNotMatch(h, /\bTab\b|\bAI\b/);
});
