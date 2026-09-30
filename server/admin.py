"""User admin CLI (run on the server, as the service user).

  python -m server.admin list
  python -m server.admin add alice        # prints the new token once
  python -m server.admin rotate alice     # issues a new token, old one stops working
  python -m server.admin remove alice [--purge]

Reads QUADRANT_DATA_DIR / QUADRANT_USERS_FILE like the server does; the running
server picks up changes without a restart.
"""

from __future__ import annotations

import argparse
import shutil
import sys

from server.app import Settings
from server.users import LEGACY_USER, UserRegistry


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m server.admin", description=__doc__.split("\n")[0]
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="列出用户")
    for cmd, text in (("add", "新建用户并打印令牌"), ("rotate", "重置令牌")):
        sub.add_parser(cmd, help=text).add_argument("name")
    rm = sub.add_parser("remove", help="删除用户")
    rm.add_argument("name")
    rm.add_argument("--purge", action="store_true", help="同时删除该用户的任务数据")
    args = parser.parse_args(argv)

    settings = Settings.from_env()
    registry = UserRegistry(
        data_dir=settings.data_dir,
        users_file=settings.users_file or settings.data_dir / "users.json",
        legacy_token=settings.legacy_token,
    )

    try:
        if args.cmd == "list":
            if settings.legacy_token:
                print(f"{LEGACY_USER}\t(QUADRANT_TOKEN)")
            for u in registry.list_users():
                print(f"{u['name']}\t{u.get('createdAt') or ''}")
        elif args.cmd == "add":
            token = registry.add_user(args.name)
            print(f"用户 {args.name} 已创建，令牌（只显示这一次）：\n{token}")
        elif args.cmd == "rotate":
            token = registry.rotate_token(args.name)
            print(f"用户 {args.name} 的新令牌：\n{token}")
        elif args.cmd == "remove":
            registry.remove_user(args.name)
            if args.purge:
                shutil.rmtree(registry.store_path(args.name).parent, ignore_errors=True)
            print(f"用户 {args.name} 已删除" + ("（数据已清除）" if args.purge else ""))
    except ValueError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
