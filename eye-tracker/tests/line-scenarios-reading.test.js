'use strict';
// Line metrics on ordinary readings: clean, re-reads, skips, regressions, stops, short last lines (seeds 3000-3199, see tests/line-scenarios.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./line-scenarios');

const GROUP = 'reading';
const r = (name) => S.resultOf(GROUP, name);
for (const name of Object.keys(S.GROUPS[GROUP])) {
  test(`reliable and wrong in <= 2% of ${S.N} sessions: ${name}`, () => {
    const x = r(name);
    assert.ok(x.reliableWrong <= S.MAX_RELIABLE_WRONG, `${x.reliableWrong} of ${S.N} reliable but wrong (reliable ${x.reliable})`);
  });
}

test('clean laptop sessions stay reliable (>= 90% at offsets 0, +150, -120 and drift)', () => {
  for (const name of ['clean, offset 0', 'clean, offset +150', 'clean, offset -120', 'clean, drift 80 -> 220']) {
    assert.ok(r(name).reliable >= 0.9 * S.N, `${name}: reliable ${r(name).reliable} of ${S.N}`);
  }
});

test('accuracy where pass order alone fails: skips, re-reads (trivial rule < 85%)', () => {
  // Two skips in six passes is partly indistinguishable from a gaze drift of about one line, so
  // its bar is lower; those sessions come out 참고용 (see the reliable-and-wrong tests).
  const bars = { 'skipping line 4': 0.9, 'skipping lines 2 and 5': 0.85, 're-reading 30% of lines from their start': 0.9, 'going back two lines': 0.9 };
  for (const [name, bar] of Object.entries(bars)) {
    assert.ok(r(name).acc >= bar, `${name}: accuracy ${r(name).acc}`);
    assert.ok(r(name).trivial < 0.85, `${name}: the trivial rule scores ${r(name).trivial}`);
  }
});

test('skip, regression, stop and re-read figures hold over many seeds (>= 90% of sessions right)', () => {
  const cases = [
    ['skipping line 4', ['skippedLines', 'linesRead', 'completed', 'regressions']],
    ['going back one line', ['regressions', 'skippedLines', 'completed']],
    ['going back two lines', ['regressions', 'skippedLines', 'completed']],
    ['stopping after 4 of 8 lines', ['linesRead', 'completed', 'skippedLines', 'regressions']],
    ['re-reading every line from its start', ['linesRead', 'completed', 'skippedLines']],
  ];
  for (const [name, keys] of cases) {
    for (const k of keys) assert.ok(r(name).right[k] >= 0.9 * S.N, `${name}: ${k} right in ${r(name).right[k]} of ${S.N}`);
  }
});

test('a short last line read just before pressing "다 읽었어요" completes the passage (>= 90%)', () => {
  for (const name of ['short last line (2 words), 0 ms on the button', 'short last line (2 words), 1 s on the button']) {
    assert.ok(r(name).right.completed >= 0.9 * S.N, `${name}: completed right in ${r(name).right.completed} of ${S.N}`);
  }
});
