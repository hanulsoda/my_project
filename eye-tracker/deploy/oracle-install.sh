#!/usr/bin/env bash
# Oracle Cloud VM에서 실행: 안구추적 대표 저장소 10개를 얕게 clone하고 웹앱을 8080으로 서빙한다.
set -u
DEST="${DEST:-$HOME/eye-tracking-repos}"
REPOS=(
  antoinelame/GazeTracking
  pupil-labs/pupil
  EyeTrackVR/EyeTrackVR
  JEOresearch/EyeTracker
  CSAILVision/GazeCapture
  trishume/eyeLike
  esdalmaijer/PyGaze
  NativeSensors/EyeGestures
  mpatacchiola/deepgaze
  Ahmednull/L2CS-Net
)
mkdir -p "$DEST" && cd "$DEST" || exit 1
for r in "${REPOS[@]}"; do
  d="${r#*/}"
  if [ -d "$d/.git" ]; then echo "skip $r (exists)"; else git clone --depth 1 "https://github.com/$r.git" "$d" || echo "FAILED $r"; fi
done
echo "Done: $DEST"
echo "Serve web app:  cd <eye-tracker>/app && python3 -m http.server 8080"
echo "NOTE: browsers allow camera only on https or localhost -> use SSH tunnel: ssh -L 8080:localhost:8080 user@vm"
