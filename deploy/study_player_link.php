<?php
// 학원 사이트에서 학습 플레이어로 들어가는 입장 링크를 만듭니다. 링크는 5분 동안만 유효합니다.
// 사용법은 docs/시놀로지-설치.md 6단계를 보세요. 보통 study_go.php에서 이렇게 씁니다:
//   header('Location: ' . study_player_link('https://study.학원도메인', $secret));
// $secret은 플레이어의 docker-compose.yml에 넣은 ENTRY_SECRET과 같은 값이어야 합니다.

function study_player_link(string $base_url, string $secret): string
{
    $secret = trim($secret);  // 복사하다 붙은 앞뒤 공백·줄바꿈 제거 (플레이어도 똑같이 지움)
    $exp = time() + 300;
    $sig = hash_hmac('sha256', "enter:$exp", $secret);
    return rtrim($base_url, '/') . "/enter?exp=$exp&sig=$sig";
}
