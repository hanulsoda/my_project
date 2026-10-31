"""학생용 학습 플레이어 웹 서버.

실행: uvicorn academy.server:app --host 0.0.0.0 --port 8000
"""

import gzip
import hashlib
import html
import ipaddress
import json
import logging
import os
import re
import secrets
from bisect import bisect_right
from collections import Counter, deque
from contextlib import asynccontextmanager
from datetime import datetime
from itertools import accumulate
from pathlib import Path
from threading import BoundedSemaphore, Lock, Thread
from time import monotonic, time as wall_clock
from typing import Literal

import anthropic
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

from academy.entry import PASS_TTL, entry_link_ok, make_pass, pass_ok
from academy.library import find_videos, load_analysis, load_moves
from academy.settings import entry_settings, teacher_key as _teacher_key
from academy.references import load_references, matcher, ref_key, reference_sections, suspects, usable_references
from academy.timelink import link_times

STATIC_DIR = Path(__file__).parent / "static"
# NAS 영상 폴더를 한 번 훑는 데 18초쯤 걸려서 목록을 기억해 둡니다.
REFRESH_SECONDS = 300  # 이보다 오래된 목록은 뒤에서 다시 훑습니다
MISS_SECONDS = 30  # 모르는 id가 와도 이 안에 훑었으면 다시 훑지 않습니다
INDEX_VERSION = 1  # 저장해 두는 서버 요약(.server-index.cache)에 넣는 항목을 바꾸면 올립니다
# 질문하기 제한: 질문마다 Claude API 비용이 들어서, 다시 켰을 때 한 사람이나 프로그램이 마구 보내지 못하게 합니다.
ASK_PER_PERSON = 10    # 한 사람이 ASK_WINDOW 동안 할 수 있는 질문 수
ASK_WINDOW = 600       # 초 (10분)
ASK_PER_HOUR = 200     # 학원 전체가 1시간에 할 수 있는 질문 수
ASK_AT_ONCE = 4        # 동시에 답을 만드는 질문 수 (나머지 요청이 영상·목록을 막지 않게)
HISTORY_CHARS = 20000  # 함께 보내는 대화 기록 글자 수 합
MAX_QUERY = 30         # 검색어 최대 글자 수(띄어쓰기·기호 뺀 뒤). 긴 검색어로 서버를 오래 붙잡지 못하게
NEAR_MAX = 10          # 받아쓰기가 한 소리 다르게 적은 말 찾기는 이 글자 수까지(작품명·용어용, 길면 매우 느림)
LOG_WRITES_PER_HOUR = 600  # 한 기기가 1시간에 남기는 퀴즈 결과·강의 열기 기록 상한(평소 학생은 닿지 않음, 넘으면 기록만 안 함)
TRANSFERS_PER_DEVICE = 10  # 한 기기가 10분에 만들 수 있는 기기 옮기기 코드 수
MAX_BODY = 4 * 1024 * 1024  # 요청 본문 최대 크기. 기기 옮기기(기록 2MB까지)는 받고, 그보다 큰 요청으로 메모리를 채우지 못하게
PASS_COOKIE = "study_pass"
LOGIN_NOTICE = "학원 사이트에 로그인한 뒤 들어와 주세요"
LAN_ONLY_NOTICE = "학습 플레이어는 인터넷으로는 열려 있지 않습니다. 학원 안에서 접속해 주세요."


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


# 인터넷에서 직접 올 수 없는 주소. 사설·자기 PC 주소(ipaddress의 is_private)와 Tailscale 같은 VPN이 쓰는 대역.
_VPN = ipaddress.ip_network("100.64.0.0/10")


def _where(request) -> str:
    """요청이 온 곳: "lan"(학원 내부망·VPN), "internet", "unknown"(주소 모양이 아님, 시험용 접속 등).

    DS918+ 역방향 프록시가 X-Forwarded-For 맨 오른쪽에 붙인 주소가 실제 접속 주소입니다(그 앞의 주소는 학생이
    마음대로 넣을 수 있음). 프록시를 거쳤는데 실제 주소를 알려 주지 않으면(설정 빠뜨림) 인터넷으로 봅니다.
    """
    # 머리글이 여러 줄로 오면 이어 붙여 봅니다(uvicorn과 같은 방식).
    forwarded = ",".join(request.headers.getlist("x-forwarded-for"))
    if forwarded:
        host = forwarded.split(",")[-1].strip()
    elif request.headers.get("x-forwarded-proto"):
        return "internet"
    else:
        host = request.client.host if request.client else ""
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        # 프록시가 보낸 주소를 읽을 수 없으면(머리글 값 잘못 적음, 포트가 붙음 등) 인터넷으로 봅니다.
        return "internet" if forwarded else "unknown"
    return "lan" if address.is_private or address in _VPN else "internet"


def _from_outside(request) -> bool:
    """학원 내부망 밖에서 온 요청인지. 알 수 없으면 밖으로 봅니다."""
    return _where(request) != "lan"


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

    @model_validator(mode="after")
    def _history_not_too_long(self):
        # 대화 기록은 질문할 때마다 Claude에 다시 보내져 비용이 듭니다. 실제 대화는 이보다 훨씬 짧습니다.
        if sum(len(t.content) for t in self.history) > HISTORY_CHARS:
            raise ValueError(f"대화 기록이 {HISTORY_CHARS}자를 넘습니다")
        return self


class _AskLimits:
    """질문하기(유료 API)를 한 사람이 마구 쓰거나, 동시에 몰려 서버가 멈추지 않게 하는 제한."""

    def __init__(self):
        self.lock = Lock()
        self.by_person: dict[str, deque] = {}
        self.everyone: deque = deque()
        self.at_once = BoundedSemaphore(ASK_AT_ONCE)

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


class FixRequest(BaseModel):
    section: str = Field(max_length=50)
    original: str = Field(max_length=5000)
    text: str | None = Field(None, max_length=5000)
    hidden: bool | None = None


class QuizResult(BaseModel):
    id: str = Field(max_length=32)
    key: str = Field(min_length=1, max_length=1000)  # 문제 글(빈칸 문제는 지문과 답 문장)
    right: bool


class TransferRequest(BaseModel):
    data: dict


class PicksRequest(BaseModel):
    ids: list[str] = Field(max_length=20)
    note: str = Field("", max_length=200)
    # 강의마다 대상 학년(없으면 모든 학년). 학생은 사이드바에서 자기 학년을 고르면 그 학년 것만 봅니다.
    grades: dict[str, Literal["", "중1", "중2", "중3", "고1", "고2", "고3"]] = Field(default_factory=dict)
    # 화면을 열 때 받은 저장 시각. 그사이 다른 탭·선생님이 저장했으면 덮어쓰지 않고 409(보내지 않으면 확인하지 않음)
    at: float | None = None


def create_app(video_dir: Path, data_dir: Path, answer, references=(), log_dir=None, usage_ignore=(),
               teacher_key=None, entry_secret="", site_url="") -> FastAPI:
    """log_dir를 주면 현황(/api/status)에 백업·밤 작업·새 강의 분석 로그의 마지막 줄을 함께 보여 줍니다.

    entry_secret을 주면 인터넷(학원 내부망 밖)에서 온 요청은 학원 사이트 입장 링크로 받은 통과 쿠키가 있어야 합니다.
    """
    references = usable_references(references)  # 모양이 다른 정리 하나가 목록·검색·현황을 멈추지 않게

    @asynccontextmanager
    async def lifespan(app):
        # NAS를 훑고 분석 상태를 읽고 학원 정리를 짝짓는 데 시간이 걸려, 첫 학생이 기다리지 않게 켜자마자 해 두고 요약을 저장합니다.
        Thread(target=lambda: (listing(), save_index()), daemon=True).start()
        yield

    # 서버가 자동으로 만드는 API 설명서(/docs 등)는 바깥에 보일 필요가 없어 끕니다.
    app = FastAPI(title="학원 학습 플레이어", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    if entry_secret:
        # 보안 머리글보다 안쪽이라 로그인 안내 화면에도 머리글이 붙습니다. 학원 내부망은 지금처럼 그대로 씁니다.
        @app.middleware("http")
        async def require_pass(request: Request, call_next):
            path = request.url.path
            if (path == "/enter" or not _from_outside(request)
                    or pass_ok(entry_secret, request.cookies.get(PASS_COOKIE), wall_clock())):
                return await call_next(request)
            if path.startswith(("/api/", "/media/")):
                return JSONResponse({"detail": LOGIN_NOTICE}, status_code=401)
            return _denied_page(site_url)
    else:
        # 입장 확인을 켜지 않은 서버는 학원 내부망 전용입니다. DS918+ 프록시를 만들어 둔 채 ENTRY_SECRET 없이
        # 서버를 다시 켜도 강의가 인터넷에 열리지 않게, 인터넷에서 온 요청은 막습니다.
        @app.middleware("http")
        async def lan_only(request: Request, call_next):
            if _where(request) != "internet":
                return await call_next(request)
            if request.url.path.startswith(("/api/", "/media/")):
                return JSONResponse({"detail": LAN_ONLY_NOTICE}, status_code=403)
            return HTMLResponse(f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>학습 플레이어</title>'
                                f'</head><body><h1 style="font-size:20px">{LAN_ONLY_NOTICE}</h1></body></html>',
                                status_code=403)

    # 입장 확인보다 먼저 요청 크기를 봅니다. 본문을 읽기 전에 거절해야 서버 메모리를 지킵니다.
    @app.middleware("http")
    async def limit_body(request: Request, call_next):
        if request.method in ("POST", "PUT", "PATCH"):
            length = request.headers.get("content-length", "")
            if not length.isdigit():
                return JSONResponse({"detail": "요청 크기를 알 수 없습니다"}, status_code=411)
            if int(length) > MAX_BODY:
                return JSONResponse({"detail": "요청이 너무 큽니다"}, status_code=413)
        return await call_next(request)

    @app.middleware("http")
    async def security_headers(request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"  # 브라우저가 파일 종류를 멋대로 짐작하지 않게
        response.headers["X-Frame-Options"] = "DENY"  # 다른 사이트가 플레이어를 자기 화면 안에 몰래 띄우지 못하게
        response.headers["Referrer-Policy"] = "same-origin"  # 강의 주소가 바깥 사이트로 새지 않게
        return response

    # 강의 목록(약 550KB)·화면 파일을 압축해 휴대폰에 빨리 보냅니다. 영상·사진·영상 탐색(206)은 그대로 둡니다(Starlette 기본값).
    app.add_middleware(GZipMiddleware, minimum_size=1000)

    @app.get("/enter")
    def enter(request: Request, exp: str | None = None, sig: str | None = None):
        """학원 사이트의 "강의 보기"가 보내는 입장 링크. 맞으면 12시간짜리 통과 쿠키를 줍니다."""
        if not entry_secret:
            return RedirectResponse("/", 303)
        if not entry_link_ok(entry_secret, exp, sig, wall_clock()):
            return _denied_page(site_url)
        res = RedirectResponse("/", 303)
        # DS918+가 https로 받아 http로 넘겨도 학생 브라우저와는 https라서 Secure를 붙입니다.
        https = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
        res.set_cookie(PASS_COOKIE, make_pass(entry_secret, wall_clock()), max_age=PASS_TTL,
                       httponly=True, samesite="lax", secure=https)
        return res

    library = {"at": None, "videos": [], "by_id": {}}
    scan_lock = Lock()

    def scan(max_age):
        with scan_lock:  # 한 번에 하나만 훑고, 기다리는 사이 다른 요청이 훑었으면 그 결과를 씁니다.
            if library["at"] is None or monotonic() - library["at"] > max_age:
                videos = find_videos(video_dir)
                if not videos and library["videos"]:
                    # NAS 연결이 잠깐 끊기면 영상 폴더가 비어 보입니다. 학생 목록을 비우지 않고 1분 뒤 다시 훑습니다.
                    logging.warning("영상 폴더가 비어 보여 이전 목록을 그대로 씁니다(NAS 연결 확인): %s", video_dir)
                    library["at"] = monotonic() - REFRESH_SECONDS + 60
                    return
                for v in videos:  # '새로 올라온 강의'를 고를 파일 날짜(NAS 3,900개에 3초쯤 더 걸림)
                    try:
                        v["added"] = int(v["path"].stat().st_mtime)
                    except OSError:
                        v["added"] = 0
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
    # 다시 켤 때 분석 결과 3,900개(수백 MB)를 처음부터 읽느라 몇 분 걸리지 않게, 이 상태들을 저장해 두고 바뀐 파일만 다시 읽습니다.
    # 분석 결과 JSON을 하나씩 읽는 스크립트가 섞어 읽지 않도록 확장자를 .json으로 하지 않습니다.
    index_path = Path(data_dir) / ".server-index.cache"
    try:
        saved = json.loads(index_path.read_text(encoding="utf-8"))
        if saved.get("version") == INDEX_VERSION:
            status_cache.update({video_id: (tuple(stamp), entry) for video_id, (stamp, entry) in saved["entries"].items()})
    except (OSError, ValueError, TypeError, AttributeError, KeyError):
        pass  # 없거나 망가졌거나 예전 형식이면 처음부터 읽습니다

    def save_index():
        if not Path(data_dir).is_dir():
            return
        tmp = index_path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps({"version": INDEX_VERSION, "entries": dict(status_cache)}, ensure_ascii=False),
                           encoding="utf-8")
            tmp.replace(index_path)
        except OSError:
            logging.exception("서버 요약 저장 실패(다음에 켤 때 분석 결과를 처음부터 읽습니다)")

    def read_analysis(video_id):
        """손으로 고치다 형식이 깨진 분석 파일은 그 강의만 '분석 전'으로 보고, 목록·검색·현황은 계속 돌게 합니다."""
        try:
            data = load_analysis(data_dir, video_id)
        except ValueError:  # JSON 형식 오류(JSONDecodeError)·글자 깨짐
            data = []
        if data is None or isinstance(data, dict):
            return data
        logging.warning("분석 파일 형식 오류로 건너뜀: %s.json", video_id)  # 깨졌거나, 내용이 통째로 목록·숫자 등으로 바뀜
        return None

    def analysis_entry(video_id):
        path = Path(data_dir) / f"{video_id}.json"
        try:
            stat = path.stat()  # 한 번만 봅니다. 그사이 분석이 파일을 바꿔도 모두의 목록이 오류 나지 않게
        except FileNotFoundError:
            return None
        stamp = (stat.st_mtime_ns, stat.st_size)
        if status_cache.get(video_id, (None,))[0] != stamp:
            data = read_analysis(video_id)
            if data is None:  # 파일이 다시 바뀔(고쳐질) 때까지 '분석 전'
                status_cache[video_id] = (stamp, None)
                return None
            spoken = [(_norm(s["text"]), s["start"]) for s in data.get("segments") or []]
            chapters = ((data.get("guide") or {}).get("chapters") or (data.get("toc") or {}).get("chapters") or [])
            status_cache[video_id] = (stamp, {
                "guide": bool(data.get("guide")), "toc": bool((data.get("toc") or {}).get("chapters")),
                "toc_tried": "toc" in data, "duration": data.get("duration") or 0, "modified": stamp[0] / 1e9,
                "chapters": sorted((c["start"], c["title"]) for c in chapters),
                "text": "".join(t for t, _ in spoken), "offsets": list(accumulate((len(t) for t, _ in spoken), initial=0))[:-1],
                "times": [start for _, start in spoken]})
        return status_cache[video_id][1]

    def analysis_status(video_id):
        entry = analysis_entry(video_id)
        return {"analyzed": bool(entry), "guide": bool(entry and entry["guide"]), "toc": bool(entry and entry["toc"])}

    matched = {}  # 영상 id → 파일 이름으로 짝지어지는 학원 요점 정리. 처음 찾을 때 전체 목록에 몇 초 걸려 기억해 둡니다.
    find_references = matcher(references)  # 정리마다 보여 줄 내용을 한 번만 만들어 모든 강의가 함께 씁니다

    def academy_summaries(video):
        if video["id"] not in matched:
            # 빈칸 문제는 퀴즈 탭에서 풀도록 요점 정리에서는 뺍니다.
            matched[video["id"]] = [{"source": r["source"], "key": r["key"], "quiz": r["quiz"],
                                     "sections": [s for s in r["sections"] if s["name"] != "빈칸 문제"]}
                                    for r in find_references(video["title"])]
        return matched[video["id"]]

    def stamp(path):  # 파일이 바뀌었는지 보는 값(없으면 None)
        try:
            info = Path(path).stat()
            return info.st_mtime_ns, info.st_size
        except OSError:
            return None

    # 강의 목록: 수업 시작에 학생 수십 명이 한꺼번에 열어도 기다리지 않게, 다 만든 답(압축까지)을 두고 같이 씁니다.
    # 새 강의(다시 훑기)·분석 결과 저장(분석 폴더가 바뀜)·선생님의 정리 고치기가 있으면 다시 만들고, 그 밖에도 1분마다 새로 만듭니다.
    list_cache, list_lock = {"key": None}, Lock()

    def built_list():
        listed, fixes = [], read_fixes()
        for v in current_library()["videos"]:
            status = analysis_status(v["id"])
            # Claude 요점 정리가 없어도 학원 요점 정리를 보여 줄 수 있으면 요점 정리가 있는 강의입니다.
            status["guide"] = status["guide"] or (status["analyzed"] and shows_summary(v, fixes))
            listed.append({"id": v["id"], "title": v["title"], "added": v.get("added", 0), **status})
        return listed

    def listing():
        current_library()
        key = (library["at"], stamp(data_dir), stamp(fixes_path), int(monotonic() // 60))
        with list_lock:  # 한 명이 만드는 동안 나머지는 기다렸다가 그 답을 씁니다
            if list_cache["key"] != key:
                body = json.dumps(built_list(), ensure_ascii=False, separators=(",", ":")).encode()
                list_cache.update(key=key, body=body, gzip=gzip.compress(body, 6))
        return list_cache

    @app.get("/api/videos")
    def list_videos(request: Request):
        cache = listing()
        if "gzip" in request.headers.get("accept-encoding", ""):  # 압축해 둔 것을 그대로(서버가 매번 다시 압축하지 않게)
            return Response(cache["gzip"], media_type="application/json",
                            headers={"Content-Encoding": "gzip", "Vary": "Accept-Encoding"})
        return Response(cache["body"], media_type="application/json")

    @app.get("/api/search")
    def search(q: str = ""):
        """낱말을 말한 강의를 많이 말한 순서로. 대본 글은 학생에게 보내지 않고 시각만 보냅니다.

        exact: 그대로 말한 강의, similar: 그대로는 없고 받아쓰기가 한 소리 다르게 적은 말만 있는 강의(적힌 말과 함께)
        """
        word = _search_word(q)
        current_library()
        # 1분마다도 다시 찾습니다: 분석 파일을 그 자리에서 고치면(메모장 등) 분석 폴더의 시각이 바뀌지 않습니다.
        key = (word, library["at"], stamp(data_dir), stamp(fixes_path), int(monotonic() // 60))
        found = searches.get(key)  # 찾아 둔 답은 다른 낱말을 찾는 동안 줄 서지 않고 바로 씁니다
        if found is not None:
            return found
        # 한 번에 하나씩 찾습니다(어차피 CPU를 나눠 써서 함께 돌려도 빠르지 않음). 수업 중 여러 학생이 같은 낱말을 찾으면
        # 처음 찾은 결과를 함께 씁니다. 새 강의·분석 저장·정리 고치기가 있으면 다시 찾습니다.
        with search_lock:
            if key not in searches:
                if len(searches) >= 64:
                    searches.pop(next(iter(searches)))  # 가장 오래된 것부터
                searches[key] = find_spoken(word)
            return searches[key]

    searches, search_lock = {}, Lock()

    def find_spoken(word):
        near = _near(word) if len(word) <= NEAR_MAX else None
        maybe_near = _near_filter(word) if near else None  # 비슷한 말이 있을 수 없는 대본은 정규식을 돌리지 않음(결과는 같음)
        exact, similar, notes, fixes, fixes_at = [], [], [], read_fixes(), stamp(fixes_path)
        for v in current_library()["videos"]:
            entry = analysis_entry(v["id"])
            if not entry:
                continue
            at = [m.start() for m in re.finditer(re.escape(word), entry["text"])]
            if at:
                exact.append(found_at(v, entry, at))
            elif near and maybe_near(entry["text"]) and (matches := list(near.finditer(entry["text"]))):
                result, recording = found_at(v, entry, [m.start() for m in matches])
                result["heard_as"] = [w for w, _ in Counter(m.group() for m in matches).most_common(2)]
                similar.append((result, recording))
            elif lines := noted(v, entry, word, fixes, fixes_at):
                notes.append(({"id": v["id"], "title": v["title"], "matches": lines[:3], "also": []},
                              (round(entry["duration"]), entry["text"][:150])))
        return {"exact": merge_copies(exact), "similar": merge_copies(similar), "notes": merge_copies(notes)}

    noted_lines = {}  # 영상 id → (분석 파일·정리 고치기 시점, [(띄어쓰기 뺀 글, 글, 시각)]): 찾을 때마다 10만 줄을 다시 다듬지 않게

    def noted(v, entry, word, fixes, fixes_at):
        """말하지는 않았어도 목차·챕터 제목이나 학원 정리 항목에 낱말이 든 줄 [{"text", "time"}]"""
        key = (status_cache.get(v["id"], (None,))[0], fixes_at)
        if noted_lines.get(v["id"], (None,))[0] != key:
            lines = [(title, start) for start, title in entry["chapters"]]
            if not entry["guide"]:  # Claude 요점 정리는 학원 정리를 바탕으로 만들었으니 챕터만 봅니다
                lines += [(item, None) for r in fixed(academy_summaries(v), fixes) for s in r["sections"] for item in s["items"]]
            noted_lines[v["id"]] = (key, [(_norm(text), text, t) for text, t in lines])
        return [{"text": text, "time": t} for flat, text, t in noted_lines[v["id"]][1] if word in flat]

    def found_at(v, entry, positions, limit=5):
        spots = [entry["times"][bisect_right(entry["offsets"], at) - 1] for at in positions]
        times = []
        for t in spots:
            if not times or t - times[-1] >= 60:  # 1분 안에 다시 말한 것은 한 번으로 봅니다
                times.append(t)
        starts = [start for start, _ in entry["chapters"]]
        chapters = [entry["chapters"][i - 1][1] if (i := bisect_right(starts, t)) else None for t in times[:limit]]
        # 같은 녹화를 여러 폴더에 넣어 둔 경우: 길이와 대본 앞부분이 같으면 같은 녹화로 봅니다.
        return ({"id": v["id"], "title": v["title"], "count": len(spots), "times": times[:limit], "chapters": chapters, "also": []},
                (round(entry["duration"]), entry["text"][:150]))

    @app.get("/api/videos/{video_id}/search")
    def search_lecture(video_id: str, q: str = ""):
        """이 강의에서 낱말을 말한 시각 모두와 그때의 챕터(대본 글은 보내지 않음). 그대로 말한 곳이 없으면
        받아쓰기가 한 소리 다르게 적은 곳(heard_as: 적힌 말), 목차·챕터 제목·학원 정리에 나오는 줄(notes)도 줍니다."""
        video, word = get_video(video_id), _search_word(q)
        entry = analysis_entry(video["id"])
        if not entry:
            return {"times": [], "chapters": [], "heard_as": [], "notes": []}
        at, heard = [m.start() for m in re.finditer(re.escape(word), entry["text"])], []
        if not at and len(word) <= NEAR_MAX and (near := _near(word)):
            matches = list(near.finditer(entry["text"]))
            at, heard = [m.start() for m in matches], [w for w, _ in Counter(m.group() for m in matches).most_common(2)]
        found, _ = found_at(video, entry, at, limit=None)
        return {"times": found["times"], "chapters": found["chapters"], "heard_as": heard, "notes": noted(video, entry, word, read_fixes(), stamp(fixes_path))}

    def merge_copies(found):
        merged, first = [], {}
        for result, recording in sorted(found, key=lambda f: -f[0].get("count", 0)):  # notes는 횟수가 없어 강의 순서대로
            if recording in first:
                first[recording]["also"].append(result["title"])
            else:
                first[recording] = result
                merged.append(result)
        return merged[:300]  # 화면은 30개씩 '더 보기'

    # ---- 선생님용 이용 통계: 플레이어에서 강의를 연 시각·강의·기기 번호만 log_dir/usage.log에 한 줄씩 ----
    # 기기 번호는 서버만 아는 비밀값(.usage-salt)을 섞어 바꾼 짧은 글자라 기기 주소로 되돌릴 수 없습니다.
    # usage_ignore(원장님 PC 등)의 접속과, 복습 화면처럼 강의를 열지 않고 정보만 읽는 것(view 없음)은 세지 않습니다.
    usage_lock = Lock()
    writes, writes_lock = {}, Lock()  # (기록 종류, 기기 주소) → 최근 1시간 동안 남긴 시각들

    def may_log(kind, host):
        """한 기기가 기록을 끝없이 보내 디스크를 채우지 못하게 합니다."""
        now = wall_clock()
        with writes_lock:
            if len(writes) > 10000:  # 오래된 기기 기록 정리
                for k in [k for k, t in writes.items() if not t or now - t[-1] >= 3600]:
                    del writes[k]
            times = writes.setdefault((kind, host), deque())
            while times and now - times[0] >= 3600:
                times.popleft()
            if len(times) >= LOG_WRITES_PER_HOUR:
                return False
            times.append(now)
            return True

    def device(host):
        salt_path = Path(log_dir) / ".usage-salt"
        if not salt_path.exists():
            salt_path.write_text(secrets.token_hex(16), encoding="utf-8")
        return hashlib.sha256((salt_path.read_text(encoding="utf-8") + host).encode()).hexdigest()[:10]

    if log_dir:
        try:  # 없으면 만들어 둡니다(전에는 학생이 강의를 열 때마다 오류가 났음)
            Path(log_dir).mkdir(parents=True, exist_ok=True)
        except OSError:
            logging.warning("로그 폴더를 만들지 못했습니다(이용 통계·퀴즈 기록 없이 씁니다): %s", log_dir)

    def append_log(name, row):
        """기록 한 줄. 쓰지 못해도(폴더 권한·디스크) 학생의 요청은 그대로 됩니다."""
        try:
            with usage_lock, (Path(log_dir) / name).open("a", encoding="utf-8") as f:
                f.write(json.dumps({**row, "who": device(row.pop("who"))}) + "\n")
        except OSError as e:
            logging.warning("로그를 쓰지 못했습니다(%s): %s", name, e)

    def record_open(video_id, host):
        if not log_dir or host in usage_ignore or not may_log("open", host):
            return
        append_log("usage.log", {"t": int(wall_clock()), "id": video_id, "who": host})

    # ---- 많이 틀리는 문제: 퀴즈를 풀 때 강의·문제·맞음/틀림·기기 번호만 log_dir/quiz.log에(이용 통계와 같은 방식) ----
    @app.post("/api/quiz-result", status_code=204)
    def quiz_result(req: QuizResult, request: Request):
        get_video(req.id)
        host = request.client.host if request.client else ""
        if not log_dir or host in usage_ignore or not may_log("quiz", host):
            return
        # 한글도 \u 글자로 적습니다: 학생이 보낸 문제 글의 U+2028 같은 글자가 줄 바꿈으로 읽혀 가짜 줄이 생기지 않게
        append_log("quiz.log", {"t": int(wall_clock()), "id": req.id, "k": req.key, "who": host, "right": req.right})

    def quiz_summary():
        first = {}  # (기기, 강의, 문제) → 처음 푼 결과: 다시 푼 것은 정답률을 흐리므로 세지 않습니다
        for row in read_lines(Path(log_dir) / "quiz.log", "t", "who", "id", "k", "right"):
            if row["t"] >= wall_clock() - 30 * 86400:
                first.setdefault((row["who"], row["id"], row["k"]), row["right"])
        tally = {}
        for (_, video_id, key), right in first.items():
            seen = tally.setdefault((video_id, key), [0, 0])
            seen[0] += 1
            seen[1] += right
        titles = {v["id"]: v["title"] for v in current_library()["videos"]}
        # 세 기기 넘게 풀고 한 번이라도 틀린 문제를 정답률 낮은 순서로 10개
        hard = sorted(((n, r, i, k) for (i, k), (n, r) in tally.items() if n >= 3 and r < n), key=lambda x: (x[1] / x[0], -x[0]))
        return {"answered": len(first), "hardest": [{"id": i, "title": titles.get(i, "(목록에 없는 강의)"), "question": k,
                                                     "attempts": n, "right": r} for n, r, i, k in hard[:10]]}

    def read_lines(path, *keys):  # JSON 한 줄씩 쌓은 기록. 쓰다 끊긴 줄과 keys가 다 있는 객체가 아닌 줄은 건너뜁니다.
        rows = []
        try:
            for line in path.read_text(encoding="utf-8").split("\n"):  # splitlines는 U+2028 등에서도 잘라 '\n'만
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if isinstance(row, dict) and all(k in row for k in keys):
                    rows.append(row)
        except OSError:
            pass
        return rows

    def usage_summary():
        rows = read_lines(Path(log_dir) / "usage.log", "t", "id", "who")
        now = wall_clock()
        month = [r for r in rows if r["t"] >= now - 30 * 86400]
        opens, devices = Counter(r["id"] for r in month), {}
        for r in month:
            devices.setdefault(r["id"], set()).add(r["who"])
        titles = {v["id"]: v["title"] for v in current_library()["videos"]}
        top = sorted(opens, key=lambda i: (-len(devices[i]), -opens[i], titles.get(i, "")))[:10]
        weekdays = [0] * 7  # 월~일, 최근 4주
        for r in rows:
            if r["t"] >= now - 28 * 86400:
                weekdays[datetime.fromtimestamp(r["t"]).weekday()] += 1
        return {"since": datetime.fromtimestamp(rows[0]["t"]).strftime("%Y-%m-%d") if rows else None,
                "opens": len(month), "devices": len({r["who"] for r in month}), "weekdays": weekdays,
                "top": [{"id": i, "title": titles.get(i, "(목록에 없는 강의)"), "opens": opens[i], "devices": len(devices[i])}
                        for i in top]}

    # ---- 선생님이 고른 '이번 주 강의': 누구나 보고, 바꾸는 것은 선생님 열쇠(X-Teacher-Key)가 있어야 합니다 ----
    # 열쇠를 정하지 않은 서버(teacher_key 없음)는 아무도 바꿀 수 없습니다. 분석 결과 폴더에 두어 매일 백업에 들어갑니다.
    picks_path, picks_lock = Path(data_dir) / ".teacher-picks", Lock()

    # 마구 넣어 보기 막기: 기기마다 틀린 횟수를 세어 limit번 틀리면 10분 동안 429
    misses = {"key": {}, "code": {}}  # 종류 → 기기 주소 → (틀린 횟수, 마지막으로 틀린 시각)

    def guard(kind, request, limit, message):
        host = request.client.host if request.client else ""
        count, last = misses[kind].get(host, (0, 0))
        if count >= limit and wall_clock() - last < 600:
            raise HTTPException(429, message)
        return host

    def missed(kind, host):
        count, last = misses[kind].get(host, (0, 0))
        misses[kind][host] = (count + 1 if wall_clock() - last < 600 else 1, wall_clock())

    def require_teacher(request):
        host = guard("key", request, 10, "선생님 열쇠를 여러 번 틀려 10분 동안 막았습니다")
        given = request.headers.get("x-teacher-key", "")
        if not given:  # 열쇠를 넣기 전에 화면을 연 것은 틀린 것으로 세지 않습니다(인터넷에서 현황을 열 때마다 묻습니다)
            raise HTTPException(403, "선생님 열쇠를 넣어 주세요")
        if not teacher_key or not secrets.compare_digest(given.encode(), teacher_key.encode()):
            missed("key", host)
            raise HTTPException(403, "선생님 열쇠가 맞지 않습니다")
        misses["key"].pop(host, None)

    # ---- 기기 옮기기: 학생 기록(메모·진도·틀린 문제 등)을 6자리 코드로 잠깐 맡겼다가 다른 기기가 한 번 찾아 갑니다 ----
    # 서버 메모리에만 두고(파일에 남기지 않음) 10분이 지나거나 한 번 찾아 가면 지웁니다.
    transfers = {}  # 코드 → (기록, 사라지는 시각)
    made = {}  # 기기 주소 → 최근 10분 동안 코드를 만든 시각들(한 기기가 코드 자리를 다 차지하지 못하게)

    @app.post("/api/transfer")
    def start_transfer(req: TransferRequest, request: Request):
        if len(json.dumps(req.data, ensure_ascii=False).encode()) > 2_000_000:  # 2MB: 강의 3,900개의 진도를 다 담아도 0.3MB쯤
            raise HTTPException(413, "기록이 너무 큽니다")
        now = wall_clock()
        for code in [c for c, (_, until) in transfers.items() if until < now]:
            del transfers[code]
        for who in [w for w, times in made.items() if now - times[-1] >= 600]:
            del made[who]
        host = request.client.host if request.client else ""
        mine = [t for t in made.get(host, []) if now - t < 600]
        if len(mine) >= TRANSFERS_PER_DEVICE:
            raise HTTPException(429, "코드를 너무 많이 만들었습니다. 10분 뒤 다시 해 주세요")
        made[host] = mine + [now]
        if len(transfers) >= 200:
            raise HTTPException(503, "잠시 뒤 다시 해 주세요")
        code = f"{secrets.randbelow(10**6):06d}"
        while code in transfers:
            code = f"{secrets.randbelow(10**6):06d}"
        transfers[code] = (req.data, now + 600)
        return {"code": code, "expires": int(now + 600)}

    @app.post("/api/transfer/{code}")
    def claim_transfer(code: str, request: Request):
        host = guard("code", request, 20, "코드를 여러 번 틀려 10분 동안 막았습니다")
        data, until = transfers.pop(code, (None, 0))
        if data is None or until < wall_clock():
            missed("code", host)
            raise HTTPException(404, "코드가 없거나 시간이 지났습니다")
        return {"data": data}

    def saved_picks():
        try:
            return json.loads(picks_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    @app.get("/api/moves")
    def moves():
        """폴더를 옮기거나 이름을 바꾼 강의 {예전 번호: 지금 번호}: 학생 기기가 이어 보기·메모·틀린 문제를 새 번호로 옮깁니다."""
        return load_moves(data_dir)

    @app.get("/api/picks")
    def picks():
        saved, moved = saved_picks(), load_moves(data_dir)
        by_id, grades = current_library()["by_id"], saved.get("grades", {})
        # 고른 뒤 폴더를 옮긴 강의도 새 자리로 보여 줍니다(대상 학년은 예전 번호에 적혀 있음)
        chosen = {}  # 지금 번호 → 고를 때 번호(같은 강의는 한 번)
        for i in saved.get("ids", []):
            chosen.setdefault(moved.get(i, i), i)
        return {"note": saved.get("note", ""), "at": saved.get("at"),
                "lectures": [{"id": now, "title": by_id[now]["title"], "grade": grades.get(now) or grades.get(was, "")}
                             for now, was in chosen.items() if now in by_id]}

    @app.put("/api/picks")
    def set_picks(req: PicksRequest, request: Request):
        require_teacher(request)
        by_id = current_library()["by_id"]
        ids = [i for i in dict.fromkeys(req.ids) if i in by_id]  # 화면을 연 뒤 NAS에서 빠진 강의는 버립니다
        grades = {i: g for i, g in req.grades.items() if i in ids and g}
        with picks_lock:  # 두 PC에서 동시에 저장해도 같은 임시 파일을 서로 지우지 않게
            if "at" in req.model_fields_set and req.at != saved_picks().get("at"):
                raise HTTPException(409, "다른 화면에서 먼저 바꿨습니다. 새로 고침해 바뀐 목록을 본 뒤 다시 저장해 주세요")
            picks_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = picks_path.with_name(picks_path.name + ".tmp")
            tmp.write_text(json.dumps({"ids": ids, "grades": grades, "note": req.note.strip(), "at": wall_clock()},
                                      ensure_ascii=False), encoding="utf-8")
            tmp.replace(picks_path)
        return picks()

    # ---- 학원 정리 고치기(선생님): 원본 정리는 그대로 두고, 고친 글·숨긴 항목만 DATA_DIR/.reference-fixes에 ----
    # {정리 열쇠: {칸 이름: {원래 항목: {"text": 고친 글, "hidden": true}}}} — 학생에게 보낼 때 덮어씁니다.
    fixes_path, fixes_lock = Path(data_dir) / ".reference-fixes", Lock()

    def read_fixes():
        try:
            return json.loads(fixes_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def fixed(summaries, fixes=None):  # 목록·검색처럼 강의마다 부를 때는 fixes를 한 번 읽어 넘깁니다
        fixes = read_fixes() if fixes is None else fixes
        out = []
        for r in summaries:
            sections = []
            for s in r["sections"]:
                mine = fixes.get(r.get("key"), {}).get(s["name"], {})
                items = [mine.get(i, {}).get("text", i) for i in s["items"] if not mine.get(i, {}).get("hidden")]
                if items := [i for i in items if i]:
                    sections.append({**s, "items": items})
            if r["sections"] and not sections:  # 선생님이 항목을 모두 숨긴 정리는 쓰지 않습니다(빈칸 문제·어휘 퀴즈도)
                continue
            # 어휘 퀴즈는 원본 정리로 만들어서, 선생님이 숨기거나 뜻을 고친 낱말의 문제는 뺍니다
            # (숨긴 낱말을 묻거나 고치기 전의 틀린 뜻을 정답으로 내지 않게).
            words = fixes.get(r.get("key"), {}).get("어휘", {})
            fills = fixes.get(r.get("key"), {}).get("빈칸 문제", {})  # 선생님이 숨긴 빈칸 문제도 뺍니다
            quiz = [q for q in r.get("quiz", []) if ("choices" not in q or q["explanation"] not in words)
                    and not fills.get(q.get("item"), {}).get("hidden")]
            out.append({**r, "sections": sections, "quiz": quiz})
        return out

    def shows_summary(video, fixes):  # 요점 정리 탭에 보일 학원 정리가 있는지(빈칸 문제만 있는 정리는 퀴즈로만 나감)
        return any(r["sections"] for r in fixed(academy_summaries(video), fixes))

    def ref_by_key(key):
        ref = next((r for r in references if ref_key(r) == key and reference_sections(r)), None)
        if ref is None:
            raise HTTPException(404, "학원 정리를 찾을 수 없습니다")
        return ref

    @app.get("/api/references")
    def reference_list():
        fixes = read_fixes()

        def open_suspects(r):  # 선생님이 아직 고치거나 숨기지 않은 의심 항목
            mine = fixes.get(ref_key(r), {})
            return sum(1 for name, items in suspects(r).items() for item in items if not mine.get(name, {}).get(item))
        return [{"key": ref_key(r), "title": r["title"], "grade": r["grade"], "suspects": open_suspects(r)}
                for r in references if reference_sections(r)]

    @app.get("/api/references/{key}")
    def reference_detail(key: str):
        ref, fixes = ref_by_key(key), read_fixes().get(key, {})
        flagged = suspects(ref)
        return {"key": key, "title": ref["title"], "grade": ref["grade"], "sections": [
            {"name": s["name"], "items": [{"original": i, "text": fixes.get(s["name"], {}).get(i, {}).get("text", i),
                                           "hidden": bool(fixes.get(s["name"], {}).get(i, {}).get("hidden")),
                                           "suspect": flagged.get(s["name"], {}).get(i)} for i in s["items"]]}
            for s in reference_sections(ref)]}  # 빈칸 문제는 요점 정리가 아니라 퀴즈로 나가고, 숨기기만 됩니다

    @app.put("/api/references/{key}/fix")
    def fix_reference(key: str, req: FixRequest, request: Request):
        require_teacher(request)
        ref = ref_by_key(key)
        if req.original not in next((s["items"] for s in reference_sections(ref) if s["name"] == req.section), []):
            raise HTTPException(404, "그 항목을 찾을 수 없습니다")
        if req.section == "빈칸 문제" and req.text not in (None, req.original):  # 빈칸 표시(두 칸 띄어쓰기)가 깨지기 쉬워
            raise HTTPException(400, "빈칸 문제는 숨기기만 할 수 있습니다")
        with fixes_lock:
            fixes = read_fixes()
            entry = fixes.setdefault(key, {}).setdefault(req.section, {}).setdefault(req.original, {})
            if req.text is not None:
                entry["text"] = req.text.strip()
            if req.hidden is not None:
                entry["hidden"] = req.hidden
            if entry.get("text") == req.original:  # 원래 글로 돌리면 고친 기록에서 뺍니다
                del entry["text"]
            if not entry.get("hidden"):
                entry.pop("hidden", None)
            for path in [(key, req.section, req.original), (key, req.section), (key,)]:  # 빈 칸은 지웁니다
                node = fixes
                for part in path[:-1]:
                    node = node[part]
                if not node[path[-1]]:
                    del node[path[-1]]
            fixes_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = fixes_path.with_name(fixes_path.name + ".tmp")
            tmp.write_text(json.dumps(fixes, ensure_ascii=False), encoding="utf-8")
            tmp.replace(fixes_path)
        return reference_detail(key)

    @app.get("/api/status")
    def status(request: Request):
        """선생님용 현황: 강의마다 학생이 받는 것(Claude 요점 정리 > 학원 정리 > 자동 목차 > 페이지만)과 자동 목차 진행률"""
        if entry_secret and _from_outside(request):
            require_teacher(request)  # 인터넷에서는 입장한 학생도 이용 통계·운영 기록을 보지 못하게
        counts = {"guide": 0, "summary": 0, "toc": 0, "pages": 0}
        target = done = recent = 0
        since = wall_clock() - 3 * 86400
        unanalyzed, fixes = [], read_fixes()
        videos = current_library()["videos"]
        for v in videos:
            entry = analysis_entry(v["id"])
            if not entry:
                unanalyzed.append(v["title"])
                continue
            summary = not entry["guide"] and shows_summary(v, fixes)
            counts["guide" if entry["guide"] else "summary" if summary else "toc" if entry["toc"] else "pages"] += 1
            # 밤 작업(academy.toc)과 같은 대상: 대본이 있고 Claude 요점 정리가 없는 강의
            if not entry["guide"] and entry["times"]:
                target += 1
                done += entry["toc_tried"]
                recent += entry["toc_tried"] and entry["modified"] >= since
        found = {"total": len(videos), "analyzed": len(videos) - len(unanalyzed), **counts,
                 "toc_progress": {"target": target, "done": done, "last_3_days": recent}, "unanalyzed": unanalyzed}
        if log_dir:
            # 밤 작업 로그에는 강의마다 '목차:' 줄이 쌓여서 날짜로 시작하는 상태 줄만 봅니다.
            found["ops"] = {"backup": _last_line(Path(log_dir) / "backup.log", dated=True),
                            "night": _last_line(Path(log_dir) / "toc.log", dated=True),
                            "new_videos": _last_line(Path(log_dir) / "new-videos.log")}
            found["usage"] = counted("usage.log", usage_summary)
            found["quiz"] = counted("quiz.log", quiz_summary)
        return found

    log_counts = {}  # 기록 파일 → (파일 시점·10분 단위·강의 목록, 센 결과): 몇 달 치 기록을 현황을 열 때마다 다 읽지 않게

    def counted(name, count):  # 기록이 늘었거나 10분이 지나면(최근 30일 창이 움직임) 다시 셉니다
        key = (stamp(Path(log_dir) / name), int(wall_clock() // 600), library["at"])
        if log_counts.get(name, (None,))[0] != key:
            log_counts[name] = (key, count())
        return log_counts[name][1]

    linked = {}  # 영상 id → (분석 파일·정리 고치기 시점, 시간을 붙인 학원 정리): 대본에서 시간을 찾는 일을 강의를 열 때마다 하지 않게

    @app.get("/api/videos/{video_id}")
    def video_detail(video_id: str, request: Request, view: bool = False):
        video = get_video(video_id)
        if view:  # 플레이어에서 강의를 열 때만 view=1
            record_open(video_id, request.client.host if request.client else "")
        key = (stamp(Path(data_dir) / f"{video_id}.json"), stamp(fixes_path))  # 읽기 전에 봐 둡니다(그사이 바뀌면 다음에 다시)
        analysis = read_analysis(video_id)
        # Claude 요점 정리는 학원 정리를 바탕으로 만들었으니, 없을 때만 학원 정리를 대본에서 찾은 시간과 함께 보냅니다.
        summaries = []
        if analysis and not analysis.get("guide"):
            if linked.get(video_id, (None,))[0] != key:
                linked[video_id] = (key, link_times(fixed(academy_summaries(video)), analysis.get("segments") or []))
            summaries = linked[video_id][1]
        if analysis:
            # 받아쓰기 대본과 화면 글자 원문은 틀린 곳이 많아 학생에게 보내지 않고, 질문하기·요점 정리에만 씁니다.
            analysis.pop("segments", None)
            analysis["pages"] = [{k: v for k, v in p.items() if k != "text"} for p in analysis.get("pages", [])]
            if analysis.get("guide"):
                analysis["guide"].pop("edits", None)  # 학원 정리에서 고친 내역은 선생님 확인용
            if (analysis.get("toc") or {}).get("chapters"):
                analysis["toc"]["chapters"] = [{**c, "title": _respell(c["title"], video["title"])}
                                               for c in analysis["toc"]["chapters"]]
        # 같은 폴더의 앞뒤 강의(목록은 이미 '2강 < 10강' 순서): 플레이어의 이전·다음 강의 버튼과 끝난 뒤 '다음 강의' 카드
        folder = video["title"].rpartition("/")[0]
        siblings = [v for v in current_library()["videos"] if v["title"].rpartition("/")[0] == folder]
        ids = [v["id"] for v in siblings]
        at = ids.index(video_id) if video_id in ids else len(siblings) + 1  # 목록을 막 다시 훑은 순간이면 앞뒤 없음
        near = lambda i: {"id": siblings[i]["id"], "title": siblings[i]["title"]} if 0 <= i < len(siblings) else None
        return {"id": video_id, "title": video["title"], "analysis": analysis, "references": summaries,
                "prev": near(at - 1), "next": near(at + 1)}

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

    limits = _AskLimits()

    @app.post("/api/videos/{video_id}/ask")
    def ask(video_id: str, req: AskRequest, request: Request):
        if answer is None:
            raise HTTPException(403, "질문하기는 지금 쓰지 않습니다")
        get_video(video_id)
        data = read_analysis(video_id)
        if not data or not data["segments"]:
            raise HTTPException(409, "아직 분석되지 않은 영상이라 질문할 수 없습니다")
        # 인터넷에서 온 학생은 입장 통과(쿠키)마다 셉니다. 학원 내부망과 입장 확인을 끈 서버는 아무도 쿠키를
        # 확인하지 않아 마음대로 바꿔 보낼 수 있으므로 기기(접속 주소)마다 셉니다.
        cookie = request.cookies.get(PASS_COOKIE)
        if entry_secret and cookie and _from_outside(request):
            person = hashlib.sha256(cookie.encode()).hexdigest()
        else:
            person = f"ip:{request.client.host if request.client else ''}"
        if not limits.at_once.acquire(blocking=False):
            raise HTTPException(503, "다른 학생들의 질문에 답하는 중입니다. 잠시 뒤 다시 해 주세요.")
        try:
            # 차례가 온 질문만 셉니다. 바빠서 돌려보낸 질문까지 세면 답을 한 번도 못 받고 막힙니다.
            reason = limits.refuse_reason(person, monotonic())
            if reason:
                raise HTTPException(429, reason)
            text = answer(data["title"], data["segments"], req.question,
                          [t.model_dump() for t in req.history], req.current_time)
        except HTTPException:
            raise
        except Exception:  # API 키 누락, 네트워크 오류, 응답 거절 등
            # 원인은 로그에만 남깁니다. 학생 화면에 내부 오류 문구를 보이지 않습니다.
            logging.exception("AI 답변 실패")
            raise HTTPException(502, "AI 답변을 받지 못했습니다. 잠시 뒤 다시 해 주세요.")
        finally:
            limits.at_once.release()
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


def _search_word(q):
    """검색어를 띄어쓰기·기호 없이 맞춥니다. 너무 짧거나 길면 400."""
    word = _norm(q)
    if len(word) < 2:
        raise HTTPException(400, "두 글자 이상 넣어 주세요")
    if len(word) > MAX_QUERY:
        raise HTTPException(400, f"검색어는 {MAX_QUERY}글자까지 넣어 주세요")
    return word


def _near(word, spaced=False):
    """받아쓰기가 한 음절의 자음이나 모음 하나만 다르게 적은 말('제망매가'→'제막매가')을 찾는 정규식. 세 글자 이상만.

    spaced면 음절 사이 띄어쓰기도 허용합니다('성의 꽃').
    """
    branches = [pattern for _, pattern in _near_branches(word, spaced)]
    return re.compile("|".join(branches)) if branches else None


def _near_branches(word, spaced=False):
    """_near의 갈래마다 (바뀌는 음절 자리, 정규식 글). 갈래 하나가 한 음절이 다른 말 하나입니다."""
    sep = r"\s?" if spaced else ""
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
        parts = [re.escape(c) for c in word]
        parts[i] = f"[{syllables}]"
        branches.append((i, sep.join(parts)))
    return branches


def _near_filter(word):
    """_near(word)가 이 글에서 무엇이라도 찾는지 빨리 답하는 함수(띄어쓰기 없는 대본용). 갈래마다 바뀌지 않는 앞뒤 글이 그대로
    들어 있을 때만 그 갈래의 정규식을 돌립니다. 3,900개 대본에서 '선생님 말' 찾기가 1초 넘게 걸리던 것을 줄입니다."""
    checks = [(word[:i], word[i + 1:], re.compile(pattern)) for i, pattern in _near_branches(word)]
    return lambda text: any(before in text and after in text and pattern.search(text) for before, after, pattern in checks)


def _respell(text, lecture_title):
    """자동 목차 제목의 받아쓰기 오류 중, 파일 이름의 작품명과 소리 하나 다른 말을 작품명으로 바로잡습니다('성의 꽃'→'성에꽃')."""
    for part in re.split(r"[,_()\[\]·\-~]|\d+", lecture_title.rsplit("/", 1)[-1]):
        name = re.sub(r"[^가-힣]", "", part)
        if len(name) >= 3 and (pattern := _near(name, spaced=True)):
            spelled = " ".join(re.sub(r"[^가-힣 ]", "", part).split())  # 파일 이름의 띄어쓰기 그대로('운수 좋은 날')
            text = pattern.sub(spelled, text)
    return text


def _claude_answer():
    from academy.ai import answer_question

    client = None

    def answer(*args):
        nonlocal client
        if client is None:  # API 키 없이도 영상 시청은 되도록, 첫 질문 때 연결합니다.
            client = anthropic.Anthropic()
        return answer_question(client, *args)

    return answer



def _ignored_hosts(text):
    """USAGE_IGNORE의 주소들. 쉼표 뒤 띄어쓰기는 무시합니다('192.168.0.6, 192.168.0.7')."""
    return tuple(host.strip() for host in text.split(",") if host.strip())


app = create_app(Path(os.environ.get("VIDEO_DIR", "videos")),
                 Path(os.environ.get("DATA_DIR", "data")),
                 None,  # 질문하기는 Claude API 크레딧을 써서 막아 둡니다. 다시 열려면 _claude_answer()를 넘깁니다.
                 load_references(os.environ.get("REFERENCES_FILE")),
                 os.environ.get("LOG_DIR"),
                 _ignored_hosts(os.environ.get("USAGE_IGNORE", "")),  # 이용 통계에서 뺄 기기 주소(원장님 PC 등)
                 _teacher_key(os.environ.get("TEACHER_KEY_FILE")),
                 *entry_settings(os.environ))  # 인터넷으로 열 때만: 학원 사이트 입장 확인(docs/인터넷-열기.md)
