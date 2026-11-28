'use strict';
// Line metrics under poor gaze: few fixations, portrait, noise, clamping, stares (seeds 3000-3199, see tests/line-scenarios.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./line-scenarios');

const GROUP = 'gaze';
const r = (name) => S.resultOf(GROUP, name);
for (const name of Object.keys(S.GROUPS[GROUP])) {
  test(`reliable and wrong in <= 2% of ${S.N} sessions: ${name}`, () => {
    const x = r(name);
    assert.ok(x.reliableWrong <= S.MAX_RELIABLE_WRONG, `${x.reliableWrong} of ${S.N} reliable but wrong (reliable ${x.reliable})`);
  });
}

test('gaze pinned to the screen edge makes the session 참고용', () => {
  assert.ok(r('small laptop, offset +250, clamped').reliable <= 0.01 * S.N);
});

test('a stare is not offered as a reading (<= 2% reliable), and a one-line stare is not completed', () => {
  // Every reliable stare counts as wrong, so this is the same 2% bar as above.
  for (const name of ['stare with sweeps at one height (8 lines)', 'stare with sweeps at one height (1 line)', 'wandering blob (8 lines)', 'wandering blob (1 line)', 'frozen point (8 lines)']) {
    assert.ok(r(name).reliable <= S.MAX_RELIABLE_WRONG, `${name}: reliable ${r(name).reliable}`);
  }
  const { computeLineMetrics } = require('../server/line-metrics');
  const builds = [
    S.notReading(() => (t, rng, normal) => ({ x: 640 + normal() * 15, y: 400 + normal() * 15 }), 1),
    S.notReading(S.sweepsAtOneHeight, 1),
    S.notReading(() => (t, rng) => ({ x: rng() * 1280, y: rng() * 1100 }), 1),
  ];
  for (const build of builds) {
    for (let seed = S.SEED0; seed < S.SEED0 + 10; seed++) {
      const b = build(seed);
      assert.equal(computeLineMetrics(b.samples, b.L.words, S.LAPTOP).completed, false, `seed ${seed}`);
    }
  }
});

test('too few fixations per line is 참고용, not a guess', () => {
  assert.ok(r('2 fixations per line').reliable <= 0.2 * S.N, `reliable ${r('2 fixations per line').reliable}`);
});
