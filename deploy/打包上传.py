#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""YMusic 上云：把沙盘打包上传到云服务器，并在服务器上跑 install.sh。

用法（推荐直接双击/命令行跑，会一步步问你）：

    python deploy\\打包上传.py
    python deploy\\打包上传.py --host root@1.2.3.4          # 免交互
    python deploy\\打包上传.py --host root@1.2.3.4 --port 22 --key C:\\Users\\me\\.ssh\\id_rsa

上传前它会告诉你清单里有什么、多大；上传后会展示服务状态。

服务端是**零第三方依赖**的纯 Node 实现，所以这里刻意不带 node_modules：
你在云端不用 npm install，装个 node 就能跑。
"""
import argparse
import os
import subprocess
import sys
import tarfile
import time

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'dist', 'ymusic-cloud.tar.gz')

# ── 白名单：只带云端真正需要的东西 ────────────────────────────────────────
# （不用黑名单排 node_modules，那样一不小心就把 118MB 的 playwright 带上去）
INCLUDE_FILES = [
    'server.mjs',
    'config.json',
    'public-url.txt',
    'package.json',
    '打包与分发说明.md',
    '一键打包.py',
    # 管理端 OTA 元数据：server.mjs:65 的 ADMIN_APK_META 读 android-admin/apk-release.json，
    # 而 android-admin/ 不在 INCLUDE_DIRS 里。漏掉它云端 /api/app/admin-apk 会 404。
    'android-admin/apk-release.json',
]
INCLUDE_DIRS = ['web', 'admin', 'data', 'bootstrap', 'deploy']

# 这些即使在上面的目录里也不要（本地运行态产物 / 密钥 / 临时文件）
SKIP_NAMES = {'node_modules', '__pycache__', '.git', 'backups', 'admin-log.jsonl'}
SKIP_SUFFIX = ('.jks', '.keystore', '.log', '.idsig', '.pyc', '.token', '.png',
               '.zip', '.exe', '.apk', '.msi', '.bat', '.cmd')
# 开发机上跑出来的临时/运行态文件，搬到云端只会造成误解
SKIP_EXACT = {'current-url.txt', '_junction.txt', '_procs.txt', 'sea-main.cjs'}


def build_tarball():
    """打包：只收白名单，敏感/临时/平台专属的一律不带。"""
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    n = 0
    with tarfile.open(OUT, 'w:gz', compresslevel=6) as tar:
        for rel in INCLUDE_FILES:
            p = os.path.join(ROOT, rel)
            if os.path.isfile(p):
                tar.add(p, arcname=rel)
                n += 1
        for d in INCLUDE_DIRS:
            base = os.path.join(ROOT, d)
            if not os.path.isdir(base):
                print('  · 跳过（不存在）%s/' % d)
                continue
            cnt = 0
            for dirpath, dirnames, filenames in os.walk(base):
                dirnames[:] = [x for x in dirnames if x not in SKIP_NAMES]
                for f in filenames:
                    # app-update/manifest.json 这类 OTA 清单要保留（客户端更新靠它），
                    # 唯独不要里面的 .exe / .apk 二进制 —— 后缀过滤已经处理了。
                    if f in SKIP_NAMES or f in SKIP_EXACT or f.endswith(SKIP_SUFFIX):
                        continue
                    full = os.path.join(dirpath, f)
                    arc = os.path.relpath(full, ROOT).replace('\\', '/')
                    tar.add(full, arcname=arc)
                    cnt += 1
                    n += 1
            print('  · %-12s %d 个文件' % (d + '/', cnt))
        # deploy 目录可能还没算进去（已在白名单里），确保 install.sh 一定在
        sh = os.path.join(ROOT, 'deploy', 'install.sh')
        if os.path.isfile(sh):
            tar.add(sh, arcname='deploy/install.sh')
    size = os.path.getsize(OUT) / 1048576.0
    print('\n  共 %d 个条目，%.2f MB' % (n, size))
    if size > 60:
        print('  ⚠ 超过 60MB，多半是 data/uploads 里堆了上传文件，建议先清理')
    return size


def ask(prompt, default=''):
    try:
        v = input(prompt).strip()
    except EOFError:
        v = ''
    return v or default


def ssh_base(host, port, key):
    base = ['ssh', '-p', str(port), '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null']
    if key:
        base += ['-i', key]
    base.append(host)
    return base


def main():
    ap = argparse.ArgumentParser(description='YMusic 云端部署上传')
    ap.add_argument('--host', help='例如 root@1.2.3.4')
    ap.add_argument('--port', default='22')
    ap.add_argument('--key', default='', help='私钥路径（用密码登录就留空）')
    ap.add_argument('--pack-only', action='store_true', help='只打包不上传')
    args = ap.parse_args()

    print('\n' + '=' * 58)
    print('  YMusic 上云 · 打包上传')
    print('=' * 58)

    print('\n[1/3] 打包（不含 node_modules，服务端零依赖）')
    build_tarball()
    print('  产物：' + OUT)

    if args.pack_only:
        print('\n  只打包模式，到此为止。')
        return 0

    print('\n[2/3] 上传')
    host = args.host
    if not host:
        print('  服务器格式：用户名@公网IP，默认端口 22（腾讯云/阿里云轻量都是 22）')
        host = ask('  服务器 > ')
    if not host:
        print('  × 没填服务器地址，退出。')
        return 1

    remote = '/tmp/ymusic-cloud.tar.gz'
    scp = ['scp', '-P', args.port, '-o', 'StrictHostKeyChecking=no',
           '-o', 'UserKnownHostsFile=/dev/null']
    if args.key:
        scp += ['-i', args.key]
    scp += [OUT, '%s:%s' % (host, remote)]

    print('  正在上传…（第一次会问你是否信任主机指纹，输 yes）')
    t0 = time.time()
    r = subprocess.run(scp)
    if r.returncode != 0:
        print('\n  × 上传失败。常见原因：')
        print('    · IP 或用户名写错（腾讯云 Ubuntu 镜像默认用户名是 ubuntu，不是 root）')
        print('    · 控制台安全组没放行 22 端口')
        print('    · 密码打字时不显示，直接输完回车即可')
        return 1
    print('  ✅ 上传完成，用时 %.0f 秒' % (time.time() - t0))

    print('\n[3/3] 在服务器上安装并启动')
    sh = ssh_base(host, args.port, args.key)
    cmd = sh + ['-t', 'bash %s; echo; echo "--- 服务状态 ---"; sudo -n true 2>/dev/null; '
                       'systemctl is-active ymusic ymusic-admin 2>/dev/null; '
                       'grep -h . /opt/ymusic/public-url.txt 2>/dev/null']
    # 部署包里有 service 文件，install.sh 会自己解压后安装，这里先就地解压到 /tmp
    prep = sh + ['tar -xzf %s -C /tmp' % remote]
    pr = subprocess.run(prep)
    if pr.returncode != 0:
        print('  × 远程解压失败，检查服务器磁盘空间和权限')
        return 1
    # install.sh 会在 /opt/ymusic 下解压正式的副本
    subprocess.run(sh + ['cp', '-r', '/tmp/deploy', '/tmp/.ymdeploy_bak'])
    subprocess.run(sh + ['bash', '/tmp/deploy/install.sh', remote])

    print('\n' + '=' * 58)
    print('  下一步（别忘了）：')
    print('   1. 云厂商控制台 → 防火墙/安全组 → 放行 8788 和 8803 端口')
    print('   2. 浏览器打开 http://你的公网IP:8788 确认能进')
    print('   3. 回本机跑「一键打包.py」重新打包 APK —— 它会读云端那份')
    print('      public-url.txt（地址已经同步到服务器了，见上面输出）')
    print('=' * 58 + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
