"""학생용 학습 플레이어 웹 서버.

실행: uvicorn academy.server:app --host 0.0.0.0 --port 8000
"""

import html
import logging
import os
import re
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Literal

import anthropic
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from academy.entry import MIN_SECRET_LEN, PASS_TTL, entry_link_ok, make_pass, pass_ok
from academy.library import find_videos, load_analysis

STATIC_DIR = Path(__file__).parent / "static"
PASS_COOKIE = "study_pass"
LOGIN_NOTICE = "학원 사이트에 로그인한 뒤 들어와 주세요"


def _denied_page(site_url: str) -> HTMLResponse:
    link = f'<p><a href="{html.escape(site_url)}">학원 사이트로 가기</a></p>' if site_url else ""
    return HTMLResponse(
        '<!doctype html><html lang="ko"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1"><title>학습 플레이어</title></head>'
        '<body style="font-family:sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;line-height:1.6">'
        f'<h1 style="font-size:20px">{LOGIN_NOTICE}</h1>'
        '<p>학습 플레이어는 학원 사이트의 "강의 보기"로만 들어올 수 있습니다. '
        '들어온 지 12시간이 지났다면 다시 들어와 주세요.</p>'
        f"{link}</body></html>",
        status_code=401)


def _vtt_time(seconds: float) -> str:
    ms = round(seconds * 1000)
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d}.{ms % 1000:03d}"


def subtitles_vtt(segments: list[dict]) -> str:
    # <, &, > 를 그대로 두면 자막 문법으로 읽혀 글자가 사라지거나 자막이 깨집니다. 줄바꿈도 한 줄로 이어
    # 붙입니다(빈 줄에서 자막이 끊김). 선생님이 대본을 고치다 끝 시각을 지웠으면 5초 동안 보여 줍니다.
    cues = [f"{_vtt_time(s['start'])} --> {_vtt_time(s.get('end', s['start'] + 5))}\n"
            f"{html.escape(' '.join(s['text'].split()), quote=False)}\n"
            for s in segments]
    return "\n".join(["WEBVTT\n", *cues])


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=10000)


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    history: list[Turn] = Field(default=[], max_length=20)
    current_time: float | None = None


def create_app(video_dir: Path, data_dir: Path, answer,
               entry_secret: str = "", site_url: str = "") -> FastAPI:
    app = FastAPI(title="학원 학습 플레이어")

    if entry_secret:
        # 학원 사이트의 입장 링크로 받은 통과 쿠키가 있어야 화면·영상·질문을 쓸 수 있습니다.
        @app.middleware("http")
        async def require_pass(request: Request, call_next):
            path = request.url.path
            if path == "/enter" or pass_ok(entry_secret, request.cookies.get(PASS_COOKIE), time.time()):
                return await call_next(request)
            if path.startswith(("/api/", "/media/")):
                return JSONResponse({"detail": LOGIN_NOTICE}, status_code=401)
            return _denied_page(site_url)

    @app.get("/enter")
    def enter(request: Request, exp: str | None = None, sig: str | None = None):
        if not entry_secret:
            return RedirectResponse("/", 303)
        if not entry_link_ok(entry_secret, exp, sig, time.time()):
            return _denied_page(site_url)
        res = RedirectResponse("/", 303)
        res.set_cookie(PASS_COOKIE, make_pass(entry_secret, time.time()), max_age=PASS_TTL,
                       httponly=True, samesite="lax", secure=request.url.scheme == "https")
        return res

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

    @app.get("/api/search")
    def search(q: str = Query(min_length=1, max_length=100)):
        """모든 강의의 대본과 요점에서 검색어가 나오는 장면. 강의마다 앞에서부터 5곳과 전체 개수."""
        needle = q.strip().lower()
        if not needle:
            raise HTTPException(422, "검색어를 입력해 주세요")
        results = []
        for video in find_videos(video_dir):
            try:
                data = load_analysis(data_dir, video["id"])
            except ValueError:  # 손으로 고치다 깨진 분석 파일 하나 때문에 검색 전체가 멈추지 않게
                continue
            if not data:
                continue
            hits = [{"start": s["start"], "text": s["text"]}
                    for s in data["segments"] if needle in s["text"].lower()]
            for c in (data.get("guide") or {}).get("chapters", []):
                hits += [{"start": c["start"], "text": text}
                         for text in [c["title"], *c["points"]] if needle in text.lower()]
            if hits:
                hits.sort(key=lambda h: h["start"])
                results.append({"id": video["id"], "title": video["title"], "total": len(hits), "hits": hits[:5]})
        return results

    @app.get("/api/videos/{video_id}/subtitles.vtt")
    def subtitles(video_id: str):
        get_video(video_id)
        data = load_analysis(data_dir, video_id)
        if not data:
            raise HTTPException(404, "아직 분석되지 않은 영상입니다")
        return Response(subtitles_vtt(data["segments"]), media_type="text/vtt")

    @app.get("/media/{video_id}")
    def media(video_id: str):
        return FileResponse(get_video(video_id)["path"])

    @app.get("/frames/{video_id}/{name}")
    def board_photo(video_id: str, name: str):
        get_video(video_id)
        path = Path(data_dir) / "frames" / video_id / name
        if not re.fullmatch(r"\d+\.jpg", name) or not path.is_file():
            raise HTTPException(404, "사진을 찾을 수 없습니다")
        return FileResponse(path, media_type="image/jpeg")

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


def entry_settings(env: Mapping[str, str]) -> tuple[str, str]:
    """(입장 링크 비밀 키, 학원 사이트 주소). 복사하다 붙은 앞뒤 공백은 지웁니다."""
    secret = env.get("ENTRY_SECRET", "").strip()
    # "1"뿐 아니라 "true"·"yes"도 켜진 것으로 봅니다. 꺼진 것으로 잘못 읽으면 인터넷에 그대로 열리기 때문입니다.
    if env.get("REQUIRE_ENTRY", "").strip() not in ("", "0") and len(secret) < MIN_SECRET_LEN:
        raise SystemExit(f"ENTRY_SECRET(입장 링크 비밀 키)가 없거나 {MIN_SECRET_LEN}자보다 짧아서 서버를 시작하지 않습니다. "
                         "docker-compose.yml에 학원 사이트와 같은 비밀 키를 넣어 주세요.")
    return secret, env.get("SITE_URL", "").strip()


app = create_app(Path(os.environ.get("VIDEO_DIR", "videos")),
                 Path(os.environ.get("DATA_DIR", "data")),
                 _claude_answer(),
                 *entry_settings(os.environ))
