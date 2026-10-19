import io
import os
import shutil
import subprocess
import sys
import wave
from pathlib import Path

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


def test_keeps_last_frame_of_each_scene(three_scenes):
    assert [t for t, _ in extract_frames(three_scenes)] == [30, 90, 150]


def board(lines):
    img = np.zeros((H, W, 3), np.uint8)
    for i in range(lines):
        img[20 + i * 40:40 + i * 40, 40:100] = 255  # 한 줄이 같은 장면 기준보다 작은 변화
    return img


def test_keeps_fullest_board_while_teacher_writes(tmp_path):
    # 30초마다 한 줄씩 쓰고(1→2→3줄) 지웁니다. 3줄 다 쓴 칠판(90초)이 남아야 합니다.
    video = make_video(tmp_path / "writing.mp4", [(30, board(0)), (30, board(1)), (30, board(2)),
                                                  (30, board(3)), (60, board(0))])

    assert [t for t, _ in extract_frames(video)] == [30, 90, 150]


def test_times_are_relative_to_video_start(tmp_path):
    # 잘라 낸 영상처럼 첫 화면의 시각이 0이 아닌 파일 (플레이어와 대본은 0초부터 셉니다)
    path = tmp_path / "offset.mp4"
    with av.open(str(path), "w") as out:
        stream = out.add_stream("mpeg4", rate=1)
        stream.width, stream.height, stream.pix_fmt = W, H, "yuv420p"
        for i, img in enumerate([white()] * 60 + [black_with_box(40)] * 60):
            frame = av.VideoFrame.from_ndarray(img, format="rgb24")
            frame.pts = 600 + i
            for packet in stream.encode(frame):
                out.mux(packet)
        for packet in stream.encode():
            out.mux(packet)

    assert [t for t, _ in extract_frames(path)] == [30, 90]


def test_long_side_is_capped_for_portrait_video(tmp_path):
    from PIL import Image

    tall = np.zeros((1440, 360, 3), np.uint8)
    with av.open(str(tmp_path / "portrait.mp4"), "w") as out:
        stream = out.add_stream("mpeg4", rate=1)
        stream.width, stream.height, stream.pix_fmt = 360, 1440, "yuv420p"
        for packet in [*stream.encode(av.VideoFrame.from_ndarray(tall, format="rgb24")), *stream.encode()]:
            out.mux(packet)

    jpeg = extract_frames(tmp_path / "portrait.mp4")[0][1]

    assert Image.open(io.BytesIO(jpeg)).size == (320, 1280)


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg 명령이 없음")
def test_rotated_phone_video_comes_out_upright(tmp_path):
    from PIL import Image

    img = np.zeros((H, W, 3), np.uint8)
    img[0:40, 0:60] = 255  # 왼쪽 위 표시
    make_video(tmp_path / "land.mp4", [(3, img)])
    # 휴대폰처럼 화면은 그대로 두고 "90도 돌려서 보여 줘"라는 정보만 붙입니다.
    subprocess.run(["ffmpeg", "-loglevel", "error", "-display_rotation", "90", "-i", str(tmp_path / "land.mp4"),
                    "-c", "copy", str(tmp_path / "rotated.mp4")], check=True)

    photo = np.asarray(Image.open(io.BytesIO(extract_frames(tmp_path / "rotated.mp4")[0][1])).convert("L"))

    assert photo.shape == (W, H)  # 세로로 섬
    assert photo[-40:, :40].mean() > 200 and photo[:40, :40].mean() < 50  # 반시계 90도: 왼쪽 위 → 왼쪽 아래


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


def test_broken_middle_keeps_photos_taken_before(three_scenes):
    data = bytearray(three_scenes.read_bytes())
    start = len(data) // 2
    data[start:start + len(data) // 10] = bytes(len(data) // 10)  # 복사하다 깨진 파일
    three_scenes.write_bytes(data)

    assert extract_frames(three_scenes) != []


def test_unexpected_error_does_not_stop_analysis(three_scenes, monkeypatch):
    def broken_jpeg(frame):
        raise TypeError("예상 못 한 오류")

    monkeypatch.setattr("academy.frames._jpeg", broken_jpeg)

    assert extract_frames(three_scenes) == []


def run_preview(cwd, *videos):
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parent.parent)}
    return subprocess.run([sys.executable, "-m", "academy.frames", *map(str, videos)], cwd=cwd,
                          env=env, capture_output=True, text=True)


def test_preview_command_saves_photos_named_by_time(three_scenes, tmp_path):
    result = run_preview(tmp_path, "lecture.mp4")

    assert result.returncode == 0, result.stderr
    folder = tmp_path / "판서-미리보기" / "lecture"
    assert sorted(p.name for p in folder.iterdir()) == ["00-30.jpg", "01-30.jpg", "02-30.jpg"]
    assert (folder / "00-30.jpg").read_bytes().startswith(b"\xff\xd8")
    assert "lecture.mp4: 사진 3장" in result.stdout


def test_preview_keeps_same_named_lectures_apart(tmp_path):
    # README가 권하는 videos/수학/1강.mp4, videos/영어/1강.mp4 구성
    for subject in ("수학", "영어"):
        (tmp_path / "videos" / subject).mkdir(parents=True)
        make_video(tmp_path / "videos" / subject / "1강.mp4", [(10, white())])

    result = run_preview(tmp_path, tmp_path / "videos/수학/1강.mp4", tmp_path / "videos/영어/1강.mp4")

    assert result.returncode == 0, result.stderr
    for name in ("수학-1강", "영어-1강"):
        assert [p.name for p in (tmp_path / "판서-미리보기" / name).iterdir()] == ["00-00.jpg"]


@pytest.mark.parametrize("name", ["..mp4", ".."])
def test_preview_refuses_names_that_would_clear_other_previews(tmp_path, name):
    keep = tmp_path / "판서-미리보기" / "2강" / "00-30.jpg"
    keep.parent.mkdir(parents=True)
    keep.write_bytes(b"\xff\xd8")

    result = run_preview(tmp_path, name)

    assert result.returncode != 0
    assert keep.exists()


def test_thin_spreads_evenly_and_keeps_ends():
    thinned = thin(list(range(300)), 100)

    assert len(thinned) == 100
    assert thinned[0] == 0 and thinned[-1] == 299
    assert thinned == sorted(set(thinned))
    assert thin([1, 2], 5) == [1, 2]
