import av
import numpy as np

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


def make_video(path, levels, seconds_each):
    with av.open(str(path), "w") as out:
        stream = out.add_stream("mpeg4", rate=1)
        stream.width, stream.height, stream.pix_fmt = 64, 36, "yuv420p"
        stream.codec_context.gop_size = 5  # 실제 화면 녹화처럼 5초마다 키프레임
        for level in levels:
            for _ in range(seconds_each):
                frame = av.VideoFrame.from_ndarray(np.full((36, 64, 3), level, np.uint8), format="rgb24")
                out.mux(stream.encode(frame))
        out.mux(stream.encode())


def test_detect_pages_finds_page_starts_and_saves_thumbnails(tmp_path):
    make_video(tmp_path / "lecture.mp4", [30, 220], 60)

    pages = detect_pages(tmp_path / "lecture.mp4", tmp_path / "thumbs")

    assert [p["start"] for p in pages] == [0, 60]
    for n in range(2):
        assert (tmp_path / "thumbs" / f"{n}.jpg").read_bytes()[:2] == b"\xff\xd8"  # JPEG
