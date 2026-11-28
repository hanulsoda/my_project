'use strict';
const { startTestServer } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { csvCell, toCsv } = require('../server/csv');

const HEADER = ['code', 'initials', 'gradeBand', 'group', 'consentDate', 'sessionCount', 'lastSessionAt',
  'lastWpm', 'lastLinesRead', 'lastTotalLines', 'lastReliable'];

function call(srv, method, path, cookie, body) {
  return fetch(srv.url + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// Minimal RFC 4180 reader (quotes, doubled quotes, CRLF), to prove the output round-trips.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell); rows.push(row); row = []; cell = ''; i++;
    } else cell += ch;
  }
  assert.equal(quoted, false, 'unterminated quote');
  assert.equal(cell === '' && row.length === 0, true, 'file ends with CRLF');
  return rows;
}

test('csvCell / toCsv', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell(''), '');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(83), '83');
  assert.equal(csvCell(true), 'true');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell('cr\rhere'), '"cr\rhere"');
  for (const lead of ['=', '+', '-', '@']) assert.equal(csvCell(`${lead}1+2`), `'${lead}1+2`, lead);
  assert.equal(csvCell('\tx'), "'\tx");
  assert.equal(csvCell('\rx'), '"\'\rx"', 'prefixed, then quoted because of the CR');
  assert.equal(csvCell('=1,2'), '"\'=1,2"', 'prefixed, then quoted');
  assert.equal(csvCell('a=b'), 'a=b', 'only a leading trigger matters');
  assert.equal(csvCell("'=x"), "'=x", 'already starts with a quote: not a formula');
  // The trigger is judged after leading whitespace too, and LF and full-width look-alikes count.
  assert.equal(csvCell(' =1+1'), "' =1+1");
  assert.equal(csvCell('  \t@x'), "'  \t@x");
  assert.equal(csvCell('\n=1+1'), '"\'\n=1+1"');
  assert.equal(csvCell('\u3000=1+1'), "'\u3000=1+1", 'ideographic space then formula');
  for (const lead of ['＝', '＋', '－', '＠']) assert.equal(csvCell(`${lead}1+1`), `'${lead}1+1`, lead);
  assert.equal(csvCell(' safe'), ' safe');
  assert.equal(csvCell('a =1'), 'a =1');
  // Numbers stay numbers: a negative figure is never prefixed.
  assert.equal(csvCell(-5), '-5');
  assert.equal(csvCell(-0.5), '-0.5');
  assert.equal(toCsv([['n', -3]]), '\uFEFFn,-3\r\n');
  assert.equal(toCsv([['a', 'b'], ['1', '=2']]), '﻿a,b\r\n1,\'=2\r\n');
});

test('GET /api/children/export.csv', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const cookieA = await srv.loginAs('teacher');
  const cookieB = await srv.loginAs('teacher');
  const adminCookie = await srv.loginAs('admin');
  const DAY = 86400000;
  const t0 = Date.UTC(2026, 2, 2, 9, 30, 0);

  const addChild = async (cookie, body) => {
    const res = await call(srv, 'POST', '/api/children', cookie, { gradeBand: 'elementary', ...body });
    assert.equal(res.status, 201, JSON.stringify(body));
    return (await res.json()).id;
  };
  const addSession = (childId, kind, startedAt, metrics) => srv.db.prepare(
    `INSERT INTO read_sessions (child_id, passage_id, kind, started_at, screen_w, screen_h, words_json, samples_json, metrics_json)
     VALUES (?, 'p', ?, ?, 1280, 720, '[]', '[]', ?)`,
  ).run(childId, kind, startedAt, JSON.stringify(metrics));
  const reliable = (over = {}) => ({ wpm: 83.4, linesRead: 5, totalLines: 6, reliable: true, detail: 'line', ...over });

  // A-1: two reference sessions (the newer one wins) and a later non-reference one.
  const a1 = await addChild(cookieA, { code: 'A-1', initials: 'KJ', consentDate: '2026-03-02', group: '월요반' });
  addSession(a1, 'reference', t0, reliable({ wpm: 10, linesRead: 1, totalLines: 2 }));
  addSession(a1, 'reference', t0 + DAY, reliable());
  addSession(a1, 'new', t0 + 2 * DAY, reliable({ wpm: 999, linesRead: 9, totalLines: 9 }));
  // A-2: latest reference session is unreliable (참고용): figures blank, flag false.
  const a2 = await addChild(cookieA, { code: 'A-2', initials: 'LS', consentDate: '2026-03-03' });
  addSession(a2, 'reference', t0, reliable({ wpm: 120, linesRead: 4, totalLines: 8, reliable: false }));
  // A-3: no sessions, no consent.
  await addChild(cookieA, { code: 'A-3', initials: 'PH' });
  // A-4: legacy word-level metrics (no `reliable`): wpm kept, no line figures; A-5: legacy line-only = reference only.
  const a4 = await addChild(cookieA, { code: 'A-4', initials: 'W4' });
  addSession(a4, 'reference', t0, { wpm: 70.6, detail: 'word', quality: 0.9 });
  const a5 = await addChild(cookieA, { code: 'A-5', initials: 'W5' });
  addSession(a5, 'reference', t0, { wpm: 55, detail: 'line', quality: 0.3 });
  // A-6: only a non-reference session: counted, but no figures.
  const a6 = await addChild(cookieA, { code: 'A-6', initials: 'N6' });
  addSession(a6, 'new', t0 + 5 * DAY, reliable());
  // Hostile text everywhere a teacher can type.
  await addChild(cookieA, { code: '=HYPERLINK("x")', initials: '@SUM(1)', group: '+1,"q"' });
  await addChild(cookieA, { code: '-1+1', initials: 'a,b', group: 'two\nlines' });
  // The API trims codes and initials, so a tab/CR-led value can only come from older rows: write it directly.
  const legacy = await addChild(cookieA, { code: 'LEGACY', initials: 'LG', group: '한글' });
  srv.db.prepare('UPDATE children SET code = ?, initials = ? WHERE id = ?').run('\tTAB', '\rCR', legacy);
  await addChild(cookieA, { code: ' =1+1', initials: '＝SUM', group: '＠x' });
  // Another teacher's data must never show up.
  const b1 = await addChild(cookieB, { code: 'B-SECRET', initials: 'ZZ', group: 'B-GROUP', consentDate: '2026-03-02' });
  addSession(b1, 'reference', t0, reliable({ wpm: 77 }));

  srv.clock.t = Date.UTC(2026, 10, 28, 15, 0, 0);
  const get = (cookie) => call(srv, 'GET', '/api/children/export.csv', cookie);
  // fetch's .text() silently drops a leading BOM, so decode the bytes ourselves.
  const body = async (cookie) => Buffer.from(await (await get(cookie)).arrayBuffer()).toString('utf8');

  await t.test('requires login', async () => {
    assert.equal((await get(null)).status, 401);
  });

  await t.test('headers: csv, attachment with a dated filename, no-store', async () => {
    const res = await get(cookieA);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/csv; charset=utf-8$/i);
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="children-20261128.csv"');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    await res.arrayBuffer();
  });

  await t.test('UTF-8 BOM first, CRLF line endings, fixed header', async () => {
    const buf = Buffer.from(await (await get(cookieA)).arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
    const text = buf.toString('utf8');
    assert.equal(text.charCodeAt(0), 0xFEFF);
    assert.ok(text.endsWith('\r\n'));
    assert.equal(text.slice(1, text.indexOf('\r\n')), HEADER.join(','));
    assert.ok(!/(^|[^\r])\n/.test(text.replace(/"(?:[^"]|"")*"/g, '""')), 'every line break outside quotes is CRLF');
  });

  await t.test('figures: latest reference session, blank when unreliable, no sessions or legacy line-only', async () => {
    const rows = parseCsv((await body(cookieA)).slice(1));
    assert.deepEqual(rows[0], HEADER);
    const byCode = Object.fromEntries(rows.slice(1).map((r) => [r[0], r]));
    const iso = (ms) => new Date(ms).toISOString();
    assert.deepEqual(byCode['A-1'], ['A-1', 'KJ', 'elementary', '월요반', '2026-03-02', '3', iso(t0 + 2 * DAY), '83', '5', '6', 'true']);
    assert.deepEqual(byCode['A-2'], ['A-2', 'LS', 'elementary', '', '2026-03-03', '1', iso(t0), '', '', '', 'false']);
    assert.deepEqual(byCode['A-3'], ['A-3', 'PH', 'elementary', '', '', '0', '', '', '', '', '']);
    assert.deepEqual(byCode['A-4'], ['A-4', 'W4', 'elementary', '', '', '1', iso(t0), '71', '', '', 'true']);
    assert.deepEqual(byCode['A-5'], ['A-5', 'W5', 'elementary', '', '', '1', iso(t0), '', '', '', 'false']);
    assert.deepEqual(byCode['A-6'], ['A-6', 'N6', 'elementary', '', '', '1', iso(t0 + 5 * DAY), '', '', '', '']);
    assert.equal(rows.length, 1 + 10, 'header plus this teacher\'s ten children');
    assert.ok(rows.every((r) => r.length === HEADER.length));
  });

  await t.test('rows are in creation order (child id)', async () => {
    const rows = parseCsv((await body(cookieA)).slice(1)).slice(1);
    assert.deepEqual(rows.slice(0, 6).map((r) => r[0]), ['A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6']);
  });

  await t.test('quoting and formula injection: hostile cells are neutralised and still round-trip', async () => {
    const raw = (await body(cookieA));
    const rows = parseCsv(raw.slice(1)).slice(1);
    const hostile = rows.slice(6, 10);
    assert.deepEqual(hostile.map((r) => r.slice(0, 4)), [
      ["'=HYPERLINK(\"x\")", "'@SUM(1)", 'elementary', "'+1,\"q\""],
      ["'-1+1", 'a,b', 'elementary', 'two\nlines'],
      ["'\tTAB", "'\rCR", 'elementary', '한글'],
      ["'=1+1", "'＝SUM", 'elementary', "'＠x"],
    ]);
    // Raw bytes: the quote characters really are doubled, and no cell starts with a trigger.
    assert.ok(raw.includes('"\'=HYPERLINK(""x"")"'));
    for (const row of rows) {
      for (const cell of row) assert.doesNotMatch(cell.trimStart(), /^[=+\-@＝＋－＠\t\r\n]/, `unprotected cell ${JSON.stringify(cell)}`);
    }
  });

  await t.test('tenancy: another teacher\'s children never appear; the director exports every child', async () => {
    const text = await (await get(cookieA)).text();
    assert.doesNotMatch(text, /B-SECRET|B-GROUP|ZZ/);
    const own = parseCsv((await body(cookieB)).slice(1));
    assert.deepEqual(own.slice(1).map((r) => r[0]), ['B-SECRET']);
    assert.deepEqual(own[1].slice(7), ['77', '5', '6', 'true']);
    const admin = parseCsv((await body(adminCookie)).slice(1));
    assert.deepEqual(admin[0], HEADER);
    assert.ok(admin.some((r) => r[0] === 'B-SECRET') && admin.some((r) => r[0] === 'A-1'), 'the director sees all (docs/sso.md)');
  });

  await t.test('the export carries no ids, teacher data, notes or session payloads', async () => {
    srv.db.prepare("UPDATE children SET note = 'PRIVATE-CHILD-NOTE' WHERE code = 'A-1'").run();
    srv.db.prepare("UPDATE read_sessions SET note = 'PRIVATE-SESSION-NOTE'").run();
    const text = await (await get(cookieA)).text();
    assert.doesNotMatch(text, /PRIVATE|pw_hash|scrypt|teacher|@example/);
  });

  await t.test('the route does not shadow /api/children/:id', async () => {
    assert.equal((await call(srv, 'GET', `/api/children/${a1}`, cookieA)).status, 200);
    assert.equal((await call(srv, 'GET', '/api/children/export', cookieA)).status, 404);
  });
});
