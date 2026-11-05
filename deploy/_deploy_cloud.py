# -*- coding: utf-8 -*-
"""YMusic 上云部署（paramiko 版，非交互）。

打 tar.gz -> SFTP 上传 -> 解压 -> 跑 install.sh -> 验证 8788。
复用 deploy/打包上传.py 的白名单（它用命令行 scp，非交互下要不到密码，故另写此脚本）。

用法: python _deploy_cloud.py <host> <user> <password>
"""
import os
import sys
import tarfile
import time

import paramiko

HOST = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
USER = sys.argv[2] if len(sys.argv) > 2 else "root"
PWD = sys.argv[3] if len(sys.argv) > 3 else None
PORT = 22

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "dist", "ymusic-cloud.tar.gz")
REMOTE_TAR = "/tmp/ymusic-cloud.tar.gz"

# 与 deploy/打包上传.py 保持一致的白名单
INCLUDE_FILES = ["server.mjs", "config.json", "public-url.txt", "package.json",
                 "打包与分发说明.md", "一键打包.py",
                 # 管理端 OTA 元数据。server.mjs:65 的 ADMIN_APK_META 读的是
                 # android-admin/apk-release.json，而 android-admin/ 整个目录不在
                 # INCLUDE_DIRS 里 —— 漏了这个文件，云端 /api/app/admin-apk 就 404。
                 "android-admin/apk-release.json",
                 # 用户端 OTA 元数据
                 "data/apk-release.json"]
# ⚠️ 这里曾经是整个 "data" 目录，那是会丢生产数据的写法：
# data/users.json（用户账号）、sessions.json（登录会话）、secrets.json、
# deleted-users/、uploads/ 都是**运行时产生的生产数据**，每次部署用本地副本
# 覆盖上去，会把云端真实用户和会话直接冲掉，且不会报错。
# 所以 data/ 只放 OTA 相关的两部分：apk-release.json（上面）和 data/app-update/（下面）。
# 云端缺的其他 json 由 server.mjs 的 writeJSON 首次写入时自建。
INCLUDE_DIRS = ["web", "admin", "bootstrap", "deploy", "data/app-update"]
SKIP_NAMES = {"node_modules", "__pycache__", ".git", "backups", "admin-log.jsonl"}
SKIP_SUFFIX = (".jks", ".keystore", ".log", ".idsig", ".pyc", ".token", ".png",
               ".zip", ".exe", ".apk", ".msi", ".bat", ".cmd")
SKIP_EXACT = {"current-url.txt", "_junction.txt", "_procs.txt", "sea-main.cjs"}


def build_tarball():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    n = 0
    sizes = {}
    with tarfile.open(OUT, "w:gz", compresslevel=6) as tar:
        for rel in INCLUDE_FILES:
            p = os.path.join(ROOT, rel)
            if os.path.isfile(p):
                tar.add(p, arcname=rel)
                n += 1
        for d in INCLUDE_DIRS:
            base = os.path.join(ROOT, d)
            if not os.path.isdir(base):
                print("  · 跳过（不存在）%s/" % d)
                continue
            cnt, tot = 0, 0
            for dirpath, dirnames, filenames in os.walk(base):
                dirnames[:] = [x for x in dirnames if x not in SKIP_NAMES]
                for f in filenames:
                    if f in SKIP_NAMES or f in SKIP_EXACT:
                        continue
                    # OTA 例外：data/app-update/ 下的 apk/exe 是客户端更新时要下载的包，
                    # 必须上传。否则云端 /api/app/apk 会返回 404 / "apk file missing"。
                    rel_dir = os.path.relpath(dirpath, ROOT).replace("\\", "/")
                    if f.endswith(SKIP_SUFFIX) and not rel_dir.startswith("data/app-update"):
                        continue
                    full = os.path.join(dirpath, f)
                    tot += os.path.getsize(full)
                    arc = os.path.relpath(full, ROOT).replace("\\", "/")
                    tar.add(full, arcname=arc)
                    cnt += 1
                    n += 1
            sizes[d] = (cnt, tot / 1048576.0)
            print("  · %-12s %d 个文件  %.2f MB" % (d + "/", cnt, tot / 1048576.0))
        sh = os.path.join(ROOT, "deploy", "install.sh")
        if os.path.isfile(sh):
            tar.add(sh, arcname="deploy/install.sh")
    size = os.path.getsize(OUT) / 1048576.0
    print("\n  共 %d 个条目，压缩包 %.2f MB" % (n, size))
    return size


def stream_exec(c, cmd, timeout, label, tail=None):
    """边执行边打印，避免长命令看起来卡住。"""
    print("\n>>> [%s] %s" % (label, cmd if len(cmd) < 160 else cmd[:160] + " ..."))
    sys.stdout.flush()
    t0 = time.time()
    _, out, err = c.exec_command(cmd, timeout=timeout)
    buf = []
    while True:
        line = out.readline()
        if not line:
            if out.channel.exit_status_ready():
                break
            continue
        line = line.rstrip("\n")
        buf.append(line)
        print("    " + line)
        sys.stdout.flush()
    rest = out.read().decode("utf-8", "replace")
    if rest.strip():
        for line in rest.splitlines():
            buf.append(line)
            print("    " + line)
    e = err.read().decode("utf-8", "replace").strip()
    code = out.channel.recv_exit_status()
    print("<<< [%s] exit=%d  用时 %.1fs" % (label, code, time.time() - t0))
    if e:
        print("    stderr: " + e[:500])
    sys.stdout.flush()
    if tail:
        print("    --- 末尾输出 ---")
        for line in buf[-tail:]:
            print("    " + line)
    return code, "\n".join(buf), e


def main():
    print("=" * 66)
    print("步骤 1/5 · 本地打包")
    print("=" * 66)
    size = build_tarball()
    if size > 80:
        print("  ⚠ 超过 80MB，检查是否有大文件混进去")
        if "--force" not in sys.argv:
            print("  中止。确认无误后加 --force 重跑。")
            return 1

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print("\n" + "=" * 66)
    print("步骤 2/5 · 连接 %s" % HOST)
    print("=" * 66)
    c.connect(HOST, port=PORT, username=USER, password=PWD, timeout=20,
              look_for_keys=False, allow_agent=False)
    print("  登录成功")

    print("\n" + "=" * 66)
    print("步骤 3/5 · 上传 %.2f MB" % size)
    print("=" * 66)
    t0 = time.time()
    sftp = c.open_sftp()
    sftp.put(OUT, REMOTE_TAR)
    sftp.close()
    print("  上传完成，用时 %.1fs" % (time.time() - t0))
    st = c.exec_command("ls -la %s" % REMOTE_TAR)[1].read().decode().strip()
    print("  服务端: " + st)

    print("\n" + "=" * 66)
    print("步骤 4/5 · 解压并跑 install.sh")
    print("=" * 66)
    stream_exec(c, "rm -rf /tmp/deploy && mkdir -p /tmp/deploy && "
                   "tar -xzf %s -C /tmp && ls /tmp/deploy" % REMOTE_TAR, 120, "解压")
    code, out, err = stream_exec(
        c, "cd /tmp && bash /tmp/deploy/install.sh %s 2>&1" % REMOTE_TAR, 600,
        "install.sh", tail=25)
    if code != 0:
        print("\n!! install.sh 退出码 %d，部署可能未完成" % code)

    # 🔴 必须显式重启：install.sh 只解压文件，而服务若已 active，
    # systemctl start 不会重新加载代码 —— 不重启的话跑的仍是旧代码。
    # 这个坑踩过一次，写进脚本避免每次靠人记着。
    stream_exec(c, "systemctl restart ymusic ymusic-admin && sleep 4 && "
                   "systemctl is-active ymusic ymusic-admin", 90, "重启服务")
    stream_exec(c, "ss -lntp | grep -E ':8788|:8803'", 30, "重启后监听")

    print("\n" + "=" * 66)
    print("步骤 5/5 · 验收")
    print("=" * 66)
    stream_exec(c, "systemctl status ymusic --no-pager | head -12", 60, "服务状态")
    stream_exec(c, "ss -lntp | grep -E ':8788|:8803' || echo '未监听'", 30, "监听地址")
    stream_exec(c, "curl -s -m 8 http://127.0.0.1:8788/api/ping || echo '本机连不上'", 30, "本机 8788")
    stream_exec(c, "curl -s -m 8 http://127.0.0.1:8788/api/ping || echo '公网连不上'", 30, "公网 8788")

    c.close()
    print("\n部署流程结束。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
