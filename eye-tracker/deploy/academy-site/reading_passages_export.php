<?php
/**
 * 읽기 시선 기록용 지문 내보내기 (읽기 전용, 원장 전용)
 *
 * 다힘 사이트의 문제은행 DB(PDO)에서 지문을 읽어 JSON 파일로 내려받게 합니다.
 * 데이터를 바꾸지 않습니다(SELECT / SHOW 만 사용). 이 파일은 읽기 시선 기록 서버가 아니라
 * **다힘 사이트 서버**의 문제은행 api 폴더(get_passage_preview.php 와 같은 폴더)에 올립니다.
 *
 * 사용 (원장 계정으로 로그인한 브라우저에서):
 *   1) .../reading_passages_export.php?mode=tables
 *        → 지문 테이블 이름, 열, 개수, 학년/학교급 값 목록을 보여 줍니다(화면에서 확인용).
 *   2) .../reading_passages_export.php?mode=export&table=neasin_passages
 *        → passages_neasin_passages.json 파일을 내려받습니다(HTML 태그를 지운 본문 포함).
 *      선택 조건: &min=150 &max=1500 (본문 글자 수 범위), &limit=3000, &grade=값, &level=값
 */
declare(strict_types=1);
session_start();

// ---- 설정: 서버에 맞게 한 줄만 확인하세요 ----------------------------------------------
const DB_INCLUDE = __DIR__ . '/../include/db.php';   // $pdo (PDO) 를 만들어 주는 파일
// ----------------------------------------------------------------------------------------

header('Cache-Control: no-store');

function fail(int $code, string $msg): never {
    http_response_code($code);
    header('Content-Type: text/plain; charset=utf-8');
    echo $msg;
    exit;
}

// 원장만: 관리자 로그인이고 강사 번호가 없거나 정확히 0.
$tid = $_SESSION['admin_teacher_id'] ?? 0;
$isDirector = !empty($_SESSION['admin_logged_in'])
    && (($tid === 0 || $tid === '0' || $tid === '' || $tid === null));
if (!$isDirector) fail(403, '원장 계정으로 로그인한 뒤 열어 주세요.');

if (!is_file(DB_INCLUDE)) fail(500, 'DB_INCLUDE 경로를 확인하세요: 파일 맨 위의 설정.');
require_once DB_INCLUDE;
if (!isset($pdo) || !($pdo instanceof PDO)) fail(500, '$pdo 를 찾을 수 없습니다. DB_INCLUDE 가 맞는지 확인하세요.');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

$tables = $pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN);
$passageTables = array_values(array_filter($tables, fn($t) => stripos((string)$t, 'passage') !== false));

function columnsOf(PDO $pdo, string $table): array {
    $out = [];
    foreach ($pdo->query('SHOW COLUMNS FROM `' . str_replace('`', '', $table) . '`') as $c) $out[] = $c['Field'];
    return $out;
}

$mode = (string)($_GET['mode'] ?? 'tables');

if ($mode === 'tables') {
    $report = [];
    foreach ($passageTables as $t) {
        $cols = columnsOf($pdo, $t);
        $row = ['table' => $t, 'columns' => $cols,
                'rows' => (int)$pdo->query('SELECT COUNT(*) FROM `' . $t . '`')->fetchColumn()];
        foreach (['grade', 'school_level', 'publisher'] as $c) {
            if (in_array($c, $cols, true)) {
                $row['distinct_' . $c] = $pdo->query('SELECT `' . $c . '` v, COUNT(*) n FROM `' . $t . '` GROUP BY `' . $c . '` ORDER BY n DESC LIMIT 30')
                    ->fetchAll(PDO::FETCH_ASSOC);
            }
        }
        $report[] = $row;
    }
    // 'passage' 가 이름에 없는 후보도 한눈에 보도록 전체 테이블 이름도 함께.
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['passage_tables' => $report, 'all_tables' => $tables], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    exit;
}

if ($mode !== 'export') fail(400, 'mode 는 tables 또는 export 입니다.');

$table = (string)($_GET['table'] ?? '');
if (!in_array($table, $tables, true)) fail(400, '알 수 없는 테이블입니다. mode=tables 로 이름을 확인하세요.');
$cols = columnsOf($pdo, $table);
if (!in_array('content', $cols, true)) fail(400, '이 테이블에는 content(본문) 열이 없습니다.');

$want = ['id', 'unit_name', 'title_clean', 'title', 'publisher', 'grade', 'school_level', 'q_count', 'content'];
$use = array_values(array_intersect($want, $cols));
$select = implode(', ', array_map(fn($c) => '`' . $c . '`', $use));

$where = [];
$args = [];
if (isset($_GET['grade']) && in_array('grade', $cols, true)) { $where[] = '`grade` = ?'; $args[] = (string)$_GET['grade']; }
if (isset($_GET['level']) && in_array('school_level', $cols, true)) { $where[] = '`school_level` = ?'; $args[] = (string)$_GET['level']; }
$sql = 'SELECT ' . $select . ' FROM `' . $table . '`' . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY 1';

$min = max(0, (int)($_GET['min'] ?? 150));
$max = max($min, (int)($_GET['max'] ?? 1500));
$limit = min(20000, max(1, (int)($_GET['limit'] ?? 3000)));

$stmt = $pdo->prepare($sql);
$stmt->execute($args);
$items = [];
while (($r = $stmt->fetch(PDO::FETCH_ASSOC)) !== false) {
    $text = html_entity_decode(strip_tags((string)$r['content']), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $text = trim((string)preg_replace('/\s+/u', ' ', $text));
    $len = mb_strlen($text, 'UTF-8');
    if ($len < $min || $len > $max) continue;
    $r['content'] = $text;
    $r['char_count'] = $len;
    $items[] = $r;
    if (count($items) >= $limit) break;
}

header('Content-Type: application/json; charset=utf-8');
header('Content-Disposition: attachment; filename="passages_' . preg_replace('/[^A-Za-z0-9_]/', '', $table) . '.json"');
echo json_encode(['table' => $table, 'count' => count($items), 'items' => $items], JSON_UNESCAPED_UNICODE);
