'use strict';
// Line metrics for natural readers: variable durations, word skips, pauses, indents, noise (seeds 3000-3199, see tests/line-scenarios.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./line-scenarios');

const GROUP = 'natural';
const r = (name) => S.resultOf(GROUP, name);
for (const name of Object.keys(S.GROUPS[GROUP])) {
  test(`reliable and wrong in <= 2% of ${S.N} sessions: ${name}`, () => {
    const x = r(name);
    assert.ok(x.reliableWrong <= S.MAX_RELIABLE_WRONG, `${x.reliableWrong} of ${S.N} reliable but wrong (reliable ${x.reliable})`);
  });
}

test('a 1.2 s pause between lines is a break, not bad gaze (>= 80% reliable)', () => {
  assert.ok(r('1.2 s gaze pause between lines').reliable >= 0.8 * S.N, `reliable ${r('1.2 s gaze pause between lines').reliable}`);
});

test('moderately noisy webcam gaze (y sd 60, offset +100) is still useful (>= 50% reliable)', () => {
  for (const name of ['noisy: y sd 60, offset +100', 'noisy: y sd 60, offset +100, some pinned samples']) {
    assert.ok(r(name).reliable >= 0.5 * S.N, `${name}: reliable ${r(name).reliable} of ${S.N}`);
  }
});
