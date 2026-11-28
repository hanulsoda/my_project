<?php
// 읽기 시선 기록(reading.dahim.kr)으로 들어가는 입장 토큰을 만드는 함수 모음입니다.
// 다힘 사이트에서만 씁니다. 화면을 그리지 않고, 세션도 직접 읽지 않습니다(값은 reading_go.php가 넘김).
// 토큰 약속(계약)은 eye-tracker/docs/sso.md 와 server/sso-token.js 가 기준입니다:
//   토큰 = <payload_b64url>.<sig_hex>
//   payload = {"v":1,"role":"director|teacher|student","uid":"..","sid":"..","exp":<초>,"n":"<16바이트 hex>"}
//   sig = hash_hmac('sha256', payload_b64url, 비밀값)  (소문자 hex)
// 이름 같은 개인정보는 토큰에 넣지 않습니다.
declare(strict_types=1);

const READING_TOKEN_TTL = 300;          // 5분. 읽기 서버는 330초보다 먼 exp를 거절합니다.
const READING_MIN_SECRET_LEN = 32;
// 모든 정규식은 \z(문자열 끝)로 끝납니다. PCRE의 $는 끝의 줄바꿈("0123\n")도 받아 주기 때문입니다.
const READING_ID4_RE = '/^[0-9]{4}\z/';

function reading_b64url(string $raw): string
{
    return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
}

// $role/$uid/$sid는 세션에서만 얻은 값이어야 합니다. 형식이 틀리면 예외(토큰을 만들지 않음).
function reading_sso_token(string $role, string $uid, string $sid, string $secret, ?int $now = null): string
{
    $secret = trim($secret);  // 복사하다 붙은 앞뒤 공백·줄바꿈 제거 (읽기 서버도 똑같이 지움)
    if (strlen($secret) < READING_MIN_SECRET_LEN) {
        throw new RuntimeException('reading secret missing or shorter than 32 characters');
    }
    $ok = match ($role) {
        'director' => preg_match('/^[A-Za-z0-9_-]{1,32}\z/', $uid) === 1,
        'teacher' => preg_match('/^[1-9][0-9]{0,9}\z/', $uid) === 1,
        'student' => preg_match(READING_ID4_RE, $uid) === 1 && $sid === $uid,
        default => false,
    };
    if (!$ok || ($sid !== '' && preg_match(READING_ID4_RE, $sid) !== 1)) {
        throw new InvalidArgumentException('bad role, uid or sid for the reading token');
    }
    $payload = [
        'v' => 1,
        'role' => $role,
        'uid' => $uid,
        'sid' => $sid,
        'exp' => ($now ?? time()) + READING_TOKEN_TTL,
        'n' => bin2hex(random_bytes(16)),  // 한 번만 쓰는 값(재사용 방지)
    ];
    $b64 = reading_b64url(json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
    return $b64 . '.' . hash_hmac('sha256', $b64, $secret);
}

function reading_sso_url(string $base, string $token, string $next = ''): string
{
    $url = rtrim($base, '/') . '/sso?t=' . rawurlencode($token);
    return $next === '' ? $url : $url . '&next=' . rawurlencode($next);
}

// 로그인 세션을 보고 어디로 보낼지 정합니다. 화면 출력·header()는 하지 않습니다(시험하기 쉽게).
//   $session : $_SESSION (역할과 번호는 여기서만 읽습니다)
//   $query   : $_GET (선생님이 학생 화면에서 누른 ?student=0123 만 봅니다)
//   $scopeOk : 학생 번호 => bool. 다힘의 drs_scope()/drs_ok()로 "맡은 반 학생인가"를 확인합니다.
//              null이면 확인할 수 없다는 뜻이며, 그때 선생님의 학생 지정은 거절합니다(안전한 쪽).
// 돌려주는 값: ['login' => true] | ['error' => 문구] | ['role','uid','sid','next']
function reading_go_decide(array $session, array $query, ?callable $scopeOk): array
{
    $isStaff = !empty($session['admin_logged_in']);
    $isStudent = !$isStaff && isset($session['student_logged_in']) && $session['student_logged_in'] === true;
    if (!$isStaff && !$isStudent) {
        return ['login' => true];
    }

    if ($isStudent) {
        $raw = $session['student_id'] ?? '';
        $sid = is_int($raw) || is_string($raw) ? (string)$raw : '';
        if (preg_match('/^[0-9]{1,4}\z/', $sid) === 1) {
            $sid = str_pad($sid, 4, '0', STR_PAD_LEFT);  // 다힘 학생 번호는 4자리("0123")
        }
        if (preg_match(READING_ID4_RE, $sid) !== 1) {
            return ['error' => '학생 번호를 확인할 수 없어요. 다시 로그인해 주세요.'];
        }
        return ['role' => 'student', 'uid' => $sid, 'sid' => $sid, 'next' => ''];
    }

    // 원장은 admin_teacher_id가 없거나(null) 정확히 0/'0'일 때만. 선생님은 1 이상의 정수(또는 그런 숫자 문자열).
    // 그 밖의 값(음수, 'abc', '', 소수, 배열, true...)은 가장 넓은 권한(원장)으로 떨어지지 않게 거절합니다.
    $tid = $session['admin_teacher_id'] ?? null;
    if ($tid === null || $tid === 0 || $tid === '0') {
        $role = 'director';
        $uid = 'admin';
    } elseif ((is_int($tid) && $tid > 0 && $tid <= 9999999999)
        || (is_string($tid) && preg_match('/^[1-9][0-9]{0,9}\z/', $tid) === 1)) {
        $role = 'teacher';
        $uid = (string)$tid;
    } else {
        return ['error' => '선생님 정보를 확인할 수 없어요. 다시 로그인해 주세요.'];
    }

    $sid = '';
    if (isset($query['student'])) {
        $raw = $query['student'];
        if (!is_string($raw) || preg_match(READING_ID4_RE, $raw) !== 1) {
            return ['error' => '학생 번호가 올바르지 않아요.'];
        }
        // 맡은 반 확인이 예외를 던지면 통과가 아니라 거절입니다.
        try {
            $inScope = $scopeOk === null ? null : ($scopeOk($raw) === true);
        } catch (Throwable) {
            return ['error' => '지금은 학생 정보를 확인할 수 없어요. 잠시 뒤 다시 시도해 주세요.'];
        }
        if ($role === 'teacher') {
            // 선생님은 맡은 반 학생만. 확인할 방법이 없으면 막습니다.
            if ($inScope !== true) {
                return ['error' => '맡은 반 학생만 측정할 수 있어요.'];
            }
        } elseif ($inScope === false) {
            return ['error' => '이 학생을 찾을 수 없어요.'];
        }
        $sid = $raw;
    }
    return ['role' => $role, 'uid' => $uid, 'sid' => $sid, 'next' => $sid === '' ? '/children.html' : ''];
}
