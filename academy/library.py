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
    videos = []
    for path in sorted(Path(video_dir).rglob("*"), key=_lecture_order):
        rel_path = path.relative_to(video_dir)
        # 시놀로지 휴지통(#recycle)·썸네일(@eaDir)과 숨김 파일(.으로 시작)은 강의가 아닙니다.
        if any(part[0] in ".@#" for part in rel_path.parts):
            continue
        if path.is_file() and path.suffix.lower() in VIDEO_EXTS:
            rel = rel_path.as_posix()
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
    tmp = path.with_suffix(".tmp")
    # 임시 파일에 다 쓴 뒤 바꿔치기해서, 저장 중에 끊겨도 기존 파일은 멀쩡하게 남깁니다.
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def save_frame(data_dir: Path, video_id: str, seconds: int, jpeg: bytes) -> None:
    folder = Path(data_dir) / "frames" / video_id
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{seconds}.jpg"
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(jpeg)
    os.replace(tmp, path)
