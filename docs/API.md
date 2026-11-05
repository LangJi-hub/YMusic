# API 参考

服务端 `server.mjs` 共暴露 **152 个端点**，全部为 JSON over HTTP。

## 通用约定

| 项 | 说明 |
|---|---|
| Base URL | `http://<host>:8788` |
| 认证 | 会话令牌，登录后由服务端下发；除公开接口外均需携带 |
| 请求体 | `application/json`（上传类为 `multipart/form-data`） |
| 响应 | JSON；文件类端点直接返回字节流 |
| 分页 | `page` 从 1 开始，`size` 语义为**每平台条数**（上限 50），非总数 |
| 健康检查 | `GET /api/ping` |

## 检索

| 端点 | 说明 |
|---|---|
| `GET /api/search` | 综合搜索。`q` 关键词，`src` 平台（`all` 为全部），`page` / `size` 分页 |
| `GET /api/search/singer` | 歌手搜索 |
| `GET /api/search/album` | 专辑搜索 |
| `GET /api/singer/all` | 歌手全部作品 |
| `GET /api/singer/hot` | 热门歌手 |
| `GET /api/singer/songs` | 指定歌手曲目 |
| `GET /api/album/songs` | 专辑完整曲目 |
| `GET /api/special/list` | 歌单列表 |
| `GET /api/special/search` | 歌单搜索 |
| `GET /api/special/songs` | 歌单曲目 |
| `GET /api/rank/list` | 榜单列表 |
| `GET /api/rank/songs` | 榜单曲目 |
| `GET /api/charts` | 排行榜数据 |
| `GET /api/chart/songs` | 榜单歌曲 |
| `GET /api/top` | 顶部推荐 |
| `GET /api/daily` | 每日推荐（`src=all` 会混入视频源，前端使用前需过滤） |
| `GET /api/browse` | 分类浏览 |
| `GET /api/drives` | 可用音源驱动列表 |

## 播放与媒体

| 端点 | 说明 |
|---|---|
| `GET /api/resolve` | 解析播放地址 |
| `GET /api/alt` | 备用音源 |
| `GET /api/probe` | 音质探测 |
| `GET /api/lyric` | 歌词 |
| `GET /api/mv/find` | MV 检索 |
| `GET /api/mv/url` | MV 地址 |
| `GET /api/proxy` | 媒体代理（绕开跨域与 Referer 限制） |
| `GET /api/img` | 图片代理 |
| `GET /api/nowplaying` | 当前播放状态 |

## 下载与落盘

| 端点 | 说明 |
|---|---|
| `GET /api/save` | 保存单曲 |
| `GET /api/saveLyric` | 保存歌词 |
| `GET /api/dl/progress` | 下载进度 |
| `GET /api/task` | 单个任务状态 |
| `GET /api/tasks` | 任务列表 |
| `GET /api/tasks/clear` | 清理任务 |
| `POST /api/upload` | 上传音频 |
| `GET /api/mkdir` | 新建目录 |
| `GET /api/opendir` | 打开目录 |
| `GET /api/reveal` | 定位文件 |

## 个人曲库

| 端点 | 说明 |
|---|---|
| `GET /api/music/list` | 曲库列表 |
| `GET /api/music/mine` | 我的上传 |
| `GET /api/music/user` | 指定用户的公开曲库 |
| `GET /api/music/file` | 获取音频文件 |
| `GET /api/music/duration` | 时长识别 |
| `GET /api/music/delete` | 删除曲目 |
| `GET /api/fav` | 收藏 |
| `GET /api/history` | 播放历史 |

## 账号

| 端点 | 说明 |
|---|---|
| `POST /api/auth/register` | 注册 |
| `POST /api/auth/login` | 登录 |
| `POST /api/auth/codelogin` | 验证码登录 |
| `GET /api/auth/logout` | 登出 |
| `GET /api/auth/me` | 当前账号 |
| `GET /api/auth/captcha` | 图形验证码 |
| `GET /api/auth/reqcode` | 请求验证码 |
| `POST /api/auth/pass` | 修改密码 |
| `GET /api/auth/pass/reqcode` | 改密验证码 |
| `GET /api/auth/forgot/reqcode` | 找回密码验证码 |
| `POST /api/auth/forgot/reset` | 重置密码 |
| `POST /api/auth/bindemail` | 绑定邮箱 |
| `GET /api/auth/bindemail/reqcode` | 绑定邮箱验证码 |
| `POST /api/auth/smtp` | 配置发信（**仅本机可调**） |
| `GET /api/user/profile` | 用户资料 |
| `GET /api/me/delete` | 注销账号 |
| `GET /api/config` | 站点配置 |

## 社交

### 动态 `moment`

| 端点 | 说明 |
|---|---|
| `GET /api/moment/list` | 动态列表 |
| `POST /api/moment/post` | 发布 |
| `GET /api/moment/like` | 点赞 |
| `GET /api/moment/comment` | 评论 |
| `GET /api/moment/comment/del` | 删除评论 |
| `GET /api/moment/recall` | 撤回 |

### 私信 `chat` / `msg`

| 端点 | 说明 |
|---|---|
| `GET /api/chat/list` | 会话列表 |
| `GET /api/chat/thread` | 会话消息 |
| `POST /api/chat/send` | 发送 |
| `GET /api/chat/read` | 标记已读 |
| `GET /api/chat/recall` | 撤回 |
| `GET /api/chat/del` | 删除会话 |
| `GET /api/chat/clear` | 清空 |
| `GET /api/msg/list` | 消息列表 |
| `GET /api/msg/read` | 已读 |
| `GET /api/msg/del` | 删除 |
| `GET /api/msg/summary` | 未读汇总 |

### 好友 `friend`

| 端点 | 说明 |
|---|---|
| `GET /api/friend/list` | 好友列表 |
| `GET /api/friend/add` | 添加 |
| `GET /api/friend/find` | 查找 |
| `GET /api/friend/requests` | 待处理请求 |
| `GET /api/friend/handle` | 处理请求 |
| `GET /api/friend/remove` | 移除 |

### 分享 `share`

| 端点 | 说明 |
|---|---|
| `GET /api/share/send` | 分享 |
| `GET /api/share/list` | 分享列表 |
| `GET /api/share/read` | 读取 |
| `GET /api/share/delete` | 删除 |

### 一起听 `listen`

| 端点 | 说明 |
|---|---|
| `GET /api/listen/room` | 房间状态 |
| `GET /api/listen/invite` | 创建邀请 |
| `GET /api/listen/invites` | 邀请列表 |
| `GET /api/listen/join` | 加入 |
| `GET /api/listen/ask` | 申请加入 |
| `GET /api/listen/grant` | 批准 |
| `GET /api/listen/pick` | 选曲 |
| `GET /api/listen/sync` | 进度同步 |
| `GET /api/listen/end` | 结束 |

## 运营管理 `admin`

### 概览与用户

| 端点 | 说明 |
|---|---|
| `GET /api/admin/state` | 管理台状态 |
| `GET /api/admin/claim` | 认领管理员（**首次部署后必须立即改掉默认码**） |
| `POST /api/admin/code` | 设置授权码 |
| `GET /api/admin/users` | 用户列表 |
| `GET /api/admin/user` | 单个用户 |
| `GET /api/admin/user/role` | 设置角色 |
| `GET /api/admin/user/del` | 删除用户 |
| `GET /api/admin/transfer` | 数据迁移 |
| `GET /api/admin/whitelist` | 白名单 |

### 内容审核

| 端点 | 说明 |
|---|---|
| `GET /api/admin/uploads` | 待审上传 |
| `GET /api/admin/uploads/file` | 预览文件 |
| `GET /api/admin/uploads/review` | 审核 |
| `GET /api/admin/uploads/delete` | 删除 |
| `GET /api/admin/avatars` | 待审头像 |
| `GET /api/admin/avatars/file` | 头像文件 |
| `GET /api/admin/avatars/review` | 头像审核 |

### 公告

| 端点 | 说明 |
|---|---|
| `GET /api/admin/notice` | 公告列表 |
| `GET /api/admin/notice/post` | 发布 |
| `GET /api/admin/notice/delete` | 删除 |

### 平台账号（酷狗 / QQ / 网易云）

三个平台接口结构对称，以 `{p}` 表示 `kg` / `qq` / `ne`：

| 端点 | 说明 |
|---|---|
| `GET /api/admin/{p}/qr` | 获取登录二维码 |
| `GET /api/admin/{p}/qr/poll` | 轮询扫码结果 |
| `GET /api/admin/{p}/cred` | 凭证状态 |
| `GET /api/admin/{p}/health` | 健康检查 |
| `GET /api/admin/{p}/probe` | 主动探测 |
| `GET /api/admin/{p}/expire` | 到期时间 |

## 客户端分发 `app`

| 端点 | 说明 |
|---|---|
| `GET /api/app/version` | 版本信息 |
| `GET /api/app/file` | 文件下载 |
| `GET /api/app/apk` | Android 包 |
| `GET /api/app/admin-apk` | 管理端 Android 包 |
| `GET /api/app/exe` | Windows 桌面端 |
| `GET /api/app/ipa` | iOS 包 |
| `GET /api/app/ios` | iOS 引导 |
| `GET /api/app/hap` | 鸿蒙包 |
| `GET /api/app/update-now` | 触发强制更新 |

## 其他

| 端点 | 说明 |
|---|---|
| `GET /api/ping` | 健康检查 |
| `GET /api/notice` | 公告读取 |
| `GET /api/notice/read` | 标记已读 |
| `GET /api/presence` | 在线状态 |
| `GET /api/avatars/map` | 头像映射 |
| `GET /api/avatar/file` | 头像文件 |
| `GET /api/comment` | 评论 |
| `GET /api/sync/push` | 数据同步 |
| `GET /api/dy/fp` | 抖音指纹参数 |

> 部分端点同时接受 GET 与 POST，具体以 `server.mjs` 中的路由分发为准。
