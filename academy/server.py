"""학생용 학습 플레이어 웹 서버.

실행: uvicorn academy.server:app --host 0.0.0.0 --port 8000
"""

import logging
import os
from contextlib import asynccontextmanager
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


def create_app(video_dir: Path, data_dir: Path, answer, references=()) -> FastAPI:
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

    status_cache = {}  # 영상 id → (파일 수정 시각·크기, 요점 정리 유무). 목록을 열 때마다 큰 JSON을 다시 읽지 않습니다.

    def analysis_status(video_id):
        path = Path(data_dir) / f"{video_id}.json"
        if not path.exists():
            return {"analyzed": False, "guide": False}
        stamp = (path.stat().st_mtime_ns, path.stat().st_size)
        if status_cache.get(video_id, (None,))[0] != stamp:
            status_cache[video_id] = (stamp, bool(load_analysis(data_dir, video_id).get("guide")))
        return {"analyzed": True, "guide": status_cache[video_id][1]}

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

    @app.get("/api/videos/{video_id}")
    def video_detail(video_id: str):
        video = get_video(video_id)
        analysis = load_analysis(data_dir, video_id)
        if analysis:
            # 받아쓰기 대본과 화면 글자 원문은 틀린 곳이 많아 학생에게 보내지 않고, 질문하기·요점 정리에만 씁니다.
            analysis.pop("segments", None)
            analysis["pages"] = [{k: v for k, v in p.items() if k != "text"} for p in analysis.get("pages", [])]
            if analysis.get("guide"):
                analysis["guide"].pop("edits", None)  # 학원 정리에서 고친 내역은 선생님 확인용
        # Claude 요점 정리는 학원 정리를 바탕으로 만들었으니, 없을 때만 학원 정리를 그대로 보냅니다.
        summaries = academy_summaries(video) if analysis and not analysis.get("guide") else []
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
                 load_references(os.environ.get("REFERENCES_FILE")))
