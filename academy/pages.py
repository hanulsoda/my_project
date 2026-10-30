"""강의 화면에서 페이지가 바뀌는 지점을 찾고 페이지마다 썸네일을 저장합니다.

교재 PDF를 띄워 놓고 판서하는 화면 녹화를 기준으로 맞춘 값입니다.
"""

import shutil
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
        # 잘라 낸 녹화는 첫 화면 시각이 0이 아닙니다. 플레이어·대본처럼 영상 시작을 0초로 셉니다.
        start = float(stream.start_time * stream.time_base) if stream.start_time else 0.0
        rotation = 0
        for frame in container.decode(stream):
            # VP9 같은 코덱은 "키프레임만"을 무시하고 모든 화면을 풀어서 직접 거릅니다(다 쌓으면 메모리가 넘침).
            if not frame.key_frame or frame.time is None:
                continue
            rotation = frame.rotation
            frames.append(frame.reformat(width=32, height=18, format="gray").to_ndarray().astype(np.float32))
            times.append(float(frame.time) - start)
            height = round(frame.height * THUMB_WIDTH / frame.width / 2) * 2
            thumbs.append(frame.reformat(width=THUMB_WIDTH, height=height, format="yuvj420p"))
    if not frames:
        return []
    starts = find_pages(frames, times)
    shutil.rmtree(out_dir, ignore_errors=True)  # 다시 분석하면 지난번 그림이 남지 않게
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    for n, i in enumerate(starts):
        _save_jpeg(_upright(thumbs[i], rotation), Path(out_dir) / f"{n}.jpg")
    return [{"start": round(times[i], 2)} for i in starts]


def _upright(frame, rotation):
    """휴대폰 영상은 화면은 그대로 두고 "돌려서 보여 줘"라는 정보만 붙어 있어서, 그림을 직접 세웁니다(반시계 방향)."""
    turns = round(rotation / 90) % 4
    if not turns:
        return frame
    upright = np.ascontiguousarray(np.rot90(frame.to_ndarray(format="rgb24"), turns))
    return av.VideoFrame.from_ndarray(upright, format="rgb24").reformat(format="yuvj420p")


def _save_jpeg(frame, path):
    with av.open(str(path), "w", format="image2") as out:
        stream = out.add_stream("mjpeg")
        stream.width, stream.height, stream.pix_fmt = frame.width, frame.height, "yuvj420p"
        out.mux(stream.encode(frame))
        out.mux(stream.encode())
