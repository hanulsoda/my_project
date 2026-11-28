<?php
// reading_go.php - 다힘 사이트에서 "읽기 시선 기록 / 읽기 측정"을 누르면 오는 페이지입니다.
// 이미 로그인한 사람만 씁니다. 세션으로 역할과 번호를 정하고(요청 값은 믿지 않음), 5분짜리
// 한 번용 입장 토큰을 만들어 https://reading.dahim.kr/sso 로 보냅니다. 설치 방법은 README.md.
//   원장   : admin_logged_in 이고 admin_teacher_id 가 0      -> role director, uid "admin"
//   선생님 : admin_logged_in 이고 admin_teacher_id 가 1 이상 -> role teacher,  uid 선생님 번호
//   학생   : student_logged_in === true, student_id "0123"   -> role student,  uid=sid 학생 번호
//   선생님/원장이 학생 화면의 "측정" 버튼으로 오면 ?student=0123 (형식과 맡은 반을 확인)
declare(strict_types=1);

// ---- 설정 (학원 서버에 맞게 고치세요) ---------------------------------------------------
const READING_BASE_URL = 'https://reading.dahim.kr';
const ACADEMY_LOGIN_URL = '/login.php';  // 로그인 안 된 사람을 보낼 다힘 로그인 주소
// 비밀값: 환경변수 DAHIM_READING_SECRET, 없으면 웹 루트 밖의 PHP 파일(return '...';)
const READING_SECRET_FILE = '/home/dahim/private/reading_secret.php';
// 선생님 "맡은 반" 확인 함수(drs_scope/drs_ok)가 있는 파일. 없으면 선생님의 학생 지정은 막힙니다.
const READING_SCOPE_LIB = __DIR__ . '/admin/lib/drill_scope.php';
// ------------------------------------------------------------------------------------------

require_once __DIR__ . '/reading_sso_lib.php';

if (session_status() === PHP_SESSION_NONE) {
    session_start();
}
header('Cache-Control: no-store');
header('Referrer-Policy: no-referrer');

function reading_fail(string $message, int $status = 403): void
{
    http_response_code($status);
    header('Content-Type: text/html; charset=utf-8');
    $m = htmlspecialchars($message, ENT_QUOTES, 'UTF-8');
    echo "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        . "<title>읽기 시선 기록</title></head><body><main style=\"max-width:420px;margin:48px auto;font-family:sans-serif\">"
        . "<h1>읽기 시선 기록</h1><p>{$m}</p><p><a href=\"/\">다힘 첫 화면으로</a></p></main></body></html>";
    exit;
}

function reading_secret(): string
{
    $env = getenv('DAHIM_READING_SECRET');
    if (is_string($env) && trim($env) !== '') {
        return trim($env);
    }
    if (is_file(READING_SECRET_FILE)) {
        $value = require READING_SECRET_FILE;
        if (is_string($value)) {
            return trim($value);
        }
    }
    return '';
}

// 다힘의 "맡은 반" 함수가 있으면 씁니다. 원장은 drs_scope()가 null(제한 없음)입니다.
if (is_file(READING_SCOPE_LIB)) {
    require_once READING_SCOPE_LIB;
}
// drs_scope()/drs_ok()가 오류를 던지면 토큰을 만들지 않고 거절합니다(reading_go_decide도 다시 감쌈).
$scopeOk = null;
if (function_exists('drs_scope') && function_exists('drs_ok')) {
    try {
        $scope = drs_scope();
        $scopeOk = static fn(string $id): bool => $scope === null || (bool)drs_ok($scope, $id);
    } catch (Throwable) {
        reading_fail('지금은 학생 정보를 확인할 수 없어요. 잠시 뒤 다시 시도해 주세요.', 503);
    }
}

$decision = reading_go_decide($_SESSION, $_GET, $scopeOk);
if (isset($decision['login'])) {
    header('Location: ' . ACADEMY_LOGIN_URL, true, 302);
    exit;
}
if (isset($decision['error'])) {
    reading_fail($decision['error']);
}

$secret = reading_secret();
if (strlen($secret) < READING_MIN_SECRET_LEN) {
    error_log('reading_go: reading secret is not configured');  // 값은 절대 기록하지 않음
    reading_fail('읽기 시선 기록 연결이 아직 설정되지 않았어요. 원장님께 알려 주세요.', 503);
}

try {
    $token = reading_sso_token($decision['role'], $decision['uid'], $decision['sid'], $secret);
} catch (Throwable) {
    reading_fail('지금은 들어갈 수 없어요. 다시 로그인해 주세요.');
}
header('Location: ' . reading_sso_url(READING_BASE_URL, $token, $decision['next']), true, 302);
exit;
