<?php
// Test-only: signs entry tokens with the academy library, for tests/fixtures/php-sso-tokens.json.
// Usage (from eye-tracker/):
//   docker run --rm -v "$PWD":/w php:8.3-cli php /w/tests/php/make-tokens.php <test secret> <unix now>
// The secret must be the fixed TEST value from tests/sso-helpers.js, never a real one.
declare(strict_types=1);
require __DIR__ . '/../../deploy/academy-site/reading_sso_lib.php';

[$self, $secret, $now] = $argv + [null, '', '0'];
$now = (int)$now;
$out = ['php' => PHP_VERSION, 'now' => $now, 'tokens' => [
    'director' => reading_sso_token('director', 'admin', '', $secret, $now),
    'teacher' => reading_sso_token('teacher', '12', '', $secret, $now),
    'teacherStudent' => reading_sso_token('teacher', '12', '0123', $secret, $now),
    'student' => reading_sso_token('student', '0123', '0123', $secret, $now),
], 'url' => reading_sso_url('https://reading.dahim.kr', 'TOKEN', '/children.html')];
echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
