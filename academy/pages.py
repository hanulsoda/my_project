"""강의 화면에서 페이지가 바뀌는 지점을 찾고 페이지마다 썸네일을 저장합니다.

교재 PDF를 띄워 놓고 판서하는 화면 녹화를 기준으로 맞춘 값입니다.
"""

from pathlib import Path

import av
import numpy as np

THUMB_WIDTH = 320
FAR = 10        # 페이지 첫 화면과 이만큼(0~255 밝기 평균 차이) 달라지면 다른 화면
STILL = 2       # 다음 키프레임과 이만큼도 차이가 안 나면 스크롤이 멈춘 것
MIN_SECONDS = 40  # 이보다 짧게 지나간 화면은 스크롤 도중으로 보고 다음 페이지에 합침


def find_pages(frames, times):
    """frames는 작은 흑백 화면(numpy 배열) 목록. 페이지가 시작하는 키프레임 번호를 돌려줍니다."""
    diff = lambda a, b: float(np.abs(frames[a] - frames[b]).mean())
    starts = [0]
    for i in range(1, len(frames) - 1):
        if diff(i, starts[-1]) > FAR and diff(i, i + 1) < STILL:
            if times[i] - times[starts[-1]] < MIN_SECONDS:
                starts[-1] = i
            else:
                starts.append(i)
    return starts


def detect_pages(video_path, out_dir) -> list[dict]:
    frames, times, thumbs = [], [], []
    with av.open(str(video_path)) as container:
        if not container.streams.video:
            return []
        stream = container.streams.video[0]
        stream.codec_context.skip_frame = "NONKEY"  # 키프레임만 읽어서 1시간 영상도 몇 초면 끝납니다.
        for frame in container.decode(stream):
            frames.append(frame.reformat(width=32, height=18, format="gray").to_ndarray().astype(np.float32))
            times.append(float(frame.time))
            height = round(frame.height * THUMB_WIDTH / frame.width / 2) * 2
            thumbs.append(frame.reformat(width=THUMB_WIDTH, height=height, format="yuvj420p"))
    if not frames:
        return []
    starts = find_pages(frames, times)
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    for n, i in enumerate(starts):
        _save_jpeg(thumbs[i], Path(out_dir) / f"{n}.jpg")
    return [{"start": round(times[i], 2)} for i in starts]


def _save_jpeg(frame, path):
    with av.open(str(path), "w", format="image2") as out:
        stream = out.add_stream("mjpeg")
        stream.width, stream.height, stream.pix_fmt = frame.width, frame.height, "yuvj420p"
        out.mux(stream.encode(frame))
        out.mux(stream.encode())
