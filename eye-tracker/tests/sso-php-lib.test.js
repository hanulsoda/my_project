'use strict';
// Runs the PHP-side checks (tests/php/decide-test.php: session-only roles, \z-anchored ids, the
// fail-closed admin_teacher_id and scope rules) with a local php, or php:8.3-cli in Docker.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = 'tests/php/decide-test.php';

function runner() {
  if (spawnSync('php', ['-v']).status === 0) return ['php', [path.join(ROOT, SCRIPT)]];
  if (spawnSync('docker', ['image', 'inspect', 'php:8.3-cli']).status === 0) {
    return ['docker', ['run', '--rm', '-v', `${ROOT}:/w`, 'php:8.3-cli', 'php', `/w/${SCRIPT}`]];
  }
  return null;
}

const how = runner();
test('PHP academy library: decision and token rules', { skip: how ? false : 'no php and no php:8.3-cli image' }, () => {
  const r = spawnSync(how[0], how[1], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ALL OK/);
  assert.doesNotMatch(r.stdout, /^FAIL/m);
});
