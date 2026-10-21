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
