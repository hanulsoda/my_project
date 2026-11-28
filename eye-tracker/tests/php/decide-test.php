<?php
// Test-only: checks reading_go_decide() and the token builder's refusals. Exits 1 on failure.
//   docker run --rm -v "$PWD":/w php:8.3-cli php /w/tests/php/decide-test.php
declare(strict_types=1);
require __DIR__ . '/../../deploy/academy-site/reading_sso_lib.php';

$fails = 0;
function check(string $name, bool $ok): void
{
    global $fails;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    if (!$ok) $fails++;
}
$yes = static fn(string $id): bool => true;
$no = static fn(string $id): bool => false;
$only0123 = static fn(string $id): bool => $id === '0123';

check('not logged in -> login', reading_go_decide([], [], $yes) === ['login' => true]);
check('student_logged_in must be exactly true', reading_go_decide(['student_logged_in' => 1, 'student_id' => '0123'], [], $yes) === ['login' => true]);
check('director', reading_go_decide(['admin_logged_in' => true, 'admin_teacher_id' => 0], [], null)
    === ['role' => 'director', 'uid' => 'admin', 'sid' => '', 'next' => '/children.html']);
check('teacher', reading_go_decide(['admin_logged_in' => true, 'admin_teacher_id' => '12'], [], null)
    === ['role' => 'teacher', 'uid' => '12', 'sid' => '', 'next' => '/children.html']);
check('student from the SESSION, zero-padded', reading_go_decide(['student_logged_in' => true, 'student_id' => '123'], [], null)
    === ['role' => 'student', 'uid' => '0123', 'sid' => '0123', 'next' => '']);
check('student ignores ?student= in the request', reading_go_decide(['student_logged_in' => true, 'student_id' => '0123'], ['student' => '0456'], $yes)['sid'] === '0123');
check('student with a bad id -> error', isset(reading_go_decide(['student_logged_in' => true, 'student_id' => 'x1'], [], null)['error']));
check('teacher + own student', reading_go_decide(['admin_logged_in' => true, 'admin_teacher_id' => 12], ['student' => '0123'], $only0123)['sid'] === '0123');
check('teacher + other class -> error', isset(reading_go_decide(['admin_logged_in' => true, 'admin_teacher_id' => 12], ['student' => '0456'], $only0123)['error']));
check('teacher + no scope functions -> error (fail closed)', isset(reading_go_decide(['admin_logged_in' => true, 'admin_teacher_id' => 12], ['student' => '0123'], null)['error']));
check('director + student, no scope functions', reading_go_decide(['admin_logged_in' => true], ['student' => '0123'], null)['sid'] === '0123');
check('director + student refused by scope', isset(reading_go_decide(['admin_logged_in' => true], ['student' => '0123'], $no)['error']));
foreach (['123', '01234', '0123/', '../1', ['0123']] as $bad) {
    check('bad ?student= ' . json_encode($bad), isset(reading_go_decide(['admin_logged_in' => true], ['student' => $bad], $yes)['error']));
}
// F4: a trailing newline is not a valid id anywhere (PCRE "$" would accept it).
check('session student_id with newline -> error', isset(reading_go_decide(['student_logged_in' => true, 'student_id' => "0123\n"], [], null)['error']));
check('?student= with newline -> error', isset(reading_go_decide(['admin_logged_in' => true], ['student' => "0123\n"], $yes)['error']));
// F5: only an absent/null or exactly 0 admin_teacher_id is the director; anything malformed is refused.
foreach ([[null, 'director'], [0, 'director'], ['0', 'director'], [12, 'teacher'], ['12', 'teacher']] as [$tid, $want]) {
    $sess = ['admin_logged_in' => true];
    if ($tid !== null) $sess['admin_teacher_id'] = $tid;
    check('admin_teacher_id ' . json_encode($tid) . " -> $want", (reading_go_decide($sess, [], null)['role'] ?? null) === $want);
}
foreach (['abc', -3, '-3', '', ' 12', '12 ', "12\n", '00', '012', '1.5', 1.5, true, false, [1], '99999999999'] as $tid) {
    check('admin_teacher_id ' . json_encode($tid) . ' -> refused', isset(reading_go_decide(['admin_logged_in' => true, 'admin_teacher_id' => $tid], [], null)['error']));
}
// S5: a scope check that throws is a refusal, never a token.
$boom = static function (string $id): bool { throw new RuntimeException('db down'); };
check('throwing scope check (teacher) -> error', isset(reading_go_decide(['admin_logged_in' => true, 'admin_teacher_id' => 12], ['student' => '0123'], $boom)['error']));
check('throwing scope check (director) -> error', isset(reading_go_decide(['admin_logged_in' => true], ['student' => '0123'], $boom)['error']));

$secret = str_repeat('s', 40);
foreach ([['teacher', "12\n", ''], ['student', "0123\n", "0123\n"], ['director', "admin\n", ''], ['teacher', '12', "0123\n"], ['teacher', '0', ''], ['teacher', 'abc', ''], ['student', '0123', ''], ['student', '0123', '0456'], ['parent', '1', ''], ['director', '원장', '']] as [$r, $u, $s]) {
    $threw = false;
    try { reading_sso_token($r, $u, $s, $secret, 1000); } catch (InvalidArgumentException) { $threw = true; }
    check("token refused for $r/$u/$s", $threw);
}
$threw = false;
try { reading_sso_token('teacher', '12', '', "  short \n", 1000); } catch (RuntimeException) { $threw = true; }
check('short secret refused', $threw);
$t = reading_sso_token('teacher', '12', '', "  $secret\n", 1000);
[$b64, $sig] = explode('.', $t);
check('secret trimmed before signing', hash_equals(hash_hmac('sha256', $b64, $secret), $sig));
$p = json_decode(base64_decode(strtr($b64, '-_', '+/')), true);
check('payload fields', array_keys($p) === ['v', 'role', 'uid', 'sid', 'exp', 'n'] && $p['exp'] === 1300 && preg_match('/^[0-9a-f]{32}$/', $p['n']) === 1);
check('two tokens never share a nonce', $t !== reading_sso_token('teacher', '12', '', $secret, 1000));
echo $fails === 0 ? "ALL OK\n" : "$fails FAILED\n";
exit($fails === 0 ? 0 : 1);
