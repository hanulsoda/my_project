"""강의 화면을 일정 간격으로 캡처하고, 거의 같은 장면은 버립니다 (판서 분석용)."""

import io
import math
import sys
from pathlib import Path

import av
import numpy as np

INTERVAL = 30       # 캡처 간격(초)
WIDTH = 1280        # 판서 글씨가 읽히는 폭. 더 작은 영상은 키우지 않음
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
    width = min(WIDTH, frame.width)
    height = round(frame.height * width / frame.width)
    buf = io.BytesIO()
    frame.reformat(width=width, height=height).to_image().save(buf, "JPEG", quality=JPEG_QUALITY)
    return buf.getvalue()


def extract_frames(path: Path) -> list[tuple[int, bytes]]:
    """[(초, JPEG 바이트), ...]. 영상이 없거나 읽을 수 없으면 빈 목록 (분석은 계속)."""
    try:
        with av.open(str(path)) as container:
            stream = container.streams.video[0]
            if not container.duration:
                raise ValueError("영상 길이를 알 수 없음")
            duration = container.duration / av.time_base
            kept, last = [], None
            for t in range(0, int(duration) + 1, INTERVAL):
                frame = _frame_at(container, stream, t)
                if frame is None:
                    break
                small = frame.reformat(width=32, height=18, format="gray").to_ndarray().astype(np.int16)
                if last is not None and np.abs(small - last).mean() < SAME_SCENE:
                    continue
                last = small
                kept.append((t, _jpeg(frame)))
    except (av.error.FFmpegError, IndexError, ValueError) as e:
        print(f"  화면 캡처를 건너뜁니다: {e}", file=sys.stderr)
        return []
    return thin(kept, min(MAX_FRAMES, max(1, math.ceil(duration / 60))))
