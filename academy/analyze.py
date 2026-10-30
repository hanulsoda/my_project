"""서버 폴더의 모든 강의 영상을 받아쓰고 요점 정리·퀴즈를 만듭니다.

실행: python -m academy.analyze [--force] [--part i/n] [--no-guide]
이미 분석된 영상은 건너뛰므로, 새 영상을 올린 뒤 다시 실행하면 새 영상만 분석합니다.
"""

import argparse
import os
import sys
from itertools import groupby
from pathlib import Path

import numpy as np

from academy.library import VIDEO_EXTS, find_videos, load_analysis, save_analysis

SILENT_GUIDE = {"summary": "음성이 없는 영상입니다.", "chapters": [], "quiz": []}


def analyze_all(video_dir, data_dir, transcribe, make_guide, force=False, part=(1, 1),
                detect_pages=None, read_screens=None, find_references=None) -> int:
    """make_guide가 None이면 Claude 없이 받아쓰기와 페이지만 만듭니다. 요점 정리는 나중에 붙일 수 있습니다.

    read_screens가 있으면 요점 정리를 만들 때 페이지마다 화면 글자를 읽어 근거로 함께 보냅니다.
    find_references(제목, 화면 글자 줄)는 짝지어지는 학원 요점 정리를 {"source", "text"} 목록으로 돌려줍니다.
    """
    videos = find_videos(video_dir)
    if not videos:
        print(f"영상이 없습니다: {Path(video_dir).resolve()} ({' '.join(sorted(VIDEO_EXTS))} 파일만 찾습니다)")
        return 0
    # GPU마다 프로세스를 하나씩 띄울 때 서로 다른 영상을 맡도록 나눕니다.
    videos = videos[part[0] - 1::part[1]]
    failures = 0
    for n, video in enumerate(videos, 1):
        print(f"[{n}/{len(videos)}] {video['title']}", flush=True)
        data = None if force else load_analysis(data_dir, video["id"])
        done = data or {}
        need_pages = detect_pages is not None and "pages" not in done
        need_guide = make_guide is not None and not done.get("guide")
        if data and not (need_pages or need_guide):
            print("  이미 분석됨, 건너뜀")
            continue
        try:
            if not data:
                print("  받아쓰는 중...", flush=True)
                segments, duration = transcribe(video["path"])
                data = {"title": video["title"], "duration": duration,
                        "segments": segments, "guide": None}
                # 요점 정리에서 실패해도 오래 걸린 받아쓰기는 남겨 둡니다.
                save_analysis(data_dir, video["id"], data)
            if need_pages:
                print("  페이지 찾는 중...", flush=True)
                try:
                    data["pages"] = detect_pages(video["path"], Path(data_dir) / video["id"])
                except Exception as e:  # 페이지는 덤이라 실패해도 요점 정리는 만듭니다. 매번 다시 시도하지도 않습니다.
                    print(f"  페이지 찾기 실패, 건너뜀: {e}", file=sys.stderr)
                    data["pages"] = []
                save_analysis(data_dir, video["id"], data)
            if need_guide:
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
                data["guide"] = (make_guide(data["title"], data["segments"], screens, [r["text"] for r in refs] or None)
                                 if data["segments"] else SILENT_GUIDE)
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
    )
    if failures:
        print(f"{failures}개 영상 분석 실패. 다시 실행하면 실패한 영상만 이어서 분석합니다.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
