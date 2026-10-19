import io
import wave

import av
import numpy as np
import pytest

from academy.frames import extract_frames, thin

W, H = 320, 180


def white():
    return np.full((H, W, 3), 255, np.uint8)


def black_with_box(left):
    img = np.zeros((H, W, 3), np.uint8)
    img[45:135, left:left + 80] = 255  # 칠판에 쓴 글씨 덩어리 대신
    return img


def make_video(path, scenes):
    """scenes: [(초, 그림), ...] 를 1초 1장짜리 mp4로 만듭니다."""
    with av.open(str(path), "w") as out:
        stream = out.add_stream("mpeg4", rate=1)
        stream.width, stream.height, stream.pix_fmt = W, H, "yuv420p"
        for seconds, img in scenes:
            for _ in range(seconds):
                for packet in stream.encode(av.VideoFrame.from_ndarray(img, format="rgb24")):
                    out.mux(packet)
        for packet in stream.encode():
            out.mux(packet)
    return path


@pytest.fixture
def three_scenes(tmp_path):
    return make_video(tmp_path / "lecture.mp4",
                      [(60, white()), (60, black_with_box(40)), (60, black_with_box(200))])


def test_keeps_one_frame_per_distinct_scene(three_scenes):
    assert [t for t, _ in extract_frames(three_scenes)] == [0, 60, 120]


def test_frames_are_jpeg_and_not_upscaled(three_scenes):
    from PIL import Image

    jpeg = extract_frames(three_scenes)[0][1]

    assert jpeg.startswith(b"\xff\xd8")
    assert Image.open(io.BytesIO(jpeg)).width == W


def test_short_video_gives_one_frame(tmp_path):
    frames = extract_frames(make_video(tmp_path / "short.mp4", [(10, white())]))

    assert [t for t, _ in frames] == [0]


def write_audio_only(path):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * 16000)
    return path


@pytest.mark.parametrize("make_file", [
    lambda p: (p / "not_video.mp4").write_text("영상이 아님") and p / "not_video.mp4",
    lambda p: write_audio_only(p / "audio_only.wav"),
], ids=["not-a-video", "audio-only"])
def test_file_without_video_gives_empty_list(tmp_path, make_file):
    assert extract_frames(make_file(tmp_path)) == []


def test_thin_spreads_evenly_and_keeps_ends():
    thinned = thin(list(range(300)), 100)

    assert len(thinned) == 100
    assert thinned[0] == 0 and thinned[-1] == 299
    assert thinned == sorted(set(thinned))
    assert thin([1, 2], 5) == [1, 2]
