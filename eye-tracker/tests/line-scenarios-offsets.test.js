'use strict';
// Line metrics with changing gaze offsets: look-aways, glances, drift up and down, sign changes, steps (seeds 3000-3199, see tests/line-scenarios.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./line-scenarios');

const GROUP = 'offsets';
const r = (name) => S.resultOf(GROUP, name);
for (const name of Object.keys(S.GROUPS[GROUP])) {
  test(`reliable and wrong in <= 2% of ${S.N} sessions: ${name}`, () => {
    const x = r(name);
    assert.ok(x.reliableWrong <= S.MAX_RELIABLE_WRONG, `${x.reliableWrong} of ${S.N} reliable but wrong (reliable ${x.reliable})`);
  });
}

test('a glance off the text is not a line (accuracy >= 90%, trivial rule < 85%)', () => {
  const x = r('3 s glance at the top right between lines 3 and 4');
  assert.ok(x.acc >= 0.9, `accuracy ${x.acc}`);
  assert.ok(x.trivial < 0.85, `trivial ${x.trivial}`);
});

test('look-away with an offset change: reliable sessions are assigned right (>= 90%)', () => {
  for (const name of ['look-away 4 s, offset +150 -> +20', 'look-away 4 s, offset +150 -> +280', 'look-away 1 s, offset +150 -> +20']) {
    if (r(name).reliable > 0) assert.ok(r(name).accReliable >= 0.9, `${name}: accuracy of reliable sessions ${r(name).accReliable}`);
  }
});

test('looking away without moving does not cost reliability (>= 80% reliable)', () => {
  assert.ok(r('look-away 4 s, same offset').reliable >= 0.8 * S.N, `reliable ${r('look-away 4 s, same offset').reliable}`);
});
