"""QuadrantTasks sync + PWA host.

Dev:
  QUADRANT_TOKEN=devtoken uvicorn server.app:app --reload --port 18765

Prod: 127.0.0.1:18765 behind Nginx at /quadrant/
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response as RawResponse

from server.models import TasksPayload
from server.store import TaskStore
from server.version import __version__

ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "static"
DATA_DIR = Path(os.environ.get("QUADRANT_DATA_DIR", str(ROOT / "data")))
STORE_PATH = DATA_DIR / "tasks.json"
TOKEN = os.environ.get("QUADRANT_TOKEN", "").strip()

store = TaskStore(STORE_PATH)

app = FastAPI(
    title="QuadrantTasks Sync",
    version=__version__,
    docs_url=None,
    redoc_url=None,
)


def require_token(authorization: Optional[str] = Header(default=None)) -> None:
    if not TOKEN:
        raise HTTPException(status_code=503, detail="Server token not configured")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    got = authorization.split(" ", 1)[1].strip()
    if not secrets.compare_digest(got, TOKEN):
        raise HTTPException(status_code=401, detail="Invalid token")


def etag_for(doc: Dict[str, Any]) -> str:
    return f'"{int(doc.get("revision") or 0)}"'


def _static_file(name: str, media_type: Optional[str] = None, no_cache: bool = False) -> FileResponse:
    path = STATIC_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    headers = {"Cache-Control": "no-cache"} if no_cache else {"Cache-Control": "public, max-age=3600"}
    kwargs: Dict[str, Any] = {"path": path, "headers": headers}
    if media_type:
        kwargs["media_type"] = media_type
    return FileResponse(**kwargs)


@app.get("/api/health")
def health() -> Dict[str, Any]:
    return {"ok": True, "service": "quadrant-tasks", "version": __version__}


@app.get("/api/tasks", response_model=None)
def get_tasks(
    response: Response,
    _: None = Depends(require_token),
    if_none_match: Optional[str] = Header(default=None, alias="If-None-Match"),
):
    doc = store.get()
    tag = etag_for(doc)
    response.headers["ETag"] = tag
    response.headers["Cache-Control"] = "no-cache"
    if if_none_match and if_none_match.strip() == tag:
        return RawResponse(status_code=304, headers={"ETag": tag, "Cache-Control": "no-cache"})
    return doc


@app.put("/api/tasks")
def put_tasks(
    payload: TasksPayload,
    response: Response,
    _: None = Depends(require_token),
) -> Dict[str, Any]:
    if payload.mode == "replace":
        doc = store.replace(payload.tasks)
    else:
        doc = store.merge_put(payload.tasks)
    response.headers["ETag"] = etag_for(doc)
    response.headers["Cache-Control"] = "no-cache"
    return doc


@app.get("/api/bootstrap")
def bootstrap() -> Dict[str, Any]:
    return {
        "ok": True,
        "authRequired": True,
        "defaultSyncPath": "/quadrant",
        "version": __version__,
    }


_assets = STATIC_DIR / "assets"
if _assets.is_dir():
    app.mount("/assets", StaticFiles(directory=_assets), name="assets")


@app.get("/")
@app.get("/index.html")
def index() -> FileResponse:
    return _static_file("index.html", media_type="text/html; charset=utf-8", no_cache=True)


@app.get("/manifest.webmanifest")
def manifest() -> FileResponse:
    return _static_file(
        "manifest.webmanifest",
        media_type="application/manifest+json",
        no_cache=True,
    )


@app.get("/sw.js")
def service_worker() -> FileResponse:
    # SW must never be cached aggressively or clients stick on old shells.
    return _static_file("sw.js", media_type="application/javascript", no_cache=True)


@app.get("/icon.svg")
def icon() -> FileResponse:
    return _static_file("icon.svg", media_type="image/svg+xml")


@app.get("/{path:path}")
def spa_fallback(path: str, request: Request):
    if path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not found")
    # Reject path traversal.
    candidate = (STATIC_DIR / path).resolve()
    try:
        candidate.relative_to(STATIC_DIR.resolve())
    except ValueError:
        raise HTTPException(status_code=404, detail="Not found") from None
    if candidate.is_file():
        return FileResponse(candidate)
    return _static_file("index.html", media_type="text/html; charset=utf-8", no_cache=True)
