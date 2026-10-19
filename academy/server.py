"""학생용 학습 플레이어 웹 서버.

실행: uvicorn academy.server:app --host 0.0.0.0 --port 8000
"""

import functools
import hashlib
import html
import json
import logging
import os
import re
import threading
import time
import unicodedata
from collections import deque
from collections.abc import Mapping
from pathlib import Path
from typing import Literal

import anthropic
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

from academy.entry import MIN_SECRET_LEN, PASS_TTL, entry_link_ok, make_pass, pass_ok
from academy.library import find_videos, load_analysis

STATIC_DIR = Path(__file__).parent / "static"
PASS_COOKIE = "study_pass"
LOGIN_NOTICE = "학원 사이트에 로그인한 뒤 들어와 주세요"
VIDEO_LIST_TTL = 10  # 영상 목록을 기억해 두는 시간(초)
# 질문하기 제한: 질문마다 Claude API 비용이 들어서, 한 사람이나 프로그램이 마구 보내지 못하게 합니다.
ASK_PER_PERSON = 10   # 한 사람(입장 통과 하나)이 ASK_WINDOW 동안 할 수 있는 질문 수
ASK_WINDOW = 600      # 초 (10분)
ASK_PER_HOUR = 200    # 학원 전체가 1시간에 할 수 있는 질문 수
ASK_AT_ONCE = 4       # 동시에 답을 만드는 질문 수 (나머지 요청이 영상·목록을 막지 않게)
HISTORY_CHARS = 20000 # 함께 보내는 대화 기록 글자 수 합
MAX_BODY = 256 * 1024 # 요청 본문 최대 크기(바이트). 큰 요청으로 NAS 메모리를 채우지 못하게


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
    cues = [f"{_vtt_time(s['start'])} --> {_vtt_time(s['start'] + 5 if s.get('end') is None else s['end'])}\n"
            f"{html.escape(' '.join(s['text'].split()), quote=False)}\n"
            for s in segments]
    return "\n".join(["WEBVTT\n", *cues])


def _search_text(text: str) -> str:
    # 맥에서 고친 파일의 한글(NFD)과 줄바꿈이 섞여도 같은 말로 찾습니다.
    return " ".join(unicodedata.normalize("NFC", text).split()).lower()


@functools.lru_cache(maxsize=2048)
def _search_lines(path: str, mtime_ns: int, size: int) -> list[tuple[float, str, str]]:
    """분석 파일 하나의 [(시점, 찾기용 글, 원래 글)]. 검색할 때마다 NAS에서 모든 파일을 다시 읽지 않도록
    기억해 두고, 파일이 바뀌면(시각·크기) 새로 읽습니다."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    lines = [(s["start"], s["text"]) for s in data["segments"]]
    for c in (data.get("guide") or {}).get("chapters", []):
        lines += [(c["start"], text) for text in [c["title"], *c["points"]]]
    return [(float(start), _search_text(text), text) for start, text in lines]


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=10000)


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    history: list[Turn] = Field(default=[], max_length=20)
    current_time: float | None = None

    @model_validator(mode="after")
    def _history_not_too_long(self):
        # 대화 기록은 질문할 때마다 Claude에 다시 보내져 비용이 듭니다. 실제 대화는 이보다 훨씬 짧습니다.
        if sum(len(t.content) for t in self.history) > HISTORY_CHARS:
            raise ValueError(f"대화 기록이 {HISTORY_CHARS}자를 넘습니다")
        return self


class _AskLimits:
    """질문하기(유료 API)를 한 사람이 마구 쓰거나, 동시에 몰려 서버가 멈추지 않게 하는 제한."""

    def __init__(self):
        self.lock = threading.Lock()
        self.by_person: dict[str, deque] = {}
        self.everyone: deque = deque()
        self.at_once = threading.BoundedSemaphore(ASK_AT_ONCE)

    def refuse_reason(self, person: str, now: float) -> str | None:
        with self.lock:
            mine = self.by_person.setdefault(person, deque())
            while mine and now - mine[0] >= ASK_WINDOW:
                mine.popleft()
            while self.everyone and now - self.everyone[0] >= 3600:
                self.everyone.popleft()
            if len(mine) >= ASK_PER_PERSON:
                return "질문을 너무 자주 했습니다. 몇 분 뒤 다시 해 주세요."
            if len(self.everyone) >= ASK_PER_HOUR:
                return "지금은 질문이 너무 많습니다. 잠시 뒤 다시 해 주세요."
            mine.append(now)
            self.everyone.append(now)
            if len(self.by_person) > 10000:  # 오래된 사람 기록 정리
                self.by_person = {k: q for k, q in self.by_person.items() if q and now - q[-1] < ASK_WINDOW}
            return None


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

    # 가장 바깥에서(입장 확인보다 먼저) 요청 크기를 봅니다. 본문을 읽기 전에 거절해야 NAS 메모리를 지킵니다.
    @app.middleware("http")
    async def limit_body(request: Request, call_next):
        if request.method in ("POST", "PUT", "PATCH"):
            length = request.headers.get("content-length", "")
            if not length.isdigit():
                return JSONResponse({"detail": "요청 크기를 알 수 없습니다"}, status_code=411)
            if int(length) > MAX_BODY:
                return JSONResponse({"detail": "요청이 너무 큽니다"}, status_code=413)
        return await call_next(request)

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

    listed = {"at": None, "videos": []}

    def videos():
        # 영상 폴더 전체를 훑는 일은 NAS에서 느립니다(영상 1,000개면 수백 ms). 영상을 넘길 때마다 오는 요청마다
        # 훑지 않도록 잠깐 기억해 둡니다. 새로 올린 강의는 VIDEO_LIST_TTL초 안에 목록에 나타납니다.
        now = time.monotonic()
        if listed["at"] is None or now - listed["at"] >= VIDEO_LIST_TTL:
            listed["videos"], listed["at"] = find_videos(video_dir), now
        return listed["videos"]

    def get_video(video_id):
        for video in videos():
            if video["id"] == video_id and video["path"].is_file():  # 그사이 지운 영상은 없는 것으로
                return video
        raise HTTPException(404, "영상을 찾을 수 없습니다")

    @app.get("/api/videos")
    def list_videos():
        return [{"id": v["id"], "title": v["title"],
                 "analyzed": (Path(data_dir) / f"{v['id']}.json").exists()}
                for v in videos()]

    @app.get("/api/videos/{video_id}")
    def video_detail(video_id: str):
        video = get_video(video_id)
        return {"id": video_id, "title": video["title"],
                "analysis": load_analysis(data_dir, video_id)}

    @app.get("/api/search")
    def search(q: str = Query(min_length=2, max_length=100)):
        """모든 강의의 대본과 요점에서 검색어가 나오는 장면. 강의마다 앞에서부터 5곳과 전체 개수."""
        needle = _search_text(q)
        if len(needle) < 2:
            raise HTTPException(422, "두 글자 이상 입력해 주세요")
        results = []
        for video in videos():
            path = Path(data_dir) / f"{video['id']}.json"
            try:
                stat = path.stat()
                lines = _search_lines(str(path), stat.st_mtime_ns, stat.st_size)
            except FileNotFoundError:  # 아직 분석 전
                continue
            except (ValueError, KeyError, TypeError, AttributeError):
                # 손으로 고치다 형식이 틀린 분석 파일 하나 때문에 모든 학생의 검색이 멈추지 않게
                logging.warning("검색에서 건너뛴 분석 파일 (형식이 맞지 않음): %s", path)
                continue
            hits = [{"start": start, "text": text} for start, found, text in lines if needle in found]
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

    limits = _AskLimits()

    @app.post("/api/videos/{video_id}/ask")
    def ask(video_id: str, req: AskRequest, request: Request):
        get_video(video_id)
        data = load_analysis(data_dir, video_id)
        if not data or not data["segments"]:
            raise HTTPException(409, "아직 분석되지 않은 영상이라 질문할 수 없습니다")
        # 입장 통과(쿠키)마다 셉니다. 입장 확인을 끈 학원 내부망에서는 컴퓨터마다 셉니다.
        cookie = request.cookies.get(PASS_COOKIE)
        person = hashlib.sha256(cookie.encode()).hexdigest() if cookie else f"ip:{request.client.host}"
        reason = limits.refuse_reason(person, time.monotonic())
        if reason:
            raise HTTPException(429, reason)
        if not limits.at_once.acquire(blocking=False):
            raise HTTPException(503, "다른 학생들의 질문에 답하는 중입니다. 잠시 뒤 다시 해 주세요.")
        try:
            text = answer(data["title"], data["segments"], req.question,
                          [t.model_dump() for t in req.history], req.current_time)
        except Exception as e:  # API 키 누락, 네트워크 오류, 응답 거절 등
            logging.exception("AI 답변 실패")
            raise HTTPException(502, f"AI 답변을 받지 못했습니다: {e}")
        finally:
            limits.at_once.release()
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
