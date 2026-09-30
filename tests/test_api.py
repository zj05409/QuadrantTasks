"""HTTP API tests (auth, ETag, merge, multi-user, sign-up, CORS)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.app import Settings, create_app


def make_client(tmp_path: Path, **overrides) -> TestClient:
    settings = Settings(data_dir=tmp_path, legacy_token="test-token", **overrides)
    return TestClient(create_app(settings))


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    return make_client(tmp_path)


def auth(token: str = "test-token") -> dict:
    return {"Authorization": f"Bearer {token}"}


def task(task_id: str, title: str, updated: str = "2026-01-01T00:00:00Z", **extra) -> dict:
    return {
        "id": task_id,
        "title": title,
        "note": "",
        "quadrant": 0,
        "isDone": False,
        "createdAt": "2026-01-01T00:00:00Z",
        "completedAt": None,
        "updatedAt": updated,
        "deleted": False,
        **extra,
    }


def test_health(client: TestClient) -> None:
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "version" in body


def test_tasks_requires_auth(client: TestClient) -> None:
    assert client.get("/api/tasks").status_code == 401
    assert client.get("/api/tasks", headers=auth("nope")).status_code == 401


def test_no_users_configured(tmp_path: Path) -> None:
    c = TestClient(create_app(Settings(data_dir=tmp_path)))
    assert c.get("/api/tasks", headers=auth()).status_code == 503


def test_put_get_and_etag(client: TestClient, tmp_path: Path) -> None:
    put = client.put(
        "/api/tasks", headers=auth(), json={"mode": "merge", "tasks": [task("t1", "工程化")]}
    )
    assert put.status_code == 200
    assert put.json()["revision"] == 1
    etag = put.headers.get("etag")
    assert etag == '"1"'
    # Legacy token keeps using the original file.
    assert (tmp_path / "tasks.json").is_file()

    get = client.get("/api/tasks", headers=auth())
    assert get.status_code == 200
    assert get.json()["tasks"][0]["title"] == "工程化"

    not_mod = client.get("/api/tasks", headers={**auth(), "If-None-Match": etag})
    assert not_mod.status_code == 304
    assert not_mod.content == b""


def test_me(client: TestClient) -> None:
    assert client.get("/api/me", headers=auth()).json() == {"user": "default"}


def test_users_are_isolated(client: TestClient) -> None:
    registry = client.app.state.registry
    alice = registry.add_user("alice")
    bob = registry.add_user("bob")

    client.put("/api/tasks", headers=auth(alice), json={"tasks": [task("a1", "alice task")]})
    client.put("/api/tasks", headers=auth(bob), json={"tasks": [task("b1", "bob task")]})

    assert client.get("/api/me", headers=auth(alice)).json() == {"user": "alice"}
    a = client.get("/api/tasks", headers=auth(alice)).json()["tasks"]
    b = client.get("/api/tasks", headers=auth(bob)).json()["tasks"]
    legacy = client.get("/api/tasks", headers=auth()).json()["tasks"]
    assert [t["title"] for t in a] == ["alice task"]
    assert [t["title"] for t in b] == ["bob task"]
    assert legacy == []

    new_alice = registry.rotate_token("alice")
    assert client.get("/api/tasks", headers=auth(alice)).status_code == 401
    assert client.get("/api/tasks", headers=auth(new_alice)).status_code == 200

    registry.remove_user("bob")
    assert client.get("/api/tasks", headers=auth(bob)).status_code == 401


def register(c: TestClient, name: str, code: str):
    return c.post("/api/register", json={"name": name, "inviteCode": code})


def test_register_disabled_by_default(client: TestClient) -> None:
    assert client.get("/api/bootstrap").json()["signup"] is False
    assert register(client, "carol", "x").status_code == 404


def test_register_with_invite_code(tmp_path: Path) -> None:
    c = make_client(tmp_path, invite_code="letmein")
    assert c.get("/api/bootstrap").json()["signup"] is True
    assert register(c, "carol", "wrong").status_code == 403
    assert register(c, "Bad Name!", "letmein").status_code == 400
    assert register(c, "default", "letmein").status_code == 400

    r = register(c, "carol", "letmein")
    assert r.status_code == 200
    token = r.json()["token"]
    assert c.get("/api/me", headers=auth(token)).json() == {"user": "carol"}
    assert register(c, "carol", "letmein").status_code == 409


def test_register_throttled(tmp_path: Path) -> None:
    c = make_client(tmp_path, invite_code="letmein")
    for _ in range(10):
        assert register(c, "dave", "wrong").status_code == 403
    assert register(c, "dave", "letmein").status_code == 429


def test_cors(tmp_path: Path) -> None:
    origin = "https://example.github.io"
    c = make_client(tmp_path, cors_origins=[origin])
    pre = c.options(
        "/api/tasks",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "PUT",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert pre.status_code == 200
    assert pre.headers["access-control-allow-origin"] == origin
    r = c.get("/api/tasks", headers={**auth(), "Origin": origin})
    assert "etag" in r.headers["access-control-expose-headers"].lower()

    other = c.get("/api/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in other.headers


def test_body_limit(tmp_path: Path) -> None:
    c = make_client(tmp_path, max_body=100)
    r = c.put("/api/tasks", headers=auth(), json={"tasks": [task("t1", "x" * 200)]})
    assert r.status_code == 413


def test_index_served(client: TestClient) -> None:
    r = client.get("/")
    assert r.status_code == 200
    assert "四象限" in r.text
    assert client.get("/config.js").status_code == 200
    assert client.get("/icon.svg").headers["content-type"].startswith("image/svg")
    assert "FastAPI" not in client.get("/%2e%2e/server/app.py").text
