'use strict';
// read.html design layer (public/css/read.css): the styles must stay colour/decoration-only on the
// reading text, and the markup the scripts rely on must stay in place.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (rel) => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');

test('read.html loads read.css after app.css and keeps the ids the scripts use', () => {
  const html = read('read.html');
  const app = html.indexOf('/css/app.css');
  const own = html.indexOf('/css/read.css');
  assert.ok(app > 0 && own > app, 'read.css comes after app.css');
  for (const id of ['s-loading', 's-error', 'error-title', 'error-text', 's-consent', 's-setup', 'child-code', 'child-line',
    'kind-choice', 'passage-select', 'size-choice', 'practice', 'setup-error', 'start', 's-ready', 'calibrate',
    's-sending', 's-fail', 'fail-text', 'retry', 's-finish', 'passage-wrap', 'passage', 'done-bar', 'begin', 'next', 'done']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  // the practice note is shown by a sibling selector, so it must follow #begin
  assert.ok(html.indexOf('id="practice-note"') > html.indexOf('id="begin"'));
  // the child sees no scores on the finish screen
  const finish = html.slice(html.indexOf('id="s-finish"'), html.indexOf('id="passage-wrap"'));
  assert.doesNotMatch(finish, /점수|\d+\s*(?:%|점|wpm)/i);
});

test('read.css does not change the geometry of the passage or its words', () => {
  const css = read('css/read.css');
  const geometry = /\b(?:font(?:-size|-family)?|line-height|letter-spacing|word-spacing|padding|margin|width|height|top|left|border(?:-width)?)\s*:/;
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].trim();
    if (!/#passage(?![-\w])|#passage-wrap|span\.w|\.w\b/.test(sel)) continue;
    assert.doesNotMatch(m[2], geometry, `${sel} sets a layout property`);
  }
  // the bottom bar stays inside the 64px read.js keeps free under the text
  assert.match(read('js/read.js'), /DONE_BAR_PX = 64/);
  assert.match(css, /#done-bar button \{[^}]*white-space: nowrap/);
});
