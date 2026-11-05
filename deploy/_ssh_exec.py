# -*- coding: utf-8 -*-
"""云端 SSH 执行器：在服务器上跑命令并实时打印输出。

用法: python _ssh_exec.py <host> <user> <password> "<命令1>" ["命令2" ...]
"""
import sys
import time

import paramiko

HOST = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
USER = sys.argv[2] if len(sys.argv) > 2 else "root"
PWD = sys.argv[3] if len(sys.argv) > 3 else None
CMDS = sys.argv[4:]


def main():
    if not CMDS:
        print("用法: _ssh_exec.py <host> <user> <pwd> \"<命令>\" [...]")
        return 1
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, port=22, username=USER, password=PWD, timeout=20,
              look_for_keys=False, allow_agent=False)
    print("已连接 %s\n" % HOST + "=" * 64)
    for cmd in CMDS:
        print("\n$ %s" % cmd)
        t0 = time.time()
        try:
            _, out, err = c.exec_command(cmd, timeout=180)
            o = out.read().decode("utf-8", "replace").rstrip()
            e = err.read().decode("utf-8", "replace").rstrip()
            code = out.channel.recv_exit_status()
            if o:
                print(o)
            if e:
                print("[stderr] " + e[:400])
            print("[exit=%d  %.1fs]" % (code, time.time() - t0))
        except Exception as ex:
            print("!! 异常: %s" % ex)
        sys.stdout.flush()
    c.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
