# 这个目录是「账号管理台」，不是 `web/admin.html` 那个管理台

工程里有**两个都叫「管理台」的东西**。它们是两个不同产品的页面，**不要合并**，
也**不要只改其中一个就以为两头都变了**。

| | ① 本目录（账号管理台） | ② `web/admin.html`（运营管理台） |
|---|---|---|
| 页面文件 | `admin/index.html` | `web/admin.html` |
| 后端 | `admin/server.mjs`（独立进程，端口 8803） | `server.mjs`（主服务，端口 8788） |
| 接口面 | `/api/state`、`/api/users`、`/api/merge`、`/api/dedupe`、`/api/backups`、`/api/restore`、`/api/release*`、`/api/port` … | `/api/admin/*`（state / users / uploads / notice / transfer / whitelist）+ `/api/auth/*` |
| 干什么 | 数据源归集、账号合并去重、备份恢复、发布打包 | 歌曲审核、公告、用户角色与白名单 |
| 打包产物 | `dist/YMusic账号管理台.exe`（SEA，内嵌本目录的 index.html） | `dist/YMusic.exe` 的 `/admin`、管理台 APK、管理台 Electron |
| 谁在用 | 运维/开发者自己 | 管理员（手机 APK、桌面端、网页） |

## 为什么不能合并

两边的接口面**零重叠**：

```
在 admin/server.mjs 上实测（临时起在 8803）：
  /api/state          → 200     ← admin/index.html 用的
  /api/users          → 200
  /api/admin/state    → 404     ← web/admin.html 用的
  /api/admin/users    → 404
  /api/auth/login     → 404
  /logo-mark.svg      → 404     ← web/admin.html 的静态引用
  /icons/apple-touch-icon.png → 404
```

把 `web/admin.html` 塞进账号管理台的 exe，结果是**页面上每一次接口调用都 404、logo 也加载不出来**。
而且 `admin/server.mjs` 只有 `/` 和 `/index.html` 两条静态路由，**没有兜底静态处理**，
连「补上静态资源」这条路都走不通。

## 打包链路的两个坑

1. `build/admin-sea-config.json` **不是手写配置**，它是 `build-exe.py`（`build-exe.py:107-112`）
   每次打包时生成的产物。直接改它，下次打包就被覆盖。
   要改本目录打进 exe 的资源，得改 `build-exe.py` 里 admin 分支的 `assets` 表。

2. `server.mjs` 里 `/admin` 路由上方那句注释写着「放在 `web/admin.html` 里，
   这样 exe 打包时会自动跟着 `web/` 一起内嵌进去」——它说的是**主程序 exe**
   （`dist/YMusic.exe` 整包内嵌 `web/`），**不是**本目录的账号管理台 exe。
   已经有人只看那句注释就误判过一次，注释旁边也补了交叉提示。

## 打包命令

```bash
python build-exe.py admin        # → dist/YMusic账号管理台.exe
node admin/server.mjs            # 脚本态直接跑，端口 8803
```

脚本态改完 `admin/index.html` 刷新即见效；exe 态的页面是内嵌资源，改完必须重打。
