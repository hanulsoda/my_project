"""서버 폴더의 강의 영상 목록과 분석 결과(JSON) 저장소."""

import hashlib
import json
import os
import re
import unicodedata
from pathlib import Path

# 브라우저에서 바로 재생되는 형식만 다룹니다.
VIDEO_EXTS = {".mp4", ".m4v", ".webm", ".mov"}


def _lecture_order(path: Path):
    # "2강"이 "10강"보다 앞에 오도록 숫자는 숫자로 비교합니다. 확장자는 빼고 비교합니다('1강 제망매가'가 '1강 제망매가 학습활동'보다 앞).
    # 맥에서 만든 폴더 이름(자모로 나뉨)도 같은 이름으로 봅니다(제목과 같게).
    return [int(p) if p.isdigit() else p for p in re.split(r"(\d+)", unicodedata.normalize("NFC", path.with_suffix("").as_posix()))]


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
                # 맥에서 NAS로 옮긴 이름은 한글이 자모로 나뉘어(NFD) 학생이 친 낱말로 찾지 못해 합쳐 둡니다. 영상 번호는 그대로.
                "title": unicodedata.normalize("NFC", rel.rsplit(".", 1)[0]),
                "path": path,
            })
    return videos


def load_analysis(data_dir: Path, video_id: str) -> dict | None:
    path = Path(data_dir) / f"{video_id}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


_LECTURE_ID = re.compile(r"[0-9a-f]{12}")  # 강의 번호(경로로 만든 12자리)
MOVES_FILE = ".moved-lectures"  # 폴더를 옮기거나 이름을 바꾼 강의의 {예전 번호: 새 번호}(분석 폴더에, 매일 백업에 들어감)


def load_moves(data_dir: Path, listed=()) -> dict:
    """옮긴 강의 {예전 번호: 지금 번호}. 두 번 옮긴 강의(가→나→다)도 지금 번호로 이어 줍니다.
    listed(지금 목록의 번호)에 다시 있는 예전 번호는 옮긴 것으로 보지 않습니다: 예전 자리에 새 강의가 올라온 것이라
    학생 기록·'이번 주 강의'를 예전 녹화로 넘기면 안 됩니다."""
    try:
        raw = json.loads((Path(data_dir) / MOVES_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    lecture = lambda value: isinstance(value, str) and _LECTURE_ID.fullmatch(value)  # 손으로 고친 줄은 건너뜀
    raw = {old: new for old, new in raw.items() if lecture(old) and lecture(new) and old not in listed}
    moves = {}
    for old, new in raw.items():
        seen = {old}
        while new in raw and new not in seen:
            seen.add(new)
            new = raw[new]
        if new != old:
            moves[old] = new
    return moves


def record_move(data_dir: Path, old_id: str, new_id: str) -> None:
    # 되돌려 옮기면(가→나 뒤에 나→가) 나에서 옮겼다는 줄은 지웁니다(둘이 서로를 가리켜 아무 데도 옮기지 않게).
    _update(data_dir, MOVES_FILE, lambda moves: {**{k: v for k, v in moves.items() if k != new_id}, old_id: new_id})


SIZES_FILE = ".lecture-sizes"  # 강의 번호 → 영상 파일 크기: 옮긴 강의를 알아볼 때 씁니다(분석 파일을 다시 쓰지 않게 따로)


def load_sizes(data_dir: Path) -> dict:
    try:
        sizes = json.loads((Path(data_dir) / SIZES_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return sizes if isinstance(sizes, dict) else {}


def record_sizes(data_dir: Path, sizes: dict) -> None:
    if any(load_sizes(data_dir).get(k) != v for k, v in sizes.items()):  # 바뀐 것이 있을 때만 씁니다
        _update(data_dir, SIZES_FILE, lambda saved: {**saved, **sizes})


def _update(data_dir: Path, name: str, change) -> None:
    """분석 폴더의 작은 기록 파일(JSON 사전)을 change로 고쳐 씁니다. 함께 도는 --part 묶음이 서로의 것을 지우지 않게
    잠근 채 읽고 씁니다(윈도에는 이 잠금이 없어 잠그지 않습니다)."""
    path = Path(data_dir) / name
    with open(Path(data_dir) / ".records.lock", "w") as lock:
        try:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX)
        except ImportError:
            pass
        try:
            current = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            current = {}
        tmp = path.with_name(name + ".tmp")
        tmp.write_text(json.dumps(change(current if isinstance(current, dict) else {})), encoding="utf-8")
        tmp.replace(path)


def save_analysis(data_dir: Path, video_id: str, data: dict) -> None:
    Path(data_dir).mkdir(parents=True, exist_ok=True)
    path = Path(data_dir) / f"{video_id}.json"
    # 새 파일에 다 쓴 뒤 바꿔치기해서, 서버가 반쯤 쓰인 파일을 읽거나 저장 도중 끊겨 분석이 망가지지 않게 합니다.
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
