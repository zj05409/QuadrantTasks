"""HTTP API tests (auth, ETag, merge)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("QUADRANT_TOKEN", "test-token")
    monkeypatch.setenv("QUADRANT_DATA_DIR", str(tmp_path))
    # Import after env is set so module-level store picks up DATA_DIR.
    import importlib

    import server.app as app_mod
    import server.store as store_mod

    importlib.reload(store_mod)
    importlib.reload(app_mod)
    # Rebind store to tmp path (reload may still use old TOKEN from env — OK).
    app_mod.TOKEN = "test-token"
    app_mod.store = store_mod.TaskStore(tmp_path / "tasks.json")
    return TestClient(app_mod.app)


def auth() -> dict:
    return {"Authorization": "Bearer test-token"}


def test_health(client: TestClient) -> None:
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "version" in body


def test_tasks_requires_auth(client: TestClient) -> None:
    assert client.get("/api/tasks").status_code == 401


def test_put_get_and_etag(client: TestClient) -> None:
    payload = {
        "mode": "merge",
        "tasks": [
            {
                "id": "t1",
                "title": "工程化",
                "note": "",
                "quadrant": 0,
                "isDone": False,
                "createdAt": "2026-01-01T00:00:00Z",
                "completedAt": None,
                "updatedAt": "2026-01-01T00:00:00Z",
                "deleted": False,
            }
        ],
    }
    put = client.put("/api/tasks", headers=auth(), json=payload)
    assert put.status_code == 200
    assert put.json()["revision"] == 1
    etag = put.headers.get("etag")
    assert etag == '"1"'

    get = client.get("/api/tasks", headers=auth())
    assert get.status_code == 200
    assert get.json()["tasks"][0]["title"] == "工程化"

    not_mod = client.get("/api/tasks", headers={**auth(), "If-None-Match": etag})
    assert not_mod.status_code == 304
    assert not_mod.content == b""


def test_index_served(client: TestClient) -> None:
    r = client.get("/")
    assert r.status_code == 200
    assert "四象限" in r.text
