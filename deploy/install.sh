#!/usr/bin/env bash
# YMusic 云端部署脚本（在服务器上以 root 执行）
#
#   bash install.sh /tmp/ymusic-cloud.tar.gz
#
# 会做这些事：
#   1. 装 Node.js 22（NodeSource 源）
#   2. 建专用运行用户 ymusic + 目录 /opt/ymusic
#   3. 解压工程（不含 node_modules，服务端零第三方依赖）
#   4. 写 Linux 版 config.json（本机那份是 Windows 路径，不能用）
#   5. 探测本机公网 IP → 写进 public-url.txt（客户端 APK 打包时读它）
#   6. 装 systemd 服务并拉起 8788 / 8803
#
# 可以重复执行：已经装好的部分会跳过。

set -euo pipefail

TARBALL="${1:-/tmp/ymusic-cloud.tar.gz}"
APP_DIR=/opt/ymusic
LOG_DIR=/var/log/ymusic
RUN_USER=ymusic
MAIN_PORT=8788
ADMIN_PORT=8803

say()  { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✘ %s\033[0m\n' "$*"; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行：sudo bash $0 $TARBALL"
[[ -f "$TARBALL" ]] || die "找不到部署包：$TARBALL（先用 打包上传.py 传上来）"

# ── 1. Node.js ────────────────────────────────────────────────────────────
say "检查 Node.js"
if command -v node >/dev/null 2>&1; then
  MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
  if [[ "$MAJOR" -ge 18 ]]; then
    ok "已装 $(node -v)，版本够用，跳过"
    SKIP_NODE=1
  fi
fi
if [[ -z "${SKIP_NODE:-}" ]]; then
  say "安装 Node.js 22（NodeSource）"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
  ok "已装 $(node -v)"
fi
NODE_BIN=$(command -v node)

# ── 2. 运行用户与目录 ─────────────────────────────────────────────────────
say "准备运行环境"
if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$RUN_USER"
  ok "已创建用户 $RUN_USER"
else
  ok "用户 $RUN_USER 已存在"
fi
install -d -o "$RUN_USER" -g "$RUN_USER" -m 0755 "$APP_DIR"
install -d -o "$RUN_USER" -g "$RUN_USER" -m 0755 "$LOG_DIR"
install -d -o "$RUN_USER" -g "$RUN_USER" -m 0755 "$APP_DIR/downloads"
ok "目录就绪：$APP_DIR"

# ── 3. 解压工程 ───────────────────────────────────────────────────────────
say "解压部署包"
tar -xzf "$TARBALL" -C "$APP_DIR"
# Windows 上编辑过的文件可能带 CRLF，会让 shell 脚本炸掉，统一洗一遍
find "$APP_DIR" -maxdepth 3 -type f \( -name '*.sh' -o -name '*.service' \) \
  -exec sed -i 's/\r$//' {} + 2>/dev/null || true
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
[[ -f "$APP_DIR/server.mjs" ]] || die "包里没有 server.mjs，打包有问题"
[[ -f "$APP_DIR/admin/server.mjs" ]] || die "包里没有 admin/server.mjs"
ok "解压完成"

# ── 4. Linux 版配置 ───────────────────────────────────────────────────────
say "写入 Linux 版 config.json"
cat > "$APP_DIR/config.json" <<EOF
{
  "downloadDir": "$APP_DIR/downloads",
  "concurrency": 4
}
EOF
chown "$RUN_USER:$RUN_USER" "$APP_DIR/config.json"
ok "下载目录：$APP_DIR/downloads（并发提到 4，服务器带宽比家用宽带宽裕）"

# admin/sources.json 里写的是开发机上的 Windows 绝对路径（D:\WorkBuddy...），
# 搬到 Linux 上就是一个不存在的目录，管理台会显示「数据源无效」。这里整个重写成 Linux 版。
# 主数据源仍然指向 data/ —— 管理台和服务端必须共用同一份，否则改了账号这边不生效。
say "重写管理台数据源"
cat > "$APP_DIR/admin/sources.json" <<EOF
[
  {
    "id": "server",
    "name": "主数据目录（服务与界面共用）",
    "dir": "$APP_DIR/data",
    "main": true
  }
]
EOF
chown "$RUN_USER:$RUN_USER" "$APP_DIR/admin/sources.json"
ok "数据源指向 $APP_DIR/data"

# ── 5. 公网地址 ───────────────────────────────────────────────────────────
say "探测公网 IP"
PUB_IP=""
for probe in https://api.ipify.org https://ip.sb/ip https://ifconfig.me/ip; do
  PUB_IP=$(curl -fsS --max-time 6 "$probe" 2>/dev/null | tr -d ' \n' || true)
  [[ -n "$PUB_IP" ]] && break
done
if [[ -n "$PUB_IP" ]]; then
  echo "http://$PUB_IP:$MAIN_PORT" > "$APP_DIR/public-url.txt"
  # 引导页也同步一份：客户端万一先访问引导页，也能拿到这个地址
  if [[ -d "$APP_DIR/bootstrap" ]]; then
    cat > "$APP_DIR/bootstrap/addr.json" <<EOF
{
  "url": "http://$PUB_IP:$MAIN_PORT",
  "updated": "$(date -Iseconds)",
  "note": "YMusic 服务端公网地址"
}
EOF
  fi
  chown "$RUN_USER:$RUN_USER" "$APP_DIR/public-url.txt"
  ok "公网地址：http://$PUB_IP:$MAIN_PORT"
  warn "记得去云厂商控制台「防火墙 / 安全组」放行 $MAIN_PORT 和 $ADMIN_PORT 端口"
else
  warn "探测不到公网 IP，public-url.txt 就没写。稍后手动补："
  warn "  echo http://你的公网IP:$MAIN_PORT > $APP_DIR/public-url.txt"
fi

# ── 6. systemd ────────────────────────────────────────────────────────────
say "安装 systemd 服务"
cd "$APP_DIR/deploy"
# ExecStart 里的 node 路径以本机实际为准
sed -i "s#^ExecStart=.*#ExecStart=$NODE_BIN $APP_DIR/server.mjs#" ymusic.service
sed -i "s#^ExecStart=.*#ExecStart=$NODE_BIN $APP_DIR/admin/server.mjs#" ymusic-admin.service
install -m 0644 ymusic.service /etc/systemd/system/
install -m 0644 ymusic-admin.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ymusic.service
systemctl enable --now ymusic-admin.service
ok "两个服务已设为开机自启并启动"

# ── 6b. 日志轮转 ──────────────────────────────────────────────────────────
# systemd 的 StandardOutput=append: 不会自动切分文件，进程又长期持有句柄，
# 不装 logrotate 日志会一直涨到撑满磁盘。配置里用 copytruncate 而非 create。
say "安装日志轮转规则"
install -m 0644 logrotate-ymusic.conf /etc/logrotate.d/ymusic
ok "已安装 /etc/logrotate.d/ymusic"

# ── 6c. 确认监听地址 ──────────────────────────────────────────────────────
# 这是最容易踩的坑：服务默认只绑 127.0.0.1，安全组放行 8788 外网照样连不上。
# ymusic.service 里已设 Environment=HOST=0.0.0.0，这里把它显式打出来便于核对。
say "核对监听地址（应为 0.0.0.0，若为 127.0.0.1 则外网连不上）"
LISTEN=$(ss -lntp 2>/dev/null | grep ":$MAIN_PORT" || echo "未检测到")
if echo "$LISTEN" | grep -q "0.0.0.0:$MAIN_PORT"; then
  ok "监听地址正确：$LISTEN"
else
  warn "监听地址异常，外网可能无法访问：$LISTEN"
fi

# ── 7. 冒烟 ───────────────────────────────────────────────────────────────
say "等待服务就绪并冒烟测试"
sleep 4
for port in $MAIN_PORT $ADMIN_PORT; do
  for _ in $(seq 1 20); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$port/" || echo 000)
    [[ "$code" == "200" ]] && break
    sleep 1
  done
  if [[ "$code" == "200" ]]; then
    ok "端口 $port 正常响应"
  else
    warn "端口 $port 还没起来（$code），看日志：journalctl -u ymusic -n 50"
  fi
done

say "完成"
echo "  管理台： http://${PUB_IP:-你的公网IP}:$ADMIN_PORT"
echo "  用户端： http://${PUB_IP:-你的公网IP}:$MAIN_PORT"
echo ""
echo "常用命令："
echo "  看状态  systemctl status ymusic ymusic-admin"
echo "  看日志  journalctl -u ymusic -f"
echo "  重启    systemctl restart ymusic"
echo "  更新本到云端后重启即可（工程文件在 $APP_DIR）"
