"""서버 폴더의 모든 강의 영상을 받아쓰고 요점 정리·퀴즈를 만듭니다.

실행: python -m academy.analyze [--force] [--part i/n] [--no-guide]
이미 분석된 영상은 건너뛰므로, 새 영상을 올린 뒤 다시 실행하면 새 영상만 분석합니다.
"""

import argparse
import os
import sys
import time
import unicodedata
from itertools import groupby
from pathlib import Path

import numpy as np

from academy.library import VIDEO_EXTS, find_videos, load_analysis, record_move, save_analysis

# 예전에 소리 없는 강의에 넣던 빈 요점 정리. 지금은 "silent": true로 표시하고, 이것을 만나면 걷어 냅니다.
SILENT_GUIDE = {"summary": "음성이 없는 영상입니다.", "chapters": [], "quiz": []}
SETTLE_SECONDS = 600  # 이보다 최근에 바뀐 영상은 아직 NAS로 복사 중일 수 있어 다음에 분석합니다


def run_lock(data_dir, part):
    """같은 묶음(--part)의 분석이 이미 돌고 있으면 None. 돌려준 파일을 닫으면(프로세스가 끝나면) 풀립니다.
    윈도에는 이 잠금(fcntl)이 없어 잠그지 않습니다(분석을 겹쳐 돌리지 않게 조심)."""
    Path(data_dir).mkdir(parents=True, exist_ok=True)
    lock = open(Path(data_dir) / f".analyze-{part[0]}of{part[1]}.lock", "w")
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


def analyze_all(video_dir, data_dir, transcribe, make_guide, force=False, part=(1, 1),
                detect_pages=None, read_screens=None, find_references=None, settle_seconds=0, probe=None) -> int:
    """make_guide가 None이면 Claude 없이 받아쓰기와 페이지만 만듭니다. 요점 정리는 나중에 붙일 수 있습니다.

    read_screens가 있으면 요점 정리를 만들 때 페이지마다 화면 글자를 읽어 근거로 함께 보냅니다.
    find_references(제목, 화면 글자 줄)는 짝지어지는 학원 요점 정리를 {"source", "text"} 목록으로 돌려줍니다.
    settle_seconds: 이보다 최근에 바뀐 영상은 복사 중일 수 있어 받아쓰지 않습니다(반쯤 받아쓴 것이 '분석됨'으로 남지 않게).
    probe(영상 경로)는 영상 길이(초). 주면 폴더를 옮기거나 이름을 바꾼 강의를 알아보고 예전 분석을 이어 씁니다.
    """
    videos = find_videos(video_dir)
    if not videos:
        print(f"영상이 없습니다: {Path(video_dir).resolve()} ({' '.join(sorted(VIDEO_EXTS))} 파일만 찾습니다)")
        return 0
    lock = run_lock(data_dir, part)  # 밤 작업이 겹쳐 같은 강의를 두 번 받아쓰고 Claude 비용을 두 번 내지 않게
    if lock is None:
        print("이 묶음의 분석이 이미 돌고 있어 이번에는 하지 않습니다.")
        return 0
    try:
        orphans = _orphans(data_dir, {v["id"] for v in videos}) if probe else []
        return _analyze(videos[part[0] - 1::part[1]],  # GPU마다 프로세스를 하나씩 띄울 때 서로 다른 영상을 맡도록 나눕니다.
                        data_dir, transcribe, make_guide, force, detect_pages, read_screens, find_references, settle_seconds,
                        lambda video: _adopt(video, data_dir, orphans, probe))
    finally:
        lock.close()


def _orphans(data_dir, known):
    """지금 영상 폴더의 어느 강의 것도 아닌 분석(폴더를 옮기거나 이름을 바꾸기 전의 강의) [{"id", "name", "duration", "data"}]"""
    found = []
    for path in Path(data_dir).glob("*.json"):
        if path.stem in known:
            continue
        try:
            data = load_analysis(data_dir, path.stem)
            found.append({"id": path.stem, "name": unicodedata.normalize("NFC", data["title"].rsplit("/", 1)[-1]),
                          "duration": float(data["duration"]), "size": data.get("size"), "data": data})
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            continue  # 읽을 수 없거나 형식이 다른 파일은 건드리지 않습니다
    return found


def _adopt(video, data_dir, orphans, probe):
    """옮긴 강의: 주인 없는 분석 가운데 파일 이름이 같고 길이가 2초 안이고 파일 크기가 같은 것이 꼭 하나면,
    그 분석(과 페이지 그림)을 이 강의로 옮깁니다. 받아쓰기·요점 정리를 다시 만들지 않아 비용이 들지 않습니다.
    둘 이상이거나 길이·크기가 다르면 짐작하지 않고 None. 크기를 적기 전의 분석은 이름과 길이로만 봅니다."""
    name = video["title"].rsplit("/", 1)[-1]
    same = [o for o in orphans if o["name"] == name]
    if not same:
        return None
    try:
        duration, size = probe(video["path"]), video["path"].stat().st_size
        same = [o for o in same if abs(o["duration"] - duration) <= 2 and o["size"] in (None, size)]
        if len(same) != 1:
            return None
        old = same[0]
        # 분석 파일을 먼저 옮긴 쪽만 이어 씁니다(함께 도는 --part 묶음이 같은 분석을 둘 다 가져가지 않게).
        (Path(data_dir) / f"{old['id']}.json").rename(Path(data_dir) / f"{video['id']}.json")
        data = {**old["data"], "title": video["title"], "size": size}
        save_analysis(data_dir, video["id"], data)
        if (Path(data_dir) / old["id"]).is_dir() and not (Path(data_dir) / video["id"]).exists():
            (Path(data_dir) / old["id"]).rename(Path(data_dir) / video["id"])
        record_move(data_dir, old["id"], video["id"])  # 학생 기기의 이어 보기·메모와 '이번 주 강의'가 따라오게
    except Exception as e:  # 영상 길이를 못 읽음 등: 이어 쓰지 않고 새로 분석합니다
        print(f"  예전 분석을 이어 쓰지 못함, 새로 분석: {e}", file=sys.stderr)
        return None
    orphans.remove(old)
    print(f"  옮긴 강의로 보여 예전 분석을 이어 씁니다: {old['data']['title']}")
    return data


def _analyze(videos, data_dir, transcribe, make_guide, force, detect_pages, read_screens, find_references, settle_seconds, adopt):
    failures = 0
    for n, video in enumerate(videos, 1):
        print(f"[{n}/{len(videos)}] {video['title']}", flush=True)
        try:
            old = load_analysis(data_dir, video["id"])
            if old is not None and not isinstance(old, dict):
                raise ValueError("JSON 객체가 아님")
        except ValueError as e:  # 손으로 고치다 형식이 깨진 파일: 덮어쓰지 않고 이 강의만 건너뜁니다
            failures += 1
            print(f"  분석 파일 형식 오류, 건너뜀(고친 곳의 쉼표·따옴표를 확인하세요): {e}", file=sys.stderr)
            continue
        if old and old.get("guide") == SILENT_GUIDE:  # 예전에는 소리 없는 강의에 빈 요점 정리를 넣어 학원 정리가 가려졌습니다
            old = {**old, "guide": None, "silent": True}
            save_analysis(data_dir, video["id"], old)
        if old and "size" not in old:  # 옮긴 강의를 알아볼 파일 크기: 크기를 적기 전의 분석에 채워 둡니다
            try:
                old = {**old, "size": video["path"].stat().st_size}
                save_analysis(data_dir, video["id"], old)
            except OSError:
                pass
        data = None if force else old
        if data is None and not force:
            data = adopt(video)  # 폴더를 옮기거나 이름을 바꾼 강의면 예전 분석을 이어 씀
        done = data or {}
        need_pages = detect_pages is not None and "pages" not in done
        # 소리 없는 강의(받아쓴 말 없음)는 Claude에 묻지 않습니다. 요점 정리 칸은 비워 두어 학원 정리가 보이게 합니다.
        # guide_stale: --force로 새로 받아쓴 뒤 아직 새 요점 정리를 못 만든 강의(예전 것을 보여 주는 중): 다음 실행에서 이어 만듭니다.
        need_guide = make_guide is not None and (not done.get("guide") or done.get("guide_stale")) and not done.get("silent")
        if data and not (need_pages or need_guide):
            print("  이미 분석됨, 건너뜀")
            continue
        try:  # 영상이 그사이 옮겨졌거나 NAS가 답하지 않으면 이 강의만 실패로 셉니다
            if not data and time.time() - video["path"].stat().st_mtime < settle_seconds:
                print("  방금 바뀐 영상이라(복사 중일 수 있음) 다음에 분석합니다")
                continue
            if not data:
                print("  받아쓰는 중...", flush=True)
                size = video["path"].stat().st_size
                segments, duration = transcribe(video["path"])
                data = {"title": video["title"], "duration": duration, "size": size,
                        "segments": segments, "guide": None}
                # 다시 분석(--force)해도 새 요점 정리가 생길 때까지 예전 요점 정리·목차(비용을 들인 결과)를 둡니다.
                data.update({key: old[key] for key in ("guide", "toc") if old and key in old})
                # --no-guide로 받아쓰기만 새로 했으면 예전 요점 정리를 계속 씁니다(다음 밤에 강의마다 다시 사지 않게).
                if data["guide"] and (make_guide is not None or old.get("guide_stale")):
                    data["guide_stale"] = True
                # 요점 정리에서 실패해도 오래 걸린 받아쓰기는 남겨 둡니다.
                save_analysis(data_dir, video["id"], data)
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
            if need_guide and not data["segments"]:  # 소리 없는 강의: Claude에 묻지 않고 표시만 해 둡니다(다시 묻지 않게)
                data["silent"] = True
                save_analysis(data_dir, video["id"], data)
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
                data["guide"] = make_guide(data["title"], data["segments"], screens, [r["text"] for r in refs] or None)
                if refs:
                    data["guide"]["sources"] = [r["source"] for r in refs]
                for label in data["guide"].pop("page_labels", []):
                    for page in data.get("pages", []):
                        if abs(page["start"] - label["start"]) <= 1:  # 이름표 시점은 페이지 시작을 초 단위로 버린 값
                            page["label"] = label["label"]
                # Claude가 요점 정리 때 찾은 받아쓰기 오타를 대본 탭·질문하기에도 반영합니다.
                for fix in data["guide"].get("corrections", []):
                    for segment in data["segments"]:
                        segment["text"] = segment["text"].replace(fix["wrong"], fix["right"])
                data.pop("guide_stale", None)
                save_analysis(data_dir, video["id"], data)
            print("  완료")
        except Exception as e:
            failures += 1
            print(f"  실패: {e}", file=sys.stderr)
    return failures


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
    args = parser.parse_args()
    video_dir = Path(os.environ.get("VIDEO_DIR", "videos"))
    if not video_dir.is_dir():
        sys.exit(f"영상 폴더가 없습니다: {video_dir.resolve()} (VIDEO_DIR 설정을 확인하세요)")

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
        Path(os.environ.get("DATA_DIR", "data")),
        whisper_transcriber(),
        make_guide,
        force=args.force,
        part=args.part,
        detect_pages=detect_pages,
        read_screens=read_screens,
        find_references=find_references,
        settle_seconds=SETTLE_SECONDS,
        probe=video_duration,
    )
    if failures:
        print(f"{failures}개 영상 분석 실패. 다시 실행하면 실패한 영상만 이어서 분석합니다.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
