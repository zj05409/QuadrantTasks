"""Multi-user registry: bearer token -> user name -> per-user TaskStore.

Users live in ``users.json`` (only SHA-256 of each token is stored)::

    {"users": [{"name": "alice", "tokenSha256": "...", "createdAt": "..."}]}

The legacy single-user ``QUADRANT_TOKEN`` keeps working as user ``default``
backed by the original ``<data>/tasks.json``, so existing deployments need no
migration. Every other user gets ``<data>/users/<name>/tasks.json``.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from server.store import TaskStore, utc_now_iso

LEGACY_USER = "default"
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_token() -> str:
    return secrets.token_urlsafe(24)


def valid_name(name: str) -> bool:
    return bool(NAME_RE.match(name)) and name != LEGACY_USER


class UserRegistry:
    def __init__(self, data_dir: Path, users_file: Path, legacy_token: str = "") -> None:
        self.data_dir = data_dir
        self.users_file = users_file
        self.legacy_token = legacy_token.strip()
        self._lock = threading.RLock()
        self._stores: Dict[str, TaskStore] = {}
        self._by_hash: Dict[str, str] = {}
        self._mtime: Optional[float] = None

    # ---- users.json -------------------------------------------------------

    def _read_file(self) -> List[Dict[str, Any]]:
        try:
            data = json.loads(self.users_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        users = data.get("users") if isinstance(data, dict) else None
        if not isinstance(users, list):
            return []
        return [
            u
            for u in users
            if isinstance(u, dict)
            and valid_name(str(u.get("name") or ""))
            and isinstance(u.get("tokenSha256"), str)
        ]

    def _write_file(self, users: List[Dict[str, Any]]) -> None:
        self.users_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.users_file.with_suffix(".tmp")
        tmp.write_text(
            json.dumps({"users": users}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        tmp.chmod(0o600)
        tmp.replace(self.users_file)
        self._mtime = None

    def _refresh(self) -> None:
        """Reload users.json when it changes, so `server.admin` needs no restart."""
        try:
            mtime = self.users_file.stat().st_mtime
        except OSError:
            mtime = -1.0
        if mtime == self._mtime:
            return
        self._by_hash = {u["tokenSha256"]: u["name"] for u in self._read_file()}
        self._mtime = mtime

    # ---- auth / stores ----------------------------------------------------

    def authenticate(self, token: str) -> Optional[str]:
        token = token.strip()
        if not token:
            return None
        if self.legacy_token and secrets.compare_digest(token, self.legacy_token):
            return LEGACY_USER
        with self._lock:
            self._refresh()
            return self._by_hash.get(hash_token(token))

    def has_any_user(self) -> bool:
        with self._lock:
            self._refresh()
            return bool(self.legacy_token or self._by_hash)

    def store_path(self, name: str) -> Path:
        if name == LEGACY_USER:
            return self.data_dir / "tasks.json"
        return self.data_dir / "users" / name / "tasks.json"

    def store_for(self, name: str) -> TaskStore:
        with self._lock:
            store = self._stores.get(name)
            if store is None:
                store = TaskStore(self.store_path(name))
                self._stores[name] = store
            return store

    # ---- admin ------------------------------------------------------------

    def list_users(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [{"name": u["name"], "createdAt": u.get("createdAt")} for u in self._read_file()]

    def add_user(self, name: str) -> str:
        """Create a user and return its (only-shown-once) token."""
        if not valid_name(name):
            raise ValueError("用户名需为 1-32 位小写字母/数字/-/_，且不能是 default")
        with self._lock:
            users = self._read_file()
            if any(u["name"] == name for u in users):
                raise ValueError(f"用户 {name} 已存在")
            token = new_token()
            users.append(
                {"name": name, "tokenSha256": hash_token(token), "createdAt": utc_now_iso()}
            )
            self._write_file(users)
            return token

    def rotate_token(self, name: str) -> str:
        with self._lock:
            users = self._read_file()
            for u in users:
                if u["name"] == name:
                    token = new_token()
                    u["tokenSha256"] = hash_token(token)
                    self._write_file(users)
                    return token
            raise ValueError(f"用户 {name} 不存在")

    def remove_user(self, name: str) -> None:
        with self._lock:
            users = self._read_file()
            kept = [u for u in users if u["name"] != name]
            if len(kept) == len(users):
                raise ValueError(f"用户 {name} 不存在")
            self._write_file(kept)
            self._stores.pop(name, None)
