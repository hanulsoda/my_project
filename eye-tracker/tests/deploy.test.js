'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const lines = (rel) => read(rel).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

// Splits docker-compose.yml into { serviceName: textOfItsBlock } (two-space-indented keys under services:).
function composeServices() {
  const text = read('docker-compose.yml');
  const m = text.match(/^services:\n([\s\S]*?)(?=^\S|(?![\s\S]))/m);
  assert.ok(m, 'services: section');
  const out = {};
  let cur = null;
  for (const line of m[1].split('\n')) {
    const key = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (key) { cur = key[1]; out[cur] = ''; } else if (cur) out[cur] += `${line}\n`;
  }
  return out;
}

test('docker-compose.yml: app and caddy services, only caddy publishes ports 80/443', () => {
  const s = composeServices();
  assert.deepEqual(Object.keys(s).sort(), ['app', 'caddy']);
  assert.match(s.caddy, /ports:[\s\S]*"80:80"[\s\S]*"443:443"/);
  assert.doesNotMatch(s.app, /^\s*ports:/m, 'the app port must not be published on the host');
  assert.match(s.app, /^\s*expose:[\s\S]*"3000"/m, 'app port stays internal');
  for (const name of ['app', 'caddy']) assert.match(s[name], /restart:\s*unless-stopped/, `${name} restart policy`);
  assert.match(s.app, /env_file:\s*\n?\s*-?\s*\.env/);
  assert.match(s.app, /-\s*app-data:\/app\/data\/db\s*$/m, 'SQLite directory is a named volume');
  // server/passages.js requires data/passages.json, which ships in the image: a volume on
  // /app/data itself would hide it (and keep a stale copy across updates).
  assert.doesNotMatch(s.app, /:\/app\/data\s*$/m, 'no volume may cover /app/data itself');
  assert.match(s.caddy, /\.\/Caddyfile:\/etc\/caddy\/Caddyfile/);
  assert.match(s.caddy, /\/data\b/, 'caddy data volume (certificates)');
  assert.match(s.caddy, /\/config\b/, 'caddy config volume');
  assert.match(s.caddy, /depends_on/);
  assert.match(read('docker-compose.yml'), /^volumes:\n[\s\S]*app-data:[\s\S]*caddy-data:[\s\S]*caddy-config:/m);
});

test('Caddyfile: reading.dahim.kr reverse-proxied to the app, gzip, camera stays allowed', () => {
  // Comments may mention what not to do; only the active config counts.
  const c = read('Caddyfile').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.match(c, /^reading\.dahim\.kr\s*\{/m);
  assert.match(c, /reverse_proxy\s+app:3000/);
  assert.match(c, /encode\s+gzip/);
  assert.doesNotMatch(c, /http:\/\//, 'no plain-http site block: automatic HTTPS must stay on');
  assert.doesNotMatch(c, /auto_https\s+off/);
  if (/Permissions-Policy/i.test(c)) {
    assert.match(c, /camera=\(self\)/);
  }
  assert.doesNotMatch(c, /camera=\(\)/, 'a policy that blocks the camera would break measuring');
});

test('Dockerfile: node 22 slim, production install, non-root user, healthcheck, internal port', () => {
  const d = read('Dockerfile');
  assert.match(d, /^FROM node:22-slim/m);
  assert.match(d, /npm ci --omit=dev/);
  // Without it npm tries node-gyp for better-sqlite3 and fails on the compiler-less slim image.
  assert.match(d, /npm ci --omit=dev --ignore-scripts/);
  assert.match(d, /^USER\s+(node|\d+)/m);
  assert.doesNotMatch(d, /^USER\s+root/m);
  assert.match(d, /^HEALTHCHECK[\s\S]*\/index\.html/m);
  assert.match(d, /^EXPOSE 3000/m);
  assert.match(d, /NODE_ENV=production/);
  // A hand-written .env without DB_PATH must still put the database on the volume, not in the image layer.
  assert.match(d, /^ENV DB_PATH=\/app\/data\/db\/app\.db$/m);
  assert.match(d, /CMD \["node", "server\/index\.js"\]/);
  // The non-root user must be able to write the SQLite directory.
  assert.match(d, /chown[^\n]*\/app\/data/);
  // passages.json is required by server/passages.js and must be in the image.
  assert.match(d, /COPY data\/passages\.json/);
});

test('.dockerignore keeps secrets, data and non-runtime folders out of the image', () => {
  const entries = lines('.dockerignore');
  for (const e of ['node_modules', '.git', '.superpowers', 'docs', 'tests', 'app', 'skill', 'deploy', '.env']) {
    assert.ok(entries.includes(e) || entries.includes(`${e}/`), `.dockerignore lists ${e}`);
  }
  // data/ is excluded (databases), except passages.json which server/passages.js requires.
  assert.ok(entries.includes('data/*'));
  assert.ok(entries.includes('!data/passages.json'));
});

test('.env.example: placeholders only, never a real password', () => {
  const env = Object.fromEntries(lines('.env.example').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.ok('ADMIN_EMAIL' in env);
  assert.ok('ADMIN_PASSWORD' in env);
  assert.match(env.ADMIN_PASSWORD, /^change-me/i, 'password must be an obvious placeholder');
  assert.match(env.ADMIN_EMAIL, /example\.(com|org|test)$/);
  assert.equal(env.DB_PATH, '/app/data/db/app.db', 'must sit on the app-data volume mount');
  assert.equal(env.NODE_ENV, 'production');
});

test('.env is git-ignored and not tracked; no real .env is committed', () => {
  const ignore = read('.gitignore').split('\n').map((l) => l.trim());
  assert.ok(ignore.includes('.env'), '.gitignore lists .env');
  if (fs.existsSync(path.join(ROOT, '.git'))) {
    const tracked = execFileSync('git', ['ls-files', '.env', '.env.*'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
    assert.deepEqual(tracked.filter((f) => f !== '.env.example'), [], 'only .env.example may be tracked');
    execFileSync('git', ['check-ignore', '-q', '.env'], { cwd: ROOT });
  }
});

test('docs/deploy.md: ports, DNS, first start, backup, update and the honest scope note', () => {
  const d = read('docs/deploy.md');
  assert.match(d, /\b80\b/);
  assert.match(d, /\b443\b/);
  assert.match(d, /reading\.dahim\.kr/);
  assert.match(d, /A 레코드/);
  assert.match(d, /<VM_PUBLIC_IP>/);
  assert.match(d, /docker compose up -d/);
  assert.match(d, /\.backup/);
  assert.match(d, /docker compose logs/);
  assert.match(d, /git pull/);
  assert.match(d, /이 저장소에서 하지 않은 것/);
  assert.match(d, /동의/);
  // Only a public resolver (propagation check) and the "any source" CIDR may appear literally.
  assert.doesNotMatch(d.replaceAll('1.1.1.1', '').replaceAll('0.0.0.0/0', ''), /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, 'no invented IP addresses');
});

test('docs/deploy.md: password reset via the admin CLI, ADMIN_PASSWORD quoting trap, no false "no reset" claim', () => {
  const d = read('docs/deploy.md');
  assert.match(d, /docker compose exec -T app node server\/admin-cli\.js set-password/);
  assert.match(d, /server\/admin-cli\.js disable/);
  assert.match(d, /server\/admin-cli\.js list/);
  assert.match(d, /표준 입력|stdin/, 'password is piped, not an argument');
  assert.match(d, /작은따옴표/, 'quote ADMIN_PASSWORD in single quotes');
  assert.match(d, /\$ # " '|\$ # "/, 'names the characters that compose interpolation alters');
  assert.match(d, /로그인.*확인|확인.*로그인/, 'test login right after first start');
  assert.doesNotMatch(d, /비밀번호 재설정 화면이 없습니다/, 'the old sentence must be replaced by the honest CLI-only statement');
  assert.match(d, /웹 화면은 없/, 'states plainly that there is no web UI for it');
});

test('docs/accuracy-protocol.md: devices, threshold rule tied to line-metrics.js, screening-only wording', () => {
  const d = read('docs/accuracy-protocol.md');
  for (const t of ['iPad', 'Safari', 'Android', 'Chrome', 'Edge']) assert.match(d, new RegExp(t), t);
  const threshold = read('server/line-metrics.js').match(/LINE_RELIABLE_MIN\s*=\s*([0-9.]+)/)[1];
  assert.ok(d.includes(threshold), `mentions the current threshold ${threshold}`);
  assert.match(d, /server\/line-metrics\.js/);
  assert.match(d, /LINE_RELIABLE_MIN/);
  assert.doesNotMatch(d, /QUALITY_WORD_THRESHOLD/, 'the word-level threshold is no longer what the product uses');
  assert.match(d, /154/, 'records the real laptop result');
  assert.match(d, /90%/, 'states the line-level target');
  assert.match(d, /measure\.html/);
  assert.match(d, /줄 단위/);
  assert.match(d, /단어 단위/);
  assert.match(d, /진단이 아/);
});
