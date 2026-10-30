import shutil
import subprocess

import av
import numpy as np
import pytest

from academy import pages
from academy.pages import detect_pages, find_pages


def screen(level):
    return np.full((18, 32), level, dtype=np.float32)


def every_5s(frames):
    return [5.0 * i for i in range(len(frames))]


def test_scrolling_to_another_page_starts_a_new_page_once_the_screen_settles():
    frames = [screen(200)] * 12 + [screen(150), screen(100)] + [screen(50)] * 12

    assert find_pages(frames, every_5s(frames)) == [0, 14]


def test_pen_strokes_stay_on_the_same_page():
    frames, page = [], screen(240)
    for i in range(20):
        page = page.copy()
        page[i % 18, i] = 0  # 키프레임마다 획 하나만큼 잉크가 늘어남
        frames.append(page)

    assert find_pages(frames, every_5s(frames)) == [0]


def test_screen_shown_only_briefly_is_merged_into_the_next_page():
    frames = [screen(200)] * 12 + [screen(120)] * 3 + [screen(40)] * 12

    assert find_pages(frames, every_5s(frames)) == [0, 15]


def make_video(path, levels, seconds_each, codec="mpeg4", first_pts=0, marker=False):
    with av.open(str(path), "w") as out:
        stream = out.add_stream(codec, rate=1)
        stream.width, stream.height, stream.pix_fmt = 64, 36, "yuv420p"
        stream.codec_context.gop_size = 5  # 실제 화면 녹화처럼 5초마다 키프레임
        n = 0
        for level in levels:
            for _ in range(seconds_each):
                img = np.full((36, 64, 3), level, np.uint8)
                if marker:
                    img[0:12, 0:20] = 255  # 왼쪽 위 표시 (돌린 방향 확인용)
                frame = av.VideoFrame.from_ndarray(img, format="rgb24")
                frame.pts = first_pts + n
                n += 1
                out.mux(stream.encode(frame))
        out.mux(stream.encode())


def read_jpeg(path):
    with av.open(str(path)) as image:
        return next(image.decode(video=0)).to_ndarray(format="gray")


def test_detect_pages_finds_page_starts_and_saves_thumbnails(tmp_path):
    make_video(tmp_path / "lecture.mp4", [30, 220], 60)

    pages = detect_pages(tmp_path / "lecture.mp4", tmp_path / "thumbs")

    assert [p["start"] for p in pages] == [0, 60]
    for n in range(2):
        assert (tmp_path / "thumbs" / f"{n}.jpg").read_bytes()[:2] == b"\xff\xd8"  # JPEG


def test_vp9_recordings_compare_keyframes_only(tmp_path, monkeypatch):
    # 브라우저 화면 녹화(VP9 webm)는 "키프레임만 읽기"를 무시하고 모든 화면을 풉니다.
    # 다 쌓으면 1시간 강의에 메모리가 수십 GB 들고, 바로 다음 화면끼리 비교하게 되어 페이지도 틀립니다.
    make_video(tmp_path / "rec.webm", [30, 220], 60, codec="libvpx-vp9")
    compared, real = [], pages.find_pages
    monkeypatch.setattr(pages, "find_pages", lambda frames, times: compared.append(len(frames)) or real(frames, times))

    found = detect_pages(tmp_path / "rec.webm", tmp_path / "thumbs")

    assert [p["start"] for p in found] == [0, 60]
    assert compared[0] <= 30  # 120장 중 키프레임(5초마다)만


def test_page_times_are_relative_to_video_start(tmp_path):
    # 잘라 낸 녹화처럼 첫 화면 시각이 0이 아닌 파일. 플레이어와 대본은 0초부터 셉니다.
    make_video(tmp_path / "trimmed.mp4", [30, 220], 60, first_pts=600)

    assert [p["start"] for p in detect_pages(tmp_path / "trimmed.mp4", tmp_path / "thumbs")] == [0, 60]


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg 명령이 없음")
def test_rotated_phone_video_gets_upright_thumbnails(tmp_path):
    make_video(tmp_path / "land.mp4", [30], 10, marker=True)
    # 휴대폰처럼 화면은 그대로 두고 "90도 돌려서 보여 줘"라는 정보만 붙입니다.
    subprocess.run(["ffmpeg", "-loglevel", "error", "-display_rotation", "90", "-i", str(tmp_path / "land.mp4"),
                    "-c", "copy", str(tmp_path / "rotated.mp4")], check=True)

    detect_pages(tmp_path / "rotated.mp4", tmp_path / "thumbs")

    thumb = read_jpeg(tmp_path / "thumbs" / "0.jpg")
    height, width = thumb.shape
    assert height > width  # 세로로 섬
    corner = height // 3, width // 3
    assert thumb[-corner[0]:, :corner[1]].mean() > 150 and thumb[:corner[0], :corner[1]].mean() < 100  # 반시계 90도


def test_reanalysis_removes_old_thumbnails(tmp_path):
    (tmp_path / "thumbs").mkdir()
    (tmp_path / "thumbs" / "7.jpg").write_bytes(b"old")  # 지난번 분석의 8번째 페이지
    make_video(tmp_path / "lecture.mp4", [30, 220], 60)

    detect_pages(tmp_path / "lecture.mp4", tmp_path / "thumbs")

    assert sorted(p.name for p in (tmp_path / "thumbs").iterdir()) == ["0.jpg", "1.jpg"]
