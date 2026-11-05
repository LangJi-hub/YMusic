#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""YMusic 一键打包 —— 一次产出全部 5 个可分发文件。

    python 一键打包.py

产出（都落在 dist/ 目录）：

    YMusic-<版本>.apk           用户端 · 安卓
    YMusic.exe                  用户端 · Windows（单文件，免安装）
    YMusic-<版本>-桌面版/        用户端 · Windows 桌面版（原生应用窗口）
    YMusic管理台-<版本>.apk      管理台 · 安卓
    YMusic账号管理台.exe         管理台 · Windows（单文件）
    YMusic管理台-桌面版-<版本>/  管理台 · Windows 桌面版（原生应用窗口）

────────────────────────────────────────────────────────────
为什么这套打包「不受限制」
────────────────────────────────────────────────────────────
不需要开发者账号、不需要应用商店、不需要买代码签名证书：

  · APK 用工程自带的 .jks 自签名即可。安卓本来就允许装「未知来源」的包，
    用户第一次安装时点一下「允许安装此来源」就行，不必上架任何商店。
  · EXE 是 Node SEA 打出的单文件，免安装、双击即用。没做代码签名，
    所以 Windows 第一次会弹 SmartScreen 蓝框，点「更多信息 → 仍要运行」。

两个文件都能直接通过微信 / QQ / 网盘发给别人，对方装上就能用。

────────────────────────────────────────────────────────────
打包环境（一次性准备，之后不用管）
────────────────────────────────────────────────────────────
  1. Python 3.10+（本机已装）
  2. Node.js 22（本机在 ~/.workbuddy/binaries/node/versions/ 下）
  3. JDK 17 + Android SDK（build-tools 34 / platform-34）
     默认路径 D:\\ymtoolchain，换地方就用环境变量指：
         set JAVA_HOME=D:\\your\\jdk
         set ANDROID_SDK=D:\\your\\android-sdk
  4. 两个 npm 小工具（打包 EXE 要用，本机已装在 node workspace）：
         npm i -g postject rcedit      # 或装到任意目录后用环境变量指
         set POSTJECT_CLI=<...>/postject/dist/cli.js
         set RCEDIT_EXE=<...>/rcedit/bin/rcedit-x64.exe

缺哪个它会自己报出来，按提示补即可。
"""
import os
import re
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

# 地址槽位表抽到 sync_addr.py 了 —— 启动脚本（start-service.py）和打包脚本
# 共用同一份，两处各存一份迟早会对不上，管理端和桌面端的地址就是这么飘掉的。
from sync_addr import sync_addr, verify, current_url, alive  # noqa: E402


def step_sync_addr():
    """第 0 步：把当前在线地址写进所有会被烧进制品的地方。"""
    u = current_url()
    if not u:
        print('\n× 找不到在线地址（public-url.txt / bootstrap/addr.json 都没有）。')
        print('  先启动服务端和内网穿透，确认外网能访问后再打包。')
        return False
    print('\n  当前在线地址：%s' % u)
    if not alive(u):
        print('  ⚠ 该地址现在连不通，打包出来对方也用不了。')
        print('    建议先确认服务端 + 隧道在跑；本次仍会按旧流程继续打包。')
    else:
        print('  ✅ 探活通过')
    _n, errs = sync_addr(u)
    verify(u)
    return not errs


def find_node():
    """动态找 node.exe —— 不能写死版本号，WorkBuddy 升级后目录名会变。"""
    env = os.environ.get('NODE_BIN')
    if env and os.path.exists(env):
        return env
    vb = os.path.join(os.path.expanduser('~'), '.workbuddy', 'binaries', 'node', 'versions')
    if os.path.isdir(vb):
        for d in sorted(os.listdir(vb), reverse=True):
            p = os.path.join(vb, d, 'node.exe')
            if os.path.exists(p):
                return p
    return 'node'


PY = sys.executable
NODE = find_node()

# (显示名, 产物文件名关键字, 命令)
# ⚠️ 管理台桌面版（⑤）用的是 Electron 原生窗口壳 —— 和用户端 ② 的 SEA 单文件不是一回事。
#    它的外壳必须是 Python：本机 Node spawn 外部进程会 EBUSY(errno -4082)，
#    而给 exe 写图标非得调 rcedit 不可。详见 build-admin-app.py 的头部注释。
STEPS = [
    ('① 用户端 · 安卓 APK', 'YMusic-', [PY, 'build-apk.py']),
    ('② 用户端 · Windows EXE', 'YMusic.exe', [PY, 'build-exe.py']),
    ('③ 管理台 · 安卓 APK', 'YMusic管理台-', [PY, 'build-admin-apk.py']),
    ('④ 管理台 · Windows EXE', 'YMusic账号管理台.exe', [NODE, 'build-admin-exe.mjs']),
    ('⑤ 管理台 · Windows 桌面版', 'YMusic管理台.exe', [PY, 'build-admin-app.py']),
]


def run_one(name, cmd):
    t0 = time.time()
    print('\n' + '─' * 56)
    print('  ' + name)
    print('─' * 56)
    try:
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                           encoding='utf-8', errors='replace')
    except FileNotFoundError as e:
        print('  × 找不到命令：' + str(e))
        return False
    out = ((r.stdout or '') + (r.stderr or '')).strip()
    if out:
        for line in out.splitlines()[-16:]:
            print('  ' + line)
    ok = r.returncode == 0
    print('  → ' + ('✅ 完成' if ok else '❌ 失败')
          + '　用时 %.0f 秒' % (time.time() - t0))
    return ok


def main():
    print('\n' + '=' * 56)
    print('  YMusic 一键打包')
    print('  Python : ' + PY)
    print('  Node   : ' + NODE)
    print('=' * 56)

    if not os.path.exists(os.path.join(ROOT, 'server.mjs')):
        print('\n× 这里不像是工程根目录（找不到 server.mjs）。')
        print('  请把本脚本放在 kugou-downloader 目录下再跑。')
        return 1

    print('\n' + '─' * 56)
    print('  第 0 步 · 同步当前在线地址')
    print('─' * 56)
    if not step_sync_addr():
        return 1

    results = []
    for name, _, cmd in STEPS:
        results.append((name, run_one(name, cmd)))

    print('\n' + '=' * 56)
    print('  汇总')
    print('=' * 56)
    dist = os.path.join(ROOT, 'dist')
    for name, ok in results:
        print('  ' + ('✅ ' if ok else '❌ ') + name)

    print('\n  dist/ 下的成品：')
    if os.path.isdir(dist):
        for f in sorted(os.listdir(dist)):
            if f.lower().endswith(('.apk', '.exe')):
                p = os.path.join(dist, f)
                print('    %-32s %8.1f MB' % (f, os.path.getsize(p) / 1048576.0))
    # 桌面版是「Electron 运行时 + resources/app」的一整个目录，exe 藏在里头，
    # 上面的平铺列表扫不到，单独把它刨出来列一遍。
    for d in sorted(os.listdir(dist) if os.path.isdir(dist) else []):
        sub = os.path.join(dist, d)
        if not os.path.isdir(sub) or not d.startswith('YMusic'):
            continue
        for f in sorted(os.listdir(sub)):
            if f.lower().endswith('.exe'):
                p = os.path.join(sub, f)
                print('    %-32s %8.1f MB' % (d + '/' + f, os.path.getsize(p) / 1048576.0))

    bad = [n for n, ok in results if not ok]
    if bad:
        print('\n  有 %d 项没成功，往上翻日志看是哪一步报的错。' % len(bad))
        return 1
    print('\n  全部完成。这几个文件可以直接发给用户。')
    print('  分发与安装说明见「打包与分发说明.md」。\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
