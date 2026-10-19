"""강의 화면을 일정 간격으로 캡처하고, 거의 같은 장면은 버립니다 (판서 분석용).

미리보기: python -m academy.frames 1강.mp4 [2강.mp4 ...]
분석 때 Claude에 보낼 사진을 판서-미리보기/<영상 이름>/ 폴더에 저장합니다 (API 비용·받아쓰기 없음).
"""

import argparse
import io
import math
import shutil
import sys
from pathlib import Path

import av
import numpy as np
import PIL.Image  # noqa: F401  사진 저장(to_image)에 필요. 없으면 받아쓰기 전에 알 수 있게 미리 불러옵니다.

INTERVAL = 30       # 캡처 간격(초)
LONG_SIDE = 1280    # 판서 글씨가 읽히는 크기(긴 쪽 기준). 더 작은 영상은 키우지 않음
JPEG_QUALITY = 75
SAME_SCENE = 8      # 32×18 흑백 화소 차이 평균이 이보다 작으면 같은 장면 (0~255)
MAX_FRAMES = 100    # Claude API 한 요청의 이미지 한도 안


def thin(frames: list, limit: int) -> list:
    """시간 순 목록을 처음·끝을 포함해 고르게 limit개로 줄입니다."""
    if len(frames) <= limit:
        return frames
    if limit == 1:
        return frames[:1]
    step = (len(frames) - 1) / (limit - 1)
    return [frames[round(i * step)] for i in range(limit)]


def _frame_at(container, stream, t: int):
    container.seek(int(t / stream.time_base), stream=stream)  # t 앞의 키프레임으로
    for frame in container.decode(stream):
        if frame.time is not None and frame.time >= t - 0.001:
            return frame
    return None


def _jpeg(frame) -> bytes:
    # 세로 영상도 긴 쪽을 줄입니다. 사진이 20장을 넘으면 API가 한 변 2000px 넘는 사진을 거절합니다.
    scale = min(1, LONG_SIDE / max(frame.width, frame.height))
    img = frame.reformat(width=round(frame.width * scale), height=round(frame.height * scale)).to_image()
    if frame.rotation:  # 휴대폰 영상은 "돌려서 보여 줘"라는 정보만 붙어 있으므로 직접 세웁니다.
        img = img.rotate(frame.rotation, expand=True)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=JPEG_QUALITY)
    return buf.getvalue()


def extract_frames(path: Path) -> list[tuple[int, bytes]]:
    """[(초, JPEG 바이트), ...]. 영상이 없으면 빈 목록, 읽다가 깨지면 그때까지 찍은 사진 (분석은 계속)."""
    kept, limit = [], MAX_FRAMES
    try:
        with av.open(str(path)) as container:
            stream = container.streams.video[0]
            if not container.duration:
                raise ValueError("영상 길이를 알 수 없음")
            duration = container.duration / av.time_base
            limit = min(MAX_FRAMES, max(1, math.ceil(duration / 60)))
            # 잘라 낸 영상은 첫 화면 시각이 0이 아닐 수 있습니다. 플레이어·대본처럼 영상 시작을 0초로 셉니다.
            start = float(stream.start_time * stream.time_base) if stream.start_time else 0.0
            scene_start = None
            for t in range(0, int(duration) + 1, INTERVAL):
                frame = _frame_at(container, stream, start + t)
                if frame is None:
                    break
                small = frame.reformat(width=32, height=18, format="gray").to_ndarray().astype(np.int16)
                # 장면이 바뀌었는지는 그 장면의 첫 화면과 비교하고, 같은 장면이면 더 나중 화면으로 바꿉니다.
                # 그래서 판서가 가장 많이 채워진, 지우기 직전 칠판이 남습니다.
                if scene_start is not None and np.abs(small - scene_start).mean() < SAME_SCENE:
                    kept[-1] = (t, _jpeg(frame))
                    continue
                scene_start = small
                kept.append((t, _jpeg(frame)))
    except Exception as e:  # 사진은 덤이라 어떤 오류여도 영상 분석은 계속합니다.
        note = f"앞부분 {len(kept)}장만 씁니다" if kept else "건너뜁니다"
        print(f"  화면 캡처 중 오류, {note}: {e}", file=sys.stderr)
    return thin(kept, limit)


def main():
    from academy.ai import fmt_time

    parser = argparse.ArgumentParser(description="판서 사진 미리보기 (API 비용 없음)")
    parser.add_argument("videos", nargs="+", type=Path, help="강의 영상 파일")
    for video in parser.parse_args().videos:
        folder = Path("판서-미리보기") / video.stem
        shutil.rmtree(folder, ignore_errors=True)  # 다시 실행하면 지난번 미리보기와 섞이지 않게
        folder.mkdir(parents=True)
        frames = extract_frames(video)
        for seconds, jpeg in frames:
            # 윈도우 파일 이름에는 ":"를 쓸 수 없어서 01-30.jpg 처럼 저장합니다.
            (folder / f"{fmt_time(seconds).replace(':', '-')}.jpg").write_bytes(jpeg)
        print(f"{video.name}: 사진 {len(frames)}장 → {folder}/")


if __name__ == "__main__":
    main()
