// Repo is public: no key-like strings may ever be committed. Run: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '..');
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    if (['.git', 'node_modules'].includes(d.name)) return [];
    const p = path.join(dir, d.name); return d.isDirectory() ? files(p) : [p];
  });
}
const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'PEM private key'],
  [/organizations\/[0-9a-f-]{20,}\/apiKeys\/[0-9a-f-]{20,}/i, 'Coinbase CDP key name'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'], [/github_pat_[A-Za-z0-9_]{40,}/, 'GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS key'], [/\bsk-[A-Za-z0-9]{32,}/, 'API secret'], [/xox[baprs]-[A-Za-z0-9-]{20,}/, 'Slack token'],
  [/"(?:privateKey|private_key|secret|api_secret)"\s*:\s*"[^"]{16,}"/i, 'secret value in JSON']
];
test('no committed file contains a key-like string', () => {
  for (const f of files(root)) {
    if (/\.(png|jpe?g|ico|zip)$/i.test(f) || f.endsWith('secrets.test.js')) continue;
    const t = fs.readFileSync(f, 'utf8');
    for (const [re, what] of PATTERNS) assert.doesNotMatch(t, re, `${what} in ${path.relative(root, f)}`);
  }
});
test('.gitignore keeps local secret files out', () => {
  const g = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  for (const x of ['.env', '*.pem', '*.key', 'secrets*', 'config.local.json', 'node_modules']) assert.ok(g.split('\n').includes(x) || g.includes(x), x);
});
test('workflow reads Coinbase keys only from Actions secrets', () => {
  const y = fs.readFileSync(path.join(root, '.github/workflows/agent.yml'), 'utf8');
  assert.match(y, /COINBASE_API_KEY_NAME: \$\{\{ secrets\.COINBASE_API_KEY_NAME \}\}/);
  assert.match(y, /COINBASE_API_PRIVATE_KEY: \$\{\{ secrets\.COINBASE_API_PRIVATE_KEY \}\}/);
});
