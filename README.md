# QuadrantTasks

自托管艾森豪威尔四象限任务：**PWA 前端 + FastAPI JSON 同步**，Mac / Ubuntu / Android / iOS 浏览器或「添加到主屏幕」即可用。

| | |
|---|---|
| 生产入口 | `https://42.193.252.30/quadrant/` |
| GitHub Pages | `https://zj05409.github.io/QuadrantTasks/`（纯前端，可选连同步服务器） |
| 版本 | [`server/version.py`](server/version.py) |
| 许可 | [MIT](LICENSE) |

## 架构

```text
PWA (static/)  --Bearer-->  FastAPI (server/)  -->  users/<name>/tasks.json
  自托管同源 或 GitHub Pages        |
     |                         令牌 → 用户 → 独立数据文件
  localStorage                 last-write-wins merge
  + Service Worker             + ETag / 304
```

- **权威数据**：服务器数据目录（生产：`/var/lib/quadrant-tasks`），每个用户一个文件
- **冲突**：按任务 `updatedAt` 最后写入获胜；`deleted: true` 为墓碑（180 天后清理）
- **流量**：前台约 45s 条件 GET（304）；仅本地有改动时 PUT
- **离线**：改动先存本地并标记待上传（刷新页面也不丢），联网后自动补传

## 多用户

一个用户 = 一个令牌 = 一份独立的任务数据。同一个人在多台设备上填同一个令牌即可同步。

| 方式 | 做法 |
|---|---|
| 管理员发令牌 | 服务器上 `python -m server.admin add alice`，把打印出的令牌发给对方（只显示一次） |
| 邀请码自助注册 | 设置 `QUADRANT_INVITE_CODE`，App「设置」里会出现「用邀请码注册」 |
| 旧的单用户令牌 | `QUADRANT_TOKEN` 继续有效，作为用户 `default`，数据仍在原 `tasks.json`，无需迁移 |

```bash
python -m server.admin list
python -m server.admin add alice        # 新建并打印令牌
python -m server.admin rotate alice     # 令牌泄露时重置
python -m server.admin remove alice --purge
```

`users.json` 只保存令牌的 SHA-256；增删用户无需重启服务。

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
| GET | `/api/bootstrap` | 否 | `{ signup, version }` 客户端引导 |
| GET | `/api/me` | Bearer | `{ user }` 当前用户 |
| POST | `/api/register` | 邀请码 | `{ name, inviteCode }` → `{ user, token }`（未开启时 404） |
| GET | `/api/tasks` | Bearer | 支持 `If-None-Match` → 304 |
| PUT | `/api/tasks` | Bearer | `{ tasks, mode: "merge"\|"replace" }` |

## 部署

### 自托管（前端 + 同步）

[deploy/DEPLOY.md](deploy/DEPLOY.md)

```bash
make package
HOST=tencent-superhealth bash scripts/remote-install.sh   # 保留服务器上已有的 env
```

### GitHub Pages（纯前端）

`.github/workflows/pages.yml` 在 `main` 的 `static/` 变化时自动发布。首次需要：

1. 仓库 **Settings → Pages → Source 选 “GitHub Actions”**
2. （可选）**Settings → Secrets and variables → Actions → Variables** 新建 `QUADRANT_SYNC_URL`，
   例如 `https://42.193.252.30/quadrant`，作为页面默认同步地址
3. 服务器 env 加 `QUADRANT_CORS_ORIGINS=https://zj05409.github.io` 并重启

不配同步地址也能用：任务只存在该浏览器里（本地模式）。

> Pages 是 HTTPS 页面，同步服务器必须是**浏览器信任证书**的 HTTPS。自签名证书会被浏览器直接拒绝，
> 需要域名 + Let's Encrypt（或 Let's Encrypt 的 IP 证书）；否则继续用自托管入口即可。

## 目录

```text
server/    FastAPI + store
static/    PWA
tests/     pytest
deploy/    systemd / nginx
scripts/   package / remote-install
```
