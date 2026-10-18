<?php
// 학원 사이트에서 학습 플레이어로 들어가는 입장 링크를 만듭니다. 링크는 5분 동안만 유효합니다.
// 1) 로그인한 학생만 보는 페이지에서 이 파일을 require 합니다.
// 2) 버튼 예시: echo '<a href="' . htmlspecialchars(study_player_link('https://study.학원도메인', STUDY_PLAYER_SECRET)) . '">강의 보기</a>';
//    (이 주석 안에 PHP 끝 표시를 쓰면 그 자리에서 PHP가 끝나 버리므로 echo 형태로 적었습니다.)
// 3) 비밀 키(STUDY_PLAYER_SECRET)는 플레이어의 docker-compose.yml에 넣은 ENTRY_SECRET과 같은 값이어야 합니다.

function study_player_link(string $base_url, string $secret): string
{
    $secret = trim($secret);  // 복사하다 붙은 앞뒤 공백·줄바꿈 제거 (플레이어도 똑같이 지움)
    $exp = time() + 300;
    $sig = hash_hmac('sha256', "enter:$exp", $secret);
    return rtrim($base_url, '/') . "/enter?exp=$exp&sig=$sig";
}
