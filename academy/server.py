"""학생용 학습 플레이어 웹 서버.

실행: uvicorn academy.server:app --host 0.0.0.0 --port 8000
"""

import logging
import os
from pathlib import Path
from typing import Literal

import anthropic
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from academy.library import find_videos, load_analysis

STATIC_DIR = Path(__file__).parent / "static"


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=10000)


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    history: list[Turn] = Field(default=[], max_length=20)
    current_time: float | None = None


def create_app(video_dir: Path, data_dir: Path, answer) -> FastAPI:
    app = FastAPI(title="학원 학습 플레이어")

    def get_video(video_id):
        for video in find_videos(video_dir):
            if video["id"] == video_id:
                return video
        raise HTTPException(404, "영상을 찾을 수 없습니다")

    @app.get("/api/videos")
    def list_videos():
        return [{"id": v["id"], "title": v["title"],
                 "analyzed": (Path(data_dir) / f"{v['id']}.json").exists()}
                for v in find_videos(video_dir)]

    @app.get("/api/videos/{video_id}")
    def video_detail(video_id: str):
        video = get_video(video_id)
        return {"id": video_id, "title": video["title"],
                "analysis": load_analysis(data_dir, video_id)}

    @app.get("/media/{video_id}")
    def media(video_id: str):
        return FileResponse(get_video(video_id)["path"])

    @app.post("/api/videos/{video_id}/ask")
    def ask(video_id: str, req: AskRequest):
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

    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True))
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
                 _claude_answer())
