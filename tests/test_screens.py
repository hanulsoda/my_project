from academy.screens import read_screens, screen_times
from tests.test_pages import make_video


def test_screen_times_reads_each_page_once_a_minute():
    assert screen_times(0, 150) == [20, 80, 140]
    assert screen_times(100, 110) == [109]  # 짧은 페이지도 한 번은 읽음


def test_read_screens_merges_lines_per_page_and_drops_short_fragments(tmp_path):
    make_video(tmp_path / "lecture.mp4", [30, 220], 60)
    seen = []

    def fake_ocr(image):
        seen.append(image.shape)
        if image.mean() < 128:
            return ["교재 12쪽 상징", "홈", "교재 12쪽 상징"]
        return ["원형적 상징: 해", "원형적 상징: 해"]

    texts = read_screens(tmp_path / "lecture.mp4", [{"start": 0.0}, {"start": 60.0}], 120.0, fake_ocr)

    assert texts == [["교재 12쪽 상징"], ["원형적 상징: 해"]]
    assert seen == [(36, 64, 3), (36, 64, 3)]  # 페이지마다 1분 간격 → 이 영상은 한 번씩


def test_read_screens_on_a_trimmed_recording_reads_each_page(tmp_path):
    # 잘라 낸 녹화는 첫 화면 시각이 0이 아닙니다. 페이지 시각은 영상 시작을 0초로 센 값입니다(pages.detect_pages).
    make_video(tmp_path / "trimmed.mp4", [30, 220], 60, first_pts=600)

    texts = read_screens(tmp_path / "trimmed.mp4", [{"start": 0.0}, {"start": 60.0}], 120.0,
                         lambda image: ["어두운 첫 페이지"] if image.mean() < 128 else ["밝은 둘째 페이지"])

    assert texts == [["어두운 첫 페이지"], ["밝은 둘째 페이지"]]


def test_a_still_screen_in_a_variable_frame_rate_recording_is_read_from_its_own_page(tmp_path):
    import av
    import numpy as np
    path = tmp_path / "vfr.mp4"
    with av.open(str(path), "w") as out:  # 화면이 그대로면 프레임을 적지 않는 녹화: 0~2초 어두운 쪽, 60초부터 밝은 쪽
        stream = out.add_stream("mpeg4", rate=1)
        stream.width, stream.height, stream.pix_fmt = 64, 36, "yuv420p"
        for pts in [0, 1, 2, *range(60, 120)]:
            frame = av.VideoFrame.from_ndarray(np.full((36, 64, 3), 30 if pts < 60 else 220, np.uint8), format="rgb24")
            frame.pts = pts
            out.mux(stream.encode(frame))
        out.mux(stream.encode())

    texts = read_screens(path, [{"start": 0.0}, {"start": 60.0}], 120.0,
                         lambda image: ["어두운 첫 페이지"] if image.mean() < 128 else ["밝은 둘째 페이지"])

    assert texts == [["어두운 첫 페이지"], ["밝은 둘째 페이지"]]


def test_a_phone_video_is_read_upright(tmp_path):
    import subprocess
    make_video(tmp_path / "land.mp4", [30], 30)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-display_rotation", "90", "-i", str(tmp_path / "land.mp4"),
                    "-c", "copy", str(tmp_path / "rotated.mp4")], check=True)
    shapes = []

    read_screens(tmp_path / "rotated.mp4", [{"start": 0.0}], 30.0, lambda image: shapes.append(image.shape) or [])

    assert shapes == [(64, 36, 3)]  # 세로로 세워서 글자를 읽음
