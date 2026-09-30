"""QuadrantTasks sync + PWA host.

Dev:
  QUADRANT_TOKEN=devtoken uvicorn server.app:app --reload --port 18765

Prod: 127.0.0.1:18765 behind Nginx at /quadrant/

Environment:
  QUADRANT_DATA_DIR      data root (tasks.json, users.json, users/<name>/)
  QUADRANT_TOKEN         legacy single-user token -> user "default" (optional)
  QUADRANT_USERS_FILE    user registry (default <data>/users.json)
  QUADRANT_INVITE_CODE   enables self sign-up via POST /api/register (optional)
  QUADRANT_CORS_ORIGINS  comma-separated origins allowed to call the API, e.g.
                         https://<you>.github.io (for the GitHub Pages front end)
  QUADRANT_MAX_BODY      max request body in bytes (default 4 MiB)
"""

from __future__ import annotations

import os
import secrets
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response as RawResponse

from server.models import RegisterPayload, TasksPayload
from server.store import TooManyTasks
from server.users import UserRegistry
from server.version import __version__

ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "static"

# Failed sign-up attempts allowed per client IP per window.
REGISTER_MAX_FAILS = 10
REGISTER_WINDOW_S = 600


@dataclass
class Settings:
    data_dir: Path
    legacy_token: str = ""
    users_file: Optional[Path] = None
    invite_code: str = ""
    cors_origins: List[str] = field(default_factory=list)
    max_body: int = 4 * 1024 * 1024

    @classmethod
    def from_env(cls) -> Settings:
        data_dir = Path(os.environ.get("QUADRANT_DATA_DIR", str(ROOT / "data")))
        users_file = os.environ.get("QUADRANT_USERS_FILE", "").strip()
        origins = os.environ.get("QUADRANT_CORS_ORIGINS", "")
        return cls(
            data_dir=data_dir,
            legacy_token=os.environ.get("QUADRANT_TOKEN", "").strip(),
            users_file=Path(users_file) if users_file else None,
            invite_code=os.environ.get("QUADRANT_INVITE_CODE", "").strip(),
            cors_origins=[o.strip().rstrip("/") for o in origins.split(",") if o.strip()],
            max_body=int(os.environ.get("QUADRANT_MAX_BODY", str(4 * 1024 * 1024))),
        )


def etag_for(doc: Dict[str, Any]) -> str:
    return f'"{int(doc.get("revision") or 0)}"'


def _static_file(
    name: str, media_type: Optional[str] = None, no_cache: bool = False
) -> FileResponse:
    path = STATIC_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    cache = "no-cache" if no_cache else "public, max-age=3600"
    kwargs: Dict[str, Any] = {"path": path, "headers": {"Cache-Control": cache}}
    if media_type:
        kwargs["media_type"] = media_type
    return FileResponse(**kwargs)


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    settings = settings or Settings.from_env()
    registry = UserRegistry(
        data_dir=settings.data_dir,
        users_file=settings.users_file or settings.data_dir / "users.json",
        legacy_token=settings.legacy_token,
    )
    register_fails: Dict[str, Deque[float]] = defaultdict(deque)
    register_lock = threading.Lock()

    app = FastAPI(
        title="QuadrantTasks Sync",
        version=__version__,
        docs_url=None,
        redoc_url=None,
    )
    app.state.registry = registry
    app.state.settings = settings

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_methods=["GET", "PUT", "POST"],
            allow_headers=["Authorization", "Content-Type", "If-None-Match"],
            expose_headers=["ETag"],
            max_age=86400,
        )

    @app.middleware("http")
    async def limit_body(request: Request, call_next):
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > settings.max_body:
            return JSONResponse({"detail": "Payload too large"}, status_code=413)
        return await call_next(request)

    def current_user(authorization: Optional[str] = Header(default=None)) -> str:
        if not registry.has_any_user():
            raise HTTPException(status_code=503, detail="No users configured")
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(status_code=401, detail="Missing bearer token")
        user = registry.authenticate(authorization.split(" ", 1)[1])
        if user is None:
            raise HTTPException(status_code=401, detail="Invalid token")
        return user

    @app.get("/api/health")
    def health() -> Dict[str, Any]:
        return {"ok": True, "service": "quadrant-tasks", "version": __version__}

    @app.get("/api/bootstrap")
    def bootstrap() -> Dict[str, Any]:
        return {
            "ok": True,
            "authRequired": True,
            "signup": bool(settings.invite_code),
            "defaultSyncPath": "/quadrant",
            "version": __version__,
        }

    @app.get("/api/me")
    def me(user: str = Depends(current_user)) -> Dict[str, Any]:
        return {"user": user}

    @app.get("/api/tasks", response_model=None)
    def get_tasks(
        response: Response,
        user: str = Depends(current_user),
        if_none_match: Optional[str] = Header(default=None, alias="If-None-Match"),
    ):
        doc = registry.store_for(user).get()
        tag = etag_for(doc)
        headers = {"ETag": tag, "Cache-Control": "no-cache"}
        if if_none_match and if_none_match.strip() == tag:
            return RawResponse(status_code=304, headers=headers)
        response.headers.update(headers)
        return doc

    @app.put("/api/tasks")
    def put_tasks(
        payload: TasksPayload,
        response: Response,
        user: str = Depends(current_user),
    ) -> Dict[str, Any]:
        store = registry.store_for(user)
        try:
            if payload.mode == "replace":
                doc = store.replace(payload.tasks)
            else:
                doc = store.merge_put(payload.tasks)
        except TooManyTasks as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from None
        response.headers["ETag"] = etag_for(doc)
        response.headers["Cache-Control"] = "no-cache"
        return doc

    @app.post("/api/register")
    def register(payload: RegisterPayload, request: Request) -> Dict[str, Any]:
        if not settings.invite_code:
            raise HTTPException(status_code=404, detail="Sign-up disabled")
        ip = request.client.host if request.client else "?"
        now = time.monotonic()
        with register_lock:
            fails = register_fails[ip]
            while fails and now - fails[0] > REGISTER_WINDOW_S:
                fails.popleft()
            if len(fails) >= REGISTER_MAX_FAILS:
                raise HTTPException(status_code=429, detail="Too many attempts, retry later")
            if not secrets.compare_digest(payload.inviteCode.strip(), settings.invite_code):
                fails.append(now)
                raise HTTPException(status_code=403, detail="Invalid invite code")
        name = payload.name.strip().lower()
        try:
            token = registry.add_user(name)
        except ValueError as exc:
            status = 409 if "已存在" in str(exc) else 400
            raise HTTPException(status_code=status, detail=str(exc)) from None
        return {"user": name, "token": token}

    assets = STATIC_DIR / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/")
    @app.get("/index.html")
    def index() -> FileResponse:
        return _static_file("index.html", media_type="text/html; charset=utf-8", no_cache=True)

    @app.get("/manifest.webmanifest")
    def manifest() -> FileResponse:
        return _static_file(
            "manifest.webmanifest", media_type="application/manifest+json", no_cache=True
        )

    @app.get("/sw.js")
    def service_worker() -> FileResponse:
        # SW must never be cached aggressively or clients stick on old shells.
        return _static_file("sw.js", media_type="application/javascript", no_cache=True)

    @app.get("/{path:path}")
    def spa_fallback(path: str):
        if path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        # Reject path traversal.
        candidate = (STATIC_DIR / path).resolve()
        try:
            candidate.relative_to(STATIC_DIR.resolve())
        except ValueError:
            raise HTTPException(status_code=404, detail="Not found") from None
        if candidate.is_file():
            # App code changes with each release; let the browser revalidate.
            no_cache = candidate.suffix in {".js", ".css", ".html"}
            return _static_file(path, no_cache=no_cache)
        return _static_file("index.html", media_type="text/html; charset=utf-8", no_cache=True)

    return app


app = create_app()
