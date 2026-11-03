"""서버 폴더의 모든 강의 영상을 받아쓰고 요점 정리·퀴즈를 만듭니다.

실행: python -m academy.analyze [--force] [--part i/n] [--no-guide]
이미 분석된 영상은 건너뛰므로, 새 영상을 올린 뒤 다시 실행하면 새 영상만 분석합니다.
"""

import argparse
import os
import shutil
import sys
import time
import unicodedata
from datetime import datetime
from itertools import groupby
from pathlib import Path

import numpy as np

from academy.ai import IncompleteAnswer
from academy.library import (GUIDE_TRIES, VIDEO_EXTS, BrokenRecord, find_videos, folders_problem, load_analysis,
                             load_sizes, record_move, record_sizes, save_analysis)
from academy.settings import load_env_file

# 예전에 소리 없는 강의에 넣던 빈 요점 정리. 지금은 "silent": true로 표시하고, 이것을 만나면 걷어 냅니다.
SILENT_GUIDE = {"summary": "음성이 없는 영상입니다.", "chapters": [], "quiz": []}
SETTLE_SECONDS = 600  # 이보다 최근에 바뀐 영상은 아직 NAS로 복사 중일 수 있어 다음에 분석합니다
def _try_lock(path):
    """그 잠금을 다른 프로세스가 쥐고 있으면 None. 돌려준 파일을 닫으면(프로세스가 끝나면) 풀립니다.
    윈도에는 이 잠금(fcntl)이 없어 잠그지 않습니다(분석을 겹쳐 돌리지 않게 조심)."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    lock = open(path, "w")
    try:
        import fcntl
    except ImportError:
        return lock
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        return None
    return lock


def run_lock(data_dir, part):
    """같은 묶음(--part)의 분석이 이미 돌고 있으면 None."""
    return _try_lock(Path(data_dir) / f".analyze-{part[0]}of{part[1]}.lock")


def analyze_all(video_dir, data_dir, transcribe, make_guide, force=False, part=(1, 1),
                detect_pages=None, read_screens=None, find_references=None, settle_seconds=0, probe=None,
                retry_failed=False, only=None) -> int | None:
    """실패한 강의 수를, 분석하지 않았으면(영상 없음, 같은 묶음이 아직 도는 중) None을 돌려줍니다.
    make_guide가 None이면 Claude 없이 받아쓰기와 페이지만 만듭니다. 요점 정리는 나중에 붙일 수 있습니다.

    read_screens가 있으면 요점 정리를 만들 때 페이지마다 화면 글자를 읽어 근거로 함께 보냅니다.
    find_references(제목, 화면 글자 줄)는 짝지어지는 학원 요점 정리를 {"source", "text"} 목록으로 돌려줍니다.
    settle_seconds: 이보다 최근에 바뀐 영상은 복사 중일 수 있어 받아쓰지 않습니다(반쯤 받아쓴 것이 '분석됨'으로 남지 않게).
    probe(영상 경로)는 영상 길이(초). 주면 폴더를 옮기거나 이름을 바꾼 강의를 알아보고 예전 분석을 이어 쓰고, 다른 폴더로
    복사한 강의는 분석을 복사하고, 같은 자리에서 바뀐 영상(크기가 다름)은 새로 분석합니다.
    retry_failed: Claude 답이 잘려 GUIDE_TRIES번 실패한 강의도 다시 묻습니다.
    only: 제목(폴더 이름 포함)에 이 글이 든 강의만 분석합니다.
    """
    videos = find_videos(video_dir)
    if not videos:  # 날짜로 시작하는 줄: 현황의 '새 강의 분석'에 나옵니다
        print(f"{datetime.now():%Y-%m-%d %H:%M} 영상 분석을 멈춥니다: 영상이 없습니다: {Path(video_dir).resolve()} "
              f"(NAS 연결 확인, {' '.join(sorted(VIDEO_EXTS))} 파일만 찾습니다)")
        return None
    lock = run_lock(data_dir, part)  # 밤 작업이 겹쳐 같은 강의를 두 번 받아쓰고 Claude 비용을 두 번 내지 않게
    if lock is None:
        print(f"{datetime.now():%Y-%m-%d %H:%M} 이 묶음의 분석이 아직 돌고 있어 이번에는 하지 않았습니다.")
        return None
    try:
        mine = _chosen(videos, part, only)
        if only and not mine:
            print(f"제목에 '{only}'이(가) 든 강의가 없습니다.")
        orphans, replaced, copies = [], set(), {}
        if probe:
            analyzed = {path.stem for path in Path(data_dir).glob("*.json")}  # 이번 분석을 시작할 때 분석이 있던 강의
            replaced = _note_sizes(data_dir, mine, analyzed, settle_seconds)
            orphans = _orphans(data_dir, {v["id"] for v in videos})
            sizes = load_sizes(data_dir)
            # 크기 → 분석이 있는 강의(다른 반 폴더로 복사한 강의를 알아볼 때). --force는 요점 정리를 새로 사려는 것이라
            # 예전 것을 주고받지 않고, 이번에 새로 만든 강의만 같은 영상에 줍니다(_analyze_one 끝).
            for v in videos if not force else ():
                if v["id"] in analyzed and v["id"] in sizes and v["id"] not in replaced:
                    copies.setdefault(sizes[v["id"]], []).append(v["id"])
        return _analyze(mine, data_dir, transcribe, make_guide, force, detect_pages, read_screens, find_references,
                        settle_seconds, lambda video: _adopt(video, data_dir, orphans, probe, copies), replaced, retry_failed,
                        copies if probe else None)
    finally:
        lock.close()


def _chosen(videos, part, only):
    mine = videos[part[0] - 1::part[1]]  # GPU마다 프로세스를 하나씩 띄울 때 서로 다른 영상을 맡도록 나눕니다.
    if only:  # 맥 터미널에서 친 한글(자모로 나뉨)도 같은 글로 봅니다
        word = unicodedata.normalize("NFC", only)
        mine = [v for v in mine if word in unicodedata.normalize("NFC", v["title"])]
    return mine


def _redo_notice(video_dir, data_dir, part, only):
    """--force가 다시 사게 될 요점 정리(이미 분석한 강의)의 수와 대략적인 비용. 다시 사는 것이 없으면 None."""
    count = seconds = 0
    for video in _chosen(find_videos(video_dir), part, only):
        try:
            data = load_analysis(data_dir, video["id"])
        except ValueError:
            continue
        if isinstance(data, dict):
            count += 1
            seconds += float(data.get("duration") or 0)
    if not count:
        return None
    hours = max(1, round(seconds / 3600))
    return (f"--force: 이미 분석한 강의 {count:,}개(약 {hours:,}시간)를 처음부터 다시 받아쓰고 요점 정리를 다시 만듭니다. "
            f"Claude 비용이 약 ${hours * 0.2:,.1f}~{hours * 0.4:,.1f} 듭니다(1시간에 $0.2~0.4). "
            "맞으면 --yes를 붙여 다시 실행하세요. 몇 강의만 다시 하려면 --only <제목 일부>")


def _note_sizes(data_dir, videos, analyzed, settle_seconds=0):
    """분석이 있는데 적어 둔 크기와 달라진 강의(같은 자리에 다시 녹화한 파일 등)를 돌려줍니다.
    크기는 그 크기의 영상을 분석(또는 이어 쓰기·복사)한 뒤에만 적습니다: 먼저 적으면 그 밤에 분석하지 못한(복사 중, 실패)
    바뀐 영상을 다음 밤에 알아보지 못해 새 영상에 옛 요점 정리가 남습니다. 여기서는 크기를 적기 전에 분석해 둔 강의의
    크기만 처음 적습니다(복사 중일 수 있는 방금 바뀐 파일은 빼고)."""
    before, current, first = load_sizes(data_dir), {}, {}
    for video in videos:
        try:
            stat = video["path"].stat()
        except OSError:  # 그사이 옮겨진 영상
            continue
        current[video["id"]] = stat.st_size
        if video["id"] in analyzed and video["id"] not in before and time.time() - stat.st_mtime >= settle_seconds:
            first[video["id"]] = stat.st_size
    _record_sizes(data_dir, first)
    return {i for i, size in current.items() if i in analyzed and before.get(i) not in (None, size)}


def _record_sizes(data_dir, sizes):
    try:  # 기록 파일이 깨져도 밤 작업은 계속합니다(설정 점검이 알려 줌)
        record_sizes(data_dir, sizes)
    except (BrokenRecord, OSError) as e:
        print(f"  영상 크기를 적지 못함(옮기거나 바꾼 영상을 알아보지 못할 수 있음): {e}", file=sys.stderr)


def _size(video):
    try:
        return video["path"].stat().st_size
    except OSError:
        return None


def _tries(data):
    """Claude 답이 잘린 횟수. 손으로 "2"·null·Infinity 등으로 고쳐도 밤 작업이 멈추지 않게."""
    try:
        return int(data.get("guide_failures") or 0)
    except (TypeError, ValueError, OverflowError):
        return 0


def _orphans(data_dir, known):
    """지금 영상 폴더의 어느 강의 것도 아닌 분석(폴더를 옮기거나 이름을 바꾸기 전의 강의) [{"id", "name", "duration", "data"}]"""
    found, sizes = [], load_sizes(data_dir)
    for path in Path(data_dir).glob("*.json"):
        if path.stem in known:
            continue
        try:
            data = load_analysis(data_dir, path.stem)
            found.append({"id": path.stem, "name": unicodedata.normalize("NFC", data["title"].rsplit("/", 1)[-1]),
                          "duration": float(data["duration"]), "size": sizes.get(path.stem, data.get("size")), "data": data})
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            continue  # 읽을 수 없거나 형식이 다른 파일은 건드리지 않습니다
    return found


def _adopt(video, data_dir, orphans, probe, copies):
    """새로 보이는 강의가 예전 분석을 이어 쓸 수 있으면 그 분석을, 아니면 None(새로 분석). 비용이 들지 않습니다.
    - 옮긴 강의: 주인 없는 분석 가운데 파일 이름이 같고 길이가 2초 안이고 파일 크기가 같은 것이 꼭 하나면, 그 분석(과
      페이지 그림)을 이 강의로 옮깁니다. 크기를 적기 전의 분석은 이름과 길이로만 봅니다.
    - 파일 이름을 바꾼 강의: 이름이 같은 것이 없으면 크기가 바이트까지 같고 길이가 2초 안인 것이 꼭 하나일 때 옮깁니다.
    - 다른 반 폴더로 복사한 강의: 위가 아니고, 분석이 있는 강의 가운데 크기·길이가 같은 것이 있으면 그 분석을 복사합니다.
    후보가 둘 이상이거나 길이·크기가 다르면 짐작하지 않습니다."""
    name = video["title"].rsplit("/", 1)[-1]
    try:
        size = video["path"].stat().st_size
        named = [o for o in orphans if o["name"] == name and o["size"] in (None, size)]
        sized = [o for o in orphans if o["size"] == size and o["name"] != name]
        if not (named or sized or copies.get(size)):
            return None
        duration = probe(video["path"])
        fits = lambda o: abs(o["duration"] - duration) <= 2
        named, sized = [o for o in named if fits(o)], [o for o in sized if fits(o)]
        if not named and not sized:
            return _copy(video, data_dir, copies.get(size, []), duration, size)
        if len(named) != 1 and not (not named and len(sized) == 1):
            return None
        old = (named or sized)[0]
        # 분석 파일을 먼저 옮긴 쪽만 이어 씁니다(함께 도는 --part 묶음이 같은 분석을 둘 다 가져가지 않게).
        (Path(data_dir) / f"{old['id']}.json").rename(Path(data_dir) / f"{video['id']}.json")
    except Exception as e:  # 영상 길이를 못 읽음 등: 이어 쓰지 않고 새로 분석합니다
        print(f"  예전 분석을 이어 쓰지 못함, 새로 분석: {e}", file=sys.stderr)
        return None
    data = {**old["data"], "title": video["title"]}
    try:  # 분석 파일은 이미 옮겼으니 여기서 실패해도 이어 쓴 것으로 봅니다(옮긴 강의를 새로 사지 않게)
        save_analysis(data_dir, video["id"], data)
    except OSError as e:
        print(f"  예전 분석은 옮겼지만 제목을 고치지 못함: {e}", file=sys.stderr)
    try:  # 제목을 못 고쳐도(디스크 가득 참) 그림은 옮깁니다: 분석에 적힌 페이지 그림은 다시 만들지 않습니다
        if (Path(data_dir) / old["id"]).is_dir() and not (Path(data_dir) / video["id"]).exists():
            (Path(data_dir) / old["id"]).rename(Path(data_dir) / video["id"])
    except OSError as e:
        print(f"  예전 분석은 옮겼지만 페이지 그림을 옮기지 못함: {e}", file=sys.stderr)
    _record_sizes(data_dir, {video["id"]: size})
    try:  # 학생 기기의 이어 보기·메모와 '이번 주 강의'가 따라오게(못 남겨도 이어 쓴 분석은 그대로)
        record_move(data_dir, old["id"], video["id"])
    except (OSError, BrokenRecord) as e:
        print(f"  옮긴 기록을 남기지 못함(학생 기록이 따라오지 않을 수 있음): {e}", file=sys.stderr)
    orphans.remove(old)
    print(f"  옮긴 강의로 보여 예전 분석을 이어 씁니다: {old['data']['title']}")
    return data


def _copy(video, data_dir, sources, duration, size=None):
    """같은 영상(크기·길이가 같음)이 다른 폴더에 분석과 함께 있으면 그 분석과 페이지 그림을 복사합니다."""
    for source in sources:
        try:
            data = load_analysis(data_dir, source)
            if not (isinstance(data, dict) and abs(float(data.get("duration") or 0) - duration) <= 2):
                continue
            pictures = Path(data_dir) / source
            if pictures.is_dir() and not (Path(data_dir) / video["id"]).exists():
                shutil.copytree(pictures, Path(data_dir) / video["id"])
            copied = {**data, "title": video["title"]}
            save_analysis(data_dir, video["id"], copied)
        except (OSError, ValueError, TypeError) as e:
            print(f"  같은 영상의 분석을 복사하지 못함, 새로 분석: {e}", file=sys.stderr)
            return None
        if size is not None:
            _record_sizes(data_dir, {video["id"]: size})
        print(f"  다른 폴더의 같은 영상이라 분석을 복사합니다: {data.get('title', source)}")
        return copied
    return None


def _analyze(videos, data_dir, transcribe, make_guide, force, detect_pages, read_screens, find_references, settle_seconds,
             adopt, replaced=(), retry_failed=False, copies=None):
    """copies: 크기 → 분석이 있는 강의(영상 길이를 읽을 수 있을 때만). 이번에 분석한 강의도 더해 같은 밤의 복사본이 씁니다."""
    failures = 0
    for n, video in enumerate(videos, 1):
        print(f"[{n}/{len(videos)}] {video['title']}", flush=True)
        # 다른 분석(다른 --part, 손으로 돌린 분석)이 이 강의를 하는 중이면 건너뜁니다: 같은 강의를 두 번 사지 않게
        lock = _try_lock(Path(data_dir) / ".locks" / f"{video['id']}.lock")
        if lock is None:
            print("  다른 분석이 이 강의를 하는 중이라 건너뜀")
            continue
        try:
            failures += _analyze_one(video, data_dir, transcribe, make_guide, force, detect_pages, read_screens,
                                     find_references, settle_seconds, adopt, video["id"] in replaced, retry_failed, copies)
        finally:
            lock.close()
    return failures


def _analyze_one(video, data_dir, transcribe, make_guide, force, detect_pages, read_screens, find_references,
                 settle_seconds, adopt, replaced, retry_failed, copies) -> int:
    """강의 하나를 분석합니다. 실패하면 1."""
    size = _size(video)
    # 시작할 때 바뀐 것으로 보았어도, 잠근 뒤 다시 봅니다: 함께 도는 다른 분석이 그사이 새 영상을 분석해 크기를 적었으면
    # 그 분석을 씁니다(두 분석이 같은 영상을 두 번 사지 않게).
    replaced = replaced and load_sizes(data_dir).get(video["id"]) not in (None, size)
    try:
        old = load_analysis(data_dir, video["id"])
        if old is not None and not isinstance(old, dict):
            raise ValueError("JSON 객체가 아님")
    except ValueError as e:  # 손으로 고치다 형식이 깨진 파일: 덮어쓰지 않고 이 강의만 건너뜁니다
        print(f"  분석 파일 형식 오류, 건너뜀(고친 곳의 쉼표·따옴표를 확인하세요): {e}", file=sys.stderr)
        return 1
    except OSError as e:  # 읽을 수 없음(다른 계정이 만든 파일·NAS 오류): 밤 작업 전체를 멈추지 않고 이 강의만 건너뜁니다
        print(f"  분석 파일을 읽지 못해 건너뜀(파일 권한·NAS 연결을 확인하세요): {e}", file=sys.stderr)
        return 1
    if old and old.get("guide") == SILENT_GUIDE:  # 예전에는 소리 없는 강의에 빈 요점 정리를 넣어 학원 정리가 가려졌습니다
        old = {**old, "guide": None, "silent": True}
        save_analysis(data_dir, video["id"], old)
    if old and replaced:  # 같은 자리의 영상이 바뀜: 예전 요점 정리·목차는 다른 영상의 것이라 이어 쓰지 않습니다
        print("  같은 자리의 영상 파일이 바뀌어(크기가 다름) 새로 분석합니다")
        old = None
    data = None if force else old
    if data is None and not force and not replaced:
        data = adopt(video)  # 폴더를 옮기거나 이름을 바꾸거나 복사한 강의면 예전 분석을 이어 씀
    done = data or {}
    need_pages = detect_pages is not None and "pages" not in done
    # 소리 없는 강의(받아쓴 말 없음)는 Claude에 묻지 않습니다. 요점 정리 칸은 비워 두어 학원 정리가 보이게 합니다.
    # guide_stale: --force로 새로 받아쓴 뒤 아직 새 요점 정리를 못 만든 강의(예전 것을 보여 주는 중): 다음 실행에서 이어 만듭니다.
    need_guide = make_guide is not None and (not done.get("guide") or done.get("guide_stale")) and not done.get("silent")
    if need_guide and _tries(done) >= GUIDE_TRIES and not retry_failed:
        print(f"  Claude 답이 {GUIDE_TRIES}번 잘려 요점 정리는 건너뜀(다시 하려면 --retry-failed)")
        need_guide = False
    if data and not (need_pages or need_guide):
        print("  이미 분석됨, 건너뜀")
        return 0
    try:  # 영상이 그사이 옮겨졌거나 NAS가 답하지 않으면 이 강의만 실패로 셉니다
        if not data and time.time() - video["path"].stat().st_mtime < settle_seconds:
            print("  방금 바뀐 영상이라(복사 중일 수 있음) 다음에 분석합니다")
            return 0
        if not data:
            print("  받아쓰는 중...", flush=True)
            segments, duration = transcribe(video["path"])
            data = {"title": video["title"], "duration": duration,
                    "segments": segments, "guide": None}
            # 다시 분석(--force)해도 새 요점 정리가 생길 때까지 예전 요점 정리·목차(비용을 들인 결과)를 둡니다.
            data.update({key: old[key] for key in ("guide", "toc") if old and key in old})
            # --no-guide로 받아쓰기만 새로 했으면 예전 요점 정리를 계속 씁니다(다음 밤에 강의마다 다시 사지 않게).
            if data["guide"] and (make_guide is not None or old.get("guide_stale")):
                data["guide_stale"] = True
            _apply_corrections(data["segments"], data["guide"])  # 예전 요점 정리 때 찾은 받아쓰기 오타도 그대로 고침
            # 요점 정리에서 실패해도 오래 걸린 받아쓰기는 남겨 둡니다. 크기는 받아쓴 영상의 것이라 이제 적습니다.
            save_analysis(data_dir, video["id"], data)
            if size is not None:
                _record_sizes(data_dir, {video["id"]: size})
        if need_pages:
            print("  페이지 찾는 중...", flush=True)
            try:
                data["pages"] = detect_pages(video["path"], Path(data_dir) / video["id"])
            except Exception as e:  # 페이지는 덤이라 실패해도 요점 정리는 만듭니다. 매번 다시 시도하지도 않습니다.
                print(f"  페이지 찾기 실패, 건너뜀: {e}", file=sys.stderr)
                data["pages"] = []
            for page in data["pages"]:  # 다시 찾은 페이지에 예전 교재 쪽수 이름표를 이어 붙입니다(새 요점 정리가 다시 붙임)
                page.update(next(({"label": p["label"]} for p in (old or {}).get("pages", [])
                                  if p.get("label") and abs(p["start"] - page["start"]) <= 1), {}))
            save_analysis(data_dir, video["id"], data)
        twin = (_twin(video, data, data_dir, copies.get(size, []))
                if copies is not None and need_guide and data["segments"] else None)
        if need_guide and not data["segments"]:  # 소리 없는 강의: Claude에 묻지 않고 표시만 해 둡니다(다시 묻지 않게)
            data["silent"] = True
            save_analysis(data_dir, video["id"], data)
        elif twin:  # 다른 반 폴더의 같은 영상에 이미 요점 정리가 있음: 다시 사지 않고 가져옵니다
            data["guide"] = twin["guide"]
            for page in data.get("pages", []):
                page.update(next(({"label": p["label"]} for p in twin.get("pages", [])
                                  if p.get("label") and abs(p["start"] - page["start"]) <= 1), {}))
            _apply_corrections(data["segments"], data["guide"])
            data.pop("guide_stale", None)
            data.pop("guide_failures", None)
            save_analysis(data_dir, video["id"], data)
            print(f"  다른 폴더의 같은 영상에서 요점 정리를 가져옵니다: {twin.get('title', '')}")
        elif need_guide:
            screens = None
            if data["segments"] and read_screens and data.get("pages"):
                if "text" not in data["pages"][0]:  # 요점 정리에서 실패해도 다시 읽지 않도록 저장해 둡니다.
                    print("  화면 글자 읽는 중...", flush=True)
                    texts = read_screens(video["path"], data["pages"], data["duration"])
                    for page, lines in zip(data["pages"], texts):
                        page["text"] = lines
                    save_analysis(data_dir, video["id"], data)
                screens = [{"start": p["start"], "text": p["text"]} for p in data["pages"]]
            refs = []
            if data["segments"] and find_references:
                lines = [line for page in data.get("pages", []) for line in page.get("text", [])]
                refs = find_references(data["title"], lines)
            print("  요점 정리·퀴즈 만드는 중..." + (f" (학원 정리 {len(refs)}개 활용)" if refs else ""), flush=True)
            try:
                data["guide"] = make_guide(data["title"], data["segments"], screens, [r["text"] for r in refs] or None)
            except IncompleteAnswer:  # 답을 받았지만(비용이 듦) 쓸 수 없음: 몇 번 그랬는지 적어 매일 밤 다시 사지 않게
                data["guide_failures"] = _tries(data) + 1
                save_analysis(data_dir, video["id"], data)
                raise
            if refs:
                data["guide"]["sources"] = [r["source"] for r in refs]
            for label in data["guide"].pop("page_labels", []):
                for page in data.get("pages", []):
                    if abs(page["start"] - label["start"]) <= 1:  # 이름표 시점은 페이지 시작을 초 단위로 버린 값
                        page["label"] = label["label"]
            _apply_corrections(data["segments"], data["guide"])
            data.pop("guide_stale", None)
            data.pop("guide_failures", None)
            save_analysis(data_dir, video["id"], data)
        if copies is not None and size is not None and video["id"] not in copies.get(size, []):  # 같은 밤의 복사본이 씀
            copies.setdefault(size, []).append(video["id"])
        print("  완료")
    except Exception as e:
        print(f"  실패: {e}", file=sys.stderr)
        return 1
    return 0


def _twin(video, data, data_dir, candidates):
    """크기·길이가 같은 다른 폴더의 같은 영상 가운데 요점 정리가 다 된 분석(없으면 None)."""
    for other in candidates:
        if other == video["id"]:
            continue
        try:
            twin = load_analysis(data_dir, other)
            if (isinstance(twin, dict) and twin.get("guide") and not twin.get("guide_stale")
                    and abs(float(twin.get("duration") or 0) - float(data.get("duration") or 0)) <= 2):
                return twin
        except (OSError, ValueError, TypeError):
            continue
    return None


def _apply_corrections(segments, guide):
    """Claude가 요점 정리 때 찾은 받아쓰기 오타를 대본 탭·검색·질문하기에도 반영합니다.
    바른 표기 안에 틀린 표기가 든 경우('관동별'→'관동별곡')는 이미 바르게 적힌 곳을 건드리지 않습니다('관동별곡곡'이 되지 않게)."""
    for fix in (guide or {}).get("corrections", []):
        wrong, right = fix["wrong"], fix["right"]
        for segment in segments:
            text = segment["text"]
            segment["text"] = (right.join(part.replace(wrong, right) for part in text.split(right)) if wrong in right
                               else text.replace(wrong, right))


def voice_channel(left, right):
    """두 채널을 더한 소리와 뺀 소리 중 큰 쪽을 돌려줍니다.

    일부 녹화는 왼쪽·오른쪽 채널의 위상이 반대라서, 평균을 내면 목소리가 지워져 받아쓸 말이 사라집니다.
    """
    mid, side = (left + right) / 2, (left - right) / 2
    return side if np.square(side).mean() > np.square(mid).mean() else mid


def tidy_repeats(segments):
    """Whisper가 말 없는 구간(판서 중 등)에서 같은 말을 되풀이해 지어낸 것을 정리합니다.

    한 줄 안에서 같은 단어가 4번 이상 이어지면 하나만 남기고, 연달아 같은 줄은 한 줄로 합칩니다.
    """
    tidy = []
    for s in segments:
        words = []
        for _, run in groupby(s["text"].split(), key=lambda w: w.rstrip(",.?!")):
            run = list(run)
            words += run[:1] if len(run) >= 4 else run
        text = " ".join(words)
        if tidy and tidy[-1]["text"] == text:
            tidy[-1]["end"] = s["end"]
        else:
            tidy.append({**s, "text": text})
    return tidy


def video_duration(path):
    """영상 파일 머리에 적힌 길이(초). 파일 전체를 읽지 않아 빠릅니다."""
    import av
    with av.open(str(path)) as container:
        return (container.duration or 0) / av.time_base


def part_arg(text):
    i, n = map(int, text.split("/"))
    if not 1 <= i <= n:
        raise ValueError(text)
    return i, n


def whisper_transcriber():
    from faster_whisper import WhisperModel
    from faster_whisper.audio import decode_audio

    model = None

    def transcribe(path):
        nonlocal model
        import av
        with av.open(str(path)) as container:  # 소리 트랙이 없는 영상(화면만 녹화)은 '음성 없음'으로: 페이지는 만듭니다
            if not container.streams.audio:
                return [], (container.duration or 0) / av.time_base
        if model is None:  # 모델 로딩이 느리므로 받아쓸 영상이 있을 때 한 번만 불러옵니다.
            model = WhisperModel(os.environ.get("WHISPER_MODEL", "large-v3-turbo"),
                                 device="auto", compute_type="auto")
        audio = voice_channel(*decode_audio(str(path), split_stereo=True))
        segments, info = model.transcribe(
            audio, language=os.environ.get("WHISPER_LANGUAGE", "ko") or None, vad_filter=True)
        return tidy_repeats([{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
                             for s in segments]), info.duration

    return transcribe


def main():
    import anthropic

    from academy import references as academy_refs
    from academy import screens as screen_text
    from academy.ai import make_study_guide
    from academy.pages import detect_pages

    parser = argparse.ArgumentParser(description="강의 영상 일괄 분석")
    parser.add_argument("--force", action="store_true", help="이미 분석된 영상도 다시 분석")
    parser.add_argument("--part", type=part_arg, default=(1, 1), metavar="i/n",
                        help="영상을 n묶음으로 나눠 i번째 묶음만 분석 (GPU 여러 개를 동시에 쓸 때)")
    parser.add_argument("--no-guide", action="store_true",
                        help="Claude 없이 받아쓰기·페이지만 만듦 (나중에 이 옵션 없이 실행하면 요점 정리만 추가)")
    parser.add_argument("--retry-failed", action="store_true",
                        help=f"Claude 답이 {GUIDE_TRIES}번 잘려 건너뛰던 강의의 요점 정리도 다시 만듦")
    parser.add_argument("--only", metavar="제목_일부", help="제목(폴더 이름 포함)에 이 글이 든 강의만 분석 (예: --only 제망매가)")
    parser.add_argument("--yes", action="store_true", help="--force로 Claude 비용이 드는 다시 분석을 비용 안내 없이 시작")
    args = parser.parse_args()
    load_env_file()  # 서버·밤 작업과 같은 설정 파일
    video_dir = Path(os.environ.get("VIDEO_DIR", "videos"))
    data_dir = Path(os.environ.get("DATA_DIR", "data"))
    if not video_dir.is_dir():
        sys.exit(f"영상 폴더가 없습니다: {video_dir.resolve()} (VIDEO_DIR 설정을 확인하세요)")
    if not args.no_guide and not os.environ.get("ANTHROPIC_API_KEY", "").strip():
        sys.exit("Claude API 키(ANTHROPIC_API_KEY)가 없어 분석을 시작하지 않습니다(README '2. Claude API 키 설정'). "
                 "키 없이 받아쓰기·페이지만 만들려면 --no-guide를 붙이세요")
    if problem := folders_problem(video_dir, data_dir):
        sys.exit(problem)
    if args.force and not args.no_guide and not args.yes and (notice := _redo_notice(video_dir, data_dir, args.part, args.only)):
        sys.exit(notice)

    make_guide = read_screens = find_references = None
    if not args.no_guide:
        client = anthropic.Anthropic()
        make_guide = lambda title, segments, screens, refs: make_study_guide(client, title, segments, screens, refs)
        references = academy_refs.load_references(os.environ.get("REFERENCES_FILE"))
        if references:
            print(f"학원 요점 정리 {len(references)}개 중 짝지어지는 것을 근거로 씁니다.")
            find_references = lambda title, lines: academy_refs.find_references(title, lines, references)
        ocr = screen_text.paddle_ocr()
        if ocr:
            read_screens = lambda path, pages, duration: screen_text.read_screens(path, pages, duration, ocr)
        else:
            print("화면 글자 인식(PaddleOCR)이 설치되지 않아 대본만으로 요점 정리를 만듭니다. (README의 '화면 글자 인식' 참고)")
    failures = analyze_all(
        video_dir,
        data_dir,
        whisper_transcriber(),
        make_guide,
        force=args.force,
        part=args.part,
        detect_pages=detect_pages,
        read_screens=read_screens,
        find_references=find_references,
        settle_seconds=SETTLE_SECONDS,
        probe=video_duration,
        retry_failed=args.retry_failed,
        only=args.only,
    )
    if failures is None:  # 하지 않은 까닭은 analyze_all이 날짜 줄로 남김
        return
    # 현황 화면의 '새 강의 분석'에 나오는 날짜 줄
    print(f"{datetime.now():%Y-%m-%d %H:%M} 영상 분석 끝"
          + (f", 실패 {failures}개(다시 실행하면 실패한 영상만 이어서 분석합니다)" if failures else ""), flush=True)
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
