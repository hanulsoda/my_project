"""서버 설정 점검: python -m academy.check

서버·밤 작업이 읽는 설정(환경 변수)과 폴더를 한 번에 살펴, 고칠 것을 한국어로 알려 줍니다. 아무것도 바꾸지 않습니다.
모양이 이상해 빠진 학원 정리, 형식이 깨진 분석 파일처럼 서버 기록에만 남던 것도 여기서 보입니다.
서버를 켜는 명령과 같은 환경 변수로 실행하세요(예: ENTRY_SECRET=... python -m academy.check).
"""

import json
import logging
import os
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path

from academy.library import find_videos, load_analysis
from academy.references import usable_references
from academy.settings import entry_settings, teacher_key

PROBLEM, OK, NOTE = "문제", "확인", "참고"
MARKS = {PROBLEM: "✘", OK: "✔", NOTE: "·"}


def checks(env) -> list[tuple[str, str]]:
    """[(문제|확인|참고, 글)]"""
    found = []
    say = lambda level, text: found.append((level, text))

    video_dir = Path(env.get("VIDEO_DIR", "videos"))
    videos = find_videos(video_dir) if video_dir.is_dir() else []
    if not video_dir.is_dir():
        say(PROBLEM, f"영상 폴더가 없습니다: {video_dir.resolve()} (VIDEO_DIR, NAS 연결 확인)")
    elif not videos:
        say(PROBLEM, f"영상 폴더에 강의가 없습니다: {video_dir.resolve()} (NAS 연결 확인)")
    else:
        say(OK, f"영상 폴더: {video_dir.resolve()} (강의 {len(videos):,}개)")

    data_dir = Path(env.get("DATA_DIR", "data"))
    if not data_dir.is_dir():
        say(NOTE, f"분석 폴더가 아직 없습니다: {data_dir.resolve()} (처음 분석할 때 생깁니다)")
    else:
        try:
            tempfile.NamedTemporaryFile(dir=data_dir).close()
        except OSError as e:
            say(PROBLEM, f"분석 폴더에 쓸 수 없습니다: {data_dir.resolve()} ({e.strerror}). 서버·분석이 결과를 저장하지 못합니다")
        known = {v["id"] for v in videos}
        analyzed, broken, orphans = 0, [], 0
        for path in sorted(data_dir.glob("*.json")):
            try:
                ok = isinstance(load_analysis(data_dir, path.stem), dict)
            except (OSError, ValueError):
                ok = False
            if not ok:
                broken.append(path.name)
            elif path.stem in known:
                analyzed += 1
            else:
                orphans += 1
        say(OK, f"분석 폴더: {data_dir.resolve()} (분석 {analyzed:,}개, 분석 전 {len(videos) - analyzed:,}개)")
        if broken:
            say(PROBLEM, f"형식이 깨진 분석 파일 {len(broken)}개(손으로 고친 곳의 쉼표·따옴표 확인): {', '.join(broken[:5])}"
                         + (" 등" if len(broken) > 5 else ""))
        if orphans:
            say(NOTE, f"지금 영상 폴더에 없는 강의의 분석 {orphans:,}개(옮기거나 이름을 바꾼 강의는 다음 분석 때 이어 씁니다)")
        free = shutil.disk_usage(data_dir).free
        if free < 5e9:
            say(PROBLEM, f"분석 폴더 디스크가 {free / 1e9:.1f}GB밖에 남지 않았습니다")

    refs_file = env.get("REFERENCES_FILE")
    if not refs_file:
        say(NOTE, "학원 정리(REFERENCES_FILE)를 설정하지 않았습니다. 학원 정리 없이 씁니다")
    else:
        try:
            refs = json.loads(Path(refs_file).expanduser().read_text(encoding="utf-8"))
            if not isinstance(refs, list):
                raise ValueError("정리 목록([...])이 아닙니다")
        except (OSError, ValueError) as e:
            say(PROBLEM, f"학원 정리 파일을 읽지 못했습니다: {refs_file} ({e}). 서버가 켜지지 않습니다")
        else:
            usable = []
            skipped = _warnings(lambda: usable.extend(usable_references(refs)))
            say(OK, f"학원 정리: 학원 정리 {len(usable):,}개" + ("(제목만 남은 것 등은 빼고 셈)" if len(usable) < len(refs) else ""))
            if skipped:
                say(PROBLEM, f"학원 정리 {len(skipped)}개를 건너뜀: " + " / ".join(skipped[:3]) + (" …" if len(skipped) > 3 else ""))

    key_file = env.get("TEACHER_KEY_FILE")
    if not key_file:
        say(NOTE, "선생님 열쇠(TEACHER_KEY_FILE)가 없어 아무도 '이번 주 강의'·학원 정리를 바꿀 수 없습니다")
    elif not Path(key_file).expanduser().is_file():
        say(PROBLEM, f"선생님 열쇠 파일이 없습니다: {key_file}")
    else:
        try:
            key = teacher_key(key_file)
            say(OK, f"선생님 열쇠: {len(key)}자") if key else say(PROBLEM, f"선생님 열쇠 파일이 비어 있습니다: {key_file}")
        except SystemExit as e:
            say(PROBLEM, f"{e} — 서버가 켜지지 않습니다")

    try:
        secret, site = entry_settings(env)
        if secret:
            say(OK, "인터넷 입장 확인이 켜져 있습니다(학원 사이트의 '강의 보기'로만 들어옴)")
            if not site:
                say(NOTE, "SITE_URL이 없어 막힘 화면에 '학원 사이트로 가기' 링크가 나오지 않습니다")
        else:
            say(NOTE, "학원 내부망 전용입니다(인터넷 요청은 막음). 인터넷으로 열려면 docs/인터넷-열기.md")
    except SystemExit as e:
        say(PROBLEM, f"{e}")

    log_dir = env.get("LOG_DIR")
    if not log_dir:
        say(NOTE, "로그 폴더(LOG_DIR)가 없어 현황 화면에 이용 통계·운영 기록이 나오지 않습니다")
    elif not Path(log_dir).is_dir():
        say(NOTE, f"로그 폴더가 아직 없습니다: {log_dir} (서버를 켜면 만듭니다)")
    else:
        say(OK, f"로그 폴더: {Path(log_dir).resolve()}")

    try:  # 자동 목차(밤 작업)는 쓰는 학원만: 응답이 없어도 참고로만
        urllib.request.urlopen(env.get("OLLAMA_URL", "http://localhost:11434") + "/api/tags", timeout=2).close()
        say(OK, "로컬 AI(ollama)가 응답합니다(자동 목차)")
    except OSError:
        say(NOTE, "로컬 AI(ollama)가 응답하지 않습니다. 밤 자동 목차를 쓴다면 켜 두세요")
    return found


def _warnings(run):
    """run()이 남긴 경고 글 목록(학원 정리를 건너뛴 까닭)."""
    caught = []
    handler = logging.Handler()
    handler.emit = lambda record: caught.append(record.getMessage())
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        run()
    finally:
        root.removeHandler(handler)
    return caught


def main(env=None) -> int:
    found = checks(os.environ if env is None else env)
    print("학습 플레이어 설정 점검")
    for level, text in found:
        print(f"{MARKS[level]} {text}")
    problems = sum(level == PROBLEM for level, _ in found)
    print(f"\n문제 {problems}개. ✘ 줄을 고친 뒤 다시 점검하세요." if problems else "\n문제 없음.")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
