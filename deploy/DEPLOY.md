# 部署到 tencent-superhealth（42.193.252.30）

目标入口：`https://42.193.252.30/quadrant/`

【需要sudo】以下步骤会改 Nginx、装 systemd、写 `/etc/...` 与 `/opt/...`。  
风险：写错 `location` 可能影响同机其它站点；先 `nginx -t`，失败则禁止 reload。  
回滚：删 conf、停服务、还原文件（文末）。

---

## 0. 本机准备（你确认后执行）

在开发机生成令牌（只显示一次，请自行保存）：

```bash
python3 -c 'import secrets; print(secrets.token_urlsafe(24))'
```

打包目录（不含 venv / data；禁用 macOS AppleDouble）：

```bash
make package   # 输出 /tmp/quadrant-tasks-web.tgz
```

---

## 1. 上传并安装应用 【需要sudo】

```bash
scp /tmp/quadrant-tasks-web.tgz tencent-superhealth:/tmp/
ssh tencent-superhealth 'bash -s' <<'EOF'
set -euo pipefail
sudo rm -rf /opt/quadrant-tasks
sudo mkdir -p /opt/quadrant-tasks /var/lib/quadrant-tasks
sudo tar xzf /tmp/quadrant-tasks-web.tgz -C /opt/quadrant-tasks
sudo chown -R ubuntu:ubuntu /opt/quadrant-tasks /var/lib/quadrant-tasks
cd /opt/quadrant-tasks
python3 -m venv .venv
.venv/bin/pip install -U pip
.venv/bin/pip install -r requirements.txt
EOF
```

---

## 2. 写入环境与 systemd 【需要sudo】

把 `YOUR_TOKEN` 换成第 0 步生成的令牌：

```bash
ssh tencent-superhealth 'bash -s' <<'EOF'
set -euo pipefail
TOKEN='YOUR_TOKEN'
sudo tee /etc/quadrant-tasks.env >/dev/null <<ENV
QUADRANT_TOKEN=$TOKEN
QUADRANT_DATA_DIR=/var/lib/quadrant-tasks
ENV
sudo chmod 600 /etc/quadrant-tasks.env
sudo chown root:root /etc/quadrant-tasks.env
sudo cp /opt/quadrant-tasks/deploy/quadrant-tasks.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now quadrant-tasks
sudo systemctl status quadrant-tasks --no-pager
curl -sS http://127.0.0.1:18765/api/health
EOF
```

验证：

```bash
ssh tencent-superhealth 'curl -sS http://127.0.0.1:18765/api/health; sudo ss -lntp | grep 18765'
```

期望：`{"ok":true,...}` 且 `127.0.0.1:18765` 在听。

---

## 3. Nginx 反代 【需要sudo】

**不要**直接把 `location` 丢进会当作独立 `server` 的文件。应并入现有 `443` 的 `server { ... }`。

探查（只读）：

```bash
ssh tencent-superhealth 'sudo nginx -T 2>/dev/null | grep -n "server_name\|listen 443\|conf.d" | head -40'
```

把 [nginx-quadrant.conf](nginx-quadrant.conf) 里的两段 `location` **粘进现有 HTTPS server 块**，或：

```bash
# 若确认现有 443 server 有 include snippets 习惯，再按实际路径调整
scp deploy/nginx-quadrant.conf tencent-superhealth:/tmp/nginx-quadrant.conf
ssh tencent-superhealth 'bash -s' <<'EOF'
set -euo pipefail
# 示例：若站点主配置支持 include，请改成真实路径；否则请手动粘贴 location
echo "请把 /tmp/nginx-quadrant.conf 内容并入现有 listen 443 的 server 块后执行："
echo "  sudo nginx -t && sudo systemctl reload nginx"
EOF
```

强制顺序：

1. 改配置  
2. `sudo nginx -t`（失败则**禁止** reload）  
3. `sudo systemctl reload nginx`（不要 restart，降低断连风险）

验证：

```bash
curl -sS https://42.193.252.30/quadrant/api/health
curl -sS -o /dev/null -w '%{http_code}\n' https://42.193.252.30/quadrant/
```

---

## 4. 多用户 / GitHub Pages（可选）

新建用户（以 ubuntu 身份运行，服务无需重启）：

```bash
ssh tencent-superhealth 'cd /opt/quadrant-tasks && QUADRANT_DATA_DIR=/var/lib/quadrant-tasks .venv/bin/python -m server.admin add alice'
```

开启邀请码自助注册、允许 GitHub Pages 前端跨域访问：

```bash
CORS_ORIGINS=https://zj05409.github.io INVITE_CODE='长随机串' \
  HOST=tencent-superhealth bash scripts/remote-install.sh
```

（或手动在 `/etc/quadrant-tasks.env` 里加 `QUADRANT_CORS_ORIGINS` / `QUADRANT_INVITE_CODE` 后
`sudo systemctl restart quadrant-tasks`。）Nginx 的 `location /quadrant/` 里建议加上
`client_max_body_size 4m;`，见 [nginx-quadrant.conf](nginx-quadrant.conf)。

验证 CORS：

```bash
curl -sSI -X OPTIONS https://42.193.252.30/quadrant/api/tasks \
  -H 'Origin: https://zj05409.github.io' -H 'Access-Control-Request-Method: GET' | grep -i access-control
```

---

## 5. 客户端

1. 浏览器打开 `https://42.193.252.30/quadrant/`  
2. 设置 → 同步地址：`https://42.193.252.30/quadrant`  
3. 令牌：你自己的用户令牌（或 `/etc/quadrant-tasks.env` 里的旧 `QUADRANT_TOKEN`）  
4. iOS：Safari → 分享 → 添加到主屏幕  

四端重复上述配置即可。

---

## 回滚

```bash
ssh tencent-superhealth 'bash -s' <<'EOF'
sudo systemctl disable --now quadrant-tasks || true
sudo rm -f /etc/systemd/system/quadrant-tasks.service
sudo systemctl daemon-reload
# 从 HTTPS server 块中删除 /quadrant/ location 后：
sudo nginx -t && sudo systemctl reload nginx
# 可选：sudo rm -rf /opt/quadrant-tasks /var/lib/quadrant-tasks /etc/quadrant-tasks.env
EOF
```

数据在 `/var/lib/quadrant-tasks/`（`tasks.json` 为旧单用户数据，`users.json` + `users/<name>/` 为多用户），删目录前请先备份。
