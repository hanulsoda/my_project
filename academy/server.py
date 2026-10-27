"""학생용 학습 플레이어 웹 서버.

실행: uvicorn academy.server:app --host 0.0.0.0 --port 8000
"""

import logging
import os
import re
from bisect import bisect_right
from collections import Counter
from contextlib import asynccontextmanager
from itertools import accumulate
from pathlib import Path
from threading import Lock, Thread
from time import monotonic
from typing import Literal

import anthropic
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from academy.library import find_videos, load_analysis
from academy.references import find_references, load_references
from academy.timelink import link_times

STATIC_DIR = Path(__file__).parent / "static"
# NAS 영상 폴더를 한 번 훑는 데 18초쯤 걸려서 목록을 기억해 둡니다.
REFRESH_SECONDS = 300  # 이보다 오래된 목록은 뒤에서 다시 훑습니다
MISS_SECONDS = 30  # 모르는 id가 와도 이 안에 훑었으면 다시 훑지 않습니다


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=10000)


class RevalidatedStaticFiles(StaticFiles):
    """화면 파일을 고쳐 배포하면 학생 브라우저가 예전 파일을 쓰지 않도록, 받을 때마다 바뀌었는지 확인하게 합니다."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    history: list[Turn] = Field(default=[], max_length=20)
    current_time: float | None = None


def create_app(video_dir: Path, data_dir: Path, answer, references=(), log_dir=None) -> FastAPI:
    """log_dir를 주면 현황(/api/status)에 백업·밤 작업·새 강의 분석 로그의 마지막 줄을 함께 보여 줍니다."""
    @asynccontextmanager
    async def lifespan(app):
        # NAS를 훑고 분석 상태를 읽고 학원 정리를 짝짓는 데 30초쯤 걸려, 첫 학생이 기다리지 않게 켜자마자 해 둡니다.
        Thread(target=list_videos, daemon=True).start()
        yield

    app = FastAPI(title="학원 학습 플레이어", lifespan=lifespan)

    library = {"at": None, "videos": [], "by_id": {}}
    scan_lock = Lock()

    def scan(max_age):
        with scan_lock:  # 한 번에 하나만 훑고, 기다리는 사이 다른 요청이 훑었으면 그 결과를 씁니다.
            if library["at"] is None or monotonic() - library["at"] > max_age:
                videos = find_videos(video_dir)
                library.update(at=monotonic(), videos=videos, by_id={v["id"]: v for v in videos})

    def current_library():
        if library["at"] is None:
            scan(REFRESH_SECONDS)
        elif monotonic() - library["at"] > REFRESH_SECONDS and not scan_lock.locked():
            Thread(target=scan, args=(REFRESH_SECONDS,), daemon=True).start()  # 그동안은 이전 목록으로 답합니다
        return library

    def get_video(video_id):
        video = current_library()["by_id"].get(video_id)
        if video is None:  # 새로 올라온 영상일 수 있습니다
            scan(MISS_SECONDS)
            video = library["by_id"].get(video_id)
        if video is None:
            raise HTTPException(404, "영상을 찾을 수 없습니다")
        return video

    # 영상 id → (파일 수정 시각·크기, 상태). 목록을 열 때마다 큰 JSON을 다시 읽지 않습니다.
    # 상태에는 내용 검색용으로 띄어쓰기·기호를 뺀 대본과, 각 말이 그 글에서 시작하는 자리·시각도 둡니다.
    status_cache = {}

    def analysis_entry(video_id):
        path = Path(data_dir) / f"{video_id}.json"
        if not path.exists():
            return None
        stamp = (path.stat().st_mtime_ns, path.stat().st_size)
        if status_cache.get(video_id, (None,))[0] != stamp:
            data = load_analysis(data_dir, video_id)
            spoken = [(_norm(s["text"]), s["start"]) for s in data.get("segments") or []]
            chapters = ((data.get("guide") or {}).get("chapters") or (data.get("toc") or {}).get("chapters") or [])
            status_cache[video_id] = (stamp, {
                "guide": bool(data.get("guide")), "toc": bool((data.get("toc") or {}).get("chapters")),
                "toc_tried": "toc" in data, "duration": data.get("duration") or 0,
                "chapters": sorted((c["start"], c["title"]) for c in chapters),
                "text": "".join(t for t, _ in spoken), "offsets": list(accumulate((len(t) for t, _ in spoken), initial=0))[:-1],
                "times": [start for _, start in spoken]})
        return status_cache[video_id][1]

    def analysis_status(video_id):
        entry = analysis_entry(video_id)
        return {"analyzed": bool(entry), "guide": bool(entry and entry["guide"]), "toc": bool(entry and entry["toc"])}

    matched = {}  # 영상 id → 파일 이름으로 짝지어지는 학원 요점 정리. 처음 찾을 때 전체 목록에 몇 초 걸려 기억해 둡니다.

    def academy_summaries(video):
        if video["id"] not in matched:
            # 빈칸 문제는 퀴즈 탭에서 풀도록 요점 정리에서는 뺍니다.
            matched[video["id"]] = [{"source": r["source"], "quiz": r["quiz"],
                                     "sections": [s for s in r["sections"] if s["name"] != "빈칸 문제"]}
                                    for r in find_references(video["title"], [], references)]
        return matched[video["id"]]

    @app.get("/api/videos")
    def list_videos():
        listed = []
        for v in current_library()["videos"]:
            status = analysis_status(v["id"])
            # Claude 요점 정리가 없어도 학원 요점 정리를 보여 줄 수 있으면 요점 정리가 있는 강의입니다.
            status["guide"] = status["guide"] or (status["analyzed"] and bool(academy_summaries(v)))
            listed.append({"id": v["id"], "title": v["title"], **status})
        return listed

    @app.get("/api/search")
    def search(q: str = ""):
        """낱말을 말한 강의를 많이 말한 순서로. 대본 글은 학생에게 보내지 않고 시각만 보냅니다.

        exact: 그대로 말한 강의, similar: 그대로는 없고 받아쓰기가 한 소리 다르게 적은 말만 있는 강의(적힌 말과 함께)
        """
        word = _norm(q)
        if len(word) < 2:
            raise HTTPException(400, "두 글자 이상 넣어 주세요")
        near = _near(word)
        exact, similar, notes = [], [], []
        for v in current_library()["videos"]:
            entry = analysis_entry(v["id"])
            if not entry:
                continue
            at = [m.start() for m in re.finditer(re.escape(word), entry["text"])]
            if at:
                exact.append(found_at(v, entry, at))
            elif near and (matches := list(near.finditer(entry["text"]))):
                result, recording = found_at(v, entry, [m.start() for m in matches])
                result["heard_as"] = [w for w, _ in Counter(m.group() for m in matches).most_common(2)]
                similar.append((result, recording))
            elif lines := noted(v, entry, word):
                notes.append(({"id": v["id"], "title": v["title"], "matches": lines[:3], "also": []},
                              (round(entry["duration"]), entry["text"][:150])))
        return {"exact": merge_copies(exact), "similar": merge_copies(similar), "notes": merge_copies(notes)}

    def noted(v, entry, word):
        """말하지는 않았어도 목차·챕터 제목이나 학원 정리 항목에 낱말이 든 줄 [{"text", "time"}]"""
        lines = [(title, start) for start, title in entry["chapters"]]
        if not entry["guide"]:  # Claude 요점 정리는 학원 정리를 바탕으로 만들었으니 챕터만 봅니다
            lines += [(item, None) for r in academy_summaries(v) for s in r["sections"] for item in s["items"]]
        return [{"text": text, "time": t} for text, t in lines if word in _norm(text)]

    def found_at(v, entry, positions):
        spots = [entry["times"][bisect_right(entry["offsets"], at) - 1] for at in positions]
        times = []
        for t in spots:
            if not times or t - times[-1] >= 60:  # 1분 안에 다시 말한 것은 한 번으로 봅니다
                times.append(t)
        starts = [start for start, _ in entry["chapters"]]
        chapters = [entry["chapters"][i - 1][1] if (i := bisect_right(starts, t)) else None for t in times[:5]]
        # 같은 녹화를 여러 폴더에 넣어 둔 경우: 길이와 대본 앞부분이 같으면 같은 녹화로 봅니다.
        return ({"id": v["id"], "title": v["title"], "count": len(spots), "times": times[:5], "chapters": chapters, "also": []},
                (round(entry["duration"]), entry["text"][:150]))

    def merge_copies(found):
        merged, first = [], {}
        for result, recording in sorted(found, key=lambda f: -f[0].get("count", 0)):  # notes는 횟수가 없어 강의 순서대로
            if recording in first:
                first[recording]["also"].append(result["title"])
            else:
                first[recording] = result
                merged.append(result)
        return merged[:300]  # 화면은 30개씩 '더 보기'

    @app.get("/api/status")
    def status():
        """선생님용 현황: 강의마다 학생이 받는 것(Claude 요점 정리 > 학원 정리 > 자동 목차 > 페이지만)과 자동 목차 진행률"""
        counts = {"guide": 0, "summary": 0, "toc": 0, "pages": 0}
        target = done = 0
        unanalyzed = []
        videos = current_library()["videos"]
        for v in videos:
            entry = analysis_entry(v["id"])
            if not entry:
                unanalyzed.append(v["title"])
                continue
            summary = not entry["guide"] and bool(academy_summaries(v))
            counts["guide" if entry["guide"] else "summary" if summary else "toc" if entry["toc"] else "pages"] += 1
            # 밤 작업(academy.toc)과 같은 대상: 대본이 있고 Claude 요점 정리가 없는 강의
            if not entry["guide"] and entry["times"]:
                target += 1
                done += entry["toc_tried"]
        found = {"total": len(videos), "analyzed": len(videos) - len(unanalyzed), **counts,
                 "toc_progress": {"target": target, "done": done}, "unanalyzed": unanalyzed}
        if log_dir:
            # 밤 작업 로그에는 강의마다 '목차:' 줄이 쌓여서 날짜로 시작하는 상태 줄만 봅니다.
            found["ops"] = {"backup": _last_line(Path(log_dir) / "backup.log", dated=True),
                            "night": _last_line(Path(log_dir) / "toc.log", dated=True),
                            "new_videos": _last_line(Path(log_dir) / "new-videos.log")}
        return found

    @app.get("/api/videos/{video_id}")
    def video_detail(video_id: str):
        video = get_video(video_id)
        analysis = load_analysis(data_dir, video_id)
        # Claude 요점 정리는 학원 정리를 바탕으로 만들었으니, 없을 때만 학원 정리를 대본에서 찾은 시간과 함께 보냅니다.
        summaries = (link_times(academy_summaries(video), analysis.get("segments") or [])
                     if analysis and not analysis.get("guide") else [])
        if analysis:
            # 받아쓰기 대본과 화면 글자 원문은 틀린 곳이 많아 학생에게 보내지 않고, 질문하기·요점 정리에만 씁니다.
            analysis.pop("segments", None)
            analysis["pages"] = [{k: v for k, v in p.items() if k != "text"} for p in analysis.get("pages", [])]
            if analysis.get("guide"):
                analysis["guide"].pop("edits", None)  # 학원 정리에서 고친 내역은 선생님 확인용
        return {"id": video_id, "title": video["title"], "analysis": analysis, "references": summaries}

    @app.get("/api/videos/{video_id}/pages/{n}.jpg")
    def page_thumbnail(video_id: str, n: int):
        get_video(video_id)
        path = Path(data_dir) / video_id / f"{n}.jpg"
        if not path.exists():
            raise HTTPException(404, "페이지 그림이 없습니다")
        return FileResponse(path, media_type="image/jpeg")

    @app.get("/media/{video_id}")
    def media(video_id: str):
        return FileResponse(get_video(video_id)["path"])

    @app.post("/api/videos/{video_id}/ask")
    def ask(video_id: str, req: AskRequest):
        if answer is None:
            raise HTTPException(403, "질문하기는 지금 쓰지 않습니다")
        get_video(video_id)
        data = load_analysis(data_dir, video_id)
        if not data or not data["segments"]:
            raise HTTPException(409, "아직 분석되지 않은 영상이라 질문할 수 없습니다")
        try:
            text = answer(data["title"], data["segments"], req.question,
                          [t.model_dump() for t in req.history], req.current_time)
        except Exception as e:  # API 키 누락, 네트워크 오류, 응답 거절 등
            logging.exception("AI 답변 실패")
            raise HTTPException(502, f"AI 답변을 받지 못했습니다: {e}")
        return {"answer": text}

    app.mount("/", RevalidatedStaticFiles(directory=STATIC_DIR, html=True))
    return app


def _last_line(path, dated=False):
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    lines = [line for line in lines if line.strip() and (not dated or re.match(r"\d{4}-\d\d-\d\d ", line))]
    return lines[-1] if lines else None


def _norm(text):
    return re.sub(r"[^가-힣a-z0-9]", "", text.lower())


def _near(word):
    """받아쓰기가 한 음절의 자음이나 모음 하나만 다르게 적은 말('제망매가'→'제막매가')을 찾는 정규식. 세 글자 이상만."""
    branches = []
    for i, ch in enumerate(word):
        code = ord(ch) - 0xAC00
        if len(word) < 3 or not 0 <= code < 11172:
            continue
        first, middle, last = code // 588, code // 28 % 21, code % 28
        near = [(x, middle, last) for x in range(19) if x != first] + [(first, x, last) for x in range(21) if x != middle]
        if i < len(word) - 1:  # 마지막 음절의 받침만 다른 말은 조사가 붙은 다른 말일 때가 많습니다('군주로서')
            near += [(first, middle, x) for x in range(28) if x != last]
        syllables = "".join(chr(0xAC00 + a * 588 + b * 28 + c) for a, b, c in near)
        branches.append(f"{re.escape(word[:i])}[{syllables}]{re.escape(word[i + 1:])}")
    return re.compile("|".join(branches)) if branches else None


def _claude_answer():
    from academy.ai import answer_question

    client = None

    def answer(*args):
        nonlocal client
        if client is None:  # API 키 없이도 영상 시청은 되도록, 첫 질문 때 연결합니다.
            client = anthropic.Anthropic()
        return answer_question(client, *args)

    return answer


app = create_app(Path(os.environ.get("VIDEO_DIR", "videos")),
                 Path(os.environ.get("DATA_DIR", "data")),
                 None,  # 질문하기는 Claude API 크레딧을 써서 막아 둡니다. 다시 열려면 _claude_answer()를 넘깁니다.
                 load_references(os.environ.get("REFERENCES_FILE")),
                 os.environ.get("LOG_DIR"))
