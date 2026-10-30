"""화면 테스트: 테스트용 강의 폴더와 서버를 만들고, 실제 브라우저(Chromium)로 화면을 눌러 봅니다.

영상은 테스트할 때 ffmpeg로 만든 150초짜리 회색 화면입니다(저장소에 영상·강의 내용을 넣지 않음).
playwright가 없으면 이 폴더의 테스트는 건너뜁니다. 설치: README의 '테스트' 참고.
"""

import json
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from academy.library import find_videos

CHAPTERS = [{"start": 0.0, "title": "도입", "points": ["작품 소개"]},
            {"start": 50.0, "title": "본문 풀이", "points": ["누이의 죽음"]},
            {"start": 100.0, "title": "정리", "points": ["주제 정리"]}]
QUIZ = [{"question": "제망매가의 갈래는?", "choices": ["향가", "가사", "시조", "민요"], "answer": 0,
         "explanation": "향가입니다.", "time": 10.0},
        {"question": "누이의 죽음을 극복한 방법은?", "choices": ["망각", "종교", "복수", "여행"], "answer": 1,
         "explanation": "종교적으로 극복합니다.", "time": 60.0}]


def said(word=""):
    """10초마다 한 줄씩 받아 적은 대본. word는 30초마다 말한 낱말."""
    return [{"start": float(t), "end": t + 9.0, "text": f"{t // 10}번째 설명 {word if t % 30 == 0 else ''}".strip()}
            for t in range(0, 150, 10)]


# 학원 정리: 30초 대본에 항목 글이 그대로 나와 여러 항목이 00:30에 붙습니다.
REFS = [{"title": "제망매가", "grade": "고1", "meta": {"갈래": "향가", "주제": "누이의 죽음"},
         "features": [{"text": "이 작품의 갈래는 향가입니다"}, {"text": "누이의 죽음을 종교적으로 극복합니다"},
                      {"text": "시간을 못 찾는 항목"}],
         "words": [{"w": "울안", "pos": "명사", "def": "울타리를 둘러친 안"}, {"w": "낱말둘", "pos": "명사", "def": "뜻둘"},
                   {"w": "낱말셋", "pos": "명사", "def": "뜻셋"}, {"w": "낱말넷", "pos": "명사", "def": "뜻넷"}]}]
SAID_REF = [{"start": 30.0, "end": 35.0, "text": "이 작품의 갈래는 향가입니다 누이의 죽음을 종교적으로 극복합니다"}] + said()
# 선생님 화면 테스트용: 어느 강의에도 붙지 않는 정리(학생 화면 테스트에 영향 없음). 첫 항목은 너무 길어 '의심'.
TEACHER_REF = {"title": "성난 풀잎", "grade": "고2",
               "features": [{"text": "긴 항목 " + "가" * 260}, {"text": "둘째 특징"}, {"text": "셋째 특징"}]}
REFS.append(TEACHER_REF)
TEACHER_KEY = "e2e-teacher-key"

LECTURES = {  # 영상 경로 → 분석 파일 내용(None이면 분석 전)
    "2022개정/고1/미래엔/제망매가.webm": {"duration": 150.0, "segments": said("반어법"),
                                    "guide": {"summary": "요약", "chapters": CHAPTERS, "quiz": QUIZ}},
    "2022개정/고1/미래엔/제망매가 학습활동.webm": {"duration": 150.0, "segments": SAID_REF, "guide": None},
    "2022개정/고1/미래엔/청산별곡.webm": {"duration": 150.0, "segments": said("반어법"), "guide": None},
    "2022개정/고1/천재/성에꽃.webm": {"duration": 150.0, "segments": said(), "guide": None},
    "100%완성/작품.webm": None,
    "시험/퀴즈 없는 요점 정리.webm": {"duration": 150.0, "segments": said(),
                               "guide": {"summary": "손으로 고친 파일", "chapters": CHAPTERS}},
    "시험/길이 없는 분석.webm": {"segments": said(), "guide": None,
                           "toc": {"model": "m", "chapters": [{"start": c["start"], "title": c["title"]} for c in CHAPTERS]}},
}


@pytest.fixture(scope="session")
def site(tmp_path_factory):
    """테스트용 강의 폴더로 서버를 띄웁니다. site.url, site.ids[제목] → 영상 번호"""
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg가 없어 화면 테스트를 건너뜀")
    import uvicorn

    from academy.references import load_references
    from academy.server import create_app

    root = tmp_path_factory.mktemp("site")
    videos, data = root / "videos", root / "data"
    data.mkdir()
    clip = root / "clip.webm"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=64x36:r=5:d=150",
                    "-c:v", "libvpx-vp9", "-b:v", "20k", "-g", "25", str(clip)], check=True)
    for rel in LECTURES:
        (videos / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(clip, videos / rel)
    ids = {}
    for v in find_videos(videos):
        ids[v["title"]] = v["id"]
        analysis = LECTURES[v["path"].relative_to(videos).as_posix()]
        if analysis is not None:
            (data / f"{v['id']}.json").write_text(json.dumps({"title": v["title"], **analysis}, ensure_ascii=False),
                                                 encoding="utf-8")
    (root / "refs.json").write_text(json.dumps(REFS, ensure_ascii=False), encoding="utf-8")

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    app = create_app(videos, data, None, load_references(root / "refs.json"), log_dir=root / "logs", teacher_key=TEACHER_KEY)
    (root / "logs").mkdir()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started:
        time.sleep(0.05)
    yield SimpleNamespace(url=f"http://127.0.0.1:{port}", ids=ids)
    server.should_exit = True
    thread.join(timeout=10)


@pytest.fixture(scope="session")
def browser():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        # 영상 재생을 스크립트로 시작할 수 있게(학생이 누른 것처럼) 자동 재생을 허용합니다.
        b = p.chromium.launch(args=["--no-proxy-server", "--autoplay-policy=no-user-gesture-required"])
        yield b
        b.close()


@pytest.fixture
def page(browser, site):
    """테스트마다 새 브라우저(기록이 빈 학생). 화면에서 오류가 나면 실패로 칩니다."""
    context = browser.new_context(timezone_id="Asia/Seoul", viewport={"width": 1200, "height": 900})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    yield page
    context.close()
    assert not errors, f"화면 오류: {errors}"


def remember(page, site, records):
    """이 브라우저에 학생 기록(localStorage)을 넣어 둡니다."""
    page.goto(f"{site.url}/manifest.json")
    page.evaluate("records => { for (const [k, v] of Object.entries(records)) localStorage.setItem(k, JSON.stringify(v)); }",
                  records)


def stored(page, key):
    return page.evaluate("key => JSON.parse(localStorage.getItem(key))", key)
