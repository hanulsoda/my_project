"""서버 폴더의 강의 영상 목록과 분석 결과(JSON) 저장소."""

import hashlib
import json
import os
import re
from pathlib import Path

# 브라우저에서 바로 재생되는 형식만 다룹니다.
VIDEO_EXTS = {".mp4", ".m4v", ".webm", ".mov"}


def _lecture_order(path: Path):
    # "2강"이 "10강"보다 앞에 오도록 숫자는 숫자로 비교합니다.
    return [int(p) if p.isdigit() else p for p in re.split(r"(\d+)", path.as_posix())]


def find_videos(video_dir: Path) -> list[dict]:
    found = []
    for folder, dirs, files in os.walk(video_dir):
        # NAS 휴지통·스냅숏(#recycle, #snapshot)·시스템 폴더(@eaDir 썸네일 등)와 숨김 폴더·파일(.으로 시작)은 강의가 아닙니다.
        # 썸네일 폴더는 영상마다 있어서 아예 들어가지 않아야 빨리 훑습니다.
        # '#지구 #소통'처럼 #으로 시작하는 진짜 강의도 있어 #은 그 두 폴더만 뺍니다.
        dirs[:] = [d for d in dirs if d[0] not in ".@" and d not in ("#recycle", "#snapshot")]
        found += [Path(folder) / name for name in files if not name.startswith(".")]
    videos = []
    for path in sorted(found, key=_lecture_order):
        if path.is_file() and path.suffix.lower() in VIDEO_EXTS:  # is_file: 원본이 지워진 바로가기는 뺍니다
            rel = path.relative_to(video_dir).as_posix()
            videos.append({
                "id": hashlib.sha1(rel.encode()).hexdigest()[:12],
                "title": rel.rsplit(".", 1)[0],
                "path": path,
            })
    return videos


def load_analysis(data_dir: Path, video_id: str) -> dict | None:
    path = Path(data_dir) / f"{video_id}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def save_analysis(data_dir: Path, video_id: str, data: dict) -> None:
    Path(data_dir).mkdir(parents=True, exist_ok=True)
    path = Path(data_dir) / f"{video_id}.json"
    # 새 파일에 다 쓴 뒤 바꿔치기해서, 서버가 반쯤 쓰인 파일을 읽거나 저장 도중 끊겨 분석이 망가지지 않게 합니다.
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
