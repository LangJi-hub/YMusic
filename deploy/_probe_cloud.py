# -*- coding: utf-8 -*-
"""云端只读探查：连上服务器看清楚环境，不做任何修改。
用法: python _probe_cloud.py <host> <user> <password>
"""
import sys
import paramiko

HOST = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
USER = sys.argv[2] if len(sys.argv) > 2 else "root"
PWD = sys.argv[3] if len(sys.argv) > 3 else None
PORT = 22

CMDS = [
    ("系统版本", "cat /etc/os-release | head -3"),
    ("内核/架构", "uname -a"),
    ("CPU", "nproc"),
    ("内存", "free -h | head -2"),
    ("磁盘", "df -h / | tail -1"),
    ("是否已装 node", "which node npm 2>/dev/null; node -v 2>/dev/null || echo 'no node'"),
    ("是否已装 python3", "python3 -V 2>/dev/null || echo 'no python3'"),
    ("8788 是否被占", "ss -lntp 2>/dev/null | grep ':8788' || echo '8788 空闲'"),
    ("/opt 现状", "ls -la /opt 2>/dev/null | head -10"),
    ("是否已有 ymusic", "ls -la /opt/ymusic 2>/dev/null | head -5 || echo '无 /opt/ymusic'"),
    ("systemd 是否可用", "systemctl --version 2>/dev/null | head -1 || echo 'no systemd'"),
    ("包管理器", "which apt-get yum dnf 2>/dev/null"),
    ("能否出网", "curl -s -m 8 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/ 2>/dev/null || echo '出网失败'"),
]


def main():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print("连接 %s:%d ..." % (HOST, PORT))
    c.connect(HOST, port=PORT, username=USER, password=PWD, timeout=20,
              look_for_keys=False, allow_agent=False)
    print("登录成功\n" + "=" * 60)
    for name, cmd in CMDS:
        try:
            _, out, err = c.exec_command(cmd, timeout=25)
            o = out.read().decode("utf-8", "replace").strip()
            e = err.read().decode("utf-8", "replace").strip()
            print("\n【%s】" % name)
            print(o if o else (e if e else "(空)"))
        except Exception as ex:
            print("\n【%s】执行异常: %s" % (name, ex))
    c.close()
    print("\n" + "=" * 60)
    print("探查结束，未做任何修改。")


if __name__ == "__main__":
    main()
