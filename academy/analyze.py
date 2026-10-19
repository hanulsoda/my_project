"""서버 폴더의 모든 강의 영상을 받아쓰고 요점 정리·퀴즈를 만듭니다.

실행: python -m academy.analyze [--force] [--part i/n] [--no-guide]
이미 분석된 영상은 건너뛰므로, 새 영상을 올린 뒤 다시 실행하면 새 영상만 분석합니다.
"""

import argparse
import os
import sys
from pathlib import Path

from academy.library import clear_frames, find_videos, load_analysis, save_analysis, save_frame

SILENT_GUIDE = {"summary": "음성이 없는 영상입니다.", "chapters": [], "quiz": []}


def analyze_all(video_dir, data_dir, transcribe, make_guide, extract_frames, force=False, part=(1, 1),
                detect_pages=None) -> int:
    """make_guide가 None이면 Claude 없이 받아쓰기와 페이지만 만듭니다. 요점 정리는 나중에 붙일 수 있습니다."""
    # GPU마다 프로세스를 하나씩 띄울 때 서로 다른 영상을 맡도록 나눕니다.
    videos = find_videos(video_dir)[part[0] - 1::part[1]]
    failures = 0
    for n, video in enumerate(videos, 1):
        print(f"[{n}/{len(videos)}] {video['title']}", flush=True)
        try:
            data = None if force else load_analysis(data_dir, video["id"])
            done = data or {}
            need_pages = detect_pages is not None and "pages" not in done
            need_guide = make_guide is not None and not done.get("guide")
            if data and not (need_pages or need_guide):
                print("  이미 분석됨, 건너뜀")
                continue
            if not data:
                print("  받아쓰는 중...", flush=True)
                segments, duration = transcribe(video["path"])
                data = {"title": video["title"], "duration": duration,
                        "segments": segments, "guide": None}
                # 요점 정리에서 실패해도 오래 걸린 받아쓰기는 남겨 둡니다.
                save_analysis(data_dir, video["id"], data)
            if need_pages:
                print("  페이지 찾는 중...", flush=True)
                data["pages"] = detect_pages(video["path"], Path(data_dir) / video["id"])
                save_analysis(data_dir, video["id"], data)
            if need_guide:
                if data["segments"]:
                    print("  화면 캡처 중...", flush=True)
                    frames = extract_frames(video["path"])
                    print("  요점 정리·퀴즈 만드는 중...", flush=True)
                    data["guide"] = make_guide(data["title"], data["segments"], frames)
                else:
                    frames, data["guide"] = [], SILENT_GUIDE
                # Claude가 요점 정리 때 찾은 받아쓰기 오타를 대본 탭·질문하기에도 반영합니다.
                for fix in data["guide"].get("corrections", []):
                    for segment in data["segments"]:
                        segment["text"] = segment["text"].replace(fix["wrong"], fix["right"])
                # 지난번 분석의 사진은 지우고, 챕터가 고른 판서 사진만 남깁니다.
                # 분석 파일보다 먼저 저장해 없는 사진을 가리키지 않게 합니다.
                clear_frames(data_dir, video["id"])
                chosen = {c["board"] for c in data["guide"]["chapters"] if c.get("board") is not None}
                for seconds, jpeg in frames:
                    if seconds in chosen:
                        save_frame(data_dir, video["id"], seconds, jpeg)
                save_analysis(data_dir, video["id"], data)
            print("  완료")
        except Exception as e:
            failures += 1
            print(f"  실패: {e}", file=sys.stderr)
    return failures


def part_arg(text):
    i, n = map(int, text.split("/"))
    if not 1 <= i <= n:
        raise ValueError(text)
    return i, n


def whisper_transcriber():
    from faster_whisper import WhisperModel

    model = None

    def transcribe(path):
        nonlocal model
        if model is None:  # 모델 로딩이 느리므로 받아쓸 영상이 있을 때 한 번만 불러옵니다.
            model = WhisperModel(os.environ.get("WHISPER_MODEL", "large-v3-turbo"),
                                 device="auto", compute_type="auto")
        segments, info = model.transcribe(
            str(path), language=os.environ.get("WHISPER_LANGUAGE", "ko") or None, vad_filter=True)
        return ([{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
                 for s in segments], info.duration)

    return transcribe


def main():
    parser = argparse.ArgumentParser(description="강의 영상 일괄 분석")
    parser.add_argument("--force", action="store_true", help="이미 분석된 영상도 다시 분석")
    parser.add_argument("--part", type=part_arg, default=(1, 1), metavar="i/n",
                        help="영상을 n묶음으로 나눠 i번째 묶음만 분석 (GPU 여러 개를 동시에 쓸 때)")
    parser.add_argument("--no-guide", action="store_true",
                        help="Claude 없이 받아쓰기·페이지만 만듦 (나중에 이 옵션 없이 실행하면 요점 정리만 추가)")
    args = parser.parse_args()

    video_dir = Path(os.environ.get("VIDEO_DIR", "videos"))
    if not find_videos(video_dir):
        sys.exit(f"영상을 찾지 못했습니다: {video_dir.resolve()}\n"
                 "이 폴더에 mp4, webm, m4v, mov 영상을 넣어 주세요.")

    import anthropic

    from academy.ai import make_study_guide

    try:
        from academy.frames import extract_frames
        from academy.pages import detect_pages
    except ImportError as e:
        sys.exit(f"분석에 필요한 라이브러리({e.name})가 없습니다. pip install -r requirements.txt 를 다시 실행해 주세요.")

    make_guide = None
    if not args.no_guide:
        client = anthropic.Anthropic()
        make_guide = lambda title, segments, frames: make_study_guide(client, title, segments, frames)
    failures = analyze_all(
        video_dir,
        Path(os.environ.get("DATA_DIR", "data")),
        whisper_transcriber(),
        make_guide,
        extract_frames,
        force=args.force,
        part=args.part,
        detect_pages=detect_pages,
    )
    if failures:
        print(f"{failures}개 영상 분석 실패. 다시 실행하면 실패한 영상만 이어서 분석합니다.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
