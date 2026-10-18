"""서버 폴더의 강의 영상 목록과 분석 결과(JSON) 저장소."""

import hashlib
import json
import re
from pathlib import Path

# 브라우저에서 바로 재생되는 형식만 다룹니다.
VIDEO_EXTS = {".mp4", ".m4v", ".webm", ".mov"}


def _lecture_order(path: Path):
    # "2강"이 "10강"보다 앞에 오도록 숫자는 숫자로 비교합니다.
    return [int(p) if p.isdigit() else p for p in re.split(r"(\d+)", path.as_posix())]


def find_videos(video_dir: Path) -> list[dict]:
    videos = []
    for path in sorted(Path(video_dir).rglob("*"), key=_lecture_order):
        if path.is_file() and path.suffix.lower() in VIDEO_EXTS:
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
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
