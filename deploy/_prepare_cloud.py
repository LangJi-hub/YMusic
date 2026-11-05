# -*- coding: utf-8 -*-
"""云端环境准备（不碰业务代码）：装 Node 22、建 ymusic 用户与目录、装日志轮转。
这一步与本地的 OTA 修复并行，节省时间。传工程由 install.sh 后续完成。
用法: python _prepare_cloud.py <host> <user> <password>
"""
import sys
import time
import paramiko

HOST = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
USER = sys.argv[2] if len(sys.argv) > 2 else "root"
PWD = sys.argv[3] if len(sys.argv) > 3 else None
PORT = 22
APP_DIR = "/opt/ymusic"
RUN_USER = "ymusic"

STEPS = [
    ("apt 更新索引", "apt-get update -qq", 180),
    ("装基础依赖", "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "
                   "ca-certificates curl gnupg logrotate >/dev/null 2>&1; echo done", 240),
    ("导入 NodeSource 公钥",
     "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key "
     "| gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && echo ok", 60),
    ("写 NodeSource 源",
     "echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] "
     "https://deb.nodesource.com/node_22.x nodistro main' "
     "> /etc/apt/sources.list.d/nodesource.list && echo ok", 30),
    ("apt 再更新", "apt-get update -qq", 180),
    ("装 Node.js 22", "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null 2>&1; node -v", 300),
    ("建运行用户", "id -u %s >/dev/null 2>&1 || useradd --system --home-dir %s "
                   "--shell /usr/sbin/nologin %s; echo ok" % (RUN_USER, APP_DIR, RUN_USER), 30),
    ("建应用目录", "mkdir -p %s /var/log/ymusic && echo ok" % APP_DIR, 30),
]


def run(c, cmd, timeout, label):
    t0 = time.time()
    _, out, err = c.exec_command(cmd, timeout=timeout)
    o = out.read().decode("utf-8", "replace").strip()
    e = err.read().decode("utf-8", "replace").strip()
    dt = time.time() - t0
    print("[%5.1fs] %-20s %s" % (dt, label, (o or e or "(空)")[:200]))
    sys.stdout.flush()
    return o, e


def main():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print("连接 %s ..." % HOST)
    c.connect(HOST, port=PORT, username=USER, password=PWD, timeout=20,
              look_for_keys=False, allow_agent=False)
    print("登录成功，开始环境准备\n" + "-" * 60)

    for label, cmd, timeout in STEPS:
        try:
            run(c, cmd, timeout, label)
        except Exception as ex:
            print("!! %s 失败: %s" % (label, ex))

    print("-" * 60)
    print("【最终确认】")
    for label, cmd in [("node", "node -v"), ("npm", "npm -v 2>/dev/null || echo '无 npm(不影响,服务端零依赖)'"),
                       ("用户", "id %s" % RUN_USER), ("目录", "ls -ld %s /var/log/ymusic" % APP_DIR),
                       ("logrotate", "which logrotate || echo '未装'")]:
        try:
            run(c, cmd, 30, label)
        except Exception as ex:
            print("!! %s: %s" % (label, ex))
    c.close()
    print("\n环境准备完成。业务代码尚未上传。")


if __name__ == "__main__":
    main()
