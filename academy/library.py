"""서버 폴더의 강의 영상 목록과 분석 결과(JSON) 저장소."""

import hashlib
import json
import os
import re
import shutil
import unicodedata
from pathlib import Path

# 브라우저에서 바로 재생되는 형식만 다룹니다.
VIDEO_EXTS = {".mp4", ".m4v", ".webm", ".mov"}
GUIDE_TRIES = 2  # Claude가 답은 했지만(비용이 듦) 끝까지 못 쓴 강의는 이만큼만 다시 묻습니다(--retry-failed로 다시). 현황 화면도 씀


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
    text = path.read_text(encoding="utf-8")
    if not text.strip():  # 저장하다 전원이 나가 빈 파일: 분석 전으로 보고 다시 분석합니다(형식 오류로 영영 건너뛰지 않게)
        return None
    return json.loads(text)


def write_atomic(path: Path, text: str) -> None:
    """새 파일에 다 쓰고 디스크에 내린 뒤 바꿔치기합니다: 저장 도중 끊기거나 전원이 나가도 반쯤 쓰인 파일이 남지 않게."""
    tmp = Path(path).with_name(Path(path).name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)


_LECTURE_ID = re.compile(r"[0-9a-f]{12}")  # 강의 번호(경로로 만든 12자리)
MOVES_FILE = ".moved-lectures"  # 폴더를 옮기거나 이름을 바꾼 강의의 {예전 번호: 새 번호}(분석 폴더에, 매일 백업에 들어감)


def load_moves(data_dir: Path, listed=()) -> dict:
    """옮긴 강의 {예전 번호: 지금 번호}. 두 번 옮긴 강의(가→나→다)도 지금 번호로 이어 줍니다. 다만 그 뒤에 다시 옮긴 것만
    따라갑니다: 나→다가 가→나보다 먼저 적혔으면 가가 나에 온 것은 나의 녹화가 떠난 뒤라 가는 나에 머뭅니다(파일에 적힌 순서).
    listed(지금 목록의 번호)에 다시 있는 예전 번호는 옮긴 것으로 보지 않습니다: 예전 자리에 새 강의가 올라온 것이라
    학생 기록·'이번 주 강의'를 예전 녹화로 넘기면 안 됩니다."""
    try:
        raw = json.loads((Path(data_dir) / MOVES_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    lecture = lambda value: isinstance(value, str) and _LECTURE_ID.fullmatch(value)  # 손으로 고친 줄은 건너뜀
    entries = [(old, new) for old, new in raw.items() if lecture(old) and lecture(new)]
    at = {old: (n, new) for n, (old, new) in enumerate(entries)}
    moves = {}
    for n, (old, new) in enumerate(entries):
        if old in listed:
            continue
        while new in at and at[new][0] > n:  # 가운데 자리에 새 강의가 와도(listed) 그 뒤에 옮긴 곳까지 따라감
            n, new = at[new]
        if new != old:
            moves[old] = new
    return moves


def record_move(data_dir: Path, old_id: str, new_id: str) -> None:
    # 늘 맨 뒤에 적습니다(같은 예전 번호를 다시 옮기면 지우고 다시): load_moves가 적힌 순서로 따라갈지 정합니다.
    # 되돌려 옮긴 것(가→나 뒤에 나→가)도 그 순서로 풀려 가의 기록은 가에 머뭅니다.
    _update(data_dir, MOVES_FILE, lambda moves: {**{k: v for k, v in moves.items() if k != old_id}, old_id: new_id})


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


class BrokenRecord(ValueError):
    """분석 폴더의 작은 기록 파일이 깨짐. 덮어쓰면 그 안의 기록을 모두 잃어 고쳐 쓰지 않습니다."""


def _update(data_dir: Path, name: str, change) -> None:
    """분석 폴더의 작은 기록 파일(JSON 사전)을 change로 고쳐 씁니다. 함께 도는 --part 묶음이 서로의 것을 지우지 않게
    잠근 채 읽고 씁니다(윈도에는 이 잠금이 없어 잠그지 않습니다). 깨진 파일은 .broken으로 복사하고 BrokenRecord."""
    path = Path(data_dir) / name
    with open(Path(data_dir) / ".records.lock", "w") as lock:
        try:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX)
        except ImportError:
            pass
        try:
            current = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            current = {}
        except (OSError, ValueError):
            current = None
        if not isinstance(current, dict):
            try:
                shutil.copyfile(path, path.with_name(name + ".broken"))
            except OSError:
                pass
            raise BrokenRecord(f"{name} 파일이 깨져 고쳐 쓰지 않았습니다(쉼표·따옴표를 고치거나 백업에서 되살리세요. "
                               f"깨진 파일은 {name}.broken으로 복사해 둠)")
        write_atomic(path, json.dumps(change(current)))


def save_analysis(data_dir: Path, video_id: str, data: dict) -> None:
    Path(data_dir).mkdir(parents=True, exist_ok=True)
    # 서버가 반쯤 쓰인 파일을 읽거나 저장 도중 끊겨 분석이 망가지지 않게 바꿔치기합니다.
    write_atomic(Path(data_dir) / f"{video_id}.json", json.dumps(data, ensure_ascii=False))


ROOT_FILE = ".video-root"  # 분석 폴더에 적어 두는 맨 위 영상 폴더: 다른 영상 폴더로 돌려 강의 번호가 바뀌지 않게


def folders_problem(video_dir, data_dir, write=True):
    """분석을 시작하면 안 되는 까닭(없으면 None). 분석 폴더 설정을 빠뜨리거나 잘못 적으면 모든 강의를 처음부터 다시
    받아쓰고 Claude 비용을 다시 내고, 하위 폴더를 영상 폴더로 주면 강의 번호가 바뀌어 학생 화면에서 '분석 전'이 됩니다.
    write: 처음 분석하는 분석 폴더에 맨 위 영상 폴더를 적어 둡니다."""
    data_dir, root = Path(data_dir), str(Path(video_dir).resolve())
    if not data_dir.is_dir():
        return (f"분석 폴더(DATA_DIR)가 없습니다: {data_dir.resolve()}\n설정(DATA_DIR)을 확인하세요. 처음 분석하는 것이면 "
                f"그 폴더를 먼저 만드세요: mkdir -p \"{data_dir.resolve()}\"")
    marker = data_dir / ROOT_FILE
    try:
        saved = marker.read_text(encoding="utf-8").strip()
    except OSError:
        saved = None
    if saved and saved != root:
        return (f"이 분석 폴더는 영상 폴더 {saved}의 분석입니다. 지금 영상 폴더(VIDEO_DIR)는 {root}입니다.\n"
                "서버·분석·자동 목차에는 같은 맨 위 영상 폴더를 적어 주세요(한 폴더의 강의만 하려면 --only).")
    if not saved and write:
        marker.write_text(root, encoding="utf-8")
    return None
