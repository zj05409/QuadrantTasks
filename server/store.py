"""JSON document store with per-task last-write-wins merge."""

from __future__ import annotations

import json
import threading
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

MAX_TITLE = 200
MAX_NOTE = 2000
MAX_TASKS = 10000
# Tombstones older than this are dropped; a client offline longer than this
# could resurrect a deleted task, which is an acceptable trade-off.
TOMBSTONE_TTL = timedelta(days=180)


class TooManyTasks(ValueError):
    pass


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_ts(value: str | None) -> datetime:
    if not value:
        return datetime.min.replace(tzinfo=timezone.utc)
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def empty_document() -> dict[str, Any]:
    return {
        "revision": 0,
        "updatedAt": utc_now_iso(),
        "tasks": [],
    }


def normalize_task(raw: dict[str, Any]) -> dict[str, Any] | None:
    task_id = str(raw.get("id") or "").strip()
    title = str(raw.get("title") or "").strip()
    if not task_id:
        return None
    try:
        quadrant = int(raw.get("quadrant", 0))
    except (TypeError, ValueError):
        quadrant = 0
    if quadrant not in (0, 1, 2, 3):
        quadrant = 0
    return {
        "id": task_id,
        "title": title[:MAX_TITLE],
        "note": str(raw.get("note") or "").strip()[:MAX_NOTE],
        "quadrant": quadrant,
        "isDone": bool(raw.get("isDone", False)),
        "createdAt": str(raw.get("createdAt") or utc_now_iso()),
        "completedAt": raw.get("completedAt"),
        "updatedAt": str(raw.get("updatedAt") or utc_now_iso()),
        "deleted": bool(raw.get("deleted", False)),
    }


def merge_task_lists(a: list[dict[str, Any]], b: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Last-write-wins by updatedAt; keep tombstones so deletes propagate."""
    winners: dict[str, dict[str, Any]] = {}
    for raw in list(a) + list(b):
        task = normalize_task(raw)
        if task is None:
            continue
        prev = winners.get(task["id"])
        if prev is None or parse_ts(task["updatedAt"]) >= parse_ts(prev["updatedAt"]):
            winners[task["id"]] = task
    return sorted(winners.values(), key=lambda t: (t["quadrant"], t["createdAt"], t["id"]))


def prune_tombstones(
    tasks: list[dict[str, Any]], now: datetime | None = None
) -> list[dict[str, Any]]:
    cutoff = (now or datetime.now(timezone.utc)) - TOMBSTONE_TTL
    return [t for t in tasks if not (t["deleted"] and parse_ts(t["updatedAt"]) < cutoff)]


def check_size(tasks: list[dict[str, Any]]) -> None:
    if len(tasks) > MAX_TASKS:
        raise TooManyTasks(f"too many tasks (>{MAX_TASKS})")


class TaskStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        # Parsed document cached by file mtime: polls are mostly 304s, so skip
        # re-reading and re-normalizing the JSON on every request.
        self._cache: dict[str, Any] | None = None
        self._cache_mtime: int | None = None
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self._write(empty_document())

    def _read(self) -> dict[str, Any]:
        try:
            mtime = self.path.stat().st_mtime_ns
        except OSError:
            mtime = None
        if self._cache is not None and mtime is not None and mtime == self._cache_mtime:
            return self._cache
        doc = self._load()
        self._cache, self._cache_mtime = doc, mtime
        return doc

    def _load(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return empty_document()
        if not isinstance(data, dict):
            return empty_document()
        tasks = data.get("tasks")
        if not isinstance(tasks, list):
            tasks = []
        return {
            "revision": int(data.get("revision") or 0),
            "updatedAt": str(data.get("updatedAt") or utc_now_iso()),
            "tasks": [t for t in (normalize_task(x) for x in tasks if isinstance(x, dict)) if t],
        }

    def _write(self, doc: dict[str, Any]) -> None:
        tmp = self.path.with_suffix(".tmp")
        payload = json.dumps(doc, ensure_ascii=False, indent=2)
        tmp.write_text(payload + "\n", encoding="utf-8")
        tmp.replace(self.path)
        self._cache = None

    def get(self) -> dict[str, Any]:
        with self._lock:
            return deepcopy(self._read())

    def merge_put(self, incoming_tasks: list[dict[str, Any]]) -> dict[str, Any]:
        with self._lock:
            current = self._read()
            merged = prune_tombstones(merge_task_lists(current["tasks"], incoming_tasks))
            check_size(merged)
            doc = {
                "revision": int(current["revision"]) + 1,
                "updatedAt": utc_now_iso(),
                "tasks": merged,
            }
            self._write(doc)
            return deepcopy(doc)

    def replace(self, incoming_tasks: list[dict[str, Any]]) -> dict[str, Any]:
        """Full replace (admin / migration). Still normalizes tasks."""
        with self._lock:
            tasks = merge_task_lists([], incoming_tasks)
            check_size(tasks)
            doc = {
                "revision": int(self._read()["revision"]) + 1,
                "updatedAt": utc_now_iso(),
                "tasks": tasks,
            }
            self._write(doc)
            return deepcopy(doc)
