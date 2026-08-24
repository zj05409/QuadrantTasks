# QuadrantTasks

自托管艾森豪威尔四象限任务：**PWA 前端 + FastAPI JSON 同步**，Mac / Ubuntu / Android / iOS 浏览器或「添加到主屏幕」即可用。

| | |
|---|---|
| 生产入口 | `https://42.193.252.30/quadrant/` |
| 版本 | [`server/version.py`](server/version.py) |
| 许可 | [MIT](LICENSE) |

## 架构

```text
PWA (static/)  --Bearer-->  FastAPI (server/)  -->  tasks.json
     |                           |
  localStorage              last-write-wins merge
  + Service Worker          + ETag / 304
```

- **权威数据**：服务器 `tasks.json`（生产：`/var/lib/quadrant-tasks`）
- **冲突**：按任务 `updatedAt` 最后写入获胜；`deleted: true` 为墓碑
- **流量**：前台约 45s 条件 GET（304）；仅本地有改动时 PUT

## 本地开发

```bash
python3 -m venv .venv && source .venv/bin/activate
make install-dev
make test
make run   # http://127.0.0.1:18765  默认令牌 devtoken
```

PWA 设置：同步地址 `http://127.0.0.1:18765`，令牌 `devtoken`。

## API

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/health` | 否 | `{ ok, service, version }` |
| GET | `/api/bootstrap` | 否 | 客户端引导 |
| GET | `/api/tasks` | Bearer | 支持 `If-None-Match` → 304 |
| PUT | `/api/tasks` | Bearer | `{ tasks, mode: "merge"\|"replace" }` |

## 部署

[deploy/DEPLOY.md](deploy/DEPLOY.md)

```bash
make package
TOKEN=your-token HOST=tencent-superhealth bash scripts/remote-install.sh
```

## 目录

```text
server/    FastAPI + store
static/    PWA
tests/     pytest
deploy/    systemd / nginx
scripts/   package / remote-install
```
