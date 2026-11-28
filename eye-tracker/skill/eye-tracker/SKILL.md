---
name: eye-tracker
description: Use when the user wants webcam eye/gaze tracking, a gaze demo, or to pick/install an open-source eye-tracking library.
---

# Eye Tracker

## When to Use
- 웹캠으로 시선 위치를 추적하거나 시연하고 싶을 때
- 오픈소스 안구추적 라이브러리를 고르거나 설치할 때

## How It Works
- `app/` 은 WebGazer(브라우저, 로컬 처리) 기반 웹앱이다. `python3 -m http.server 8080` 후 `http://localhost:8080` 접속 → 시작 → 보정(9점 x 5클릭).
- 카메라는 https 또는 localhost 에서만 허용된다. 원격 서버면 `ssh -L 8080:localhost:8080` 터널을 쓴다.
- `deploy/oracle-install.sh` 는 대표 저장소 10개를 clone 한다 (GazeTracking, pupil, EyeTrackVR, EyeTracker, GazeCapture, eyeLike, PyGaze, EyeGestures, deepgaze, L2CS-Net).

## Choosing
- 간단한 파이썬 프로토타입: GazeTracking / EyeGestures
- 연구용 정밀 추적: pupil, PyGaze (전용 하드웨어 필요)
- 딥러닝 시선 추정: L2CS-Net, GazeCapture

## Privacy
영상은 브라우저 안에서만 처리하며 저장·전송하지 않는다. 타인 촬영 시 동의를 받는다.
