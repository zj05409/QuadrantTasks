"""Store merge unit tests."""

from __future__ import annotations

import tempfile
from pathlib import Path

from server.store import TaskStore, merge_task_lists, utc_now_iso


def test_merge_last_write_wins() -> None:
    a = [
        {
            "id": "1",
            "title": "old",
            "quadrant": 0,
            "updatedAt": "2020-01-01T00:00:00Z",
            "deleted": False,
        }
    ]
    b = [
        {
            "id": "1",
            "title": "new",
            "quadrant": 1,
            "updatedAt": "2021-01-01T00:00:00Z",
            "deleted": False,
        }
    ]
    merged = merge_task_lists(a, b)
    assert len(merged) == 1
    assert merged[0]["title"] == "new"
    assert merged[0]["quadrant"] == 1


def test_merge_keeps_tombstone() -> None:
    a = [
        {
            "id": "1",
            "title": "x",
            "quadrant": 0,
            "updatedAt": "2020-01-01T00:00:00Z",
            "deleted": False,
        }
    ]
    b = [
        {
            "id": "1",
            "title": "x",
            "quadrant": 0,
            "updatedAt": "2021-01-01T00:00:00Z",
            "deleted": True,
        }
    ]
    merged = merge_task_lists(a, b)
    assert merged[0]["deleted"] is True


def test_store_roundtrip() -> None:
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "tasks.json"
        store = TaskStore(path)
        doc = store.merge_put(
            [
                {
                    "id": "a",
                    "title": "hello",
                    "note": "",
                    "quadrant": 0,
                    "isDone": False,
                    "createdAt": utc_now_iso(),
                    "completedAt": None,
                    "updatedAt": utc_now_iso(),
                    "deleted": False,
                }
            ]
        )
        assert doc["revision"] == 1
        assert store.get()["tasks"][0]["title"] == "hello"


def test_prune_old_tombstones() -> None:
    from server.store import prune_tombstones

    tasks = merge_task_lists(
        [],
        [
            {"id": "old", "updatedAt": "2020-01-01T00:00:00Z", "deleted": True},
            {"id": "new", "updatedAt": utc_now_iso(), "deleted": True},
            {"id": "live", "updatedAt": "2020-01-01T00:00:00Z", "deleted": False},
        ],
    )
    assert sorted(t["id"] for t in prune_tombstones(tasks)) == ["live", "new"]


def test_title_truncated() -> None:
    merged = merge_task_lists([], [{"id": "1", "title": "x" * 500, "updatedAt": utc_now_iso()}])
    assert len(merged[0]["title"]) == 200


def test_store_picks_up_external_edits() -> None:
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "tasks.json"
        store = TaskStore(path)
        assert store.get()["revision"] == 0
        TaskStore(path).merge_put([{"id": "x", "title": "ext", "updatedAt": utc_now_iso()}])
        assert store.get()["tasks"][0]["title"] == "ext"
