/**
 * 酷狗音乐下载器 · 本地版 v2
 * 零依赖（仅 Node 内置模块）。只绑 127.0.0.1，不对外网开放。
 *
 * 覆盖范围：
 *   单曲搜索 / 歌手搜索+歌手全部歌曲 / 专辑搜索+专辑曲目 / 榜单列表+榜单曲目 / 歌单曲目
 *   音质实测探测（无损·320K·128K 逐档验证） / 歌词 / 试听代理 / 落盘 / 批量
 *
 * 边界（刻意为之，请勿改）：
 *   只解析酷狗对外公开提供的音源，不做签名破解、不做会员绕过、不拼接试听片段。
 *   会员/付费曲目在界面上明确标出，取不到就给清楚提示。
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import tls from 'node:tls';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import dns from 'node:dns';

/* ---------------- 运行形态探测：开发态（脚本）还是打包态（单文件 exe） ----------------
 * 打包成 SEA 单文件后，代码在虚拟路径里，配置/日志必须落到「exe 所在目录」。
 * 前端资源也改成「磁盘优先，找不到就读内嵌资产」，这样同一份 server.mjs
 * 既能用 node 直接跑，也能原样打成一个 exe。
 *
 * 注意：这里用 createRequire 同步探测 node:sea，而不是顶层 await import ——
 * SEA 的 ESM 引导对顶层 await 支持不稳，踩过一次。
 * ------------------------------------------------------------------------- */
const nodeRequire = createRequire(import.meta.url);
let SEA = null;
try { SEA = nodeRequire('node:sea'); } catch { SEA = null; }
const IS_SEA = (() => { try { return !!(SEA && typeof SEA.isSea === 'function' && SEA.isSea()); } catch { return false; } })();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/* 数据目录优先级：
 *   1. YM_APP_DIR —— 桌面壳（Electron）显式指定，保证 config/账号/记录落在用户可写处
 *   2. 打包态 —— exe 所在目录（便携）
 *   3. 脚本态 —— 源码目录
 * 前端资源则始终跟着代码走（web/ 与 server.mjs 同级的资源在打包态被内嵌）。 */
const APP_DIR = process.env.YM_APP_DIR || (IS_SEA ? path.dirname(process.execPath) : __dirname);
/* 前端资源跟着代码走（不是数据目录）：Electron 壳里 APP_DIR 是用户数据目录，
 * 而 web/ 始终和 server.mjs 同级。 */
const WEB_DIR = path.join(__dirname, 'web');
const CONFIG_FILE = path.join(APP_DIR, 'config.json');
/* OTA 覆盖层：远程下发的前端文件落在这里，优先级高于内嵌资产。
 * 这样一次打包之后，改前端不用再重发 80MB 的 exe —— 推几百 KB 的 HTML 即可。 */
const UPDATE_DIR = path.join(APP_DIR, 'update');
const UPDATE_MANIFEST = path.join(UPDATE_DIR, 'update.json');
/* 本机作为「更新源」时，发布出去的版本放在这里（管理台写入，主服务只读）。
 * 刻意放在 data/ 下：exe 版的 data 是联接到主库的，主服务与管理台读写的是同一份。 */
const RELEASE_DIR = path.join(APP_DIR, 'data', 'app-update');
const RELEASE_MANIFEST = path.join(RELEASE_DIR, 'manifest.json');

/* 发布清单里**被引用的**文件名集合 —— /api/app/file 的白名单（U-46）。
 * 为什么必须是「精确文件名」而不是「扩展名白名单」：发布目录里躺着 4 个 exe
 * 共 629.6 MiB，全都是 .exe，扩展名白名单一个都挡不住；而清单只引用了 3.6.16
 * 那一个，其余 448 MiB 只要不在名单里，接口就根本不认。
 *
 * ⚠️ 口径（主理人 2026-10-11 定的第三版，前两版作废，**以这条为准**）：
 *     ① manifest.json 的 files[].rel   → 3 个覆盖层 index.html / sw.js / manifest.webmanifest
 *     ② data/apk-release.json 的 file  → 1 个安卓包 YMusic-3.6.15.apk
 *     合计 4 个，不多一个、不少一个。
 *
 *   🔴 exe **故意不放行**。两个理由，缺一不可：
 *     · 放行了就等于没堵 —— 发布目录里 4 个 exe 共 629.6 MiB，190MB 那个正是
 *       ddos-probe 定的 S 级第一（匿名拉 + 整包进堆）；
 *     · 桌面端压根不走这个接口，它走 /api/app/exe。放行它没有任何好处。
 *   前两版口径错在这：第一版只扫 <对象>.file → 3 个覆盖层全 404，OTA 热更新被打死；
 *   第二版 files[].rel + exe.file + apk → 多放行 exe 就是没堵，等于白做。
 *
 * 按 mtime 缓存：清单刷了自动失效，不必每次请求都读盘。
 * 读不到清单时**回空集合**（等于这个接口整体 404），不退化成「谁都能拉」——
 * 那正是 U-46 要堵的东西，宁可功能停摆也不能把门敞开。 */
let REL_ALLOW = { set: null, mt: 0 };
function releaseFileAllow() {
  try {
    const st = fs.statSync(RELEASE_MANIFEST);
    let amt = 0;
    try { amt = fs.statSync(APK_META).mtimeMs; } catch { /* 没有 apk 元信息就当 0 */ }
    /* 缓存键必须带上 apk 元信息的 mtime：只认 manifest 的 mtime 时，
       单独换一次 apk 文件名（发新版 APK）不会让缓存失效，手机端就会 404。 */
    if (REL_ALLOW.set && REL_ALLOW.mt === st.mtimeMs && REL_ALLOW.amt === amt) return REL_ALLOW.set;
    const m = JSON.parse(fs.readFileSync(RELEASE_MANIFEST, 'utf8'));
    const norm = x => String(x || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const out = new Set();
    for (const it of (m && Array.isArray(m.files) ? m.files : [])) {
      const r = norm(it && it.rel);
      if (r && !r.includes('..')) out.add(r);
    }
    /* ② 安卓包：不在 manifest.json 里，是独立的 data/apk-release.json。
       必须单独读进来 —— 少这一条，手机端拉包就 404。 */
    try {
      const a = JSON.parse(fs.readFileSync(APK_META, 'utf8'));
      const r = norm(a && a.file);
      if (r && !r.includes('..')) out.add(path.basename(r));
    } catch { /* 没有 apk 元信息就只发覆盖层，不影响那 3 个 */ }
    REL_ALLOW = { set: out, mt: st.mtimeMs, amt };
    return out;
  } catch {
    return new Set();   /* 清单读不到 → 一律不认，见上方注释 */
  }
}

/* 下发给客户端的覆盖层清单 —— 和 readExeMeta() 同一个原则：
 * **size 和 md5 一律以磁盘上那个真实文件为准，不信 manifest.json 里填的值。**
 *
 * 为什么必须不信（实测踩到，不是推演）：
 *   data/app-update/manifest.json 的 files[] 是发布那一刻生成的，而发布目录里的
 *   index.html / sw.js 之后又被单独覆盖过，两边对不上 ——
 *     index.html  清单写 680076B / 5ccb3d3854a25107988f9da5ce2ccd08
 *                 磁盘实为 673558B / 04dfa81fedfe343a5db0093fb7d756bd
 *     sw.js       清单写   1823B / 54e910d2a21c862372058e99c9bdaa36
 *                 磁盘实为   1872B / 9dbffc8f2d4109fe0a97a1930a2f659d
 * 后果比「对不上」严重得多：客户端 OTA 拉完文件要按清单 md5 校验，
 * 对不上就 `continue` 直接丢弃、不落地（checkAppUpdate() 里那句
 * `if (f.md5 && md5(body) !== f.md5) continue;`）。
 * 于是**热更新静默失效** —— 服务端没有任何报错，用户永远停在旧页面，
 * 只有真机跑一遍完整 OTA 才看得见（实测 changed 只剩 manifest.webmanifest 一个）。
 *
 * 发布端的打包脚本以后修不修是另一回事，这里必须自愈：
 * 只要文件真在发布目录里，就报它的真值；不在的条目直接丢掉，
 * 免得客户端兴冲冲去下一个 404 的东西。
 * 清单本来就对的时候，这里算出来的和它写的一模一样，不会有任何副作用。
 *
 * md5 按「路径+体积+修改时间」缓存，换了文件自动失效（同 EXE_MD5_CACHE 的做法）。 */
let OVERLAY_FILES_CACHE = { key: '', files: [] };
function releaseOverlayFiles() {
  let m = null;
  try { m = JSON.parse(fs.readFileSync(RELEASE_MANIFEST, 'utf8')); } catch { m = null; }
  const src = (m && Array.isArray(m.files)) ? m.files : [];
  if (!src.length) { OVERLAY_FILES_CACHE = { key: '', files: [] }; return []; }

  let key = '';
  const pend = [];
  for (const it of src) {
    const rel = String((it && it.rel) || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.includes('..')) continue;
    const fp = path.join(RELEASE_DIR, rel);
    let size = 0, mt = 0;
    try {
      const st = fs.statSync(fp);
      if (!st.isFile()) {
        console.warn('[overlay-manifest] 清单里列了，但发布目录里它不是文件，已丢弃 -> ' + rel);
        continue;
      }
      size = st.size; mt = st.mtimeMs;
    } catch {
      /* ⚠️ 这里以前是静默 continue。清单列了、磁盘没有，客户端就永远等一个不存在的
         更新 —— 服务端一行日志都没有，只能靠真机跑一遍 OTA 才看得见。不许静默。 */
      console.warn('[overlay-manifest] 清单里列了，但发布目录里没有这个文件，已丢弃 -> ' + rel);
      continue;
    }
    key += rel + '|' + size + '|' + mt + ';';
    pend.push({ rel, fp, size, md5: String((it && it.md5) || '') });
  }
  if (OVERLAY_FILES_CACHE.key === key) return OVERLAY_FILES_CACHE.files;

  const files = [];
  for (const it of pend) {
    let h = '';
    /* 流式算，别把大文件整包读进堆 */
    try { h = md5FileSync(it.fp); } catch { h = ''; }
    /* ② 磁盘与清单声明对不上时，这里以前也是静默的。
       那正是 2026-10-11 那次热更新静默失效的样子：改之前 /api/app/version 直接透传
       清单的 md5，客户端拉完校验不过就丢弃，服务端一行日志都没有。
       现在就算我们按磁盘真值把它兜住了，也要把「清单本身是错的」这件事喊出来 ——
       兜住症状不等于修好数据，发布端该重算还是得重算。 */
    const declared = String((it && it.md5) || '');
    if (declared && h && declared.toLowerCase() !== h.toLowerCase()) {
      console.warn('[overlay-manifest] 清单 md5 与磁盘真实字节不符（已按磁盘为准下发）-> ' + it.rel
        + '：清单 ' + declared + ' / 磁盘 ' + h
        + '；请对发布目录重跑一次清单刷新，否则发布数据始终不自洽');
    }
    files.push({ rel: it.rel, size: it.size, md5: h });
  }
  OVERLAY_FILES_CACHE = { key, files };
  return files;
}
/* 安卓客户端（APK）的发布信息。APK 由 build-apk.py 产出、管理台发布页上传，
 * 手机端启动时比对 versionCode 决定是否提示更新。 */
const APK_META = path.join(APP_DIR, 'data', 'apk-release.json');
/* 管理台 APK 的发布信息（com.ymusic.admin）。
 * ⚠️ 必须和用户端 APK 分开两个字段下发：两者包名不同、签名也不同，
 *    拉错包装不上，只会把用户卡在一个永远失败的更新弹窗里。
 *    所以构建产物、元信息文件、下发的字段，三处都各走各的。 */
const ADMIN_APK_META = path.join(APP_DIR, 'android-admin', 'apk-release.json');
/* 公告 / 更新消息中心。管理台发公告、发版本时往这里写，客户端进来拉。
 * 已读状态按用户存，换设备也能同步（大厂做法）。 */
const NOTICE_FILE = path.join(APP_DIR, 'data', 'notices.json');
const NOTICE_READ = path.join(APP_DIR, 'data', 'notice-read.json');
/* 公告的**归档时间**：`{uid: {noticeId: 读取时刻}}`（2026-10-16 加）。
   与 NOTICE_READ 分开存，理由见 /api/msg/read 里那段注释：
   已读表有 3 处读者，只有列表需要"什么时候读的"，分开存耦合最小。
   ⚠️ 这是一个**新文件**，读不到时按 {} 处理（readJSON 的既有行为），不需要迁移。 */
const NOTICE_ARCHIVE = path.join(APP_DIR, 'data', 'notice-archive.json');
/* 用户在收件箱里删掉的那几条。按 uid 分开记 —— 公告是全局的，
   一个人删了不能让别人也看不见，所以只能记「谁把哪条划掉了」。
   好友申请 / 邀请同理：删掉只是从我的列表里消失，不替用户做任何决定。 */
const MSG_HIDDEN_FILE = path.join(APP_DIR, 'data', 'msg-hidden.json');

/* ── 消息中心的缓存上限 ──
   这几处以前写得偏大（公告留 200 条、已读留 500 个 id），
   日子一久文件只涨不缩，每拉一次都要搬一堆用不上的旧数据。
   定死上限：看历史有管理台，客户端只需要最近这些。 */
const MSG_KEEP_NOTICE = 60;    // notices.json 最多留这么多条
const MSG_KEEP_READ   = 120;   // 每个用户的已读 id 最多记这么多
const MSG_KEEP_HIDDEN = 120;   // 每个用户的「已删除」id 最多记这么多
const MSG_PAGE_MAX    = 40;    // 一次拉给客户端的最多条数

/* ── 音乐圈每日汇总推送 ──────────────────────────────────────────
   业主需求：「音乐圈上传歌曲，消息已经传至整个系统的用户手中，引导他们来听」。
   规则（2026-10-14 拍板，见 docs/设计-音乐圈推送-全量消息与每日汇总.md）：
     · 「全量消息」= 收件面是全体注册用户。系统里没有关注 / 粉丝关系，
       全量是唯一可能的覆盖面。
     · 「每日汇总」= 呈现层，每人每天最多 1 条。两者是同一批内容的两层，
       不是两套消息。
     · 「每天」= 北京时间自然日（beijingDayKey），不是滚动 24 小时窗口 ——
       滚动窗口下 N 会在用户眼前跳，且「全局一天一份」的结构根本不成立。
     · 汇总的 N 只算带歌的动态（songAuthors）。
   ⚠️ 线上出问题时第一处置动作是把 MOMENT_DAILY_ON（或 config.json 的
   momentDaily.on）改 false 重启，**不要回滚代码** —— 回滚会把同期别的改动
   一起带走。开关关闭不清数据，改回来立刻生效。 */
const MOMENT_DAILY_ON           = true;   // 总开关
const MOMENT_DAILY_KEEP_DAYS    = 30;     // days 保留多少天
const MOMENT_DAILY_NAME_MAX     = 3;      // 昵称 / 歌名快照最多几个
const MOMENT_DAILY_UID_MAX      = 50;     // uids 最多记几个（超出只截断，不影响 N）
const MOMENT_DAILY_MIN_WRITE_MS   = 3000;   // 同一天最小写盘间隔（纯节流，不为无变化触发写盘）
/* 🔴 已拍板：'song' → N 取 songAuthors（当天**带歌**动态的去重作者数）。
   'all' → N 取 n（当天全部动态的去重作者数，实测差 2 倍以上），
   **不是**拍板口径，不要改回去。 */
const MOMENT_DAILY_N_SOURCE     = 'song';
function momentDailyOn() {
  try {
    var c = CFG && CFG.momentDaily;
    if (c && typeof c.on === 'boolean') return c.on;
  } catch (e) { /* 配置读不到就退回代码默认值 */ }
  return MOMENT_DAILY_ON;
}
/* 社交：在线状态单独一个文件（心跳写得勤，跟别的数据分开省得互相拖累），
 * 好友关系 / 好友请求 / 歌曲分享放一起（写得少）。 */
const PRESENCE_FILE = path.join(APP_DIR, 'data', 'presence.json');
const SOCIAL_FILE = path.join(APP_DIR, 'data', 'social.json');
/* 用户上传的音频：实体文件放 data/uploads/，元数据（含审核状态）放 uploads.json。
 * 审核通过才会出现在公开曲库和别人的主页里。 */
const UPLOAD_DIR = path.join(APP_DIR, 'data', 'uploads');
const UPLOAD_META = path.join(APP_DIR, 'data', 'uploads.json');
/* 音乐圈：用户发动态（可带一首歌），说错了能撤回。
 * 一起听：邀请好友同步听同一首歌，靠轮询同步进度。 */
const MOMENT_FILE = path.join(APP_DIR, 'data', 'moments.json');
/* ★ T-04：音乐圈互动产生的消息单独一张表。
   为什么不直接塞进 moments.json：动态是「广场上的内容」，谁都能读、
   作者说删就删；消息是「给某个人的通知」，带已读状态、只有收件人能划掉。
   两者生命周期不一样，混在一起就会出现「动态都撤回了、我的红点还亮着」
   这种说不清的脏数据。 */
const MOMENT_MSG_FILE = path.join(APP_DIR, 'data', 'moment-msg.json');
/* 音乐圈每日汇总单独一张表。为什么不复用上面那张：
   moment-msg.json 是点对点表（每条强制带 to / from），汇总没有发送者；
   而且已读是按 id 前缀分派的（mm → 这张表），汇总复用会被吸进 mm 分支、
   在自己这张表里永远找不到自己 → 已读置不上 → 红点永远消不掉。 */
const MOMENT_DAILY_FILE = path.join(APP_DIR, 'data', 'moment-daily.json');
const LISTEN_FILE = path.join(APP_DIR, 'data', 'listen.json');
/* 一起听的房间空闲超过这个时间就自动结束，免得房间列表越堆越多 */
const ROOM_IDLE = 10 * 60 * 1000;

function readMoments() {
  const o = readJSON(MOMENT_FILE, null) || {};
  const raw = Array.isArray(o.list) ? o.list : [];
  /* 撤回现在是「真删」——整条连它身上的点赞、评论一起从列表里消失。
     老版本是软删（只置 recalled:true），存量文件里还躺着一批这样的僵尸条目：
     谁都看不见，却一直占着列表配额、又被接口反复读出来。
     读的时候顺手清掉并写回一次，别把脏数据留给下一个人。 */
  const list = raw.filter(m => m && !m.recalled);
  /* ★ U-25：给没有 cid 的老评论补主键。**只在内存里补，不在这儿写盘。**
     评论是从来没有 id 的（{uid, text, at} 三件套），而新增的「回复某人 /
     删除自己的评论」都得靠它定位 —— 数据层缺这一列，功能就落不了地。
     ❌ 不要在读侧即时算 cid（'legacy-' + m.id + '-' + i）：
        /api/moment/comment 末尾有 slice(-100)，某条动态的评论数一破 100，
        下标就会整体漂移 —— 昨天算出来的 cid 今天就指向别人，删除会删错人。
     ✅ 用 m.at（动态创建时间，永不变）+ 数组下标算，稳定可复现。

     ⚠️⚠️ **这里曾经写过一次盘，实测是被打回的 —— 别改回去**：
        /api/moment/post 这类路由是 `const o = readMoments(); ... writeMoments(o);`，
        在 readMoments 里再写一次就变成**同一个 tick 里对同一个文件连续两次
        原子写**（都是 write tmp + rename 盖上去）。Windows 上第二次 rename 会
        稳定地随机吃 EPERM：
            EPERM: operation not permitted, rename
            'data/.moments.json.<pid>.tmp' -> 'data/moments.json'
        而 writeJSONAtomic 是吞异常的（返回 false 不抛），上层完全看不见 ——
        实测五轮里挂了两轮，症状是**刚发的动态凭空消失**（响应回了 ok+id，
        盘上没有）。改之前一条动态只写一次盘，从来没这问题。
        所以补主键改成：读的时候只在内存补（落盘由下面这些路径顺带完成）
          · 启动时 migrateMomentCids() 全量补一次；
          · 任何会写盘的路由（comment / like / recall / comment:del）拿到的
            就是这份已补好的数组，写完自然落盘。 */
  list.forEach(m => {
    if (!m || !Array.isArray(m.comments)) return;
    m.comments.forEach((c, i) => {
      if (!c || typeof c !== 'object' || c.cid) return;
      c.cid = 'c' + String(m.at || 0).toString(36) + 'x' + i.toString(36);
      c.replyTo = c.replyTo || '';
      c.replyName = c.replyName || '';
    });
  });
  return { list };
}
function writeMoments(o) { writeJSON(MOMENT_FILE, o); }
/* 启动时把没有 cid 的老评论一次性补好并落盘（U-25 老数据迁移）。
   放在 listen 之前跑一次就够：跑完库里就再有没有主键的评论了，
   之后新增的评论在 /api/moment/comment 里本来就带 cid。
   ⚠️ 只写**一次**：上面的注释里记着同一个 tick 连续两次原子写会在 Windows
      上吃到 rename EPERM，这里绝不能放进 readMoments()。
   写失败也不影响服务：读的时候内存里照样会补，功能不受影响。 */
function migrateMomentCids() {
  try {
    const o = readJSON(MOMENT_FILE, null) || {};
    const raw = Array.isArray(o.list) ? o.list : [];
    let touched = false;
    raw.forEach(m => {
      if (!m || !Array.isArray(m.comments)) return;
      m.comments.forEach((c, i) => {
        if (!c || typeof c !== 'object' || c.cid) return;
        c.cid = 'c' + String(m.at || 0).toString(36) + 'x' + i.toString(36);
        c.replyTo = c.replyTo || '';
        c.replyName = c.replyName || '';
        touched = true;
      });
    });
    if (touched) writeMoments(o);
    return touched;
  } catch (e) { return false; }
}

/* ── 音乐圈互动消息（T-04）──────────────────────────────────────
   一条记录长这样：
     { id:'mm…', to:'<作者uid>', momentId:'mo…', from:'<互动的人uid>',
       act:'like'|'comment', text:'评论正文（点赞为空）', at:毫秒, read:false }
   只存**原始数据**：名字和头像在 /api/msg/list 里现查 USERS，
   跟好友申请、一起听邀请那两段的写法保持一致（改名/换头像立刻生效，
   也不会在消息里留一份过期快照）。
   ──────────────────────────────────────────────────────────────── */
function readMomentMsgs() {
  const o = readJSON(MOMENT_MSG_FILE, null) || {};
  return { list: Array.isArray(o.list) ? o.list : [] };
}
function writeMomentMsgs(o) { writeJSON(MOMENT_MSG_FILE, o); }
/* 一条动态的摘要，给消息行当正文用。
   优先取文字；没有文字就退回「《歌名》 · 歌手」；都没有就返回空 ——
   空了前端自己有兜底文案（见 index.html 的 msgSummary）。 */
function momentBrief(m) {
  if (!m) return '';
  const t = String(m.text || '').replace(/\s+/g, ' ').trim();
  if (t) return t.slice(0, 60);
  const sg = m.song || {};
  const nm = String(sg.name || sg.songname || '').trim();
  if (!nm) return '';
  const ar = String(sg.artist || sg.singer || '').trim();
  return '《' + nm + '》' + (ar ? ' · ' + ar : '');
}
/* 往某人的收件箱投一条音乐圈互动消息。
   ⚠️ 异常**必须**在函数内部吃干净（所以整个包在 try 里）：
     写消息是点赞 / 评论的附属动作，主流程（动态落库）此刻已经成功了，
     绝不能因为通知没写进去就让整个请求 500 —— 用户看到的就是「点赞失败」，
     而实际赞已经点上了，这对不上账的 bug 比没有通知更难查。 */
function pushMomentMsg(to, momentId, from, act, text) {
  try {
    if (!to || !momentId || !from) return '';
    const db = readMomentMsgs();
    const list = Array.isArray(db.list) ? db.list : [];
    const now = Date.now();
    if (act === 'like') {
      /* 点赞是 toggle：赞→取消→再赞，动作可以无限次发生，
         但收件箱里只该留一条 —— 否则同一个人反复点就被刷成一串。
         命中旧的就刷新时间并重新标未读：这确实是一次新的互动。 */
      const hit = list.find(x => x.to === to && x.momentId === momentId
                               && x.from === from && x.act === 'like');
      if (hit) { hit.at = now; hit.read = false; db.list = list; writeMomentMsgs(db); return hit.id; }
    }
    const it = {
      id: 'mm' + now.toString(36) + Math.random().toString(36).slice(2, 6),
      to, momentId, from, act,
      text: String(text || '').slice(0, 300),
      at: now, read: false
    };
    list.unshift(it);
    /* 全局配额，跟 moments.json 取同一个量级（1000）。
       满了从最早的开始丢 —— 通知记的是「最近发生的事」，
       几个月前的点赞提醒早就没有意义了。 */
    db.list = list.slice(0, 1000);
    writeMomentMsgs(db);
    return it.id;
  } catch (e) { return ''; }
}
/* 撤动态时把它产生过的通知一起带走（T-04）。
   动态是「真删」的，收件箱里再留一条点进去空空如也的通知就是纯脏数据。 */
function dropMomentMsgs(momentId) {
  try {
    const db = readMomentMsgs();
    const raw = Array.isArray(db.list) ? db.list : [];
    const keep = raw.filter(x => x.momentId !== momentId);
    if (keep.length === raw.length) return;
    db.list = keep;
    writeMomentMsgs(db);
  } catch (e) { /* 通知清不掉也不该影响撤回本身 */ }
}

/* ══════════════════════════════════════════════════════════════
   音乐圈每日汇总
   ──────────────────────────────────────────────────────────────
   一条动态 = 一条「全量」广播记录（收件面是全体注册用户，系统里没有关注
   关系，全量是唯一可能的覆盖面）；用户收件箱里呈现的是**当天那一条汇总**。
   两者是同一批内容的两层，不是两套消息。

   汇总以 beijingDayKey()（北京时间自然日）为主键，全局一天最多存在一条
   记录 —— 所以「每人每天最多 1 条」是**数据结构本身保证的**，不需要
   per-user 去重表，也不存在"重复推送"这个故障模式。
   已读同样按天记：read[uid] = 'YYYY-MM-DD' 单值，不是数组。
   ══════════════════════════════════════════════════════════════ */
function readMomentDaily() {
  const o = readJSON(MOMENT_DAILY_FILE, null) || {};
  return {
    days: (o.days && typeof o.days === 'object') ? o.days : {},
    read: (o.read && typeof o.read === 'object') ? o.read : {}
  };
}
function writeMomentDaily(o) { writeJSON(MOMENT_DAILY_FILE, o); }

/* 内存缓存。/api/msg/list 是读接口，本方案会让它偶尔写盘，必须节流：
   稳态下一天写盘 ≈ 首次生成 1 次 + 当天动态条数（今天实测 22）≈ 23 次。 */
const MOMENT_DAILY_MEM = { day: '', obj: null };

/* 扫出某个自然日的全部动态。当天没有 → list 为空、lastAt 为 0。 */
function dailyScan(day) {
  const list = readMoments().list || [];
  const out = [];
  let firstAt = 0, lastAt = 0;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || beijingDayKey(m.at) !== day) continue;
    out.push(m);
    const at = Number(m.at) || 0;
    if (at > lastAt) lastAt = at;
    if (!firstAt || at < firstAt) firstAt = at;
  }
  return { list: out, firstAt: firstAt, lastAt: lastAt };
}

/* 按当前 moments.json 重算某一天。当天没有任何动态 → 返回 null（不该有汇总）。
   prevAt：沿用已有的 at，让列表排序稳定（at 一旦生成就不再变）。
   scan：调用方已经扫过就传进来，省一次读盘。 */
function dailyRecalc(day, prevAt, scan) {
  const s = scan || dailyScan(day);
  const todays = s.list;
  if (!todays.length) return null;

  const uidSet = {}, songUidSet = {}, songKeySet = {};
  const uids = [], songUids = [], songs = [], momentIds = [];
  let count = 0, songCount = 0;
  for (let i = 0; i < todays.length; i++) {
    const m = todays[i];
    count++;
    momentIds.push(m.id);
    const uid = String(m.uid || '');
    if (uid && !uidSet[uid]) { uidSet[uid] = true; uids.push(uid); }
    const sg = m.song || null;
    const sName = sg ? String(sg.name || sg.songname || '').trim() : '';
    if (!sName) continue;                     // 纯文字动态不计入 songAuthors
    songCount++;
    if (uid && !songUidSet[uid]) { songUidSet[uid] = true; songUids.push(uid); }
    /* 歌级去重：同一个人把同一首歌反复发 / 转发，只占一个快照位 */
    const key = uid + '|' + String(sg.hash || sg.id || sName);
    if (!songKeySet[key] && songs.length < MOMENT_DAILY_NAME_MAX) {
      songKeySet[key] = true;
      songs.push({ name: sName.slice(0, 120), artist: String(sg.artist || sg.singer || '').slice(0, 120) });
    }
  }
  /* 🔴 汇总说的是「上传了新歌」，所以当天**一条带歌的动态都没有**时就不该有汇总。
     上面那个 `if (!todays.length) return null` 只挡了「当天完全没动态」，挡不住
     「当天有动态、但全是纯文字」—— 实测：三条动态里两条带歌的被撤回后，
     剩下一条纯文字，原样会渲染出「今天有 0 位用户上传了新歌」的空壳。
     这个判断放在这里（而不是在渲染处判断 N>0）是因为 dailyRecalc 有两个调用方
     （ensureMomentDaily 和 dropMomentDailyRefs），放这里一处就都覆盖了。 */
  if (!songCount) return null;

  /* 昵称快照：与评论 replyName 同一惯例，用户以后改名，历史消息里仍显示当时名字 */
  const names = [];
  for (let i = 0; i < songUids.length && names.length < MOMENT_DAILY_NAME_MAX; i++) {
    const u = USERS[songUids[i]];
    names.push(u && u.username ? String(u.username) : '有人');
  }
  return {
    id: 'md' + String(day).replace(/-/g, ''),
    day: day,
    at: prevAt || Date.now(),
    updatedAt: Date.now(),
    firstAt: s.firstAt, lastAt: s.lastAt,
    count: count,
    n: uids.length,
    songCount: songCount,
    songAuthors: songUids.length,
    uids: uids.slice(0, MOMENT_DAILY_UID_MAX),
    names: names,
    songs: songs,
    momentIds: momentIds
  };
}

/* 惰性生成：谁拉 /api/msg/list 就给谁算，不预生成、不定时广播。
   ⚠️ 异常**必须**在函数内部吃干净：汇总算不出来绝不能让 /api/msg/list 500 ——
   红点全站失效、互动消息全部消失，比"没有汇总"严重得多。
   ⚠️ 任一请求内对 moment-daily.json 最多写一次（Windows 上同一 tick 内对
   同一文件连续两次原子写会稳定随机吃 EPERM rename，而 writeJSONAtomic 是
   吞异常的，症状是"响应回了 ok、盘上没有"）。 */
function ensureMomentDaily() {
  try {
    if (!momentDailyOn()) return null;
    const day = beijingDayKey(Date.now());
    let db = (MOMENT_DAILY_MEM.day === day && MOMENT_DAILY_MEM.obj) ? MOMENT_DAILY_MEM.obj : null;
    if (!db) { db = readMomentDaily(); MOMENT_DAILY_MEM.day = day; MOMENT_DAILY_MEM.obj = db; }
    const rec = db.days[day];
    const scan = dailyScan(day);
    if (!scan.lastAt) {                       // 当天没有任何动态 → 不该有汇总
      if (rec) { delete db.days[day]; writeMomentDaily(db); }
      return null;
    }
    /* 没有任何变化就零写盘；updatedAt 那一半只是纯节流，不是周期重写 */
    if (rec && (rec.lastAt || 0) >= scan.lastAt
            && Date.now() - (rec.updatedAt || 0) < MOMENT_DAILY_MIN_WRITE_MS) return rec;
    const next = dailyRecalc(day, rec && rec.at, scan);
    if (!next) { if (rec) { delete db.days[day]; writeMomentDaily(db); } return null; }
    db.days[day] = next;
    /* 配额：按天升序，超过保留天数从最早的删 */
    const keys = Object.keys(db.days).sort();
    while (keys.length > MOMENT_DAILY_KEEP_DAYS) {
      const old = keys.shift();
      delete db.days[old];
      if (db.read) for (const u of Object.keys(db.read)) if (db.read[u] === old) delete db.read[u];
    }
    writeMomentDaily(db);
    return next;
  } catch (e) { return null; }
}

/* 我读到哪一天了。汇总的已读按「天」记，不按消息 id。 */
function momentDailyReadDay(uid) {
  try {
    const db = MOMENT_DAILY_MEM.obj;
    if (!db || !db.read || !uid) return '';
    return String(db.read[uid] || '');
  } catch (e) { return ''; }
}

/* 撤动态时把它从汇总里摘掉并重算（与 dropMomentMsgs 同款理由：动态是真删的，
   收件箱里再留一条点进去空空如也的通知就是纯脏数据）。
   当天因为撤回变成 0 条 → 整条记录删掉，消息跟着消失，
   不留「今天有 0 位用户」的空壳。 */
function dropMomentDailyRefs(momentId) {
  try {
    if (!momentId) return;
    const db = readMomentDaily();
    let hit = false;
    for (const day of Object.keys(db.days)) {
      const r = db.days[day];
      if (!r || !Array.isArray(r.momentIds) || r.momentIds.indexOf(momentId) < 0) continue;
      const next = dailyRecalc(day, r.at, null);
      if (next) db.days[day] = next; else delete db.days[day];
      hit = true;
    }
    if (hit) {
      writeMomentDaily(db);
      MOMENT_DAILY_MEM.obj = null; MOMENT_DAILY_MEM.day = '';   // 让内存缓存失效
    }
  } catch (e) { /* 汇总清不掉也不该影响撤回本身 */ }
}

/* ★ U-25：删评论时把它产生的那条通知一起带走。
   上面 dropMomentMsgs 是「撤动态 → 清整条动态的通知」，这一条是
   「撤单条评论 → 只清那一条评论的通知」。
   ⚠️ 消息里**没有 cid**（pushMomentMsg 只记 momentId / from / act / text），
      所以只能按 momentId + from + text 匹配。
      同一个人可能在同一条动态下连发两条一模一样的评论（比如两句「好听」），
      这时按时间最接近的那条撤 —— 删的是哪条评论，就撤哪条通知。 */
function dropMomentCommentMsg(momentId, from, text, at) {
  try {
    const db = readMomentMsgs();
    const raw = Array.isArray(db.list) ? db.list : [];
    const cands = [];
    for (let i = 0; i < raw.length; i++) {
      const x = raw[i];
      if (x && x.momentId === momentId && x.from === from && x.act === 'comment'
          && String(x.text || '') === String(text || '')) cands.push(i);
    }
    if (!cands.length) return;
    let pick = cands[0];
    if (cands.length > 1 && at) {
      let best = Infinity;
      for (let k = 0; k < cands.length; k++) {
        const d = Math.abs(Number(raw[cands[k]].at || 0) - Number(at));
        if (d < best) { best = d; pick = cands[k]; }
      }
    }
    raw.splice(pick, 1);
    db.list = raw;
    writeMomentMsgs(db);
  } catch (e) { /* 通知清不掉也不该影响删评论本身 */ }
}

function readRooms() {
  const o = readJSON(LISTEN_FILE, null) || {};
  return { rooms: Array.isArray(o.rooms) ? o.rooms : [] };
}
function writeRooms(o) { writeJSON(LISTEN_FILE, o); }

/* 房间里的歌：**必须整首存**，不能只存歌名。
 * 客人那一侧拿到房间状态后要真的把这首放起来，走的是 /api/resolve，
 * 而 resolve 认的是 source / hash / sqhash / duration 这些能定位到音源的字段 ——
 * 早年只存 name+artist+id，客人就算拉到了房间也只有两个字符串，
 * 根本放不出来（用户实测报的「对方播放我这边不播放」一半原因在这儿）。
 *
 * 两套键都要留：房间态自己的 name/artist（广播给面板显示），
 * 和主 App 播放器那套 songname/singer（loadAndPlay / Api.resolve 用）。
 * 客户端传哪一套都认，进来这里统一归一化。
 *
 * 全部走白名单 + 截断：房间数据是账号间互相投递的，
 * 绝不能让一个人把任意 JSON 塞进另一个人的播放列表里。 */
function roomSong(sg) {
  const s = sg && typeof sg === 'object' ? sg : {};
  const cut = (v, n) => String(v == null ? '' : v).slice(0, n);
  const name = cut(s.songname || s.name || s.title, 200).trim();
  const artist = cut(s.singer || s.artist, 200).trim();
  return {
    name, artist,
    songname: name, singer: artist,
    album: cut(s.album, 200),
    id: cut(s.id, 100),
    hash: cut(s.hash, 100),
    sqhash: cut(s.sqhash, 100),
    h320hash: cut(s.h320hash, 100),
    cover: cut(s.cover, 500),
    source: cut(s.source, 40),
    sourceName: cut(s.sourceName, 40),
    duration: Number(s.duration) || 0,
    size: Number(s.size) || 0
  };
}
const MAX_UPLOAD = 40 * 1024 * 1024;          // 单曲上限 40MB
const ALLOW_CT = /^audio\//i;

function readUploads() {
  const o = readJSON(UPLOAD_META, null) || {};
  return { list: Array.isArray(o.list) ? o.list : [] };
}
function writeUploads(o) { writeJSON(UPLOAD_META, o); }

/* ── 头像 ──────────────────────────────────────────────────────────────
 * 为什么单开 data/avatars/ + data/avatars.json，而不塞进 uploads.json：
 *   ① uploads.json 每条都是「一首歌」（name/artist/album/plays），管理端
 *      音频审核列表按这套字段渲染，头像混进去会多出一堆字段全空的怪条目。
 *   ② 生命周期不同：一首歌要长期留在曲库供人播放；头像一个人永远只有
 *      一张生效的，旧的被换掉就该回收。
 *   ③ 音频走票据播放（/api/music/file），头像是 <img src> 直接拉，
 *      访问模型完全不一样，放一起只会互相迁就。
 * 于是：实体文件 data/avatars/<id>.<ext>，审核队列 data/avatars.json，
 * 「当前生效」只记在 USERS[uid].avatar（一个 id，指回队列里那条），
 * 待审期间只记 USERS[uid].avatarPending。上传仍走 POST /api/upload
 * （带 kind=avatar），复用同一套读请求体 / 落盘 / 写队列的流程。
 * ────────────────────────────────────────────────────────────────────── */
const AVATAR_DIR = path.join(APP_DIR, 'data', 'avatars');
const AVATAR_META = path.join(APP_DIR, 'data', 'avatars.json');
const MAX_AVATAR = 3 * 1024 * 1024;               // 头像上限 3MB（头像不是歌，40MB 那条不适用）
const AVATAR_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
const AVATAR_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
/* 魔数校验：后缀是客户端说了算的，文件头才是真的。
   只认这四种常见图片，其余一律挡在写入磁盘之前。 */
function imgMagicOK(buf, ext) {
  if (!buf || buf.length < 12) return false;
  if (ext === 'png') return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
  if (ext === 'gif') return buf.slice(0, 6).toString('ascii').indexOf('GIF8') === 0;
  if (ext === 'jpg' || ext === 'jpeg') return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  if (ext === 'webp') return buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP';
  return false;
}
function readAvatars() {
  const o = readJSON(AVATAR_META, null) || {};
  return { list: Array.isArray(o.list) ? o.list : [] };
}
function writeAvatars(o) { writeJSON(AVATAR_META, o); }
/* 对外只吐「已通过审核」的头像地址；没头像 / 还在待审 → ''，前端回退字母块。
   ⚠️ 这里就是「不能先上车后补票」的落点：
      换头像只动 avatarPending，不动 avatar，新头像在过审前绝不从这里漏出去。 */
function avatarUrlOf(u) {
  const a = u && u.avatar;
  if (!a || !a.id) return '';
  return '/api/avatar/file?id=' + encodeURIComponent(a.id);
}
/* 带上限地把请求体读完（音频 40MB / 头像 3MB 共用这一份）。
   ⚠️ 超限绝不能 req.destroy()：socket 一掐，413 就写不回客户端了，
      fetch 只会抛 TypeError，用户永远看不到「文件超过 N MB」这个真原因。
      正确做法：置标志 → 剩下的照常读完丢弃（连接能正常收尾）→ 立刻 reject。 */
function readRaw(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0, tooBig = false;
    req.on('data', c => {
      if (tooBig) return;                 // 不再 push，免得无上限吃内存
      total += c.length;
      if (total > cap) {
        tooBig = true;
        chunks.length = 0;
        reject(new Error('too big'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!tooBig) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
/* 对外只暴露必要字段，不把磁盘路径泄漏出去 */
function pubTrack(t) {
  return {
    id: t.id, uid: t.uid, name: t.name, artist: t.artist, album: t.album,
    size: t.size, ext: t.ext, at: t.at, state: t.state, reason: t.reason || '',
    plays: t.plays || 0,
    /* ★ U-27：时长。上传落盘那一刻算不出来（零依赖解析 mp3/m4a/flac/wav
       各一套容器格式，VBR 还常算错），所以默认是 0 —— 由前端播过一遍之后
       通过 POST /api/music/duration 回传真值，写回 uploads.json。
       字段必须存在：前端「我的上传 / TA 的主页」直接读它，
       缺字段会被当成「没有时长」而不是「还没算过」，两种状态要分得开。 */
    duration: Number(t.duration) || 0
  };
}
/* 上传行 → 搜索结果行的适配（R13 / U-01）。
   ⚠️ 不要改 pubTrack()：它还有 /api/music/mine、/api/user/profile、
      /api/admin/uploads 三个消费方，改了会连带伤到这三处。 */
function uploadToRow(t, uploaderName) {
  return {
    id:           t.id,
    songname:     t.name   || '',
    singer:       t.artist || '',
    album:        t.album  || '',
    source:       'upload',
    sourceName:   '上传',
    /* ★ 必须显式 false，不能是 undefined：mergePlatforms 里是
       `Number(prev.vip) - Number(it.vip)`，Number(undefined) = NaN → falsy
       → 整个 VIP 优先判断被跳过 → 三层策略一条都不生效。 */
    vip:          false,
    ext:          t.ext    || 'mp3',
    /* ★ U-27：以前这里写死 0 / ''，于是搜索结果里的上传行永远没有时长。
       现在读真实值（没有就是 0，跟其它平台行一样靠 fmtDur 出 '--:--' 那一档）。 */
    duration:     Number(t.duration) || 0,
    durationText: Number(t.duration) ? fmtDur(Number(t.duration)) : '',
    cover:        '',
    uploader:     uploaderName || '（已注销）',
    uid:          t.uid
  };
}

/* 站内检索池（搜索池二，R13 / U-02）。
   ⚠️ 只复用 /api/music/list 的 approved 口径，**绝不照抄它的 kw 过滤** ——
      那边是整串 indexOf，搜「周杰伦 晴天」这种词序永远命中不到。
   ⚠️ **不要加 sort**：多人上传同名歌时「新的优先」是零成本默认行为
      （/api/upload 用 unshift 插到队首，mergePlatforms 平局保留先遍历到的）。
      加任何 sort 都可能把顺序翻成正序，别动。 */
function searchUploads(kw, limit) {
  const o = readUploads();
  /* ★ U-17：注销账号的上传行不进搜索池（作者 uid 已不在 USERS 里）。
     文件与元数据按 U-16 保留（还能播），但检索侧不展示，
     免得点进去是一个不存在的主页。 */
  let list = o.list.filter(t => t.state === 'approved' && USERS[t.uid]);
  const words = String(kw || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) {
    list = list.filter(t => {
      const hay = ((t.name || '') + ' ' + (t.artist || '') + ' ' + (t.album || '')).toLowerCase();
      return words.every(w => hay.indexOf(w) >= 0);      // 拆词 AND，词序无关
    });
  }
  /* ★ U-18：songname 为空会让整行被 mergePlatforms **静默丢弃**
     （那两处门禁是 `if (!it || !it.songname) continue;`，不报错、不告警、直接跳过）。
     后果是接口照样返回 200、结果里没有这首歌 —— 只看返回值永远测不出来，
     这是最难排查的失败形态。所以这里显式挡掉并记一条服务端日志。 */
  const out = [];
  for (const t of list.slice(0, limit || 50)) {
    const row = uploadToRow(t, (USERS[t.uid] && USERS[t.uid].username) || '（已注销）');
    /* ★ 关键字必须是 `U18_SKIP` 这种机器可 grep 的英文串，不能写中文半句 ——
       这条日志是「整行被静默丢弃」唯一的自动化抓手，QA 的回归脚本靠它判断。 */
    if (!row.songname) {
      console.log('U18_SKIP ' + t.id + ' ' + JSON.stringify({ name: t.name, file: t.file }));
      continue;
    }
    /* ⚠️ 歌手为空**不是**错误，只告警、照常放行。
       /api/upload 只校验 name 必填，artist 完全可空 —— 这里要是也 skip，
       等于把我们要修的病原样再造一遍：用户传了歌、没填歌手，照样搜不到。 */
    if (!row.singer) {
      console.log('U18_SINGER_EMPTY ' + t.id + ' ' + JSON.stringify({ name: row.songname, artist: t.artist }));
    }
    out.push(row);
  }
  return out;
}

/* ── 上传音频的短时效访问票据（R13 / U-00）─────────────────────────
   为什么不用裸 session token：SESSION_TTL 是 90 天。token 一旦进 URL，
   等于把整个账号 90 天的权限交给了浏览器历史、Referer 和任何中间代理。
   票据：HMAC-SHA256、60 秒有效、绑定 songId + uid（换歌/换人都拒）。
   密钥落 data/secrets.json（与 SMTP 配置同文件，复用 writeJSON 原子写）。 */
function ticketSecret() {
  /* 环境变量优先：容器化部署时密钥靠注入，不能指望往容器里塞文件。
     ⚠️ 只在这里加兜底就够了 —— mint / verify 两个消费方都走 ticketSecret()，
        不会出现一边用环境变量、一边用落盘密钥的错配。
        但一旦配了 YM_TICKET_KEY 就**必须**在所有实例上配同一个值，
        否则 A 签的票 B 验不过（票据只有 60 秒，多实例时尤其要注意）。 */
  if (process.env.YM_TICKET_KEY) return process.env.YM_TICKET_KEY;
  /* SECRETS 由 refreshData() 按 mtime 热更新；这里先信内存，内存没有再读盘，
     生成后两边都写上，免得下一轮 refreshData 把它覆盖回空。 */
  let s = (SECRETS && typeof SECRETS === 'object') ? SECRETS : {};
  if (!s.uploadTicketKey) {
    const d = readJSON(SECRETS_FILE, {}) || {};
    if (d.uploadTicketKey) s.uploadTicketKey = d.uploadTicketKey;
  }
  if (!s.uploadTicketKey) {
    s.uploadTicketKey = crypto.randomBytes(32).toString('hex');
    writeJSON(SECRETS_FILE, s);
  }
  return s.uploadTicketKey;
}
/* ★ P0 止血（上传歌播过 60 秒必挂）：票据窗口 60 秒 → 6 小时。
   只改下面这一行 exp 的计算；验签逻辑、签名内容、其它函数一律不动。

   ① 原来为什么是 60 秒：历史意图是「收紧分享窗口」——担心带票据的 URL 被
      转发出去后长时间可用。这个担心本身没错，但它把「分享窗口」和「播放
      窗口」当成了同一个东西，而这两个根本不是一回事。

   ② 为什么必须放大到小时级：/api/resolve 的 upload 分支把带 exp/sig 的
      票据 URL **一次性**交给前端，前端把它固定进 <audio>.src 之后就不再
      换了。浏览器续缓冲、拖进度条，用的都是这同一个 URL —— 也就是说票据
      窗口必须 ≥ 一次完整播放会话。上传歌曲动辄 3～5 分钟，60 秒的窗口
      **必然**在播放中途到期：/api/music/file 回 403「链接已失效」，被
      /api/proxy 翻译成 502 + JSON，<audio> 收到非音频字节触发 error，
      前端弹出「没找到音频文件，可能已被删除」。取 6 小时是为了覆盖任何
      正常听歌场景（含循环播放一整晚），一次播放会话远远用不完。

   ③ 为什么放大后依然是安全的：票据用 HMAC-SHA256 绑定 (id, uid, exp)，
      verifyUploadTicket() 保证改 id / 改 uid / 改 exp 三者任一都会验签
      失败。票据原本要防的三件事——换歌、换人、把 90 天 session token 塞
      进 URL——**全部由签名机制达成，与 60 秒这个时长无关**；真正挡住
      「超时」的也还是 exp 字段本身，不是 60 秒这个数值。放大到 6 小时只
      是让窗口匹配播放时长，票据仍然只授权「某一首歌给某一个人」，分享
      出去的泄露面本来就有限。 */
function mintUploadTicket(id, uid) {
  const exp = Date.now() + 6 * 60 * 60 * 1000;
  const sig = crypto.createHmac('sha256', ticketSecret())
                    .update(String(id) + '|' + String(uid) + '|' + exp).digest('hex');
  return { exp: exp, sig: sig };
}
function verifyUploadTicket(id, uid, exp, sig) {
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const want = crypto.createHmac('sha256', ticketSecret())
                     .update(String(id) + '|' + String(uid) + '|' + Number(exp)).digest('hex');
  return String(sig) === want;
}

function extOf(ct) {
  const s = String(ct || '').toLowerCase();
  if (s.indexOf('flac') >= 0) return 'flac';
  if (s.indexOf('wav') >= 0) return 'wav';
  if (s.indexOf('mp4') >= 0 || s.indexOf('m4a') >= 0) return 'm4a';
  if (s.indexOf('ogg') >= 0) return 'ogg';
  if (s.indexOf('aac') >= 0) return 'aac';
  return 'mp3';
}
/* 在线时长统一按北京时间自然日统计。记录里的 day 是这笔 today 所属日期；
 * 读榜单/主页时也校验日期，所以到了北京时间 0 点，即使用户还没发下一次心跳，
 * 昨天的 today 也不会继续混进今天。 */
const BEIJING_OFFSET = 8 * 60 * 60 * 1000;
function beijingDayKey(ms) {
  return new Date(Number(ms == null ? Date.now() : ms) + BEIJING_OFFSET).toISOString().slice(0, 10);
}
function beijingDayStart(ms) {
  const shifted = new Date(Number(ms == null ? Date.now() : ms) + BEIJING_OFFSET);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - BEIJING_OFFSET;
}
function normalizedDayKey(v) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(v || ''));
  return m ? (m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0')) : '';
}
function presenceTodayMs(p, now) {
  if (!p || normalizedDayKey(p.day) !== beijingDayKey(now)) return 0;
  return Math.max(0, Number(p.today) || 0);
}
function nextPresenceDurations(prev, now) {
  const day = beijingDayKey(now);
  const prevAt = Number(prev && prev.at) || 0;
  let add = 0;
  if (prevAt && now >= prevAt && (now - prevAt) <= ONLINE_WINDOW * 2) add = now - prevAt;
  const total = (Number(prev && prev.total) || 0) + add;
  let today = presenceTodayMs(prev, now);
  if (add > 0) {
    const start = beijingDayStart(now);
    today += prevAt < start ? Math.max(0, now - start) : add;
  }
  return { day, today, total, add };
}
/* 在线时长排行：隐身的人不上榜，免得「隐身」白设了。 */
function topActive(n, key) {
  const pre = readJSON(PRESENCE_FILE, {});
  const out = [];
  const now = Date.now();
  for (const uid of Object.keys(pre)) {
    const p = pre[uid];
    if (!p || p.state === 'invisible') continue;
    const ms = key === 'today' ? presenceTodayMs(p, now) : Math.max(0, Number(p[key]) || 0);
    if (ms <= 0) continue;
    const u = USERS[uid];
    if (!u) continue;
    const online = !!p.at && now - Number(p.at) <= ONLINE_WINDOW;
    out.push({ uid, username: u.username || '用户', ms, online });
  }
  out.sort((a, b) => b.ms - a.ms || String(a.uid).localeCompare(String(b.uid)));
  return out.slice(0, n);
}
/* 心跳超过这个时间没续上就当离线。客户端每 30 秒报一次，
 * 留 3 次容错，弱网抖一下不会被误判成掉线。 */
const ONLINE_WINDOW = 90000;

function readSocial() {
  const s = readJSON(SOCIAL_FILE, null) || {};
  return {
    friends: s.friends && typeof s.friends === 'object' ? s.friends : {},
    requests: Array.isArray(s.requests) ? s.requests : [],
    shares: Array.isArray(s.shares) ? s.shares : [],
    /* 🔴 friendNotes：好友申请的**结果**通知（2026-10-16 加，消息系统重构第 2 步）。
       用途：别人通过 / 拒绝了我的好友申请时，给**申请人**留一条通知 ——
       在此之前这条链是**完全静音**的，申请人永远不知道结果。
       ⚠️ 这个白名单是**重建式**的：不在这里列出来的字段，每次 readSocial() 之后
          再 writeSocial() 都会被**静默丢掉**（不是报错，是数据消失）。
          所以任何新增的 social 字段都必须同时加到这一行，否则写进去也没用。 */
    friendNotes: Array.isArray(s.friendNotes) ? s.friendNotes : [],
    chat: Array.isArray(s.chat) ? s.chat : []
  };
}
function writeSocial(s) { writeJSON(SOCIAL_FILE, s); }
/* 跟我有关的私聊消息（收或发都算），且我没在【我这一侧】删掉过。
   hide 是"哪几个人把自己这份删了"，所以必须按人过滤，
   我删了不影响对方还能看见。 */
function chatWith(list, me, peer){
  return list.filter(x => {
    const relat = (x.from === me && x.to === peer) || (x.from === peer && x.to === me);
    if (!relat) return false;
    if (x.hide && Array.isArray(x.hide) && x.hide.indexOf(me) >= 0) return false;
    return true;
  });
}

/* 在线判定。real=true 时连隐身的也认（管理端用）；
 * 普通用户之间，隐身一律显示离线。 */
function onlineOf(uid, real) {
  const all = readJSON(PRESENCE_FILE, {});
  const p = all[uid];
  if (!p || !p.at) return false;
  if (Date.now() - p.at > ONLINE_WINDOW) return false;
  if (real) return true;
  return p.state !== 'invisible';
}
function presenceRecord(uid) {
  const all = readJSON(PRESENCE_FILE, {});
  return all[uid] || null;
}
function presenceOf(uid) {
  const p = presenceRecord(uid);
  if (!p || !p.at || Date.now() - p.at > ONLINE_WINDOW) return null;
  return p;
}
/* 同一首歌在不同来源可能写法不同（《起风了》/ 起风了 / 起风了(Live)），
 * 统一成 key 才好统计「现在有几个人在听这首」。 */
function songKey(s) {
  const n = String((s && s.name) || '').toLowerCase()
    .replace(/\s+/g, '').replace(/[（(].*?[)）]/g, '');
  const a = String((s && s.artist) || '').toLowerCase().replace(/\s+/g, '');
  return n + '|' + a;
}
function maskPhone(v) {
  const s = String(v || '');
  return s.length >= 7 ? (s.slice(0, 3) + '****' + s.slice(-4)) : s;
}
function maskEmail(v) {
  const s = String(v || '');
  const i = s.indexOf('@');
  if (i < 1) return s;
  const name = s.slice(0, i);
  return (name.length > 2 ? name.slice(0, 1) + '***' + name.slice(-1) : name) + s.slice(i);
}
/* 把一个账号从整个社交/内容体系里彻底摘掉。
 * 管理台删号和 App 自助注销共用这一份逻辑，避免两边口径不一样留下脏数据：
 * 好友关系、歌曲分享、音乐圈动态、一起听房间、在线心跳、上传的歌，一个都不留。 */
function purgeUser(uid, operator) {
  const out = { friends: 0, requests: 0, shares: 0, moments: 0, rooms: 0, uploads: 0, files: 0 };

  const s = readSocial();
  for (const k of Object.keys(s.friends)) {
    if (k === uid) { out.friends += (s.friends[k] || []).length; delete s.friends[k]; continue; }
    const before = (s.friends[k] || []).length;
    s.friends[k] = (s.friends[k] || []).filter(x => x !== uid);
    out.friends += before - s.friends[k].length;
  }
  const rq = s.requests.length;
  s.requests = s.requests.filter(r => r.from !== uid && r.to !== uid);
  out.requests = rq - s.requests.length;
  const sh = s.shares.length;
  s.shares = s.shares.filter(x => x.from !== uid && x.to !== uid);
  out.shares = sh - s.shares.length;
  writeSocial(s);

  const m = readMoments();
  const ml = m.list.length;
  m.list = m.list.filter(x => x.uid !== uid);
  out.moments = ml - m.list.length;
  writeMoments(m);

  const rr = readRooms();
  const rl = rr.rooms.length;
  rr.rooms = rr.rooms.filter(x => x.host !== uid && x.guest !== uid);
  out.rooms = rl - rr.rooms.length;
  writeRooms(rr);

  try {
    const all = readJSON(PRESENCE_FILE, {});
    if (all[uid]) { delete all[uid]; writeJSON(PRESENCE_FILE, all); }
  } catch { /* ignore */ }
  try {
    const rd = readJSON(NOTICE_READ, {});
    if (rd[uid]) { delete rd[uid]; writeJSON(NOTICE_READ, rd); }
  } catch { /* ignore */ }

  /* ★ U-16：注销时**不再**删这个人的上传文件，也**不再**清 uploads.json 里的元数据。
     「已注销作者的歌仍然可播」是刻意保留的行为（/api/music/file 不做 USERS 校验），
     文件和元数据都留在站里，别人点开还能听 —— 不要顺手把这个"修掉"。
     只留一条可 grep 的日志（U16_KEEP），将来排查"注销后歌怎么还在"时一眼能对上。 */
  const up = readUploads();
  let keptUploads = 0;
  for (const t of up.list) if (t.uid === uid) keptUploads++;
  out.uploads = 0;                 // U-16 起不再删元数据，这两个数恒为 0
  out.files = 0;                   // 也不再删文件
  out.uploadsKept = keptUploads;   // 保留了多少首，回给调用方显示
  if (keptUploads) {
    console.log('U16_KEEP operator=' + (operator || 'unknown') + ' uid=' + uid + ' keptUploads=' + keptUploads);
  }
  writeUploads(up);                // 内容没动，落一次盘保持原有"读-改-写"节奏

  return out;
}

/* ══════════════════════════════════════════════════════════════
   角色与授权码
   ──────────────────────────────────────────────────────────────
   superadmin = 开发者（整套系统的根，不可被降级/注销，只能主动转让）
   admin      = 管理员（能审核、发公告、管账号，自己照常用 App）
   其余        = 普通用户
   授权码：注册时想当管理员要填它。存在 data/admin-code.json，
   开发者可以在管理台随时改，改完旧码立刻失效。
   ══════════════════════════════════════════════════════════════ */
const ADMIN_CODE_FILE = path.join(APP_DIR, 'data', 'admin-code.json');
const DEFAULT_ADMIN_CODE = 'CHANGE_ME_ADMIN_CODE';
function getAdminCode() {
  try {
    const j = JSON.parse(fs.readFileSync(ADMIN_CODE_FILE, 'utf8'));
    const c = j && typeof j.code === 'string' ? j.code.trim() : '';
    if (c) return c;
  } catch { /* 没配就用默认码 */ }
  return DEFAULT_ADMIN_CODE;
}
function setAdminCode(code) {
  writeJSON(ADMIN_CODE_FILE, { code: String(code || '').trim(), at: Date.now() });
}
/* ⚠️ 公网安全闸（P0）：默认授权码 CHANGE_ME_ADMIN_CODE 是写死在源码里的，谁都能看到。
 * 服务一旦绑 0.0.0.0（云上/局域网），再用这个默认码就等于把「注册即管理员」
 * 的后门开给全网 —— /api/admin/claim 填上 CHANGE_ME_ADMIN_CODE 直接提权（实测复现）。
 * 所以：绑公网 + 从未自定义过授权码 = 启动时生成随机码落盘。
 * 开发者仍可在管理台「设置 → 管理员授权码」里查看/改成自己顺手的。
 * 只绑 127.0.0.1 的本机自用场景不受影响，保留默认码的便利。 */
(function ensureAdminCode() {
  try {
    const j = JSON.parse(fs.readFileSync(ADMIN_CODE_FILE, 'utf8'));
    if (j && typeof j.code === 'string' && j.code.trim()) return;   // 已经自定义过，不动
  } catch { /* 没有文件，往下走 */ }
  if ((process.env.HOST || '127.0.0.1') !== '0.0.0.0') return;      // 本机自用保留默认码
  const c = 'YM' + crypto.randomBytes(12).toString('base64url');    // 18 位随机，猜不动
  writeJSON(ADMIN_CODE_FILE, { code: c, at: Date.now(), auto: true });
  console.log('[安全] 检测到公网监听且从未自定义授权码，已自动生成随机授权码。');
  console.log('       请用开发者账号在管理台「设置 → 管理员授权码 → 显示」查看。');
})();
const isSuper = u => !!u && u.role === 'superadmin';
/* claim 授权码试错记录：key = ip|uid → { t0, n }（见 /api/admin/claim） */
const CLAIM_TRIES = new Map();
const isAdmin = u => !!u && (u.role === 'admin' || u.role === 'superadmin');
const roleOf  = u => (u && u.role === 'superadmin') ? 'superadmin' : ((u && u.role === 'admin') ? 'admin' : 'user');
/* 真实在线：隐身只是对**其它普通用户**隐藏，管理端看的是心跳本身 */
function presView(all, uid) {
  const p = (all || {})[uid];
  if (!p || !p.at) return { online: false, hidden: false, lastSeen: 0, song: null, today: 0, total: 0, device: '' };
  const fresh = Date.now() - Number(p.at) <= ONLINE_WINDOW;
  return {
    online: fresh,
    hidden: fresh && p.state === 'invisible',
    lastSeen: Number(p.at) || 0,
    song: (fresh && p.song && p.song.name) ? { name: p.song.name, artist: p.song.artist || '' } : null,
    today: presenceTodayMs(p, Date.now()), total: Number(p.total) || 0, device: p.device || ''
  };
}
/* 管理接口统一鉴权。被拒时已经把响应发出去了，返回 null 让调用方直接 return。 */
function adminOf(req, res, needSuper) {
  /* ⚠️ userOf 返回的是 { uid, user, token } 包装对象，不是账号本身。
     要判断 role 必须取 .user —— 直接拿返回值查 role 永远是 undefined，
     结果就是"管理员也说自己没权限"。 */
  const sess = userOf(req);
  const me = sess && sess.user;
  if (!me) { sendJSON(res, { ok: false, error: '未登录' }, 401); return null; }
  if (!isAdmin(me)) { sendJSON(res, { ok: false, error: '没有管理权限' }, 403); return null; }
  if (needSuper && !isSuper(me)) { sendJSON(res, { ok: false, error: '只有开发者能做这件事' }, 403); return null; }
  return me;
}
/* ---------------- IP 属地（省级）----------------
 * 数据文件：geo/ip2region_v4.xdb
 *   上游 https://github.com/lionsoul2014/ip2region ，Apache-2.0 OR MIT 双授权，
 *   本项目选 MIT，许可证全文见仓库根目录 LICENSE-ip2region。
 *
 * 🔴 整块逻辑必须内联在本文件里，不许拆成新模块再 import：
 *    SEA 打包（build-exe.py / 管理端）只把单个 server.mjs 注入 blob，
 *    多出来的本地模块不会进包，exe 版会直接起不来。
 *
 * 三条硬边界（改这块前先读一遍）：
 *   1. 只下发省份短名 —— 城市 / ISP / 国家 ISO 码在解析函数内部就丢掉，
 *      不进任何对象、不进 JSON、不上网络；
 *   2. 省份只在内存 Map 里，不写 users.json / presence.json / 任何 data/*.json；
 *   3. 任何异常、任何查不到的情况一律返回空串 —— 前端 if(prov) 判掉就不渲染，
 *      界面和没有这个功能时一模一样。「不显示」永远优先于「显示一个可能是错的」。
 * ------------------------------------------------ */
const IPGEO_XDB = path.join(APP_DIR, 'geo', 'ip2region_v4.xdb');
/* 全量读进内存：实测常驻 10.61 MiB、单次查询 1.09 微秒（30 万次 328 ms），
   没有 IO 也就没有竞态。加载失败只 warn 一次然后整体降级，绝不 throw、
   绝不拦住进程启动 —— 属地是锦上添花，不能变成开机自检。 */
let IPGEO_BUF = null;
try {
  const _b = fs.readFileSync(IPGEO_XDB);
  /* 头 256 B + 向量索引 512 KiB，比这短的一定是坏文件（下载截断最常见） */
  if (_b && _b.length > 256 + 512 * 1024) IPGEO_BUF = _b;
  else console.warn('[ipgeo] 库文件异常（长度不足）：' + IPGEO_XDB);
} catch (e) {
  console.warn('[ipgeo] 未加载 ' + IPGEO_XDB + '，属地功能整体关闭：' + ((e && e.message) || e));
}
const IPGEO_OK = !!IPGEO_BUF;
/* 取对端 IP：口径和既有 5 处完全一致 —— 只认 socket 远端地址，XFF 一律不看
   （那个头谁都能随手写，理由见 deviceOf() 里那段注释）。 */
const ipOfReq = req => String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
/* IANA 特殊用途网段预检。下面每一段**都用真实 xdb 逐段实测过**，一律返回
   "Reserved|Reserved|Reserved|0|0" —— 省份字段不是空的，是字符串 "Reserved"。
   所以这一步不是可选的健壮性改进：不做的话本机开发时每个人头顶都挂着「Reserved」。
   纯 IPv6 一期也一并拦（v4 库不认 IPv6，查出来是 null，但换库后大概率同样有问题）。 */
function ipIsReserved(ip) {
  let s = String(ip || '').trim();
  if (!s) return true;
  if (s.indexOf(':') >= 0) {
    if (/^::ffff:/i.test(s)) s = s.slice(7);           // ::ffff:1.2.3.4 剥掉前缀当 IPv4 判
    else return s === '::' || s === '::1' || /^(fc|fd)/i.test(s) || /^fe80:/i.test(s);
  }
  const b = s.split('.');
  if (b.length !== 4 || b.some(x => !/^\d{1,3}$/.test(x) || +x > 255)) return true;
  const a = +b[0], c = +b[1], d = +b[2];
  return a === 0                                  // 0.0.0.0/8       本网络
      || a === 10                                 // 10/8            私有
      || a === 127                                // 127/8           环回（本机开发 100% 撞）
      || (a === 100 && c >= 64 && c <= 127)       // 100.64/10       CGNAT，国内 4G/宽带常见
      || (a === 169 && c === 254)                 // 169.254/16      链路本地
      || (a === 172 && c >= 16 && c <= 31)        // 172.16/12       私有
      || (a === 192 && c === 168)                 // 192.168/16      私有
      || (a === 192 && c === 0 && d === 0)        // 192.0.0.0/24    IETF 协议分配
      || (a === 192 && c === 0 && d === 2)        // 192.0.2.0/24    TEST-NET-1
      || (a === 192 && c === 88 && d === 99)      // 192.88.99.0/24  6to4 任播（已废弃）
      || (a === 198 && (c === 18 || c === 19))    // 198.18/15       基准测试
      || (a === 198 && c === 51 && d === 100)     // 198.51.100/24   TEST-NET-2
      || (a === 203 && c === 0 && d === 113)      // 203.0.113/24    TEST-NET-3
      || a >= 224;                                // 224/4 组播 + 240/4 保留（含 255.255.255.255）
}
/* xdb v4 版面：Header 256 B → 向量索引（256×256×8 B）→ 地域数据 → 二分索引
   （IPv4 每条 14 B：起始 IP 4 + 结束 IP 4 + 数据长度 2 + 数据指针 4）。
   🔴 两个坑都是实测踩出来的，写错不报错、只返回一堆乱码：
      ① 全部字段是小端（LE），不是网络序；
      ② 向量索引里存的是**字节偏移**，不是第几条 —— 必须 sPtr + m*14 去定位。 */
const XDB_HEAD = 256, XDB_VEC = 8, XDB_SEG = 14;
function xdbSearch(ipStr) {
  if (!IPGEO_BUF) return null;
  const p = String(ipStr).split('.');
  if (p.length !== 4) return null;
  const v = ((+p[0] << 24) | (+p[1] << 16) | (+p[2] << 8) | (+p[3])) >>> 0;
  const vp = XDB_HEAD + ((+p[0]) * 256 + (+p[1])) * XDB_VEC;
  const sPtr = IPGEO_BUF.readUInt32LE(vp), ePtr = IPGEO_BUF.readUInt32LE(vp + 4);
  if (!(ePtr > sPtr)) return null;
  let l = 0, h = Math.floor((ePtr - sPtr) / XDB_SEG) - 1;
  while (l <= h) {
    const m = (l + h) >> 1, o = sPtr + m * XDB_SEG;
    if (v < IPGEO_BUF.readUInt32LE(o)) { h = m - 1; continue; }
    if (v > IPGEO_BUF.readUInt32LE(o + 4)) { l = m + 1; continue; }
    const len = IPGEO_BUF.readUInt16LE(o + 8), ptr = IPGEO_BUF.readUInt32LE(o + 10);
    if (ptr <= 0 || len <= 0 || ptr + len > IPGEO_BUF.length) return null;
    return IPGEO_BUF.toString('utf8', ptr, ptr + len);
  }
  return null;
}
/* 省份名归一化：库里给全称，抖音显示短名。用显式表而不是正则一层层剥 ——
   剥不干净，还容易把「吉林」剥成「吉」。下面 29 条是实测取值里需要转的；
   广西 / 新疆 / 内蒙古 / 宁夏 / 西藏 库里本来就是短名，原样透传。
   （全量扫 553,963 条索引确认省份字段恰好 34 种取值，无城市串位。） */
const PROV_SHORT = {
  '北京市': '北京', '天津市': '天津', '上海市': '上海', '重庆市': '重庆',
  '河北省': '河北', '山西省': '山西', '辽宁省': '辽宁', '吉林省': '吉林', '黑龙江省': '黑龙江',
  '江苏省': '江苏', '浙江省': '浙江', '安徽省': '安徽', '福建省': '福建', '江西省': '江西',
  '山东省': '山东', '河南省': '河南', '湖北省': '湖北', '湖南省': '湖南', '广东省': '广东',
  '海南省': '海南', '四川省': '四川', '贵州省': '贵州', '云南省': '云南',
  '陕西省': '陕西', '甘肃省': '甘肃', '青海省': '青海',
  /* 港澳台加「中国」前缀 —— 这是**合规口径**，不是地理判断：
     属地是挂在每个用户头上的公开信息，口径必须跟监管一致，
     不能出现「台湾」与「江苏」并列、被读成两个国家的情况。
     只处理这三个；其余省 / 自治区 / 直辖市格式本来就自洽，一律不加前缀。 */
  '台湾省': '中国台湾', '香港特别行政区': '中国香港', '澳门特别行政区': '中国澳门'
};
/* IP → 省份短名。决策顺序（前一条命中就不再往后走）：
     ① 库没加载 / IP 落在保留段   → ''
     ② 库里 country 或 prov 是 Reserved → ''（哨兵，见下）
     ③ 省份字段为空或 '0'          → ''
     ④ 任何异常                    → ''
   ② 这条哨兵验证过是安全的：全量 9,048 个 Reserved 段、覆盖 5.93 亿个地址，
   落在常规公网范围内的端点数 = 0，不会误伤任何真实公网 IP。
   ⚠ 境外：省份字段是英文一级行政区（实测 8.8.8.8 → "United States|California|0|Google LLC|US"），
   按「境外显示国家、不显示省」的口径回落到国家字段，且**英文原名原样返回** ——
   一期不建中文国名表（实测国家取值 241 种，建表是另一件事），也不自作主张翻译。 */
function provOf(ip) {
  try {
    if (!IPGEO_BUF) return '';
    /* 自己剥一次 ::ffff: 前缀：将来谁直接把 req.socket.remoteAddress 喂进来
       （不走 ipOfReq）也能正常解析，否则双栈机器上属地会静默全空、且极难排查。 */
    const ip4 = String(ip || '').trim().replace(/^::ffff:/i, '');
    if (ipIsReserved(ip4)) return '';
    const r = xdbSearch(ip4);
    if (!r) return '';
    const f = r.split('|');
    const country = String(f[0] || '').trim(), prov = String(f[1] || '').trim();
    if (country === 'Reserved' || prov === 'Reserved') return '';
    if (country !== '中国') return (!country || country === '0') ? '' : country;
    if (!prov || prov === '0') return '';
    return PROV_SHORT[prov] || prov.replace(/(省|市|自治区|特别行政区)$/, '');
  } catch { return ''; }
}
/* uid → { ip, prov, at }。只在内存里，不落任何文件 —— 省份是「运行期派生展示值」，
   跟在线状态一个性质，不是账号属性。按 uid 存三个字段，量级就是用户数
   （1000 用户 ≈ 100 KB），不需要额外裁剪。 */
const IPGEO_MEM = new Map();
function touchIpGeo(uid, ip) {
  if (!uid) return;
  const cur = IPGEO_MEM.get(uid);
  if (cur && cur.ip === ip) { cur.at = Date.now(); return; }   // IP 没变：只更新时间戳
  IPGEO_MEM.set(uid, { ip: String(ip || ''), prov: provOf(ip), at: Date.now() });
}
const provOfUid = uid => { const g = IPGEO_MEM.get(uid); return g ? g.prov : ''; };
/* 别人能看到的名片：不给完整手机号/邮箱，免得被人拿去骚扰 */
function publicCard(u) {
  return {
    uid: u.uid, username: u.username || '用户',
    phone: maskPhone(u.phone), email: maskEmail(u.email),
    gender: u.gender || '',
    /* 别人的头像：评论、点赞、好友申请、一起听成员、消息通知全走 publicCard，
       在这里带一次就有，不用每个接口各带各的。同样只带已通过审核的。 */
    avatar: avatarUrlOf(u),
    /* IP 属地：只有省份短名，城市/ISP 在 provOf() 里就丢了。
       查不到（内网 / 纯 IPv6 / 库缺失 / 境外）一律是空串，前端 if(prov) 判掉即不渲染。 */
    prov: provOfUid(u.uid)
  };
}

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
/* 桌面 UA：B站 WBI 接口用移动端 UA 会返回空结果（实测），必须用 PC UA */
const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
/* 安卓移动端 UA：m.kugou.com 的 H5 页（歌单 /songlist/gcid_xxx/）对它返回
   带 window.$output 的完整 SSR 页面；换成 PC UA 时那个脚本块是空的。
   实测（2026-10-22）：iPhone UA 也行，但 Android UA 更稳，统一用它。 */
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

// 只有网络里存在中间人代理（证书不受信）时才需要，默认关闭。
if (process.env.KUGOU_INSECURE_TLS === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[提示] 已按 KUGOU_INSECURE_TLS=1 关闭上游 TLS 证书校验');
}

/* ---------------- 原子写（P0：上云之后的数据安全前提） ----------------
 * 为什么要单独搞这两个函数：
 *   fs.writeFileSync(file, ...) 是「先把目标文件截成 0 字节，再一点点写进去」。
 *   写到一半进程没了（云主机被 OOM kill、systemd 重启、机房掉电、磁盘满），
 *   磁盘上留下的就是一个**半个的 JSON**。下次 readJSON() 解析失败直接走 catch，
 *   users.json 退化成空对象 —— 全站账号像是"凭空消失"了。
 *   本机很难遇到，放到云上就是迟早的事（服务一跑几个月不停）。
 *
 *   正解是「写旁路的临时文件，写完整了再 rename 盖上去」：
 *   rename 在同一分区上是原子的，操作系统保证任一时刻别人看到的
 *   要么是旧文件、要么是新文件，绝不可能是写了一半的中间态。
 *
 *   三个不能省的细节：
 *    1) 临时文件必须和目标文件**同一个目录**。跨目录 rename 不是原子操作，
 *       会退化成 copy + delete，等于白忙一场。
 *    2) 临时文件名带上 pid。主服务(8788)和管理台(8803)会写同一批 data/ 文件，
 *       名字撞了会互相擦掉对方的临时文件。
 *    3) 失败要把 .tmp 清掉。否则一次失败就在 data/ 里留一坨残骸，
 *       日积月累把目录撑满。
 *
 * ⚠️ writeFileAtomic 失败了会**抛异常**（让调用方看得见原因），
 *    writeJSONAtomic 是它的「省心版」：吞掉异常、返回 true/false，
 *    和历史上的 writeJSON 同签名，老调用点可以零改动切过来。
 * ------------------------------------------------------------------ */
function writeFileAtomic(file, data, enc) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.tmp');
  try {
    fs.writeFileSync(tmp, data, enc || 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 清不掉也只能算了 */ }
    throw e;
  }
}
function writeJSONAtomic(file, obj) {
  try { writeFileAtomic(file, JSON.stringify(obj, null, 2), 'utf8'); return true; }
  catch { return false; }
}

/* ---------------- 配置 ---------------- */
/* 默认下载目录：**绝不写死某一台机器的路径**。
 * 老写法是「有 D 盘就 D:\Music\酷狗下载」，那是开发机的习惯 ——
 * 换一台电脑打开，下载器会凭空在 D 盘建一棵别人命名的目录树，
 * 用户的原话是「路径还是不对，要按此电脑自己的磁盘结构来」。
 * 现在按成熟下载器的规矩，落在**用户自己的库**里：
 *   ① 系统「下载」  ② 退到「音乐」  ③ 再退到用户主目录
 * 子目录固定 YMusic，跟应用名对齐，用户一看就知道是谁建的。
 * ------------------------------------------------------------------ */
function defaultDir() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.';
  const cands = [path.join(home, 'Downloads'), path.join(home, 'Music'), home];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return path.join(c, 'YMusic'); } catch { /* 下一个 */ }
  }
  return path.join(home, 'YMusic');
}
function loadConfig() {
  try { return { downloadDir: defaultDir(), concurrency: 2, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch { return { downloadDir: defaultDir(), concurrency: 2 }; }
}
function saveConfig() { try { writeFileAtomic(CONFIG_FILE, JSON.stringify(CFG, null, 2), 'utf8'); } catch { /* ignore */ } }
let CFG = loadConfig();

/* ---------------- 下载目录体检 ----------------
 * 为什么需要：downloadDir 是**上一次运行时写死的**，中间发生什么我们不知道 ——
 *   盘被拔了（U 盘/移动硬盘）、盘符被系统重排了、目录被清理软件删了、
 *   或者换了个账号登录，权限收走了。
 * 这些情况都会让 fs 在最底层抛一句 `ENOENT: no such file or directory`，
 * 经 humane() 翻译后变成「这个路径不存在」，用户完全不知道该怎么救自己，
 * 有人甚至会看到「没有权限读写这个位置」——因为 Windows 上访问一个
 * 不存在的盘符，有时确实表现为权限被拒。
 *
 * 所以规矩改成：**启动时就体检，发现问题当场治好**，
 * 不要等用户点了下载才发现存不进去。
 * 体检方式必须是「真写一个小文件再删掉」——只 stat 一下是不够的，
 * 目录存在但只读的情况照样会让下载在最后一刻失败。
 * ------------------------------------------------------------------ */
function probeDir(d) {
  if (!d) return 'missing';
  try {
    if (!fs.existsSync(d)) {
      // 也许只是还没建，试着建一次
      fs.mkdirSync(d, { recursive: true });
    }
    const st = fs.statSync(d);
    if (!st.isDirectory()) return 'notdir';
    const t = path.join(d, '.ym-probe-' + process.pid + '.tmp');
    fs.writeFileSync(t, 'ok');           // 真正的可写性判定在这一行
    try { fs.unlinkSync(t); } catch { /* 删不掉不影响结论，已经写成功了 */ }
    return 'ok';
  } catch (e) {
    const m = String((e && e.message) || e || '');
    if (/EACCES|EPERM|EROFS|permission denied/i.test(m)) return 'denied';
    if (/ENOENT|no such file/i.test(m)) return 'missing';
    return 'denied';
  }
}

/* ---- 只读体检：/api/config 每个请求都要用的那一版 ----
 * 为什么不能再拿 probeDir() 顶着用：probeDir 会 try 一下 mkdirSync，
 * 「目录不存在」被它体检完目录就建出来了 —— 启动时跑一次无所谓，
 * 现在要**每个请求都体检**，带这种副作用的探针每刷一次界面就在磁盘上
 * 留一堆空目录，而且 creatable 这个字段也就永远只能是 true 了
 * （轮到问它的时候目录已经被自己建好了，答什么都对不了）。
 *
 * 所以这里另写一套：一个字也不建，只在**已存在**的目录里写探针文件。
 * 目录本身不存在时改为去问它的父目录能不能写 —— 那正是「能不能自动建」
 * 的真正判据，跟 /api/save 里落盘前那句 mkdirSync(recursive) 的成算是同一件事。
 */
function canWriteIn(d) {
  try {
    if (!fs.existsSync(d)) return 'gone';
    const st = fs.statSync(d);
    if (!st.isDirectory()) return 'notdir';
    const t = path.join(d, '.ym-probe-' + process.pid + '-' + Date.now() + '.tmp');
    fs.writeFileSync(t, 'ok');           // 真正的可写性判定在这一行
    try { fs.unlinkSync(t); } catch { /* 删不掉不影响结论，已经写成功了 */ }
    return 'ok';
  } catch (e) {
    const m = String((e && e.message) || e || '');
    if (/EACCES|EPERM|EROFS|permission denied|read-only/i.test(m)) return 'no-permission';
    if (/ENOENT|no such file/i.test(m)) return 'gone';
    return 'no-permission';
  }
}
/* 一个下载目录的三档体检 —— 分档口径就是能力矩阵 §3.2 那张表：
 *   ① 还不存在但父目录可写 → creatable:true   （下载时会自动建，界面说琥珀色那句）
 *   ② 压根建不出来         → creatable:false + reason
 *        'no-permission'：权限不足 / 只读（ENOENT 之外的一切拒绝）
 *        'gone'          ：父目录都不在了 —— U 盘拔了、盘符被系统重排了
 *        'notdir'        ：这名字被一个文件占了
 *   ③ 目录在能写           → creatable:true，正常情况
 * 注：③ 和 ① 都是 creatable:true，界面用 exists 区分它们。 */
function dirHealth(d) {
  if (!d) return { exists: false, creatable: false, reason: 'gone' };
  let exists = false;
  try { exists = fs.existsSync(d) && fs.statSync(d).isDirectory(); } catch { exists = false; }
  if (exists) {
    const w = canWriteIn(d);
    if (w === 'ok') return { exists: true, creatable: true, reason: '' };
    return { exists: true, creatable: false, reason: w === 'notdir' ? 'notdir' : 'no-permission' };
  }
  const parent = path.dirname(d);
  if (!parent || parent === d) return { exists: false, creatable: false, reason: 'gone' };
  const w = canWriteIn(parent);
  if (w === 'ok') return { exists: false, creatable: true, reason: '' };   // ① 可自愈
  return { exists: false, creatable: false, reason: w === 'notdir' ? 'notdir' : w };   // ② 不可建
}
/* 目录不可用时自动回落到 ~/Downloads/YMusic，并讲清楚原委。
   返回 null 表示本来就没事。
   ⚠️ 什么时候算「有事」变了：以前是 probeDir 建不动就算坏了 ——
   那样「还没建过的新目录」会被当成坏目录治一刀（顺手还在别处建了一堆）。
   现在只看 dirHealth()：父目录写得动就认定可自愈，留到下载那一刻再建，
   与界面上那句「下载时会自动创建」是同一个口径。 */
function healDir() {
  const from = CFG.downloadDir;
  const probe = dirHealth(from);
  if (probe.creatable) return null;      // 能写，或还能自动建 —— 都别动它
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir() || '.';
  const cands = [
    path.join(home, 'Downloads', 'YMusic'),
    path.join(home, 'Music', 'YMusic'),
    path.join(home, 'YMusic'),
    home,
  ];
  let to = '';
  for (const c of cands) { if (probeDir(c) === 'ok') { to = c; break; } }
  if (!to) return null;                  // 全都写不了，那就别乱改，维持原样
  CFG.downloadDir = to;
  try { saveConfig(); } catch { /* ignore */ }
  return { from, to, reason: probe.reason };
}
/* 最近一次自动改存。/api/config 把它报给界面，**报过一次就清掉** ——
   这是 §3.2 里要的那条一次性提示：用户不必每次刷新设置都再被告一遍
   「你的歌存到别处了」，看见了、点了「知道了」，这事就该翻篇。 */
var PENDING_HEAL = null;
var DIR_HEAL = healDir();
if (DIR_HEAL) PENDING_HEAL = DIR_HEAL;

/* 本站对外可用的 HTTPS 地址（没配就是空串）。
 *
 * 为什么要让服务端说这件事：浏览器的 showDirectoryPicker（让用户亲手指定
 * 下载目录）**只在安全上下文里存在**，而这个服务默认跑在 http://IP:8788 上，
 * 于是网页端永远只能落到系统「下载」—— 用户看到的是「更改位置」这颗按钮
 * 直接不出现，很难自己想到「换成 https 就好了」。
 *
 * 地址由 deploy/_setup_https.py 写进 data/https.txt（一行、不带换行）。
 * 放文件而不是环境变量：改地址不用去动 systemd unit，重启一次服务就生效。
 * 读不到就当没有 —— 前端据此决定要不要显示「改用安全连接」那颗按钮。 */
var HTTPS_URL = '';
try {
  /* ⚠️ 这里不能写 DATA_DIR —— 它定义在下面（第 5900 多行），
     const 有暂时性死区，模块初始化阶段读到就是 ReferenceError。 */
  HTTPS_URL = fs.readFileSync(path.join(APP_DIR, 'data', 'https.txt'), 'utf8').trim();
  if (!/^https:\/\//i.test(HTTPS_URL)) HTTPS_URL = '';
} catch { /* 没配就是没有 */ }

/* ---------------- 基础工具 ---------------- */
const md5 = s => crypto.createHash('md5').update(s).digest('hex');

/* 算一个大文件的 md5，但**不把整个文件读进内存**。
 * 背景：桌面端安装包 180MB+，原来 readExeMeta() 用 fs.readFileSync() 整包读进来再算，
 * 一次调用就是一次 ~180MB 的堆峰值，而 Node 默认堆上限在容器里很容易被打爆或触发频繁 GC，
 * 表现为「第一次点检查更新时整个服务卡一下」。
 * 这里改成 1MB 一块循环 readSync，边读边喂给 hash，堆占用恒定 1MB。
 * 失败返回空串，调用方自行回落到清单里手填的 md5。 */
function md5FileSync(fp) {
  var fd = fs.openSync(fp, 'r');
  try {
    var h = crypto.createHash('md5');
    var buf = Buffer.allocUnsafe(1024 * 1024);
    var n = 0;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(n === buf.length ? buf : buf.subarray(0, n));
    }
    return h.digest('hex');
  } finally {
    try { fs.closeSync(fd); } catch (e) { /* 关不掉就算了，别把异常抛上去 */ }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- TLS 兼容通道 ----------------
 * 背景：酷狗部分 CDN（如 mobilecdn.kugou.com）返回的证书 altnames 里
 * 并不包含自己的域名（实测拿到的是一张 myqcloud 通配证书），任何严格校验的
 * 客户端（含浏览器/curl 默认行为）都会直接连不上，榜单/歌手/专辑接口全部瘫痪。
 * 这里不全局关校验（那样太粗暴），而是：严格模式失败且错误是证书类时，
 * 只对该域名降级为一次性兼容抓取，并记进 tlsRelaxedHosts，
 * 后续同域名直接走兼容通道，省掉一次白等的失败往返。
 * ------------------------------------------------ */
const tlsRelaxedHosts = new Set();
const TLS_ERR_HINT = /certificate|altnames|self[- ]?signed|unable to verify|tls|ssl|EPROTO/i;

/** 用 node:https 抓文本（可关证书校验，自动跟随重定向），作为 fetch 的兜底 */
function httpsGetText(url, { headers = {}, timeout = 12000, method = 'GET', body = null, depth = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(
      u,
      {
        method,
        headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
        rejectUnauthorized: false,
        timeout
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 3) {
          res.resume();
          return httpsGetText(new URL(res.headers.location, u).href, { headers, timeout, method, body, depth: depth + 1 })
            .then(resolve, reject);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 走兼容通道取 JSON */
async function getJSONRelaxed(url, { headers, timeout, method, body }) {
  const r = await httpsGetText(url, { headers, timeout, method, body });
  if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
  try { return JSON.parse(r.text); } catch { throw new Error('非 JSON 响应: ' + r.text.slice(0, 100)); }
}

/** 带超时 + 重试的 JSON 请求（证书异常自动降级） */
async function getJSON(url, { headers = {}, tries = 3, timeout = 12000, method = 'GET', body = null } = {}) {
  let host = '';
  try { host = new URL(url).host; } catch { /* ignore */ }
  let last;
  for (let i = 0; i < tries; i++) {
    if (host && tlsRelaxedHosts.has(host)) {
      try { return await getJSONRelaxed(url, { headers, timeout, method, body }); }
      catch (e) { last = e; if (i < tries - 1) await sleep(400 * (i + 1)); continue; }
    }
    try {
      const r = await fetch(url, { method, body, headers: { 'User-Agent': UA, ...headers }, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
      const t = await r.text();
      if (!r.ok) throw new Error('HTTP ' + r.status);
      try { return JSON.parse(t); } catch { throw new Error('非 JSON 响应: ' + t.slice(0, 100)); }
    } catch (e) {
      last = e;
      const msg = String((e && (e.cause && e.cause.message)) || (e && e.message) || e);
      if (host && TLS_ERR_HINT.test(msg)) {
        tlsRelaxedHosts.add(host);
        console.warn('[TLS兼容] ' + host + ' 证书校验未通过，已对该域名降级：' + msg.slice(0, 80));
        try { return await getJSONRelaxed(url, { headers, timeout, method, body }); }
        catch (e2) { last = e2; }
      }
      if (i < tries - 1) await sleep(400 * (i + 1));
    }
  }
  throw new Error(`请求失败(${tries}次重试)：${last && last.message}`);
}

const EXT_MIME = { mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', ape: 'audio/x-ape', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4' };
const safeName = s => String(s || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 110) || '未命名';
const fmtSize = n => !n ? '-' : n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB';
const fmtDur = s => { s = Math.floor(s || 0); return s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '--:--'; };
const qLabel = (bitRate, ext) => ((ext || '').toLowerCase() === 'flac' || bitRate === 0) ? '无损' : (bitRate ? Math.round(bitRate / 1000) + 'K' : '未知');
const cover = albumId => albumId ? `https://imge.kugou.com/stdmusic/240/${albumId}.jpg` : '';
const bigImg = u => (u || '').replace(/\{size\}/g, '240').replace(/^http:\/\//i, 'https://');

/** 按目标站点给合适的 UA（B站 CDN 对移动端 UA 不友好） */
const uaFor = u => /bilibili|hdslb|bilivideo/i.test(String(u || '')) ? UA_PC : UA;

/** 按目标站点给合适的 Referer（多平台音源/封面代理用）
 *  这不是可选项：B站的 m4s 音频、QQ 的 CDN 都做 Referer 校验，缺了直接 403。 */
const refererFor = u => {
  try {
    const o = new URL(u).origin;
    if (/kugou/i.test(o)) return 'https://www.kugou.com/';
    if (/qq\.com|gtimg/i.test(o)) return 'https://y.qq.com/';
    if (/126\.net|163\.com/i.test(o)) return 'https://music.163.com/';
    if (/bilibili|hdslb|bilivideo/i.test(o)) return 'https://www.bilibili.com/';
    if (/douyinstatic|douyinpic|douyin\.com|iesdouyin/i.test(o)) return 'https://www.douyin.com/';
    return o + '/';
  } catch { return ''; }
};

/* ---------------- 出网安全网（U-44）：SSRF 三层拦截 ---------------------
 * /api/proxy 以前是 `fetch(Q('u'))` 裸转：没有任何域名限制，而它是**从服务器
 * 内部**发起请求的。三件事都能干：
 *   ① 打本机管理台 —— admin/server.mjs 把 8803 硬编码绑在 127.0.0.1，
 *      我们一直以为「公网打不开」是保护，但 proxy 是从内部发起的，那层保护是假的；
 *   ② 打云厂商元数据 169.254.169.254 —— 拿实例凭据，比列目录严重得多；
 *   ③ 打进内网其它段 10/8、172.16/12、192.168/16。
 *
 * 三层，缺一不可：
 *   ① 协议：只认 http/https（挡 file://  gopher:// 这类）
 *   ② 域名白名单：挡「拿我们的服务器当匿名代理打外面」
 *   ③ 目标 IP 必须是公网单播：挡「绕过白名单打进来」
 * ③ 不是可选加固：白名单是按**名字**判的，只要有一个白名单域名被解析到
 * 127.0.0.1（DNS 被污染 / 被接管），光靠白名单就直接穿过去了。
 * ---------------------------------------------------------------------- */

/* 按**后缀**匹配，不写死主机名 —— 实测 B站的 CDN 是
 * `xy39x174x253x208xy.mcdn.bilivideo.cn:8082` 这种把 IP 编进主机名、
 * 端口还不标准的动态域名，写死必然漏。
 * 下面每一族都是 2026-10-11 真机实采样到的（见 enum.cjs / enum2.cjs）：
 *   酷狗 fsandroid.tx.kugou.com · 网易 m801.music.126.net / p3.music.126.net
 *   QQ aqqmusic.tc.qq.com · 封面 y.gtimg.cn
 *   B站 upos-sz-mirrorcoso1.bilivideo.com / mcdn.bilivideo.cn / i0.hdslb.com */
const OUT_HOST_SUFFIX = [
  'kugou.com',                                                        // 酷狗：搜索 / 歌词 / 封面 / 播放 CDN
  '126.net', '163.com',                                               // 网易云：m*.music.126.net 播放、p*.music.126.net 封面
  'qq.com', 'gtimg.cn',                                               // QQ 音乐：aqqmusic.tc.qq.com 播放、y.gtimg.cn 封面
  'bilibili.com', 'bilivideo.com', 'bilivideo.cn', 'hdslb.com', 'biliapi.net',   // B站
  'douyin.com', 'douyinvod.com', 'douyinstatic.com', 'douyinpic.com',            // 抖音
  'iesdouyin.com', 'amemv.com', 'snssdk.com',
];
const outHostAllowed = h => {
  const x = String(h || '').toLowerCase().replace(/\.$/, '');
  return OUT_HOST_SUFFIX.some(d => x === d || x.endsWith('.' + d));
};

/* 出网前的统一安检。返回 { ok:true } 或 { ok:false, why }。
 * needWhitelist=false 表示「只查协议和 IP，不查域名白名单」——
 * /api/img 走这个档：封面图床比音源杂得多，套白名单容易把封面整片打白，
 * 而它真正要防的（打到内网 / 元数据）靠 IP 那一层已经挡住了。 */
async function netGate(rawUrl, needWhitelist = true) {
  let o;
  try { o = new URL(String(rawUrl || '')); } catch { return { ok: false, why: 'URL 不合法' }; }
  if (o.protocol !== 'http:' && o.protocol !== 'https:')
    return { ok: false, why: '只支持 http/https，不支持 ' + o.protocol };
  const host = o.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = o.port ? Number(o.port) : (o.protocol === 'https:' ? 443 : 80);
  /* 回环例外：**只放行本进程自己监听的那个端口**。
     /api/resolve 的 upload 分支就是这么造 URL 的
     （http://127.0.0.1:PORT/api/music/file?...），挡掉它等于所有上传歌曲都放不了。
     但 8803 管理台这类**别的**回环端口照挡 —— 那正是 U-44 要堵的第一条。 */
  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') {
    if (port !== PORT) return { ok: false, why: '回环只允许本进程的 ' + PORT + ' 端口，不允许 ' + port };
    return { ok: true };
  }
  if (needWhitelist && !outHostAllowed(host)) return { ok: false, why: '域名不在白名单里：' + host };
  /* 按解析出来的 IP 再判一遍（防白名单域名被解析到内网） */
  try {
    const addrs = await dns.promises.lookup(host, { all: true });
    for (const a of addrs) {
      if (ipIsReserved(a.address)) return { ok: false, why: '目标解析到内网/保留地址：' + host + ' -> ' + a.address };
    }
  } catch {
    /* 解析不出来就放行：后面 fetch 一样会失败，攻击者什么也拿不到；
       反过来这里要是拒了，一次 DNS 抖动就变成「所有歌放不了」。 */
  }
  return { ok: true };
}
/* ---------------- U-52：逐跳出网 ----------------
 * ⚠️ 为什么非得自己跟进重定向：netGate() 只对**原始 URL** 做一次安检，而
 * `fetch` 默认 redirect:'follow'。于是「白名单域名 302 跳到内网」这一种打法
 * 完全绕过了安检 —— 实测用 /api/img 和 /api/proxy 都拿到了 127.0.0.1:8803
 * （管理台）的正文，而直连同一地址是被 403 挡住的。
 *
 * ⚠️ 反过来，**绝对不能只设 redirect:'manual' 却不跟进**：酷狗 / 网易 / QQ /
 * B站 的源站大量用 302 做调度（upos-sz-*.bilivideo.cn 尤其依赖跳转），
 * 那样等于把四家音源一起打挂。修一个洞捅一排，比不修更糟。
 *
 * 所以：每一跳都重新过一遍 netGate()，最多 5 跳，超了拒。
 * ---------------------------------------------------------------------- */
const NET_MAX_HOP = 5;
/** 上游连接类失败重试前的间隔。
    取 300ms 的依据：生产那次 502 本身耗时约 300ms，说明「掐断 → 下一条失败」
    是个百毫秒级的瞬时状态；间隔比它短就会两条都撞在拒绝窗口里（实测过：
    120ms 间隔配 400ms 窗口，重试反而把失败率从 45% 推到 100%）。
    300ms 是「能跨出窗口」和「别让用户等」之间的折中。 */
const NET_RETRY_GAP_MS = 300;
const IMG_MAX_BYTES = 8 * 1024 * 1024;   // 封面体积上限：正常封面几十 KB，8MB 是天花板

/* ───────────────────────────────────────────────────────────────────────────
   U-61：netFetch 的超时改成**两段式**
   ① 响应头阶段 —— headMs（原 timeoutMs）内没拿到响应头，判定上游不可用，断。
   ② 正文阶段  —— **不再给总时长设上限**，改空闲看门狗：还有字节在流就不断续期。

   为什么必须拆：AbortSignal.timeout() 是从 fetch 发起那一瞬间开始计时，
   **body 还在 serialized 传输也一样会到点 abort**。而 /api/proxy 是「边收边往
   浏览器转发」，整段耗时取决于**用户自己的下行速度**（/api/music/file 那一跳
   目标是 127.0.0.1，根本不慢）。响应头此时早已发给浏览器 —— 里面写着
   Content-Length，服务端已经没有回头路，只能 res.destroy()。用户拿到的字节数
   小于 Content-Length，<audio> 就是「播一段之后报损坏」。

   实测（10MB 上传歌，/api/proxy 链路，客户端限速 250KB/s）：
     · 修复前 33.3s 被掐断，收到 8585216 / 10485882 字节（81.9%），客户端 aborted
     · 服务端日志**一句错误都没有**（走的是 res.destroy() 那条静默分支）

   ⚠️ 不要靠「把 30000 调大」来解决：无论调到多大，只要它还是「整段请求的总时长
   上限」，就一定存在一首歌 / 一种网速踩得穿它。必须让限制跟着「是否有进展」走，
   而不是跟着「墙钟」走。
   ─────────────────────────────────────────────────────────────────────────── */

/** 取超时毫秒数：非法值（NaN/0/负数）一律回落默认，上限 10 分钟封顶 */
function netMs(v, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(n, 600000);
}

/** 给已拿到响应头的 Response 套一层空闲看门狗：
    每来一个 chunk 就把定时器续期一次；连续 idleMs 没有任何字节产出，
    才判定上游挂死并 cancel —— 「有进展就一直放行，没进展才断」。
    包出来的是新的 Response，status / headers 逐项照搬，调用点无感。 */
function wrapIdleWatchdog(res, idleMs, where) {
  const src = res.body;
  if (!src || typeof src.getReader !== 'function') return res;   // HEAD / 204 / 无 body，原样返回
  const reader = src.getReader();
  let timer = null;
  function stop() { if (timer) { clearTimeout(timer); timer = null; } }
  function arm() {
    stop();
    timer = setTimeout(function () {
      console.warn('[net] ' + where + ' 上游超过 ' + idleMs + 'ms 没有再吐字节，断开');
      try { reader.cancel(new Error('上游空闲超时')); } catch { /* 已经没了 */ }
    }, idleMs);
    if (timer.unref) timer.unref();
  }
  const pass = new ReadableStream({
    start: function () { arm(); },
    pull: function (c) {
      return reader.read().then(function (r) {
        if (r.done) { stop(); c.close(); return; }
        arm();                                   // ← 有字节产出 → 续期
        c.enqueue(r.value);
      }, function (e) { stop(); c.error(e); });
    },
    cancel: function (why) { stop(); try { return reader.cancel(why); } catch { return Promise.resolve(); } }
  });
  return new Response(pass, { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function netFetch(startUrl, opt) {
  const o = opt || {};
  const headMs = netMs(o.timeoutMs, 30000);      // ① 等响应头
  /* ② 正文空闲。显式给 0（数字或字符串）＝「这次不套看门狗」，完全交给调用方自己管。
     ⚠️ 不能写成 netMs(o.idleMs, headMs) 就完事：netMs 里 `n <= 0` 会回落到 dflt，
     那样传 0 拿到的还是 headMs，下面那个 `idleMs > 0 ? ... : up` 的 false 分支
     就成了永远走不到的死代码，注释里承诺的逃生开关也就等于没做。 */
  const idleMs = (o.idleMs === 0 || o.idleMs === '0') ? 0 : netMs(o.idleMs, headMs);
  /* idleMs 默认跟着 headMs 走，而不是取一个全局常数：
     /api/img 是 15s、/api/proxy 30s、/api/save 180s —— 沿用各调用点原本的时间尺度。
     关键差别是它量的东西变了：以前量「整段请求跑了多久」，现在量「多久没有进展」。
     顺带也保住了一处历史行为：/api/img 有几个分支在 `up.ok` 为假时直接 return 502，
     并没有 cancel 掉 up.body。以前全靠 AbortSignal.timeout 到点把这条弃用的 body
     收拾掉；若把空闲上限统一抬到 60s，这些没人要的连接就会比修复前挂得更久。 */
  let url = String(startUrl || '');
  for (let hop = 0; ; hop++) {
    const g = await netGate(url, o.whitelist !== false);
    if (!g.ok) { netDeny(o.where || 'netFetch', url, g.why); return { ok: false, why: g.why }; }
    /* U-61：超时只盖到「拿到响应头」为止。
       调用方自带 signal 时原样交给它（/api/task 依赖 signal 取消下载，不能碰）；
       没带时才由我们自己的 controller 管首字节阶段。

       ★ 上游**连接类**失败重试一次。
       背景：生产实测「拖进度条 → /api/proxy 502 → 播放器死掉」，发生率约 1/3，
       且不自愈。502 的响应体是「音源拉取失败：连不上对方服务器」—— 说明是
       `fetch()` 抛错（连接层），不是上游回了非 2xx。
       三组对照把范围收窄到「必须是**掐断一条正在流的请求**才会触发」：
         · 不掐断、只发小 Range        → 0%
         · 掐得早（300ms，只传了一点）→ 0%
         · 掐得晚（1500ms，已传数 MB）→ 18~36%
         · 不掐断、**整文件下完**（流量最大）→ 0%  ← 这条排除了「上游按流量限速」
       也就是说：不是我们传太多被打，是「上一条流被掐断」这件事本身让**下一条**
       建连失败。这类失败是瞬时的（重试一条新连接就好了），不重试就变成用户
       可见的「拖一下进度条，歌没了」。
       ⚠️ 只重试**连接层抛错**，且**不**重试这两种情况：
         · 我们自己的 headMs 到点（再等一遍只会让用户等更久）
         · 调用方主动取消（/api/task 的取消下载，取消就是取消）
       顺带也改善 /api/img —— 封面随机 502 是同一类出网问题。 */
    const MAX_TRY = (o.retry === 0 || o.retry === '0') ? 1 : 2;
    let up = null, lastErr = null, headFired = false;
    for (let attempt = 1; attempt <= MAX_TRY; attempt++) {
      let ac = null, headTimer = null;
      if (!o.signal) {
        ac = new AbortController();
        headTimer = setTimeout(function () {
          headFired = true;
          try { ac.abort(new Error('等待上游响应头超过 ' + headMs + 'ms')); } catch { /* 已经没了 */ }
        }, headMs);
        if (headTimer.unref) headTimer.unref();
      }
      try {
        up = await fetch(url, { headers: o.headers || {}, redirect: 'manual', signal: o.signal || (ac && ac.signal) });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (headFired || (o.signal && o.signal.aborted)) break;   // 见上面注释，这两种不重试
        if (attempt < MAX_TRY) {
          /* 间隔短一点：这类失败是瞬时拒绝，不是拥塞，等久了没意义还拖慢播放 */
          console.warn('[net] ' + (o.where || 'netFetch') + ' 上游连接失败，' + NET_RETRY_GAP_MS +
            'ms 后重试一次（' + attempt + '/' + MAX_TRY + '）：' + ((e && e.cause && e.cause.code) || (e && e.message) || e));
          await sleep(NET_RETRY_GAP_MS);
        }
      } finally {
        if (headTimer) clearTimeout(headTimer);    // ← 头到了就撤表，正文不再受它管
      }
    }
    if (!up) return { ok: false, err: lastErr };
    const loc = (up.status >= 300 && up.status < 400) ? (up.headers.get('location') || '') : '';
    if (!loc) return { ok: true, res: idleMs > 0 ? wrapIdleWatchdog(up, idleMs, o.where || 'netFetch') : up, url };
    /* 跟进前必须把上一跳的 body 放掉，否则连接会挂着等读完 */
    try { if (up.body) await up.body.cancel(); } catch { /* 已经没了 */ }
    if (hop + 1 > NET_MAX_HOP) { netDeny(o.where || 'netFetch', url, '重定向超过 ' + NET_MAX_HOP + ' 跳'); return { ok: false, why: '重定向超过 ' + NET_MAX_HOP + ' 跳' }; }
    let next;
    try { next = new URL(loc, url).href; } catch { return { ok: false, why: '重定向地址不合法：' + String(loc).slice(0, 120) }; }
    url = next;
  }
}

/* 出网读正文：带体积上限，超了立刻断。上游不老实给 Content-Length 时（chunked
   最常见）也必须兜住 —— 否则「一个 2GB 的假图片」就能把内存/磁盘吃干。 */
async function netReadCapped(up, maxBytes) {
  const out = [];
  let total = 0;
  const reader = up.body && up.body.getReader ? up.body.getReader() : null;
  if (!reader) return { buf: Buffer.alloc(0), over: false, total: 0 };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return { buf: Buffer.alloc(0), over: true, total };
    }
    out.push(Buffer.from(value));
  }
  return { buf: Buffer.concat(out), over: false, total };
}
/* 被拒时统一记一条日志 —— 白名单漏了某个 CDN 域名时，
   日志里能立刻看到是哪个 host，而不是只看到用户报「某个音源放不了」。 */
function netDeny(where, u, why) {
  console.warn('[SSRF] ' + where + ' 已拒绝：' + why + ' | ' + String(u).slice(0, 200));
}

/* ── 出网失败原因归类 ─────────────────────────────────────────────
   为什么要有这个：/api/img 的 502 一直是「一个数字」，日志里看不出是哪一层
   失败的，排查全靠猜。同一个 URL 时好时坏（约 2%），必须能分开「上游没连上」
   和「上游回了错误码」—— 这两种的排查方向完全不一样。

   reason 取值 → 排查方向（下一单看日志的人照这个查）：
     · conn_timeout    ETIMEDOUT / 等响应头超过 headMs
                       → 上游慢，或我们这条出网路径拥塞。瞬时概率高，隔会儿再试通常就好。
     · conn_reset      ECONNRESET / ECONNREFUSED / EPIPE / socket hang up
                       → 连接被掐断。跟 /api/proxy 那条「掐断上一条流导致下一条建连失败」
                         是同一类（见 netFetch 里的重试注释）。netFetch 已经会重试一次，
                         重试后还是它，说明不是偶发，要看出网链路。
     · dns_failed      ENOTFOUND / EAI_AGAIN → DNS，不是源站。
     · conn_<code>     上面没覆盖到的连接层错误码，原样带出，别吞。
     · conn_other      连不上但连错误码都没有 —— 这种最该关注，往往是 abort 路径。
     · upstream_status 上游**回**了非 2xx（会同时带 code=状态码）
                       → 这是源站侧的事（防盗链 / 404 / 源站 5xx），不是我们出网的问题，
                         重试没用，要去查 URL 和 Referer。
   ⚠️ 这条是**推断，不是坐实**：本机跑的时候，直连某端口若该端口已死，环境里的
      HTTP_PROXY 会返回一个 502 —— 也就是说「看到 502」有可能是我们自己的代理
      层给的，不一定是源站拒绝。源站侧的证据我们目前没有，所以下面凡是跟状态码
      有关的判断都只说「上游返回了什么」，不下「源站挂了」的结论。 */
function netFailReason(e) {
  const c = String((e && e.cause && e.cause.code) || (e && e.code) || '');
  const m = String((e && e.message) || e || '');
  const s = c + ' ' + m;
  /* ⚠️ 「等待上游响应头超过」这句中文**必须**在这条里：那是 netFetch 自己 headMs
     到点时 `ac.abort(new Error(...))` 塞进去的 reason，而 Node 会把这个 reason
     **原样**当成 fetch 的 rejection 抛出来（实测：message 就是这句中文，无 code、
     无 cause）。认不出来就会落进 conn_other，而它恰恰是我们要单独看的一类。 */
  if (/ETIMEDOUT|timed out|timeout|等待上游响应头超过/i.test(s)) return 'conn_timeout';
  if (/ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|UND_ERR_SOCKET/i.test(s)) return 'conn_reset';
  if (/ENOTFOUND|EAI_AGAIN/i.test(s)) return 'dns_failed';
  if (c) return 'conn_' + c.toLowerCase();
  return 'conn_other';
}

/** 把各接口返回的歌曲对象统一成一个形状 */
function mapSong(it) {
  let name = it.songname || '';
  let singer = it.singername || '';
  if (!name && it.filename) {
    const i = it.filename.indexOf(' - ');
    if (i > 0) { singer = it.filename.slice(0, i); name = it.filename.slice(i + 3); }
    else name = it.filename;
  }
  if (!singer && Array.isArray(it.authors)) singer = it.authors.map(a => a.author_name).filter(Boolean).join('/');
  if (!singer && it.singername) singer = it.singername;
  const vip = (it.pay_type === 3) || (it.sqprivilege >= 8) || (it.privilege >= 8 && it.pay_type !== 0);
  const hints = [];
  if (it.sqhash) hints.push('无损');
  if (it['320hash']) hints.push('320K');
  hints.push('128K');
  return {
    source: 'kugou', sourceName: '酷狗',
    hash: it.hash || '',
    sqhash: it.sqhash || '',
    h320hash: it['320hash'] || '',
    reshash: it.reshash || '',
    songname: name || '未知曲目',
    singer: singer || '未知歌手',
    album: it.album_name || it.albumname || '',
    albumId: String(it.album_id || it.albumid || ''),
    duration: it.duration || 0,
    durationText: fmtDur(it.duration),
    sizeText: fmtSize(it.filesize),
    vip, hints,
    cover: cover(it.album_id || it.albumid),
    /* MV（第 9 期）：上游搜索接口里**本来就有** mvhash，只是一直没带出去。
       前端据此决定那一行的「看 MV」是亮着还是灰的 ——
       不带的话所有歌看着都像没有 MV，用户根本不会去点。
       ⚠️ 只有 mvhash 不代表一定能播（酷狗播放地址要 App 签名），
          能不能播由 /api/mv/find 现场判定，这里只表示「这首歌有 MV」。 */
    mvhash: it.mvhash || '',
    hasMv: !!it.mvhash,
    /* 原唱标注（第 18 期）：酷狗 trans_param.OriAuthName 只有翻唱曲才带 */
    ...songOtag(name, { oriAuth: String(((it.trans_param || {}).OriAuthName) || '') })
  };
}

/* ---------------- 网页版签名搜索（JS 逆向所得算法） ----------------
 * 酷狗网页版 complexsearch 接口要求 signature：
 *   signature = MD5(盐 + 各参数按字母序以 "k=v" 直接拼接 + 盐)
 * 盐 = NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt（首尾各一次）
 * 该接口字段比移动端更全（Image/AlbumImage、SQ/HQ/Res 各档 hash、Privilege/PayType）。
 * 仅用于检索公开曲目；会员/付费曲目照旧只标记不绕过。
 */
const CX_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';

function cxSignature(params) {
  const body = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('');
  return md5(CX_SALT + body + CX_SALT);
}

/** 取文本响应（JSONP 需要） */
async function getText(url, { headers = {}, timeout = 12000 } = {}) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://www.kugou.com/', ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout)
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

async function apiComplexSearch(kw, page, size) {
  const t = Date.now();
  const p = {
    callback: 'callback123', srcappid: '2919', clientver: '1000', clienttime: t,
    mid: String(t), uuid: String(t), dfid: '-', keyword: kw, page, pagesize: size,
    bitrate: '0', isfuzzy: '0', inputtype: '0', platform: 'WebFilter',
    userid: '0', iscorrection: '1', privilege_filter: '0', filter: '10', token: '', appid: '1014'
  };
  p.signature = cxSignature(p);
  const qs = Object.keys(p).map(k => `${k}=${encodeURIComponent(p[k])}`).join('&');
  const raw = await getText('https://complexsearch.kugou.com/v2/search/song?' + qs);
  const m = raw.match(/^[^(]*\((.*)\)[;\s]*$/s);
  const j = JSON.parse(m ? m[1] : raw);
  if (j.status !== 1) throw new Error('complexsearch status=' + j.status + ' err=' + (j.error_code || 0));
  const lists = j?.data?.lists || [];
  return {
    total: j?.data?.total || 0,
    list: lists.map(x => {
      const sq = String(x.SQFileHash || '').toLowerCase();
      const hq = String(x.HQFileHash || '').toLowerCase();
      const vip = (x.Privilege >= 8) || x.PayType === 3;
      const hints = [];
      /* ★ 2026-10-18：complexsearch 一直带 ResFileHash（Hi-Res），但这里从来没取过，
         于是服务端就算想要 Hi-Res 也没有 hash 可用。实测：
           晴天 ResBitrate=1642 / ResFileSize=55,397,039
           稻香 ResBitrate=3175 / ResFileSize=88,706,509
         两者实拉头都是 664c6143（fLaC），与 SQ 无损那一档完全不同。 */
      const rs = String(x.ResFileHash || '').toLowerCase();
      if (rs) hints.push('Hi-Res');
      if (sq) hints.push('无损');
      if (hq) hints.push('320K');
      if (x.FileHash) hints.push('128K');
      return {
        source: 'kugou', sourceName: '酷狗',
        hash: String(x.FileHash || '').toLowerCase(),
        sqhash: sq,
        h320hash: hq,
        reshash: rs,
        songname: x.SongName || x.OriSongName || '',
        singer: String(x.SingerName || '').replace(/<\/?em>/g, ''),
        album: x.AlbumName || '',
        albumId: String(x.AlbumID || ''),
        duration: x.Duration || 0,
        durationText: fmtDur(x.Duration),
        sizeText: fmtSize(x.FileSize),
        vip, hints,
        cover: bigImg(x.Image || x.AlbumImage) || cover(x.AlbumID)
      };
    })
  };
}

/* ---------------- 酷狗公开接口 ---------------- */
const HOST = 'https://mobilecdn.kugou.com/api/v3';

/** 双源搜索：移动端 + 网页签名端，按 hash 去重取并集（结果更全，任一源故障不影响） */
async function apiSongSearch(kw, page, size) {
  const tasks = [
    (async () => {
      for (const host of [HOST, 'https://msearchcdn.kugou.com/api/v3']) {
        try {
          const j = await getJSON(`${host}/search/song?format=json&keyword=${encodeURIComponent(kw)}&page=${page}&pagesize=${size}&showtype=1`);
          if (j?.data?.info) return { total: j.data.total || 0, list: j.data.info.map(mapSong) };
        } catch { /* 换下一个域名 */ }
      }
      return null;
    })(),
    (async () => {
      try { return await apiComplexSearch(kw, page, size); } catch { return null; }
    })()
  ];
  const [a, b] = await Promise.all(tasks);
  if (!a && !b) return { total: 0, list: [] };
  if (!a) return b;
  if (!b) return a;

  // 以移动端顺序为主，补齐网页端多出来的曲目，按 hash 去重
  const seen = new Set();
  const merged = [];
  for (const it of a.list) { if (it.hash && !seen.has(it.hash)) { seen.add(it.hash); merged.push(it); } }
  for (const it of b.list) { if (it.hash && !seen.has(it.hash)) { seen.add(it.hash); merged.push(it); } }

  // 用另一源的封面补齐：两源取图能力不同，谁有就用谁
  const covByHash = new Map();
  for (const it of [...b.list, ...a.list]) {
    if (it.hash && it.cover && !covByHash.has(it.hash)) covByHash.set(it.hash, it.cover);
  }
  for (const it of merged) { if (!it.cover && covByHash.has(it.hash)) it.cover = covByHash.get(it.hash); }

  /* ★ 2026-10-18：reshash（Hi-Res）**只有网页端 complexsearch 给**，移动端接口不返回这个字段。
     上面的合并以移动端顺序为主，所以必须在这里按 hash 回填 ——
     不填的话搜出来的每一行 reshash 都是空，前端 Hi-Res 那一档永远是灰的
     （实测：只改 apiComplexSearch 后，40 条搜索结果带 reshash 的仍然是 0 条）。 */
  const resByHash = new Map();
  for (const it of b.list) {
    if (it.hash && it.reshash && !resByHash.has(it.hash)) resByHash.set(it.hash, it.reshash);
  }
  for (const it of merged) { if (!it.reshash && resByHash.has(it.hash)) it.reshash = resByHash.get(it.hash); }

  return { total: Math.max(a.total || 0, b.total || 0), list: merged };
}

async function apiSingerSearch(kw, page, size) {
  const j = await getJSON(`${HOST}/search/singer?format=json&keyword=${encodeURIComponent(kw)}&page=${page}&pagesize=${size}`);
  const arr = Array.isArray(j?.data) ? j.data : (j?.data?.info || []);
  return { total: arr.length ? (j.data.total || arr.length) : 0, list: arr.map(x => ({
    singerid: x.singerid, name: x.singername || x.name || '', songcount: x.songcount || 0,
    albumcount: x.albumcount || 0, avatar: bigImg(x.sizable_avatar || x.imgurl || x.avatar)
  })) };
}

/** 热门歌手（歌手页首屏用）。
 *
 *  第8期之前歌手页只有一个搜索框：用户不输入关键词，看到的是整屏空态 ——
 *  大厂歌手页首屏一律是「热门歌手」宫格，这里对齐。
 *
 *  ⚠️ 这条接口只有 mobiles 域名通，CDN 域名（HOST）在部分网络下直接 fetch failed，
 *     所以先走 SINGER_HOST，失败再回退 HOST。两处都试过再报错，不要只写一个。
 */
const SINGER_HOST = 'https://mobiles.kugou.com/api/v3';
async function apiSingerHot(page = 1, size = 24) {
  const q = `/singer/list?format=json&page=${page}&pagesize=${size}&type=1&area=1&sex=1&genre=1`;
  let j;
  try { j = await getJSON(SINGER_HOST + q, { tries: 2 }); }
  catch { j = await getJSON(HOST + q, { tries: 2 }); }
  const arr = j?.data?.info || [];
  return {
    total: Number(j?.data?.total) || arr.length,
    list: arr.map(x => ({
      singerid: String(x.singerid || ''),
      name: x.singername || '',
      songcount: Number(x.songcount) || 0,
      albumcount: Number(x.albumcount) || 0,
      fanscount: Number(x.fanscount) || 0,
      avatar: bigImg(x.sizable_avatar || x.imgurl || x.avatar)
    })).filter(x => x.singerid && x.name)
  };
}

async function apiSingerSongs(singerid, page, size, sort = 1) {
  const j = await getJSON(`${HOST}/singer/song?format=json&singerid=${singerid}&page=${page}&pagesize=${size}&sort=${sort}`);
  const info = j?.data?.info || [];
  return { total: j?.data?.total || 0, list: info.map(mapSong) };
}

/**
 * 聚合某歌手的全部歌曲：首屏拿总数，其余页并发拉取，按 hash 去重。
 * 酷狗移动端该接口有约 2000 条的展示上限，这里以最大 pagesize 尽量逼近。
 */
async function apiSingerAllSongs(singerid, sort = 1, maxPages = 10) {
  const size = 300;
  const first = await apiSingerSongs(singerid, 1, size, sort);
  if (!first.list.length) return first;
  const total = first.total || first.list.length;
  const pages = Math.min(maxPages, Math.max(1, Math.ceil(total / size)));
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) =>
      apiSingerSongs(singerid, i + 2, size, sort).catch(() => ({ list: [] })))
  );
  const seen = new Set();
  const list = [];
  for (const it of [...first.list, ...rest.flatMap(x => x.list)]) {
    if (it.hash && !seen.has(it.hash)) { seen.add(it.hash); list.push(it); }
  }
  return { total, list };
}

async function apiAlbumSearch(kw, page, size) {
  const j = await getJSON(`${HOST}/search/album?format=json&keyword=${encodeURIComponent(kw)}&page=${page}&pagesize=${size}`);
  const arr = j?.data?.info || [];
  return { total: j?.data?.total || 0, list: arr.map(x => ({
    albumid: String(x.albumid || ''), name: x.albumname || '',
    singer: x.singername || (Array.isArray(x.authors) ? x.authors.map(a => a.author_name).join('/') : ''),
    songcount: x.songcount || 0, publish: x.publishtime || '', cover: cover(x.albumid)
  })) };
}

async function apiAlbumSongs(albumid, page, size) {
  const j = await getJSON(`${HOST}/album/song?format=json&albumid=${albumid}&page=${page}&pagesize=${size}`);
  return { total: j?.data?.total || 0, list: (j?.data?.info || []).map(mapSong) };
}

async function apiRankList() {
  /* 第8期：再加 withsong=1 —— 酷狗这个接口本来就会顺带返回每个榜的前 3 首
     （字段 songinfo，形如 {name,author}）。大厂榜单目录页（QQ音乐/酷狗/网易云）
     都是一张卡里直接给前 3 名，只给"榜名 + 更新时间"的目录页没人点。
     实测：withsong=0 311ms/90KB，withsong=1 337ms/243KB —— 多 26ms。
     243KB 是酷狗的原始体（每首歌带 trans_param 一大坨），这里只取 3 个字段，
     所以真正发给前端的仍是很小的一份。 */
  const j = await getJSON(`${HOST}/rank/list?format=json&page=1&pagesize=100&withsong=1`, { tries: 2 });
  return { list: (j?.data?.info || []).map(x => ({
    rankid: String(x.rankid || ''), name: x.rankname || '', update: x.update_frequency || '',
    cover: bigImg(x.img_9 || x.imgurl || x.album_img_9),
    /* 只留歌名 + 歌手：前端要的就是这两列，多一个字段都是白流量。
       ⚠️ 降级必须留 []：withsong 是酷狗的"可选"参数，哪天它不认了，
          没有这个兜底前端会在 .map 上炸掉整页。 */
    songs: (Array.isArray(x.songinfo) ? x.songinfo : []).slice(0, 3)
      .map(s => ({ name: s?.name || '', singer: s?.author || '' }))
      .filter(s => s.name),
  })) };
}

async function apiRankSongs(rankid, page, size) {
  const j = await getJSON(`${HOST}/rank/song?format=json&rankid=${rankid}&page=${page}&pagesize=${size}`);
  return { total: j?.data?.total || 0, list: (j?.data?.info || []).map(mapSong) };
}

async function apiSpecialSongs(sid, page, size) {
  const j = await getJSON(`${HOST}/special/song?format=json&specialid=${sid}&page=${page}&pagesize=${size}`);
  return { total: j?.data?.total || 0, list: (j?.data?.info || []).map(mapSong) };
}

/** 歌单搜索（按名字找歌单）。
 *
 *  为什么必须有这一条：业主口径「歌单的导入显示要全，要是拿不全想办法，
 *  或是换方式，不可影响用户体验」。
 *
 *  实测结论（2026-10-22，逐个接口验过）：`gcid_` 自建歌单在**网页端硬限制
 *  10 首** —— m.kugou.com 那个 SPA 的 `window.$output.info.songs` 就只内联 10 条，
 *  加 ?page / ?pagesize / ?size / ?limit 全部无效（四种参数都试过，恒返 10 条），
 *  整页只发 1 个请求、没有分页 XHR，底部那颗「查看更多歌曲」直接跳 App 下载页。
 *  所以 gcid 的 101 首**拿不全**，这不是我们不努力。
 *
 *  换方式：按名字搜出来的**公开歌单**是数字 specialid，走 /special/song
 *  能拿全量（page/size 都生效，最多 500）。给用户一条「拿全」的路，
 *  而不是把 10 首塞给他然后说抱歉。
 *
 *  ⚠️ 搜索结果里 specialid=0 的也是 gcid 自建歌单（同样只有 10 首），
 *     用 full 字段标出来，前端据此排序与提示。
 */
async function apiSpecialSearch(kw, page = 1, size = 20) {
  const j = await getJSON('https://mobiles.kugou.com/api/v3/search/special?' + [
    'keyword=' + encodeURIComponent(kw),
    'page=' + page, 'pagesize=' + size, 'format=json'
  ].join('&'), { tries: 2 });
  const arr = (j && j.data && j.data.info) || [];
  return {
    total: (j && j.data && j.data.total) || 0,
    list: arr.map(x => ({
      id: String(x.specialid || ''),
      name: x.specialname || '',
      user: x.nickname || x.username || '',
      count: Number(x.songcount) || 0,
      play: Number(x.playcount) || 0,
      cover: bigImg(x.imgurl || x.pic || x.sizable_cover || ''),
      full: Number(x.specialid) > 0
    })).filter(x => x.name)
  };
}

/** 歌单导入 · 新格式（`gcid_` 开头的分享链接）。
 *
 *  业主给的测试链接：
 *    https://m.kugou.com/songlist/gcid_3zr0ubguz3z007/?src_cid=...&uid=...&iszlist=1
 *
 *  🔴 为什么必须单开一条路：
 *     /special/song 只认**数字 specialid**（老的 www 站歌单）。gcid 是
 *     「用户自建歌单」的新 ID，它的 `listinfo.specialid` 恒为 0。
 *     更糟的是老路由那句 `(raw.match(/\d{3,}/) || [])[0]` 会把
 *     gcid_3zr0ubguz3z007 里的 **"007"** 抠出来当歌单号 ——
 *     查一个不存在的歌单、回 `total:0, list:[]`，前端于是显示「导入后是空的」。
 *     这就是业主说的「歌单导入有问题」的真正原因（已复现，不是猜测）。
 *
 *  🔴 为什么只能抓 HTML：
 *     这个歌单在 m.kugou.com 上是 SPA，数据**直接内联在页面的
 *     `window.$output` 里**（实测 31KB 页面）。gcid 在移动端所有 JSON
 *     接口上都拿不到数据，三条路都试过了：
 *       /plist/list/{gcid}?json=true   → 302 到 `single/.html`（specialid 空）
 *       mobiles/api/v3/special/song    → `{"error":"参数不合法"}`
 *       mobiles/api/v3/songlist/song   → `Access Deny !!!`
 *     别再回头试这些。
 *
 *  ⚠️ 首屏只内联 10 首（实测 listinfo.count=101 / songs.length=10），
 *     所以返回的 total 与 list.length 会不相等。前端必须把这件事**说出来**
 *     （「共 101 首 · 本次取到前 10 首」），不能假装导完了。
 *     补齐办法见前端「继续导入」：按歌名+歌手逐首搜，允许有偏差但要标注。
 */
async function apiSpecialByGcid(gcid) {
  const html = await getText(`https://m.kugou.com/songlist/${encodeURIComponent(gcid)}/`, {
    headers: { 'User-Agent': MOBILE_UA, Referer: 'https://m.kugou.com/' },
    timeout: 15000
  });
  const i = html.indexOf('window.$output');
  if (i < 0) throw new Error('歌单页面里没有数据（链接可能已失效或不是歌单）');
  const j = html.indexOf('</script>', i);
  const raw = html.slice(i + 'window.$output'.length, j)
    .replace(/^\s*=\s*/, '').replace(/;\s*$/, '');
  let o;
  try { o = JSON.parse(raw); } catch { throw new Error('歌单数据解析失败'); }
  const li = (o && o.info && o.info.listinfo) || {};
  const songs = (o && o.info && o.info.songs) || [];
  const total = Number(li.count) || songs.length;
  return {
    id: gcid,
    name: li.name || '',
    cover: bigImg(li.pic || ''),
    user: li.list_create_username || '',
    heat: Number(li.heat) || 0,
    total,
    /* 前端据此决定要不要出「继续导入」以及那句「共 N 首，本次取到 M 首」 */
    partial: songs.length < total,
    list: songs.map(x => {
      /* 歌单里的 name 是「歌手 - 歌名」（实测"周杰伦 - 双截棍"），
         而 singerinfo 是权威的歌手数组。歌手有了就从 name 里切掉前缀，
         否则会变成「周杰伦 - 双截棍 / 周杰伦」这种重复。 */
      let nm = String(x.name || '');
      const ar = Array.isArray(x.singerinfo)
        ? x.singerinfo.map(a => a && a.name).filter(Boolean).join('/') : '';
      if (ar && nm.indexOf(ar + ' - ') === 0) nm = nm.slice(ar.length + 3);
      const dur = Math.round((Number(x.timelen) || 0) / 1000);
      const cv = String(x.cover || '').replace(/\{size\}/g, '400').replace(/^http:\/\//i, 'https://');
      return {
        source: 'kugou', sourceName: '酷狗',
        hash: x.hash || '',
        /* gcid 歌单**只给最高一档 hash**（没有 320hash/sqhash），
           所以 reshash/h320hash 留空，音质档位交给 /api/probe 现场探。 */
        sqhash: '', h320hash: '', reshash: '',
        songname: nm || '未知曲目',
        singer: ar || '未知歌手',
        album: (x.albuminfo && x.albuminfo.name) || '',
        albumId: String(x.album_id || ''),
        duration: dur,
        durationText: fmtDur(dur),
        sizeText: fmtSize(x.size),
        vip: Number(x.feetype) > 0 && Number(x.privilege) >= 8,
        hints: ['128K'],
        cover: cv || cover(x.album_id),
        /* MV：歌单里每首自带 mvhash / mvdata / mvtype / mvtrack（实测 10 首里 9 首有）。
           第 14 期放宽：/api/mv/url 只要 mvhash 就能出官方直链（m.kugou.com/app/i/mv.php），
           不再要求 mvdata —— 那只是元数据，有没有它都能播。 */
        mvhash: x.mvhash || '',
        hasMv: !!x.mvhash
      };
    })
  };
}

/** 精选歌单目录（歌单页首屏用）。
 *
 *  原来歌单页只接受「粘贴歌单链接或 ID」，等于把 99% 的用户挡在门外。
 *  大厂歌单页首屏是推荐歌单瀑布，这里补上目录。
 *
 *  ⚠️ 数据源是 m.kugou.com 的同一份 JSON（/plist/index?json=true）：
 *     api/v3 的 plist/list、plist/index、special/list 现在全部返回
 *     "Access Deny !"，只有 HTML 站这个口子还通 —— 别再回去试 v3。
 *  ⚠️ 分页结构是 j.plist.list.{info,total,has_next}，不是 j.data.info。
 *  ⚠️ pagesize 参数被上游忽略（固定 30/页），所以 size 只做上限校验、不参与拼接。
 */
async function apiSpecialList(page = 1, size = 30) {
  const j = await getJSON(`https://m.kugou.com/plist/index?json=true&page=${page}`, {
    tries: 2, headers: { Referer: 'https://m.kugou.com/' }
  });
  const w = j?.plist?.list || {};
  const arr = Array.isArray(w.info) ? w.info : [];
  const out = arr.slice(0, size).map(x => ({
    id: String(x.specialid || ''),
    name: x.specialname || '',
    user: x.username || '',
    count: Number(x.songcount) || 0,
    play: Number(x.playcount) || 0,
    playText: x.play_count_text || '',
    intro: x.intro || '',
    cover: bigImg(x.imgurl || '')
  })).filter(x => x.id && x.name);
  return { total: Number(w.total) || out.length, hasNext: !!w.has_next, list: out };
}

/* ══════════ 歌单目录 / 详情 · 三大平台（第 10 期）══════════════════
   业主反馈「歌单没有平台切换」。原来 /api/special/list 只会拉酷狗一家
   （m.kugou.com/plist/index），页面上自然也没有平台可选。

   三个平台的公开接口（2026-10-23 逐个 curl 实测过，别再回去试 v3 / musicu）：
     酷狗   m.kugou.com/plist/index?json=true           ← apiSpecialList（已有）
     网易云 music.163.com/api/playlist/list?cat=全部     ← 实测给 playlists[]
     QQ     c.y.qq.com/splcloud/fcg_get_diss_by_tag.fcg ← 实测 sum=11617
   ⚠️ QQ 的 musicu.fcg 两条路（PlayListCategory / PlayListSquare）实测分别回
      req_0.code=40000 / 500003，拿不到目录；只有 splcloud 这个老口子还通。

   ⚠️ 三家 ID 互不通用（specialid / dissid / playlist id）**且都是纯数字** ——
      所以详情必须**带 plat 一起走**，不能只凭数字串猜平台（猜错就是查一个
      不存在的歌单、回空列表，前端显示「导入后是空的」—— 这个坑踩过一次）。

   ⚠️ QQ 详情实测：部分歌单（如 dissid=7707261125）返回空 cdlist，不是所有
      歌单都能打开。取不到就抛错，绝不返回空列表假装成功。 */
async function apiSpecialListPlat(plat, page = 1, size = 30) {
  if (plat === 'netease') {
    const off = (page - 1) * size;
    const j = await getJSON(`https://music.163.com/api/playlist/list?cat=${
      encodeURIComponent('全部')}&offset=${off}&limit=${size}`,
      { headers: NE_H, tries: 2, timeout: 15000 });
    const arr = Array.isArray(j && j.playlists) ? j.playlists : [];
    return {
      total: Number(j && j.total) || arr.length,
      hasNext: !!(j && j.more),
      list: arr.map(x => ({
        id: String(x.id || ''),
        name: x.name || '',
        user: (x.creator && x.creator.nickname) || '',
        count: Number(x.trackCount) || 0,
        play: Number(x.playCount) || 0,
        playText: '',
        intro: x.description || '',
        cover: String(x.coverImgUrl || '').replace(/^http:\/\//i, 'https://')
      })).filter(x => x.id && x.name)
    };
  }
  if (plat === 'qq') {
    const sin = (page - 1) * size, ein = sin + size - 1;
    const j = await getJSON(`https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg`
      + `?g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8`
      + `&notice=0&platform=yqq.json&needNewCode=0&categoryId=10000000&sortId=5`
      + `&sin=${sin}&ein=${ein}`,
      { headers: QQ_H, tries: 2, timeout: 15000 });
    const d = (j && j.data) || {};
    const arr = Array.isArray(d.list) ? d.list : [];
    return {
      total: Number(d.sum) || arr.length,
      hasNext: Number(d.sum) > ein + 1,
      list: arr.map(x => ({
        id: String(x.dissid || ''),
        name: x.dissname || '',
        user: (x.creator && (x.creator.name || x.creator.nick)) || '',
        count: 0,                    // 目录接口不给曲目数，进详情才知道
        play: Number(x.listennum) || 0,
        playText: '',
        intro: x.introduction || '',
        cover: String(x.imgurl || '').replace(/^http:\/\//i, 'https://')
      })).filter(x => x.id && x.name)
    };
  }
  return apiSpecialList(page, size);
}

/** 歌单详情 · 三大平台。plat 由前端显式传，不猜。 */
async function apiSpecialSongsPlat(plat, id, page = 1, size = 50) {
  if (plat === 'netease') {
    const j = await getJSON(`https://music.163.com/api/v6/playlist/detail?id=${
      encodeURIComponent(id)}&n=${size}&s=0`, { headers: NE_H, tries: 2, timeout: 15000 });
    const pl = (j && j.playlist) || (j && j.result && j.result.playlist) || {};
    const tracks = Array.isArray(pl.tracks) ? pl.tracks : [];
    const total = Number(pl.trackCount) || tracks.length;
    return {
      id: String(id), name: pl.name || '',
      user: (pl.creator && pl.creator.nickname) || '',
      cover: String(pl.coverImgUrl || '').replace(/^http:\/\//i, 'https://'),
      total, partial: tracks.length < total,
      list: tracks.map(s => {
        /* v6 的时长在 dt（毫秒），老接口在 duration（秒）—— 只认一个会让整张
           歌单的时长全变「--:--」（dailyNetease 踩过同样的坑）。 */
        const dur = Math.round(Number(s.dt || 0) / 1000) || Math.round(Number(s.duration || 0));
        const vip = s.fee === 1 || s.fee === 4;
        return {
          source: 'netease', sourceName: '网易云', id: String(s.id || ''),
          songname: s.name || '',
          singer: (s.artists || s.ar || []).map(a => a && a.name).filter(Boolean).join('/') || '',
          album: (s.album && s.album.name) || (s.al && s.al.name) || '',
          albumId: String((s.album && s.album.id) || (s.al && s.al.id) || ''),
          duration: dur, durationText: fmtDur(dur), sizeText: '',
          vip, hints: vip ? ['会员'] : ['免费'],
          cover: String((s.album && s.album.picUrl) || (s.al && s.al.picUrl) || '').replace(/^http:\/\//i, 'https://')
        };
      })
    };
  }
  if (plat === 'qq') {
    const j = await getJSON(`https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg`
      + `?type=1&json=1&utf8=1&onlysong=0&disstid=${encodeURIComponent(id)}&format=json`
      + `&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8&notice=0`
      + `&platform=yqq.json&needNewCode=0`, { headers: QQ_H, tries: 2, timeout: 15000 });
    const cd = (j && j.cdlist && j.cdlist[0]) || {};
    const sl = Array.isArray(cd.songlist) ? cd.songlist : [];
    /* 实测 dissid=7707261125 这类歌单返回空 cdlist —— 取不到就抛错，
       绝不返回空列表让前端显示「导入成功但一首没有」。 */
    if (!sl.length) throw new Error('这个歌单打不开（可能要登录，或已经失效）');
    const total = Number(cd.total_song_num) || sl.length;
    return {
      id: String(id), name: cd.dissname || '',
      user: cd.nickname || '',
      cover: String(cd.logo || cd.headurl || '').replace(/^http:\/\//i, 'https://'),
      total, partial: sl.length < total,
      list: sl.map(s => {
        const dur = Number(s.interval) || 0;
        const mid = s.songmid || '';
        const albmMid = s.albummid || '';
        const vip = Number(s.pay && s.pay.payplay) === 1;
        return {
          source: 'qq', sourceName: 'QQ音乐', id: String(mid),
          songname: s.songname || s.name || '',
          singer: (s.singer || []).map(x => x && x.name).filter(Boolean).join('/') || '',
          album: s.albumname || '',
          albumId: String(albmMid),
          duration: dur, durationText: fmtDur(dur), sizeText: '',
          vip, hints: vip ? ['付费'] : ['免费'],
          cover: qqImg(albmMid)
        };
      })
    };
  }
  return apiSpecialSongs(id, page, size);
}

/** 酷狗歌手精确命中探测：命中时前端可一键看该歌手全部歌曲 */
async function kugouSingerHint(kw) {
  try {
    const s = await apiSingerSearch(kw, 1, 5);
    return (s.list || []).find(x => x.name === kw && x.songcount > 0) || null;
  } catch { return null; }
}

/* ================= 多平台接入 =================
 * 统一歌曲模型（各平台映射到此形状后，前端无需区分来源）：
 *   { source, sourceName, id, songname, singer, album, albumId, duration,
 *     durationText, sizeText, vip, hints, cover, hash?, sqhash?, h320hash? }
 *
 * 边界（刻意为之，请勿改）：
 *   只用各平台「未登录可见」的公开接口。免费曲目取完整音源；
 *   会员/付费/试听片段一律拒绝并明确提示，不签名破解、不登录、不拼接试听。
 * ============================================ */

/* ---------------- 网易云音乐（公开接口，未登录） ----------------
 * 搜索：music.163.com/api/search/get/web
 * 音源：music.163.com/api/song/enhance/player/url
 *       · fee=0/8 免费曲目 → 完整直链
 *       · fee=1 会员曲目 → 只给 30 秒试听（freeTrialInfo），本服务拒绝
 * 歌词：music.163.com/api/song/lyric
 */
/* ---------------- 零依赖二维码编码器（2026-10-29） ----------------
 * 为什么要有这一段：网易云的扫码登录接口只给一串 unikey，**不给图** ——
 * 它家的二维码一直是 App 自己渲染的。我们要在页面上摆一张能扫的图，就得自己画。
 * 而 server.mjs 是零依赖单文件（SEA 打包不允许 import 本地模块，见 README），
 * 装 npm 包这条路是死的，所以下面是从 QR Model 2 规范直接实现的一份编码器：
 *   字节模式 / 纠错等级 M / 版本 1-10（够装 216 字节，网易云的 key 只用 68）
 *
 * 交付前做过两道验证（deploy/_qrcheck.py）：
 *   ① 与 python 的 qrcode 库在 v3~v10 上**逐格对拍全等**（同一版本、同一掩码）；
 *   ② 渲染成 PNG 用 OpenCV 真解码，v3~v9 全部解出原文。
 *   （v10 连 python 官方库生成的都解不出，是 OpenCV 的能力边界，与本实现无关。）
 * ---------------------------------------------------------------- */
const QR_TOTAL = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];       // 各版本总码字（v1..v10）
const QR_BLOCKS = [                                                      // [g1块数, g1数据码字, g2块数, g2数据码字, 每块纠错码字]
  [1, 16, 0, 0, 10], [1, 28, 0, 0, 16], [1, 44, 0, 0, 26], [2, 32, 0, 0, 18],
  [2, 43, 0, 0, 24], [4, 27, 0, 0, 16], [4, 31, 0, 0, 18], [2, 38, 2, 39, 22],
  [3, 36, 2, 37, 22], [4, 43, 1, 44, 26],
];
const QR_ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const GF_EXP = new Array(512), GF_LOG = new Array(256);
(function () {
  let x = 1;
  for (let i = 0; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];

/** 生成多项式：∏(x + α^i)，系数降幂排，长度 = deg+1，首项恒为 1 */
function rsGen(deg) {
  let g = [1];
  for (let i = 0; i < deg; i++) {
    const n = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      n[j] ^= g[j];
      n[j + 1] ^= gfMul(g[j], GF_EXP[i]);
    }
    g = n;
  }
  return g;
}
/** Reed-Solomon 余式（即纠错码字） */
function rsEcc(data, deg) {
  const g = rsGen(deg);
  const res = new Array(deg).fill(0);
  for (const b of data) {
    const f = b ^ res[0];
    res.shift(); res.push(0);
    for (let i = 0; i < deg; i++) res[i] ^= gfMul(g[i + 1], f);
  }
  return res;
}
const qbit = (x, i) => ((x >>> i) & 1) !== 0;
function bchFormat(d) { let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537); return (((d << 10) | r) & 0x7fff) ^ 0x5412; }
function bchVersion(v) { let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25); return (v << 12) | r; }

/**
 * @param {string} text  要编码的内容
 * @param {number} mask  强制用的掩码（0..7）；不传则自动挑罚分最低的
 * @returns {{size:number, modules:number[][]}}
 */
function qrEncode(text, forceMask) {
  const bytes = Buffer.from(String(text), 'utf8');
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const [, g1n, g1d, g2n, g2d, ec] = [0, ...QR_BLOCKS[v - 1]];
    const dataCw = g1n * g1d + g2n * g2d;
    const ccBits = v < 10 ? 8 : 16;
    if ((4 + ccBits + 8 * bytes.length + 7) >> 3 <= dataCw) { version = v; break; }
  }
  if (!version) throw new Error('内容太长（>216 字节），超出 v10 容量');

  const [g1n0, g1d0, g2n0, g2d0, ecLen] = QR_BLOCKS[version - 1];
  const g1n = g1n0, g1d = g1d0, g2n = g2n0, g2d = g2d0;
  const dataCw = g1n * g1d + g2n * g2d;

  // ---- 比特流：模式 0100 + 字符数 + 数据 + 终止符 + 补齐 ----
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  for (let i = 0; i < 4 && bits.length < dataCw * 8; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const dataBytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    dataBytes.push(v);
  }
  let pad = 0xec;
  while (dataBytes.length < dataCw) { dataBytes.push(pad); pad = pad === 0xec ? 0x11 : 0xec; }

  // ---- 分块 + 纠错 + 交织 ----
  const blocks = [];
  let off = 0;
  for (let i = 0; i < g1n; i++) blocks.push({ data: dataBytes.slice(off, off += g1d) });
  for (let i = 0; i < g2n; i++) blocks.push({ data: dataBytes.slice(off, off += g2d) });
  for (const b of blocks) b.ecc = rsEcc(b.data, ecLen);
  const stream = [];
  const maxData = Math.max(g1d, g2n ? g2d : 0);
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) stream.push(b.data[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) stream.push(b.ecc[i]);

  // ---- 铺矩阵 ----
  const size = version * 4 + 17;
  const mods = Array.from({ length: size }, () => new Array(size).fill(0));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => { if (x >= 0 && x < size && y >= 0 && y < size) { mods[y][x] = dark ? 1 : 0; fn[y][x] = true; } };

  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  const finder = (x, y) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      setFn(x + dx, y + dy, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

  const ap = QR_ALIGN[version - 1];
  for (let i = 0; i < ap.length; i++) for (let j = 0; j < ap.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      setFn(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const drawFormat = (m) => {
    const f = bchFormat((0 << 3) | m);   // 纠错等级 M = 0b00
    for (let i = 0; i <= 5; i++) setFn(8, i, qbit(f, i));
    setFn(8, 7, qbit(f, 6)); setFn(8, 8, qbit(f, 7)); setFn(7, 8, qbit(f, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, qbit(f, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, qbit(f, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, qbit(f, i));
    setFn(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    const v = bchVersion(version);
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3), b = Math.floor(i / 3), d = qbit(v, i);
      setFn(a, b, d); setFn(b, a, d);
    }
  }

  let bi = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && bi < stream.length * 8) {
          mods[y][x] = qbit(stream[bi >>> 3], 7 - (bi & 7));
          bi++;
        }
      }
    }
  }

  // ---- 掩码 ----
  const applyMask = (m) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (fn[y][x]) continue;
      let inv;
      switch (m) {
        case 0: inv = (x + y) % 2 === 0; break;
        case 1: inv = y % 2 === 0; break;
        case 2: inv = x % 3 === 0; break;
        case 3: inv = (x + y) % 3 === 0; break;
        case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: inv = (x * y) % 2 + (x * y) % 3 === 0; break;
        case 6: inv = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
        default: inv = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
      }
      if (inv) mods[y][x] ^= 1;
    }
  };
  const penalty = () => {
    let s = 0;
    for (let y = 0; y < size; y++) {
      let c = false, run = 0;
      for (let x = 0; x < size; x++) {
        if (mods[y][x] === (c ? 1 : 0)) { run++; if (run === 5) s += 3; else if (run > 5) s++; }
        else { c = !!mods[y][x]; run = 1; }
      }
    }
    for (let x = 0; x < size; x++) {
      let c = false, run = 0;
      for (let y = 0; y < size; y++) {
        if (mods[y][x] === (c ? 1 : 0)) { run++; if (run === 5) s += 3; else if (run > 5) s++; }
        else { c = !!mods[y][x]; run = 1; }
      }
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const c = mods[y][x];
      if (c === mods[y][x + 1] && c === mods[y + 1][x] && c === mods[y + 1][x + 1]) s += 3;
    }
    let dark = 0;
    for (const r of mods) for (const v of r) dark += v;
    s += (Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1) * 10;
    return s;
  };
  let best = 0, bestScore = Infinity;
  const scores = [];
  if (forceMask != null) {
    applyMask(forceMask); best = forceMask;
  } else {
    for (let m = 0; m < 8; m++) {
      applyMask(m); const sc = penalty(); scores.push(sc);
      if (sc < bestScore) { bestScore = sc; best = m; }
      applyMask(m);  // 掩码是自反的，再异或一次即还原
    }
    applyMask(best);
  }
  drawFormat(best);
  return { size, modules: mods, version, mask: best, scores };
}

/** 渲染成 SVG（前端 <img> 可直接吃 data URI，比 PNG 省事且怎么放大都清楚） */
function qrSvg(text, border, scale) {
  const { size, modules } = qrEncode(text);
  const b = border == null ? 3 : border, s = scale || 6;
  const n = size + b * 2, px = n * s;
  let r = '';
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (modules[y][x]) r += '<rect x="' + ((x + b) * s) + '" y="' + ((y + b) * s) + '" width="' + s + '" height="' + s + '"/>';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px + '" viewBox="0 0 ' + px + ' ' + px + '">' +
    '<rect width="' + px + '" height="' + px + '" fill="#fff"/><g fill="#000">' + r + '</g></svg>';
}


/* ---------------- 网易云 weapi 加密（2026-10-29） ----------------
 * 扫码登录的两个接口（unikey / client/login）走 weapi，不加密一律 400。
 * 加密方式（站点 JS 逆向，三处都要一模一样，错一个字节就是 -460）：
 *   1. 明文 JSON → AES-128-CBC（密钥 0CoJUm6Qyw8W8jud，IV 0102030405060708）
 *   2. 再拿**随机 16 位**密钥对上一步的 base64 密文 AES 一次 → params
 *   3. 随机密钥**倒序**后做教科书 RSA（无填充，公钥固定）→ encSecKey
 * ⚠️ 第 3 步是**无填充**的裸 RSA，node 的 publicEncrypt 会加 PKCS#1 填充，
 *    两者不等价 —— 所以这里只能自己用 BigInt 做模幂（BigInt 直接 ** 会产生
 *    一个上千万位的中间数，改用平方-乘法，17 轮就完事）。
 * ---------------------------------------------------------------- */
const NE_AES_NONCE = '0CoJUm6Qyw8W8jud';
const NE_AES_IV = '0102030405060708';
const NE_RSA_E = BigInt('0x010001');
/* ⚠️ 这个模数错一个字符，网易云就解不开 params —— 表现是 200 + 空 body，
   不报错、不给任何提示（2026-10-29 我手拆时写漏过一个 b7，查了三轮才发现）。
   已与三个独立公开来源逐字核对，长度必须恒为 256。 */
/* ⚠️ 模数错一个字符，网易云就解不开 params —— 表现是 200 + 空 body，
   不报错、不给任何提示（2026-10-29 手拆时写漏过字符，查了三轮才发现）。
   已与三个独立公开来源逐字核对，且 bitLength 实测必须等于 1024。 */
const NE_RSA_N = BigInt('0x00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725'
  + '152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312'
  + 'ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424'
  + 'd813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8'
  + 'e7');

function neAesCbc(text, key) {
  const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(NE_AES_IV, 'utf8'));
  return Buffer.concat([c.update(Buffer.from(text, 'utf8')), c.final()]).toString('base64');
}
function neModPow(base, exp, mod) {
  let r = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return r;
}
function neRsa(text) {
  const m = BigInt('0x' + Buffer.from(String(text).split('').reverse().join(''), 'utf8').toString('hex'));
  return neModPow(m, NE_RSA_E, NE_RSA_N).toString(16).padStart(256, '0');
}
function neWeapi(obj) {
  const abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let sk = '';
  for (let i = 0; i < 16; i++) sk += abc[Math.floor(Math.random() * abc.length)];
  return { params: neAesCbc(neAesCbc(JSON.stringify(obj), NE_AES_NONCE), sk), encSecKey: neRsa(sk) };
}

/** 打一次 weapi 接口。⚠️ 一定要把 Set-Cookie 收回来 —— 网易云的登录凭证就在响应头里 */
async function neWeapiCall(pathname, data, cookie) {
  const f = neWeapi(data);
  const r = await fetch('https://music.163.com' + pathname, {
    method: 'POST',
    headers: {
      'User-Agent': UA_PC, Referer: 'https://music.163.com/',
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookie || 'os=pc; appver=8.9.70'
    },
    body: new URLSearchParams({ params: f.params, encSecKey: f.encSecKey }).toString(),
    redirect: 'manual'
  });
  let cookies = [];
  try { cookies = r.headers.getSetCookie ? r.headers.getSetCookie() : []; } catch { cookies = []; }
  let j = null;
  try { j = JSON.parse(await r.text()); } catch { j = null; }
  return { json: j, cookies, status: r.status };
}

/** 设备 cookie（NMTID / _ntes_nuid）：★ 没有它，网易云会把这次登录当新设备，
 *  会员曲只给 30 秒试听（实测同一张号：整行 cookie 出 53MB，只有 MUSIC_U 出 720KB）。 */
async function neDeviceCookie() {
  const base = 'os=pc; appver=8.9.70';
  /* ★ 必须是 /discover 或某个 api 路径，不能是首页：实测 music.163.com/ 一个
     Set-Cookie 都不给，而 /discover、/api/* 才会下发 NMTID（2026-10-29 逐条试出来的）。
     少了它，网易云会把这次登录判成新设备，会员曲只给 30 秒试听。 */
  try {
    const r = await fetch('https://music.163.com/discover', { headers: { 'User-Agent': UA_PC, Referer: 'https://music.163.com/' }, redirect: 'manual' });
    const list = (r.headers.getSetCookie ? r.headers.getSetCookie() : []) || [];
    const keep = [];
    for (const sc of list) {
      const kv = String(sc).split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0 && /^(NMTID|_ntes_nuid|MUSIC_R_T|buildver)$/i.test(kv.slice(0, i).trim())) keep.push(kv.trim());
    }
    return base + (keep.length ? '; ' + keep.join('; ') : '');
  } catch { return base; }
}

function neCookieMerge(seed, setCookies) {
  const jar = new Map();
  for (const kv of String(seed || '').split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
  for (const sc of setCookies || []) {
    const kv = String(sc).split(';')[0];
    const i = kv.indexOf('=');
    if (i <= 0) continue;
    const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
    if (!v) jar.delete(k); else jar.set(k, v);     /* 空值 = 服务端在删这条 cookie */
  }
  return Array.from(jar.entries()).map(([k, v]) => k + '=' + v).join('; ');
}

const NE_QR = new Map();
const NE_QR_TTL = 5 * 60e3;
function neQrClean() {
  const now = Date.now();
  for (const [k, v] of NE_QR) if (now - v.at > NE_QR_TTL) NE_QR.delete(k);
}

const NE_H = { Referer: 'https://music.163.com/', Cookie: 'os=pc; appver=2.9.7' };
const neImg = u => u ? String(u).replace(/^http:\/\//i, 'https://') + (String(u).indexOf('?') < 0 ? '?param=300y300' : '') : '';

/** 网易云搜索接口只回 album.picId（数字），批量换到 v3/song/detail 取真正的 picUrl */
async function neCovers(ids) {
  if (!ids || !ids.length) return {};
  try {
    const body = 'c=' + encodeURIComponent(JSON.stringify(ids.map(id => ({ id: Number(id) }))));
    const j = await getJSON('https://music.163.com/api/v3/song/detail', {
      method: 'POST', headers: { ...NE_H, 'Content-Type': 'application/x-www-form-urlencoded' }, body, tries: 2
    });
    const m = {};
    for (const s of j?.songs || []) m[String(s.id)] = s.al?.picUrl || s.album?.picUrl || '';
    return m;
  } catch { return {}; }
}

async function apiNeteaseSearch(kw, page, size) {
  const offset = Math.max(0, (page - 1) * size);
  /* ★ 2026-10-18：`api/search/get/web` 已被网易云按 IP 限流 ——
     稳定回 {"code":405,"msg":"操作频繁，请稍候再试"}，
     表现就是「网易云」单源永远 0 条（而 sources 里还写着 true，
     看不出来坏了）。实测同一台机器上 cloudsearch/pc 完全正常（337 条），
     所以主力换成它；老接口留作兜底，将来任一侧调整都还有活路。

     两个接口字段不同，这里一并兼容：
       cloudsearch/pc  ar / al / dt      （新）
       search/get/web  artists / album / duration（旧） */
  let songs = [], total = 0;
  try {
    const j = await getJSON(`https://music.163.com/api/cloudsearch/pc?s=${encodeURIComponent(kw)}&type=1&offset=${offset}&limit=${size}&total=true`, { headers: NE_H, tries: 2 });
    const r = j?.result || {};
    songs = r.songs || [];
    total = r.songCount || songs.length;
  } catch { /* 落到下面兜底 */ }
  if (!songs.length) {
    try {
      const j = await getJSON(`https://music.163.com/api/search/get/web?s=${encodeURIComponent(kw)}&type=1&offset=${offset}&limit=${size}&total=true`, { headers: NE_H, tries: 1 });
      songs = j?.result?.songs || [];
      total = j?.result?.songCount || songs.length;
    } catch { /* 两条都不通就回空列表，让聚合里其他源顶上 */ }
  }
  const cov = await neCovers(songs.map(s => s.id));   // 批量补封面
  return {
    total,
    list: songs.map(s => {
      const ar = s.ar || s.artists || [];
      const al = s.al || s.album || {};
      const dur = Math.round((Number(s.dt || s.duration || 0)) / 1000);
      const vip = s.fee === 1 || s.fee === 4;      // 1=VIP, 4=购买专辑, 0/8=免费
      return {
        source: 'netease', sourceName: '网易云',
        id: String(s.id),
        songname: s.name || '',
        singer: ar.map(a => a.name).filter(Boolean).join('/') || (al.artist && al.artist.name) || '',
        album: al.name || '',
        albumId: String(al.id || ''),
        duration: dur, durationText: fmtDur(dur),
        sizeText: '', vip,
        hints: vip ? ['会员'] : ['免费'],
        cover: neImg(cov[String(s.id)] || al.picUrl),
        /* MV（第 14 期）：s.mv 就是官方 mvid，>0 即有官方 MV。
           播放地址由 /api/mv/url 现场取（enhance/play/mv/url，公开免登录；
           旧 /api/mv/url 接口已 404，别再用）。 */
        mvid: Number(s.mv) || 0,
        hasMv: Number(s.mv) > 0,
        /* 原唱标注（第 18 期）：originCoverType 1=原唱 2=非原唱；
           非原唱时 originSongSimpleData 给原唱者与原曲名 */
        ...songOtag(s.name, {
          oct: Number(s.originCoverType) || 0,
          oriAuth: (s.originSongSimpleData && Array.isArray(s.originSongSimpleData.artists))
            ? s.originSongSimpleData.artists.map(a => a && a.name).filter(Boolean).join('/') : ''
        })
      };
    }).filter(x => x.songname && x.id)
  };
}

/* ---------------- 网易云（登录态多档） ----------------
 * ★ 2026-10-18：和酷狗 / QQ 同一套思路，但网易云的坑**跟 QQ 不一样**，别照搬判断：
 *   匿名不是「什么都不给」，而是给到 320K，然后把 lossless / hires 静默降级成 320K mp3。
 *   所以「有 url 就当成功」在这里是错的 —— 必须比 type 与 br（见 neTake）。
 *   实测（匿名）：
 *     · 免费曲 standard/higher/exhigh → 128K / 192K / 320K 都真给；
 *       再要 lossless / hires 全回 320K mp3（br=320000, type=mp3）；
 *     · 会员曲只给 128K + freeTrialInfo，约 30 秒（720,813 B）。
 *   凭证存 data/secrets.json 的 netease 段：{ uid, cookie, nickname, savedAt }，
 *   真正管用的是 MUSIC_U；refreshData() 每请求按 mtime 重读，写完即生效不用重启。
 */
const NE_LEVEL_EXT = { hires: 'flac', lossless: 'flac', exhigh: 'mp3', higher: 'mp3', standard: 'mp3' };
const NE_LEVEL_QLABEL = { hires: 'hires', lossless: 'flac', exhigh: 'hq', higher: 'n192', standard: 'n128' };
const NE_LADDER = {
  hires: ['hires', 'lossless', 'exhigh', 'higher'],
  flac: ['lossless', 'exhigh', 'higher'],
  hq: ['exhigh', 'higher'],
  /* 标准档先要 standard（真 128K），拿不到才退更高 —— 以前只打 higher，
     用户选「标准」拿到的是 192K，白多耗一半流量 */
  n128: ['standard', 'higher'],
  /* auto 不上 Hi-Res：和酷狗 / QQ 那条 auto 的取舍保持一致（一首 Hi-Res 顶两三首无损的流量） */
  auto: ['lossless', 'exhigh', 'higher']
};

/** 取网易云凭证；没有或残缺返回 null */
function neCred() {
  const k = (typeof SECRETS === 'object' && SECRETS && SECRETS.netease) || {};
  const cookie = String(k.cookie || '').trim();
  if (!cookie || !neHasKey(cookie)) return null;
  return { uid: String(k.uid || ''), cookie, nickname: String(k.nickname || '') };
}

function neHasKey(cookie) {
  return /(?:^|;\s*)MUSIC_U=[^;\s]+/.test(String(cookie || ''));
}

/** 网易云 url/v1 单次请求。cred 传 null 表示刻意匿名。 */
async function neUrlOnce(id, level, cred) {
  const c = cred === undefined ? neCred() : cred;
  /* 带凭证时自己拼 Cookie：NE_H 里那份 appver 太老，带登录态要一起换新的 */
  const headers = Object.assign({}, NE_H);
  if (c) headers.Cookie = 'os=pc; appver=8.9.70; channel=netease; ' + c.cookie;
  const j = await getJSON('https://music.163.com/api/song/enhance/player/url/v1?ids=' +
    encodeURIComponent('[' + id + ']') + '&level=' + level + '&encodeType=flac',
    { headers, tries: 2, timeout: 10000 });
  return (j && j.data && j.data[0]) || null;
}

/** 一条 url/v1 结果是不是「完整、且真是这一档」——降级必须认出来 */
function neTake(d, level, duration) {
  if (!d || !d.url) return { ok: false, reason: '没给直链' };
  if (d.freeTrialInfo) return { ok: false, reason: '只给试听片段（会员曲）' };
  const br = Number(d.br || 0), size = Number(d.size || 0);
  const ext = String(d.type || '').toLowerCase();
  const sec = br && size ? size / (br / 8) : 0;
  if (duration && sec && sec < duration * 0.8) {
    return { ok: false, reason: '只给约 ' + Math.round(sec) + ' 秒（原曲 ' + Math.round(duration) + ' 秒）' };
  }
  const kbs = Math.round(br / 1000);
  if (level === 'hires' && !(ext === 'flac' && br >= 1000000)) {
    return { ok: false, reason: '没给 Hi-Res（回的是 ' + (ext || '?') + ' ' + kbs + 'K）' };
  }
  if (level === 'lossless' && ext !== 'flac') {
    return { ok: false, reason: '没给无损（回的是 ' + (ext || '?') + ' ' + kbs + 'K）' };
  }
  if (level === 'exhigh' && br < 300000) {
    return { ok: false, reason: '没给 320K（回的是 ' + kbs + 'K）' };
  }
  return { ok: true, br, size, ext: ext || NE_LEVEL_EXT[level] };
}

/** 网易云音源：有凭证按档爬，无凭证 320K 封顶；试听片段一律拒绝 */
async function apiNeteaseResolve(id, duration, br) {
  const cred = neCred();
  /* 匿名只打 exhigh：再往上都是被静默降级的 320K，多打三次纯属浪费（实测） */
  const order = cred ? (NE_LADDER[br] || NE_LADDER.auto)
    : (br === 'n128' ? ['standard', 'higher'] : ['exhigh', 'higher']);
  const reasons = [];
  for (const lv of order) {
    let d = null;
    try { d = await neUrlOnce(id, lv, cred); }
    catch (e) { reasons.push(lv + ' 请求失败'); continue; }
    const t = neTake(d, lv, duration);
    if (!t.ok) { reasons.push(lv + ' ' + t.reason); continue; }
    const size = t.size || 0;
    return {
      url: d.url, ext: t.ext, bitRate: t.br, size,
      sizeText: size ? fmtSize(size) : '',
      quality: (lv === 'hires' && t.br >= 1000000) ? 'Hi-Res' : qLabel(t.br, t.ext),
      qualityKey: NE_LEVEL_QLABEL[lv] || 'ne', login: !!cred
    };
  }
  /* 一档都没成：把最后一档的真实原因带出去，别写成含糊的「没返回音源」 */
  const tail = reasons.length ? reasons[reasons.length - 1] : '';
  const e = new Error(cred
    ? '网易云没返回可用音源（' + (tail || '全档位失败') + '）—— 会员可能已到期，或这首是数字专辑 / 版权下架'
    : '网易云会员曲需要登录：现在只给试听片段（' + (tail || '未登录') + '）。'
      + '到守护页粘 music.163.com 的 Cookie 整行就能播（只粘 MUSIC_U 会被当成新设备，仍给试听）');
  e.isNoSource = true; throw e;
}

/** 给 /api/probe 用：把网易云四档全摆出来（对齐酷狗 probeAll / qqProbeLevels 的语义） */
async function neProbeLevels(id) {
  if (!id) return [];
  const cred = neCred();
  const out = [];
  for (const lv of ['hires', 'lossless', 'exhigh', 'higher']) {
    const label = lv === 'hires' ? 'Hi-Res' : lv === 'lossless' ? '无损' : lv === 'exhigh' ? '320K' : '192K';
    let d = null, reason = '';
    try { d = await neUrlOnce(id, lv, cred); } catch (e) { reason = humane(e, '取不到'); }
    const t = d ? neTake(d, lv) : { ok: false, reason: reason || '取不到' };
    const br = d && d.br ? Number(d.br) : 0;
    const size = d && d.size ? Number(d.size) : 0;
    const ext = (d && d.type) || NE_LEVEL_EXT[lv];
    out.push({
      q: NE_LEVEL_QLABEL[lv], label, ok: t.ok, ext,
      bitRate: br, size, sizeText: size ? fmtSize(size) : '',
      quality: (lv === 'hires' && t.ok) ? 'Hi-Res' : qLabel(br, ext),
      reason: t.ok ? '' : (t.reason || '')
    });
  }
  return out;
}

/* 探活曲：陈奕迅《孤勇者》（fee=1 会员曲，版权稳定，256 秒）。
   匿名只给 128K 试听；黑胶 VIP 应给 FLAC；曲库有 Hi-Res 就给 Hi-Res。 */
const NE_PROBE_ID = '1901371647';
const NE_PROBE_NAME = '陈奕迅《孤勇者》';
const NE_PROBE_SEC = 256;

async function neProbe(cred) {
  const c = cred === undefined ? neCred() : cred;
  if (!c) {
    return { ok: false, level: 'critical', levels: [],
      message: '还没有网易云登录凭证 —— 会员曲只会给 30 秒试听' };
  }
  const levels = [];
  for (const lv of ['hires', 'lossless', 'exhigh', 'higher']) {
    let d = null, reason = '';
    try { d = await neUrlOnce(NE_PROBE_ID, lv, c); } catch (e) { reason = humane(e, '取不到'); }
    const t = d ? neTake(d, lv, NE_PROBE_SEC) : { ok: false, reason: reason || '取不到' };
    levels.push({
      p: lv, ok: t.ok,
      br: d && d.br ? Number(d.br) : 0,
      size: d && d.size ? Number(d.size) : 0,
      reason: t.ok ? '' : (t.reason || '')
    });
  }
  const hi = levels.find(x => x.p === 'hires' && x.ok);
  const fl = levels.find(x => x.p === 'lossless' && x.ok);
  const hq = levels.find(x => x.p === 'exhigh' && x.ok);
  if (hi) return { ok: true, level: 'ok', levels,
    message: '正常：' + NE_PROBE_NAME + ' 拿到 Hi-Res' + (hi.size ? '（' + fmtSize(hi.size) + '）' : '') };
  if (fl) return { ok: true, level: 'ok', levels,
    message: '正常：' + NE_PROBE_NAME + ' 拿到无损 FLAC' + (fl.size ? '（' + fmtSize(fl.size) + '）' : '') };
  if (hq) return { ok: false, level: 'warn', levels,
    message: '凭证有效，但只给到 320K（黑胶 VIP 应有无损）—— 会员可能已到期或降级' };
  return { ok: false, level: 'critical', levels,
    message: '凭证无效：连 320K 都拿不到，会员曲仍是试听片段，需要重新登录' };
}

/* 剩余天数：和 tools/kg-guard.py 的 days_left() 同一口径（到期日 - 今天，按 CST 算日期差） */
function neDaysLeft(expireAt) {
  if (!expireAt) return null;
  const d = new Date(expireAt + 'T00:00:00+08:00').getTime();
  if (!d) return null;
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const d0 = new Date(today + 'T00:00:00+08:00').getTime();
  return Math.round((d - d0) / 864e5);
}

/** 会员到期日：网易云 vip/info 直接给 expireTime（毫秒），比 QQ 省事（QQ 只能人工填） */
async function neVipInfo(cred) {
  const c = cred === undefined ? neCred() : cred;
  if (!c) return { expireAt: '', level: '' };
  try {
    const j = await getJSON('https://music.163.com/api/music-vip-membership/client/vip/info?uid=' +
      encodeURIComponent(c.uid || '') + '&type=1', {
      headers: Object.assign({}, NE_H, { Cookie: 'os=pc; appver=8.9.70; channel=netease; ' + c.cookie }),
      tries: 1, timeout: 8000
    });
    const d = (j && j.data) || {};
    const a = d.associator || {}, m = d.musicPackage || {};
    const exp = Math.max(Number(a.expireTime || 0), Number(m.expireTime || 0));
    if (!exp) return { expireAt: '', level: '' };
    return {
      expireAt: new Date(exp + 8 * 3600e3).toISOString().slice(0, 10),
      level: 'redVip' + (d.redVipLevel || ''), raw: exp
    };
  } catch (e) {
    return { expireAt: '', level: '' };
  }
}

/* 体检结果落盘：probe / cred 两个入口共用。
   以前只有 /probe 写盘，粘完 cookie 页面还挂着「未配置」，得再点一次立即体检。 */
function neSaveHealth(r, by, vp) {
  const f = path.join(DATA_DIR, 'ne-health.json');
  const old = readJSON(f, {}) || {};
  const c = neCred();
  const auto = (vp && vp.expireAt) || '';
  const vf = path.join(DATA_DIR, 'ne-vip.json');
  const v = readJSON(vf, {}) || {};
  const notifyDays = v.notifyDays || old.notifyDays || 7;
  /* 自动值只写进巡检文件；手工登记过（manual=true）就不动它 */
  if (auto && !v.manual) {
    v.expireAt = auto;
    v.notifyDays = notifyDays;
    v.auto = true;
    v.uid = c ? c.uid : '';
    v.updatedAt = Date.now();
    try { writeJSON(vf, v); } catch (e) { /* 写不进去也不影响体检本身 */ }
  }
  const expireAt = String(v.manual ? (v.expireAt || '') : (auto || old.expireAt || '')) || '';
  const h = {
    ok: r.ok, level: r.level, message: r.message,
    checkedAt: Date.now(),
    checkedAtText: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' '),
    levels: r.levels || [],
    expireAt, daysLeft: neDaysLeft(expireAt), notifyDays,
    probe: { id: NE_PROBE_ID, name: NE_PROBE_NAME },
    account: { uid: c ? c.uid : '', nickname: c ? c.nickname : '', savedAt: (SECRETS.netease || {}).savedAt || '' },
    by: by || 'manual'
  };
  writeJSON(f, h);
  return h;
}


async function apiNeteaseLyric(id) {
  const j = await getJSON(`https://music.163.com/api/song/lyric?id=${id}&lv=-1&kv=-1&tv=-1`, { headers: NE_H, tries: 2 });
  const lrc = j?.lrc?.lyric;
  return lrc ? { lrc, title: '', artist: '' } : null;
}

/* ---------------- 歌曲评论（独立页） ----------------
 * ★ 数据源决策（2026-10-22）：酷狗的歌曲评论接口拿不到 ——
 *   comment.service.kugou.com 空响应、www.kugou.com/yy 回 Access Deny，
 *   和 MV 一样被酷狗锁了。网易云热评接口是**公开可用的**（实测返回
 *   hotComments + comments + total，无需登录、无签名）。
 *   链路：酷狗歌 → 按「歌名 歌手」去网易云搜索 → 拿网易云 song id →
 *   /api/v1/resource/comments/R_SO_4_{id} 拉热评 + 最新评论。
 * ★ 为什么不用「酷狗 hash 直接换」：酷狗没有公开的歌曲评论端点，
 *   而网易云是服务端早就适配好的数据源（搜索/音源/歌词都在用）。
 *   界面会如实标注「评论来自网易云」，不冒充酷狗原站评论。 */
async function apiSongComment(name, singer, page) {
  page = page || 1;
  /* ① 拿网易云候选：歌名 + 歌手搜，一次取 20 条（只取 3 条会把原唱漏掉 ——
        网易云对「翻唱 / 翻弹 / Remix」排名常比原唱靠前，尤其版权下架的原唱
        根本不在前几名）。 */
  let songs = [];
  for (const kw of [name + ' ' + singer, name]) {
    if (!kw.trim()) continue;
    const r = await apiNeteaseSearch(kw, 1, 20);
    songs = r.list || [];
    if (songs.length) break;
  }
  if (!songs.length) return { ok: false, error: '没找到这首歌的评论', empty: true };
  /* ② 打分挑最像原唱的：歌手精确相等 +4，歌名精确相等 +3，歌手包含 +2，
        歌名带「翻唱/cover/钢琴/吉他/Remix/DJ」尾巴 −4。这样陈奕迅《孤勇者》
        第一条就是本人；周杰伦《晴天》原版在网易云已下架，匹配不到本人时
        会如实退回最像的一条并带 matchNote 提示，而不是硬凑一条翻唱当原版。 */
  const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();
  const bare = s => norm(s).replace(/[（(].*?[)）].*$/, '');
  let pick = songs[0], best = -99;
  for (const s of songs) {
    let sc = 0;
    const sn = norm(s.songname), sg = norm(s.singer);
    const wantN = norm(name), wantS = norm(singer);
    if (wantS && sg === wantS) sc += 4;
    if (bare(sn) === wantN) sc += 3;
    else if (wantN && sn.indexOf(wantN) >= 0) sc += 1;
    if (wantS && sg && (sg.indexOf(wantS) >= 0 || wantS.indexOf(sg) >= 0)) sc += 1;
    if (/翻唱|cover|钢琴|吉他|尤克里里|remix|dj版|beat|女声版|男声版|童声版|伴奏|纯音乐/i.test(s.songname)) sc -= 4;
    if (sc > best) { best = sc; pick = s; }
  }
  /* 歌手没精确对上、但结果里有歌名精确的，说明可能是翻唱顶替 —— 记一笔，
        前端据此显示「网易云匹配到：<版本>」，别让用户以为是原唱的热评。 */
  const singerExact = singer && norm(pick.singer) === norm(singer);
  const matchNote = singerExact ? '' : (pick.singer || '未知版本');
  const neId = pick.id;
  /* ③ 拉评论：hotComments（热评）+ comments（最新）。offset 按 (page-1)*20。 */
  const offset = (page - 1) * 20;
  const j = await getJSON(
    `https://music.163.com/api/v1/resource/comments/R_SO_4_${neId}?limit=20&offset=${offset}`,
    { headers: NE_H, tries: 2 }
  );
  const mapC = c => ({
    id: String(c.commentId || ''),
    text: c.content || '',
    liked: Number(c.likedCount) || 0,
    user: (c.user && c.user.nickname) || '网易云用户',
    avatar: (c.user && c.user.avatarUrl) || '',
    time: Number(c.time) || 0,
    timeStr: c.timeStr || ''
  });
  const hot = (j.hotComments || []).map(mapC).filter(x => x.text);
  const list = (j.comments || []).map(mapC).filter(x => x.text);
  return {
    ok: true,
    neId: String(neId),
    matchedName: pick.songname || '',
    matchedSinger: pick.singer || '',
    matchNote: matchNote,
    total: Number(j.total) || 0,
    hot: hot,
    list: list,
    hasNext: offset + list.length < (Number(j.total) || 0)
  };
}

/* ---------------- QQ音乐（公开接口，未登录） ----------------
 * 搜索：c.y.qq.com/soso/fcgi-bin/client_search_cp
 * 音源：u.y.qq.com/cgi-bin/musicu.fcg  vkey.GetVkeyServer
 *       · 免费曲目 (pay_play=0) → 免登录直接拿到 purl 直链
 *       · 付费曲目 purl 为空 → 拒绝
 * 歌词：c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg
 */
const QQ_H = { Referer: 'https://y.qq.com/' };
const qqImg = mid => mid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${mid}.jpg` : '';

async function apiQQSearch(kw, page, size) {
  const j = await getJSON(`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=${page}&n=${size}&w=${encodeURIComponent(kw)}&format=json&cr=1&new_json=1`, { headers: QQ_H });
  const arr = j?.data?.song?.list || [];
  return {
    total: j?.data?.song?.totalnum || arr.length,
    list: arr.map(s => {
      const dur = s.interval || 0;
      const vip = s.pay?.pay_play === 1;
      const mid = s.mid || s.songmid || '';
      const albmMid = s.album?.mid || s.albummid || '';
      return {
        source: 'qq', sourceName: 'QQ音乐',
        id: String(mid),
        songname: s.name || s.songname || '',
        singer: (s.singer || []).map(x => x.name).filter(Boolean).join('/') || '',
        album: s.album?.name || s.albumname || '',
        albumId: String(albmMid),
        duration: dur, durationText: fmtDur(dur),
        sizeText: fmtSize(s.file?.size_flac || s.file?.size_320 || s.file?.size_128),
        vip, hints: vip ? ['付费'] : ['免费'],
        cover: qqImg(albmMid),
        /* MV（第 14 期）：s.mv.vid 是官方 MV 的 vid（腾讯视频系），
           播放地址由 /api/mv/url 现场取（vv.video.qq.com/getinfo，公开）。 */
        mvid: String((s.mv && s.mv.vid) || ''),
        hasMv: !!(s.mv && s.mv.vid),
        /* 原唱标注（第 18 期）：QQ 无等价字段，纯标题启发式 */
        ...songOtag(s.name || s.songname, {})
      };
    })
  };
}

/* ---------------- QQ音乐（登录态） ----------------
 * ★ 2026-10-18：和酷狗同一套思路 —— 用真登录态换会员曲 / 高音质。
 *   但两家的机制完全不同，别照搬字段：
 *     酷狗 = token + userid 签名后走 songinfo；
 *     QQ   = cookie（uin + qqmusic_key），直接进 vkey 的 comm.uin + Cookie 头。
 *   实测未登录时 VIP 曲四档（M500/M800/F000/RS01）全是 result=104003，
 *   所以「没凭证」和「凭证失效」在用户眼里长得一模一样 —— 这就是要守护的原因。
 *   凭证存 data/secrets.json 的 qq 段：{ uin, cookie, nickname, savedAt }。
 *   refreshData() 每个请求按 mtime 重读，写完下一个请求就生效，不用重启。
 */
const QQ_EXT = { RS01: 'flac', F000: 'flac', M800: 'mp3', M500: 'mp3', C400: 'm4a' };
const QQ_QLABEL = { RS01: 'hires', F000: 'flac', M800: 'hq', M500: 'n128', C400: 'n128' };
const QQ_LADDER = {
  hires: ['RS01', 'F000', 'M800', 'M500'],
  flac: ['F000', 'M800', 'M500'],
  hq: ['M800', 'M500'],
  n128: ['M500'],
  /* auto 不上 Hi-Res：同一首 Hi-Res 比无损大一倍，默认吃这个流量对手机不公平，
     和酷狗那条 auto 的取舍保持一致。 */
  auto: ['F000', 'M800', 'M500']
};
const QQ_DETAIL_TTL = 6 * 3600 * 1000;
const QQ_DETAIL_MAX = 400;
const QQ_DETAIL_CACHE = new Map();

/** 取 QQ 凭证；没有或残缺返回 null */
function qqCred() {
  const k = (typeof SECRETS === 'object' && SECRETS && SECRETS.qq) || {};
  const uin = String(k.uin || '').replace(/^o/i, '').trim();
  const cookie = String(k.cookie || '').trim();
  if (!/^\d{5,20}$/.test(uin) || !cookie) return null;
  return { uin, cookie, nickname: String(k.nickname || '') };
}

function qqHasKey(cookie) {
  return /(?:qqmusic_key|qm_keyst)=[^;\s]+/.test(String(cookie || ''));
}

/** 曲目元数据：media_mid（和 songmid 常常不是同一个！）+ 各档真实字节数。6 小时缓存。 */
async function qqDetail(mid) {
  const hit = QQ_DETAIL_CACHE.get(mid);
  if (hit && Date.now() - hit.t < QQ_DETAIL_TTL) return hit.v;
  let j = null;
  try {
    j = await getJSON('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST', headers: { ...QQ_H, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        req_0: { module: 'music.pf_song_detail_svr', method: 'get_song_detail_yqq', param: { song_mid: mid } },
        comm: { uin: 0, format: 'json', ct: 24, cv: 0 }
      }), tries: 2, timeout: 8000
    });
  } catch { return null; }
  const t = j?.req_0?.data?.track_info;
  if (!t || !t.file) return null;
  const f = t.file;
  const v = {
    mediaMid: String(f.media_mid || mid),
    size: {
      RS01: Number(f.size_hires || 0), F000: Number(f.size_flac || 0),
      M800: Number(f.size_320mp3 || 0), M500: Number(f.size_128mp3 || 0),
      C400: Number(f.size_96aac || 0)
    },
    name: String(t.name || ''),
    singer: (t.singer || []).map(x => x.name).filter(Boolean).join('/')
  };
  if (QQ_DETAIL_CACHE.size > QQ_DETAIL_MAX) QQ_DETAIL_CACHE.clear();
  QQ_DETAIL_CACHE.set(mid, { t: Date.now(), v });
  return v;
}

/** QQ vkey 单次请求。cred 传 null 表示刻意匿名。 */
async function qqVkeyOnce(mid, filename, cred) {
  const c = cred === undefined ? qqCred() : cred;
  const param = {
    guid: '10000', songmid: [mid], songtype: [0],
    uin: '0', loginflag: c ? 1 : 0, platform: '20'
  };
  if (filename) param.filename = [filename];
  const headers = { ...QQ_H, 'Content-Type': 'application/json' };
  if (c) headers.Cookie = c.cookie;
  /* comm.uin 固定 0：实测 QQ 只认 cookie 里的 qqmusic_key，param.uin 传 0
     照样给 RS01/F000。而微信登录的 wxuin 是 19 位，超过 2^53，Number()
     会变成近似值 —— 所以别传它。 */
  const comm = { uin: 0, format: 'json', ct: 24, cv: 0 };
  const j = await getJSON('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST', headers,
    body: JSON.stringify({ req_0: { module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param }, comm }),
    tries: 2
  });
  const d = j?.req_0?.data || {};
  const m = (d.midurlinfo && d.midurlinfo[0]) || {};
  return {
    sip: (d.sip && d.sip[0]) || 'http://aqqmusic.tc.qq.com/',
    purl: m.purl || '', rresult: Number(m.result || 0)
  };
}

/** QQ vkey：有凭证按档位阶梯爬，无凭证只给 M500（匿名上限） */
async function apiQQResolve(mid, duration, sizeHint, br) {
  const cred = qqCred();
  const det = await qqDetail(mid).catch(() => null);
  const mm = (det && det.mediaMid) || '';
  /* 无凭证只要 M500：再往上都是 104003，多打三次请求纯属浪费（实测）。
     有凭证才按档位爬，用户选 hires 就先试 RS01。 */
  const order = cred ? (QQ_LADDER[br] || QQ_LADDER.auto) : ['M500'];
  let got = null, used = '';
  if (mm) {
    for (const p of order) {
      /* 元数据说这档压根没有（Hi-Res 大量为 0）就跳过，省一次往返 */
      if (det && det.size && det.size[p] === 0 && p !== 'M500') continue;
      try {
        const r = await qqVkeyOnce(mid, p + mid + mm + '.' + QQ_EXT[p], cred);
        if (r.purl) { got = r; used = p; break; }
      } catch { /* 下一档 */ }
    }
  }
  if (!got || !got.purl) {
    const r = await qqVkeyOnce(mid, null, cred);
    if (r.purl) {
      got = r;
      used = (String(r.purl).match(/^[A-Z]\d{3}/) || [''])[0];
    }
  }
  if (!got || !got.purl) {
    const e = new Error(cred
      ? 'QQ音乐没返回音源（绿钻凭证可能已失效，或这首是数字专辑 / 版权限制曲目）'
      : 'QQ音乐没返回音源直链（会员曲，需先在守护页登录绿钻）');
    e.isNoSource = true; throw e;
  }
  const ext = QQ_EXT[used] || (/\.flac(\?|$)/i.test(got.purl) ? 'flac' : (/\.mp3(\?|$)/i.test(got.purl) ? 'mp3' : 'm4a'));
  const bitRate = (used === 'RS01' || used === 'F000') ? 0
    : (used === 'M800' ? 320000 : (used === 'M500' ? 128000 : (used === 'C400' ? 96000 : 128000)));
  /* 元数据里的字节数是精确值（实测 HEAD 与 size_128mp3 完全一致：3,911,708 B），
     比原来那个「拿搜索页 size 凑」准，也不用额外发 HEAD。 */
  const size = (det && det.size && det.size[used]) || sizeHint || 0;
  return {
    url: got.sip + got.purl, ext, bitRate, size,
    sizeText: size ? fmtSize(size) : '',
    quality: used === 'RS01' ? 'Hi-Res' : qLabel(bitRate, ext),
    qualityKey: QQ_QLABEL[used] || 'qq', login: !!cred
  };
}

/** 给 /api/probe 用：把 QQ 的全部档位摆出来（对齐酷狗 probeAll 的语义） */
async function qqProbeLevels(mid, br) {
  if (!mid) return [];
  const cred = qqCred();
  const det = await qqDetail(mid).catch(() => null);
  const mm = (det && det.mediaMid) || '';
  const order = cred ? (QQ_LADDER[br] || QQ_LADDER.auto) : ['M500'];
  const out = [];
  for (const p of order) {
    const label = p === 'RS01' ? 'Hi-Res' : p === 'F000' ? '无损' : p === 'M800' ? '320K' : '128K';
    const sz = (det && det.size && det.size[p]) || 0;
    let ok = false, reason = '';
    if (!mm) reason = '取不到 media_mid';
    else {
      try {
        const r = await qqVkeyOnce(mid, p + mid + mm + '.' + QQ_EXT[p], cred);
        ok = !!(r.purl && r.purl.trim());
        if (!ok) reason = 'QQ 回 result=' + r.rresult + '（无权限 / 该档没有）';
      } catch (e) { reason = humane(e, '取不到'); }
    }
    out.push({
      q: QQ_QLABEL[p], label, ok, ext: QQ_EXT[p],
      bitRate: p === 'M800' ? 320000 : (p === 'M500' ? 128000 : (p === 'C400' ? 96000 : 0)),
      size: sz, sizeText: sz ? fmtSize(sz) : '', quality: label, reason
    });
  }
  return out;
}

/* 探活曲：《稻香》绿钻专属，未登录必 104003。
   四档全挂 = 凭证失效；只到 320K = 权益降级；出 FLAC = 正常。 */
const QQ_PROBE_MID = '003aAYrm3GE0Ac';
const QQ_PROBE_NAME = '周杰伦《稻香》';

async function qqProbe(cred) {
  const c = cred === undefined ? qqCred() : cred;
  if (!c) {
    return { ok: false, level: 'critical', levels: [],
      message: '还没有 QQ 登录凭证 —— 会员曲会掉到别家翻唱，或干脆没有音源' };
  }
  if (!qqHasKey(c.cookie)) {
    return { ok: false, level: 'critical', levels: [],
      message: 'cookie 里没有 qqmusic_key —— 这条凭证通不过 vkey，等于没登录' };
  }
  const det = await qqDetail(QQ_PROBE_MID).catch(() => null);
  const mm = (det && det.mediaMid) || '0020wJDo3cx0j3';
  const levels = [];
  for (const p of ['RS01', 'F000', 'M800', 'M500']) {
    let rresult = 0, purl = '';
    try {
      const r = await qqVkeyOnce(QQ_PROBE_MID, p + QQ_PROBE_MID + mm + '.' + QQ_EXT[p], c);
      purl = String(r.purl || '').trim();
      rresult = r.rresult;
    } catch { /* 记成不可用 */ }
    const sz = (det && det.size && det.size[p]) || 0;
    /* 有 purl 不等于能下：Hi-Res 这档 QQ 常给一条假直链（实测 HEAD 404），
       而元数据 size=0 正好能识别 —— 所以「有直链」且「这档有货」才算可用。 */
    const ok = !!purl && sz > 0;
    levels.push({ p, ok, rresult, size: sz,
      reason: ok ? '' : (purl ? '有直链但该曲没有这一档' : 'QQ 回 result=' + rresult) });
  }
  const top = levels.find(x => x.ok);
  if (!top) {
    return { ok: false, level: 'critical', levels,
      message: '凭证无效：连 128K 都取不到（QQ 一律回 104003）。会员曲已断，需要重新扫码' };
  }
  const st = top.size ? ' / ' + fmtSize(top.size) : '';
  if (top.p === 'RS01') return { ok: true, level: 'ok', levels, message: '正常：' + QQ_PROBE_NAME + ' 拿到 Hi-Res' + st };
  if (top.p === 'F000') return { ok: true, level: 'ok', levels, message: '正常：' + QQ_PROBE_NAME + ' 拿到无损' + st };
  if (top.p === 'M800') {
    return { ok: false, level: 'warn', levels,
      message: '凭证有效，但只给到 320K（绿钻无损应给 FLAC）—— 会员权益可能已到期或降级' + st };
  }
  return { ok: false, level: 'warn', levels, message: '只给到 128K，等于未登录 —— 绿钻权益已失效' };
}

/* ---- 扫码换证 ----
 * QQ 这套和酷狗不同：ptlogin2 给的是 QQ 账号的登录跳转，跟着 302 把 cookie 收齐后，
 * 还要在 y.qq.com 上走一步才种下 qqmusic_key（音乐站自己的 key）。
 * qrsig 必须留在服务端，前端只拿一个不透明的 id。 */
const QQ_QR = new Map();
const QQ_QR_TTL = 5 * 60 * 1000;
const QQ_QR_APP = 'appid=716027609&e=2&l=M&s=3&d=72&v=4&daid=383&pt_3rd_aid=100497308';

function qqHash33(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h += (h << 5) + s.charCodeAt(i);
  return h & 0x7fffffff;
}

function qqQrClean() {
  const now = Date.now();
  for (const [k, v] of QQ_QR) if (now - v.at > QQ_QR_TTL) QQ_QR.delete(k);
}

/** 手动跟 302 链收 Set-Cookie（fetch 的 follow 会把中间响应头吞掉，这里必须自己走） */
async function qqFollow(url, jar, ua, maxHops) {
  let cur = url, hops = 0;
  const ck = () => Array.from(jar.entries()).map(([k, v]) => k + '=' + v).join('; ');
  while (cur && hops < (maxHops || 10)) {
    hops++;
    let r;
    try {
      r = await fetch(cur, {
        redirect: 'manual',
        headers: { 'User-Agent': ua, Cookie: ck(), Referer: 'https://y.qq.com/' }
      });
    } catch { break; }
    let list = [];
    try { list = r.headers.getSetCookie ? r.headers.getSetCookie() : []; } catch { list = []; }
    for (const sc of list) {
      const kv = String(sc).split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) {
      try { cur = new URL(loc, cur).toString(); } catch { break; }
      continue;
    }
    break;
  }
  return jar;
}

/** 扫码成功后：把 cookie 收齐 + 抠出 uin / 昵称 */
async function qqTakeover(startUrl, ua) {
  const jar = new Map();
  await qqFollow(startUrl, jar, ua, 10);
  if (!jar.get('qqmusic_key') && !jar.get('qm_keyst')) {
    /* 只过了 QQ 登录、还没进音乐站。挨个把音乐站的入口敲一遍，
       哪个把 qqmusic_key 吐出来就用哪个（不同账号/不同安全等级走的路径不一样）。 */
    for (const u of ['https://y.qq.com/portal/profile.html', 'https://y.qq.com/',
      'https://y.qq.com/n/yqq/portal/profile.html', 'https://y.qq.com/n/yqq/portal/player.html']) {
      await qqFollow(u, jar, ua, 6);
      if (jar.get('qqmusic_key') || jar.get('qm_keyst')) break;
    }
  }
  const cookie = Array.from(jar.entries()).map(([k, v]) => k + '=' + v).join('; ');
  const uin = String(jar.get('uin') || jar.get('ptui_loginuin') || '').replace(/^o/i, '');
  const key = jar.get('qqmusic_key') || jar.get('qm_keyst') || '';
  let nickname = '';
  if (uin) {
    try {
      const p = await getJSON('https://c.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg?cid=205360838&userid=' +
        encodeURIComponent(uin) + '&reqfrom=1&reqtype=0', { headers: { ...QQ_H, Cookie: cookie }, tries: 1, timeout: 8000 });
      nickname = String(p?.data?.creator?.nick || p?.data?.creator?.name || '');
    } catch { /* 昵称只是展示用 */ }
  }
  return { cookie, uin, key, nickname };
}

async function apiQQLyric(songmid) {
  const raw = await getText(`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${songmid}&format=json&nobase64=1&g_tk=5381`, { headers: { ...QQ_H, Referer: 'https://y.qq.com/portal/player.html' } });
  let j; try { j = JSON.parse(raw.replace(/^MusicJsonCallback\(|\);?$/g, '')); } catch { return null; }
  const lrc = j?.lyric ? String(j.lyric).replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/<br>/g, '\n') : '';
  return lrc ? { lrc, title: '', artist: '' } : null;
}

/* ---------------- B站音频（JS 逆向：WBI 签名） ----------------
 * 为什么值得做：酷我 / 咪咕匿名只给 30 秒片段（已实测），而 B站 音乐区
 * 有大量完整上传，且 DASH 音频流匿名可取。这是"全覆盖"里真正有效的一块。
 *
 * WBI 签名（逆向所得，等价于站点 JS 里的 encWbi）：
 *   1. 从 x/web-interface/nav 取 img_key / sub_key（各 32 位）
 *   2. raw = img_key + sub_key（64 位）
 *   3. mixin_key = 按固定重排表 mixinKeyEncTab 取字符后截前 32 位
 *   4. 参数加 wts（秒级时间戳）→ key 升序 → urlencode → w_rid = MD5(query + mixin_key)
 * 另需匿名凭证 buvid3/buvid4（x/frontend/finger/spi 领取，无需登录）。
 *
 * 取音频：search → bvid → view 取 cid → playurl(fnval=16) 取 dash.audio
 *        → 选带宽最高的一轨（m4a / mp4a.40.2）
 * 边界：只取匿名可播的公开投稿音频；会员/付费影片（dash 为空）如实拒绝。
 * ------------------------------------------------------------ */
const BILI_H = { 'User-Agent': UA_PC, Referer: 'https://www.bilibili.com/' };
const biliImg = u => u ? (/^\/\//.test(u) ? 'https:' + u : String(u).replace(/^http:\/\//i, 'https://')) : '';

const mixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];
const getMixinKey = raw => mixinKeyEncTab.map(i => raw[i]).join('').slice(0, 32);
const encWbi = params => Object.keys(params).sort().map(k =>
  `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]).replace(/[!'()*]/g, ''))}`
).join('&');

/* 匿名凭证 + WBI 密钥（30 分钟缓存，避免每次搜索都握手）。

   ⚠️⚠️ 复跑/对拍前必读：这份 cookie 是**每实例各领一份**的。
   buvid3/buvid4 是进程启动时向 /x/frontend/finger/spi 现场领的，落在 BILI_CTX 里
   30 分钟不换 —— 所以**两个实例就是两个不同的 buvid**，而 B站搜索的**结果顺序会
   随 buvid 变化**。这意味着：

       拿「A 实例自己搜出来的条目」跟「B 实例自己搜出来的条目」直接比对 ——
       **结论是假的**，你看到的差异很可能只是两边排第一的不是同一个视频。

   已经在这个坑上摔过两次（都是同一轮回归里出的假结论）：
     · 成都：一个实例的 B站首条是 `…成都3日｜芽腿vlog257`（vlog，不是歌），
       另一个是 `成都/赵雷`。看着像「改后退化」，其实是排序不同。
     · 孤勇者：一度报成「改前中、改后不中」。把**同一个条目**喂给两边各打 4 次，
       两边都是 4/4 中 —— 真正的变量是酷狗那条关键词时有时无，跟代码无关。

   正确姿势：**条目只取一次，把歌名和歌手固定下来，再喂给两个实例比。**
   差异要能复现才算数；一次性的差异先怀疑样本，别急着怀疑代码。

   同理，别拿「半死的实例」当对照组：有一轮某个实例已经在对 3 个关键词返回空响应
   （连 ok 字段都没有），那一轮跑出来的 83% 是测量故障，不是基线 ——
   **错误的基线比没有基线更危险**，它会让人以为「有对照」，实际对照是假的。
   要改前数据就重开一个纯净实例。 */
let BILI_CTX = null;
async function biliCtx() {
  if (BILI_CTX && Date.now() - BILI_CTX.ts < 1800_000) return BILI_CTX;
  const spi = await getJSON('https://api.bilibili.com/x/frontend/finger/spi', { headers: BILI_H, tries: 2, timeout: 10000 });
  const cookie = `buvid3=${spi?.data?.b_3 || ''}; buvid4=${spi?.data?.b_4 || ''}`;
  const nav = await getJSON('https://api.bilibili.com/x/web-interface/nav', { headers: { ...BILI_H, Cookie: cookie }, tries: 2, timeout: 10000 });
  const iu = nav?.data?.wbi_img?.img_url || '', su = nav?.data?.wbi_img?.sub_url || '';
  const imgKey = iu.slice(iu.lastIndexOf('/') + 1).split('.')[0];
  const subKey = su.slice(su.lastIndexOf('/') + 1).split('.')[0];
  BILI_CTX = { cookie, mixinKey: getMixinKey(imgKey + subKey), imgKey, subKey, ts: Date.now() };
  return BILI_CTX;
}

/** "4:30" / "1:02:11" → 秒 */
const biliDur = s => {
  const p = String(s || '').split(':').map(Number);
  if (!p.length || p.some(n => !Number.isFinite(n))) return 0;
  return p.reduce((a, b) => a * 60 + b, 0);
};

/* 括号成对表：书名号 + 圆括号 + 方括号 + 中文引号，配平判定与整对删除都用它 */
const BRACKET_PAIRS = [['（', '）'], ['(', ')'], ['【', '】'], ['[', ']'], ['《', '》'], ['「', '」'], ['『', '』']];

/* 取**最外层**那一对《…》之间内容，按括号深度配对找收尾的 》，不是「第一个 」。
   畸形串（有《没》、或者《》顺序颠倒）一律返回 null，交给调用方的兜底逻辑。
   返回 null 而不是空串，是为了跟「《》里确实没内容」区分开。 */
function sliceBookTitle(t) {
  var i = t.indexOf('《');
  if (i < 0) return null;
  var depth = 0, j = i;
  for (; j < t.length; j++) {
    var c = t.charAt(j);
    if (c === '《') depth++;
    else if (c === '》') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) return null;          // 没配平：只有半个书名号
  return t.slice(i + 1, j);
}

/* 括号是否都配平（成对计数，只看数量相等） */
function bracketsBalanced(s) {
  var pairs = BRACKET_PAIRS;
  for (var i = 0; i < pairs.length; i++) {
    var a = 0, b = 0, k = 0;
    for (; k < s.length; k++) {
      if (s.charAt(k) === pairs[i][0]) a++;
      else if (s.charAt(k) === pairs[i][1]) b++;
    }
    if (a !== b) return false;
  }
  return true;
}

/* 某一对括号没配平时，把这一对**整对删掉**（不是删半个）。
   「《《夏至未至》」→ 《2 》1 不配平 → 两个字符全删 →「夏至未至」，还能用；
   只删多出来的那个《 会得到「《夏至未至》，还是残的。 */
function dropUnpairedBrackets(s) {
  for (var i = 0; i < BRACKET_PAIRS.length; i++) {
    var a = 0, b = 0, k = 0;
    for (; k < s.length; k++) {
      if (s.charAt(k) === BRACKET_PAIRS[i][0]) a++;
      else if (s.charAt(k) === BRACKET_PAIRS[i][1]) b++;
    }
    if (a !== b) s = s.split(BRACKET_PAIRS[i][0]).join('').split(BRACKET_PAIRS[i][1]).join('');
  }
  return s.trim();
}
/* 剥掉书名号内容里的括号噪声：先反复剥配对的（…），再砍掉尾部没配平的半截。
   例：「追光者（《夏至未至》插曲）」→ 剥内层《夏至未至》→「追光者（插曲）」
       → 再剥（插曲）→「追光者」 */
function stripBracketNoise(s) {
  var prev;
  do {
    prev = s;
    s = s.replace(/[（(【\[《][^（(【\[《）)\]】》]*[）)\]】》]/g, '');
  } while (s !== prev);
  s = s.replace(/[（(【\[《][^）)\]】》]*$/, '');
  return s.trim();
}

/** 从视频标题里尽量抽出「歌名」：优先取《》里的内容，否则清理掉装饰性符号
 *
 * 🔴 为什么取书名号要按**最外层**配对，而不是「第一个 」就收：
 *    B站标题里套书名号很常见 ——
 *      「岑宁儿《追光者（《夏至未至》插曲）》百万豪装录音棚大声听」
 *    老的 `/《([^》]{1,40})》/` 会在**内层**那个 》 上收尾，产出
 *    「追光者（《夏至未至」—— 带一个**没闭合的左括号**。
 *    而下游 `lyricName()` / `lyricNorm()` 的去括号正则**要求有右括号才生效**，
 *    这段残括号砍不掉，于是「向酷狗补真歌手」那一步的精确匹配也命中不了
 *    （实测：这个名字 `/api/lyric?src=bili` → ok=false；手改成纯「追光者」→
 *    ok=true，追光者/岑宁儿，230s，104 分，47 行）。
 *
 *    那为什么不干脆**取最内层**？因为内层常常是空的或不是歌名：
 *      《XX（Live）》 → 内层没有书名号，取内层会退化成空；
 *      《追光者（《夏至未至》插曲）》 → 内层是「夏至未至」，那是**电视剧名不是歌名**。
 *    所以只能取最外层，再把里面的（…）连同没配平的半截一起剥掉。
 *
 * ⚠️ 判据：产出的歌名里**不许出现未配平的括号**（bracketsBalanced）。剥完之后
 *    不足 2 个字、或者还有残括号，就**不要这个结果**，退回下面那套兜底 ——
 *    宁可拿一个带装饰词的原名，也不要拿一个砍残的名字去搜（搜不到 = 整首没词）。 */
function biliTitleToSong(raw) {
  const t = String(raw || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
  var inner = sliceBookTitle(t);
  if (inner != null) {
    var s = stripBracketNoise(inner).slice(0, 48);
    if (s.length >= 2 && bracketsBalanced(s)) return s;
  }
  /* 兜底这条路同样可能撞上畸形标题：上面那个替换表里**没有《》**，所以
     「《《夏至未至》」这种只有半个书名号的输入会原样把《》留下来。按同一条
     判据再过一遍 dropUnpairedBrackets（整对删），删空了就还是用清理后的原名 ——
     宁可返回一个带括号的原名，也不返回空串（空歌名会让列表行整个空白）。 */
  var out = t
    /* 🔴 `live` 的**括号形态**必须放在下面那句「括号一律换成空格」**之前** ——
       那句一跑，`[Live]` 就变成了 ` Live`，形态没了，这条永远匹配不上
       （第一次写就是放在后面，实测 `稻香 [Live]` 改后变成 `稻香 Live`，没剥掉）。 */
    .replace(/[（(\[【]\s*live\s*(?:版本?)?\s*[)）\]】]/gi, ' ')
    .replace(/[【】\[\]（）()「」『』]/g, ' ')
    /* 🔴 剥杂音词必须**拆成两组**，不能一刀切：
       · 英文/数字组（4K/8K/1080P/60FPS/Hi-Res/MV/KTV）**保留 \b** —— 这组用
         单词边界本来就是对的；去掉反而误伤（英文歌名里含 "mv" 两个字母的会被剥掉）。
         ⚠️ `live` **不在这组**，它有两副面孔，见下面单独那两条。
       · 纯中文组（无损/高音质/伴奏/完整版/单曲循环/纯享/现场/音质）**必须去掉 \b** ——
         \b 是**单词边界**，只在 [A-Za-z0-9_] 与非单词字符之间成立；中文前后都是中文，
         边界永远不成立 → 这些词一个都剥不掉。
         实测（同一首歌、同一 UP、同一时长，只改歌名）：
           丑八怪 '丑八怪-薛之谦 | 无损音质' → 未命中（整首取不到词）
                  '丑八怪-薛之谦'           → 薛之谦/丑八怪 67.3 分 ✅
       ⚠️ 去掉 \b 的代价（想清楚才删的，别当随手改回去）：中文组变成**直接子串匹配**，
         如果某首歌名**本身**叫《现场》或《无损》，会被误剥。判断是「歌名正好叫这个」
         的概率远低于「标题被污染」的概率，净收益为正，所以保留这个权衡。
       ⚠️ 期望值别夸大：这条只能救「纯音质词污染」那一类。标题里混了 #话题标签、
         8D环绕、整句歌词碎片的，剥完还是不中 —— 那是《》优先策略失效后整句兜底的
         更深一层问题，本单不做。对外口径是「改善，不是根治」。 */
    /* 🔴 「版本词 + 版/版本」这条必须放在**裸词那条之前** —— `|` 是顺序匹配，
       裸词 `KTV` 先吃掉 `KTV版` 里的 KTV，剩下的「版」就孤零零留下了，
       而一个孤立的「版」字足以让歌词召回归零（见下面「版」那条注释）。 */
    .replace(/\b(4K|8K|1080P|60FPS|Hi-?Res|MV|KTV)\s*版本?/gi, ' ')
    .replace(/\b(4K|8K|1080P|60FPS|Hi-?Res|MV|KTV)\b/gi, ' ')
    /* 🔴 `live` 单独一条，只按**版本标记**的形态剥，不当通用杂音词。
       为什么它不能跟 4K/MV/KTV 待在一起 —— 有两副面孔，一刀切必错一头：
         · 版本标记：`[Live]` / `（Live）` / `Live版` / `（Live版）` → 该剥
         · 歌名的一部分：`Live Forever`、`Live Your Life`、`Live While We're Young`
                         → 剥了歌名就残了（`Live Forever` → `Forever`）
       实测（8899 旧实例与 18942 新实例输出**逐字相同** → 这是**既有 bug**，
       不是 ac7a209 那次中文组去 \b 引入的回归）：
         Avicii - Live Your Life (feat. Afrojack) → Avicii - Your Life feat. Afrojack
         Live Forever                             → Forever
       影响面（**这条定性改过，别按 1804b16 提交信息里那句理解**）：
       那一版写成「只影响显示、取词没扩散」是**错的**。真实收益在**中文取词** ——
       `（Live版）` 这种标题改前会留一个孤立的「版」，而孤立的「版」会让召回归零；
       改后拿到干净歌名，实测 5/5 首从不中变中（海阔天空 / 稻香 / 起风了 / 红豆 / 十年）。
       英文歌名那半（`Live Forever`）确实只影响显示：英文歌在酷狗这条链路上命中率
       本来就低（实测 2/12），剥不剥多半一个样，但那不是不修的理由。
       ⚠️ 后人若要回滚 1804b16，请按**取词**影响评估，不是按显示影响。
       ⚠️ 别用「去掉 \b」来修：那会走到另一个错 —— `Livelihood` / `Olivia` /
       `Deliver` 里的 "live" 会被当成杂音剥掉。两头都不安全的题，只能按形态分。
       括号形态那条在上面（必须在括号统一清理之前），这条管不带括号的 `Live版`。 */
    .replace(/\blive\s*版本?/gi, ' ')
    /* 中文组里 `现场版` 必须排在 `现场` **前面**（同样是顺序匹配：短的在前会先吃掉）。
       完整版 / 伴奏 / 纯享 / 单曲循环 后面不跟「版」，不受影响。 */
    .replace(/(无损|高音质|音质|伴奏|完整版|单曲循环|纯享|现场版|现场)/g, ' ')
    /* 🔴 清掉**孤立**的「版」/「版本」—— 这是什么鬼东西都要清的原因：
       上面几条剥完之后，标题里会剩一个光秃秃的「版」（`稻香（现场版）` →
       `稻香 版`），而**一个孤立的「版」字就能让歌词召回归零**。实测（src=bili、
       force=1，同一个实例同一首歌，只改 name）：
           '海阔天空 版' ❌  →  '海阔天空' ✅ 首句「今天我寒夜里看雪飘过」
           '稻香 版'     ❌  →  '稻香'     ✅ 首句「对这个世界如果你有太多的抱怨」
       只删**独立成 token** 的（前后是空白/串首尾），不做子串匹配 ——
       所以《版本号》这种歌名里的「版」不会被动（它是一个词的一部分，不是 token）。
       边缘：真有首歌**正好叫**《版》会被清成空串，但下面 `|| t.slice(0,48)`
       会退回原名，不会返回空歌名（空歌名会让列表行整个空白）。 */
    .replace(/(^|\s)版本?(?=\s|$)/g, ' ')
    /* 杂音词常在标题**尾部**（「丑八怪-薛之谦 | 无损音质」），剥完之后会剩下一个
       光秃秃的分隔符「丑八怪-薛之谦 |」。带着它去搜一样搜不到，所以砍掉尾部的
       分隔符。⚠️ 只砍**尾部**，中间的「-」要留 —— 那是「歌手-歌名」的一部分。 */
    .replace(/[\s|·、，,;；:：]+$/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 48) || t.slice(0, 48);
  var clean = dropUnpairedBrackets(out);
  return clean || out;
}

async function apiBiliSearch(kw, page, size) {
  const { cookie, mixinKey } = await biliCtx();
  const p = { search_type: 'video', keyword: kw, page, page_size: Math.min(50, size), order: 'totalrank' };
  const wts = Math.floor(Date.now() / 1000);
  const signed = encWbi({ ...p, wts });
  const url = `https://api.bilibili.com/x/web-interface/wbi/search/type?${signed}&w_rid=${md5(signed + mixinKey)}`;
  const j = await getJSON(url, { headers: { ...BILI_H, Cookie: cookie }, tries: 2, timeout: 15000 });
  if (j.code !== 0) throw new Error('B站搜索 code=' + j.code + ' ' + (j.message || ''));
  const arr = j?.data?.result || [];
  return {
    total: j?.data?.numResults || arr.length,
    list: arr.filter(v => v.bvid).map(v => {
      const raw = String(v.title || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
      const dur = biliDur(v.duration);
      return {
        source: 'bili', sourceName: 'B站',
        id: v.bvid,
        songname: biliTitleToSong(raw),
        singer: v.author || '',                 // 这里是 UP 主，不是原唱；匹配时用 title 兜
        album: '',
        albumId: '',
        title: raw,                             // 原始标题：换源匹配时用来找「歌手名是否出现在标题里」
        duration: dur, durationText: fmtDur(dur),
        sizeText: '',
        vip: false,
        hints: ['B站', '完整'],
        cover: biliImg(v.pic)
      };
    })
  };
}

/* ══════════════════════════════════════════════════════════════
   MV（第 9 期）
   ──────────────────────────────────────────────────────────────
   业主：「每个歌曲的 MV 的提取播放，下载也要记录待办」「MV能下载，能听，搞好」。

   §上游现实（都实测过，不是猜的）：
     · 酷狗有 MV 元数据：`mobiles.kugou.com/api/v3/mv/detail?mvhash=` ——
       标题、歌手、时长(mv_timelength 毫秒)、高清竖版封面(imgurl/erect_hdpic)、
       video_id、tags 都有，**唯独没有播放地址**（`mkv_sd_hash` 也只是个 file hash）。
       `trackercdn` 拿它换地址 → `{"error":"Hash not found"}`（那是音频库）；
       `mobilemv.kugou.com/.../mv_android.php` → 空响应（要 App 端签名）。
       所以酷狗这条**只做「有 MV」的事实与封面**，不假装能给流。
     · B站**能真出片**：`apiBiliResolve(id, dur, {mv:true})` 拿的是
       音视频一体的 MP4（durl），一个 <video> 就有画面有声音，下载也能直接用。
     · B站 MV 搜索：`apiBiliSearch` 现成，500 条量级。

   §所以链路是：给一首歌 → 先用酷狗 mvhash 确认「这首歌确实有官方 MV」并拿到
     权威时长/封面 → 再按「歌手 + 歌名」去 B站找最匹配的那条 → 播放/下载走 B站。
     这样用户点「看 MV」永远有东西可看，而不是在酷狗那条死路上等一个空地址。

   §为什么不直接搜 B站：单搜 B站会把「翻唱」「钢琴版」「reaction」排上来，
     和"这首歌的 MV"不是一回事。用酷狗 MV 的**权威时长**做锚点排序，
     匹配质量差一个量级 —— 官摄 MV 时长和 mv_timelength 几乎一致，
     而翻唱/片段会对不上。
   ══════════════════════════════════════════════════════════════ */

/** MV 候选打分：判断「这条 B站视频是不是这首歌的 MV」
 *
 *  @param list   apiBiliSearch 的结果（带 title / duration）
 *  @param name   歌名
 *  @param singer 歌手
 *  @param dur    参考时长（优先用酷狗 mv_timelength，其次是音频时长）
 */
function rankMvCandidates(list, name, singer, dur) {
  const nm = normKey(name);
  const sgParts = String(singer || '').split('/').map(x => normKey(x)).filter(Boolean);
  const ref = Number(dur) || 0;

  /* 单条打分。strict = 歌手也必须是硬门槛（第 22 期）。
     以前只按「歌名子串」认，搜「晴天」会把别的歌一起放进来 ——
     实测 B站第 4 条是《只给予你的晴天》(ヨルシカ)，歌名里含「晴天」三个字
     就算命中，用户点开看到的是完全另一首歌，这就是「MV 拿取错乱」。
     现在：歌名必须出现；歌手给了就必须也出现（标题或 UP 主名里）。 */
  const score = (v, strict) => {
    const t = normKey(String(v.title || '') + ' ' + String(v.songname || '') + ' ' + String(v.singer || ''));
    if (!nm || t.indexOf(nm) < 0) return -99;
    const sgHit = sgParts.length ? sgParts.some(x => t.indexOf(x) >= 0) : true;
    if (strict && sgParts.length && !sgHit) return -99;
    let s = 4;
    if (sgParts.length && sgHit) s += 3;
    /* 官方/高清这类词是强信号：MV 上传者几乎都会写 */
    if (/mv|官方|1080|2160|4k|高清|修复|画质/.test(t)) s += 1.5;
    /* 时长锚点：MV 比纯音频长（前奏/尾奏/剧情），容差 ±45s；
       差超过 90s 基本是别的片子（剪辑/合集/live 全场） */
    if (ref > 0) {
      const d = Math.abs((Number(v.duration) || 0) - ref);
      if (d <= 12) s += 4;
      else if (d <= 45) s += 2.5;
      else if (d <= 90) s += 0.5;
      else s -= 3;
    }
    /* 明显不是 MV 的形态：直接压下去。remix / mashup 是「二创」不是原片，
       但也不删 —— 有人就爱听 Remix，压到列表尾巴由他自己挑。 */
    if (/reaction|教学|教程|钢琴|吉他|尤克里里|翻唱|合辑|合集|串烧/.test(t)) s -= 5;
    /* 伴奏 / KTV / 消音版不是「原片」：业主点看 MV 不是来听伴奏的。
       重罚到出局（-9），只在实在没有别的候选时才由 fallback 兜回来。 */
    if (/伴奏|ktv|纯音乐|instrumental|消音|纯享/.test(t)) s -= 9;
    if (/mashup|remix|混音|串烧|剪辑版|加速|慢速|八音盒|dj|翻自|cover/.test(t)) s -= 7;
    /* 业主点「看 MV」要的是原片：现场/饭制排后面，保留但不推荐 */
    if (/现场|live|演唱会|音乐节|饭制|自制|混剪|粉丝/.test(t)) s -= 2.5;
    return s;
  };

  const pick = strict => (list || [])
    .map(v => ({ v, s: score(v, strict) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 8)
    .map(x => x.v);

  /* 严格口径（歌名 + 歌手都在）优先；一条都没有时退回只卡歌名 ——
     宁可给一组「可能对」的候选，也不要让这首歌连入口都没有。 */
  const strict = pick(true);
  return strict.length ? strict : pick(false);
}

/**
 * 找一首歌的 MV。
 *
 * @param {object} o  { name, singer, mvhash, duration }
 * @returns {{ok:boolean, kugou:object|null, list:Array, note:string}}
 */
async function apiMvFind(o) {
  const name = String(o.name || '').trim();
  const singer = String(o.singer || '').trim();
  const mvhash = String(o.mvhash || '').trim();
  let refDur = Number(o.duration) || 0;

  const out = { ok: true, kugou: null, list: [], note: '' };

  /* ── ① 酷狗 MV 元数据：确认「官方 MV 存在」并拿到权威时长/高清封面 ── */
  if (mvhash) {
    try {
      const j = await getJSON(
        `https://mobiles.kugou.com/api/v3/mv/detail?mvhash=${encodeURIComponent(mvhash)}&format=json`,
        { tries: 1, timeout: 10000 });
      const i = j && j.data && j.data.info;
      if (i) {
        const sec = Math.round((Number(i.mv_timelength) || 0) / 1000);
        /* imgurl 里 {size} 是占位符：240/400/800 都试过，800 是最清楚的一档；
           竖版 erect_hdpic 优先（跟大厂 MV 卡片的构图一致），退回横版。 */
        const cv = String(i.erect_hdpic || i.imgurl || '').replace(/\{size\}/g, '800');
        out.kugou = {
          hash: String(i.hash || mvhash),
          name: String(i.videoname || name),
          singer: String(i.singername || singer),
          duration: sec,
          cover: cv ? cv.replace(/^http:\/\//i, 'https://') : '',
          videoId: Number(i.video_id) || 0,
          tags: (i.tags || []).map(t => t && t.tag_name).filter(Boolean).slice(0, 4),
          /* ⚠️ 恒空：酷狗 MV 播放地址要 App 端签名，Web 抓不到。
             留这个字段是为了让前端只看一个地方就能判断"能不能直接播"，
             不必再自己写一套 mvhash 的判断。 */
          playUrl: ''
        };
        if (sec > 0) refDur = sec;         // 有官方时长就以它为准
      }
    } catch (e) { /* 没有 MV 或接口抽风：不影响下面 B站的兜底 */ }
  }

  /* ── ② B站按「歌手 + 歌名」找最匹配的一条 ── */
  const kw = [singer, name, 'MV'].filter(Boolean).join(' ').trim();
  if (kw) {
    try {
      const r = await apiBiliSearch(kw, 1, 20);
      out.list = rankMvCandidates(r.list, name, singer, refDur);
    } catch (e) {
      out.note = 'B站搜索失败：' + humane(e, '稍后再试');
    }
  }

  /* note 是给用户看的一句话：说清「为什么这里没有酷狗原片」 */
  if (!out.list.length) {
    out.note = out.kugou
      ? '这首歌有官方 MV，但酷狗的视频地址要 App 端签名才能拿到，B站也没找到对得上的版本。'
      : '没找到这首歌的 MV。';
  } else if (out.kugou && !out.kugou.playUrl) {
    out.note = '官方 MV 信息在，播放走 B站同版本（酷狗原片地址需要 App 签名，网页拿不到）。';
  }
  return out;
}

/** MV 搜同平台补 id 时的命中校验（第 14 期）：
 *  歌名去空格后全等 + 歌手有交集，两条都过才算「同一首歌」——
 *  搜「晴天」拿成翻唱版的 MV 比没有 MV 更糟。 */
function mvSongHit(x, name, singer) {
  const squash = s => String(s || '').replace(/[\s　]/g, '').toLowerCase();
  if (squash(x.songname) !== squash(name)) return false;
  const a = squash(x.singer), b = squash(singer);
  if (!a || !b) return true;   // 一边没给歌手就不卡（歌名已全等）
  if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return true;
  return a.split('/').some(p => p && b.indexOf(p) >= 0);
}

/** 官方 MV 直链（第 14 期）：不再只拿 B 站匹配充数。
 *  三条路全部 2026-10-24 实测通过（免登录、公开接口）：
 *    酷狗  m.kugou.com/app/i/mv.php?cmd=100&hash=<mvhash>
 *          → mvdata.{sq,le,rq}.downurl / backupdownurl[0]
 *          （地址路径带时效段，必须现取现用，不能缓存）
 *    网易  music.163.com/api/song/enhance/play/mv/url?id=<mvid>&r=1080
 *          → data.url（旧接口 /api/mv/url 已 404，勿回退）
 *    QQ    vv.video.qq.com/getinfo?vids=<vid>&defn=shd&otype=json
 *          → 返回 JSONP「QZOutputJson={...};」，剥壳后
 *            vl.vi[0]: ul.ui[0].url + fn + '?vkey=' + fvkey
 *  id 缺省时按「歌名+歌手」在本平台搜一条补上（榜单/歌单/收藏里的老数据
 *  没有 MV 字段），校验过 mvSongHit 才算数；对不上就回 notfound，
 *  前端自动退回 /api/mv/find 的 B 站兜底。 */
async function apiMvUrl(o) {
  const src = String(o.src || '').toLowerCase();
  let id = String(o.id || '').trim();
  const name = String(o.name || '').trim();
  const singer = String(o.singer || '').trim();

  /* ① 缺 id：本平台搜一条补上 */
  if (!id && name) {
    const kw = singer ? singer + ' ' + name : name;
    try {
      if (src === 'kugou') {
        const r = await apiSongSearch(kw, 1, 8);
        const hit = (r.list || []).find(x => x.mvhash && mvSongHit(x, name, singer));
        if (hit) id = hit.mvhash;
      } else if (src === 'netease') {
        const r = await apiNeteaseSearch(kw, 1, 8);
        const hit = (r.list || []).find(x => x.mvid && mvSongHit(x, name, singer));
        if (hit) id = String(hit.mvid);
      } else if (src === 'qq') {
        const r = await apiQQSearch(kw, 1, 8);
        const hit = (r.list || []).find(x => x.mvid && mvSongHit(x, name, singer));
        if (hit) id = hit.mvid;
      }
    } catch (e) { /* 搜不到就落空，让前端走 B 站兜底 */ }
  }
  if (!id) return { ok: false, error: 'notfound' };

  /* ② 按平台取直链 */
  if (src === 'kugou') {
    const j = await getJSON('https://m.kugou.com/app/i/mv.php?cmd=100&hash=' +
      encodeURIComponent(id) + '&ismp3=0&ext=mp4', { tries: 2, timeout: 10000 });
    const md = (j && j.mvdata) || {};
    /* 选档（第 20 期业主拍板「提取源要画质最强」）：rq(蓝光~164MB) 优先，
       sq(高清~85MB) 其次，le(流畅~21MB) 兜底。卡顿由前端自愈兜底：
       30 秒内卡 3 次自动换下一个源（见 index.html mvWatchBind）。 */
    for (const k of ['rq', 'sq', 'le']) {
      const d = md[k];
      const u = d && (d.downurl || (Array.isArray(d.backupdownurl) && d.backupdownurl[0]) || '');
      if (u) return {
        ok: true, url: u, ext: 'mp4', official: 'kugou',
        quality: k === 'sq' ? '高清' : (k === 'le' ? '流畅' : '蓝光'),
        size: Number(d.filesize) || 0
      };
    }
    return { ok: false, error: 'notfound' };
  }
  if (src === 'netease') {
    for (const r of [1080, 720, 480]) {
      try {
        const j = await getJSON('https://music.163.com/api/song/enhance/play/mv/url?id=' +
          encodeURIComponent(id) + '&r=' + r, { headers: NE_H, tries: 1, timeout: 10000 });
        const u = j && j.data && j.data.url;
        if (u) return {
          ok: true, url: u, ext: 'mp4', official: 'netease',
          quality: r + 'P', size: Number(j.data.size) || 0
        };
      } catch (e) { /* 降档再试 */ }
    }
    return { ok: false, error: 'notfound' };
  }
  if (src === 'qq') {
    /* 第 20 期：fhd(1080P) 优先，逐级降档。画质以**请求到的档**标注。 */
    for (const dn of ['fhd', 'shd', 'hd', 'sd']) {
      try {
        const raw = await getText('https://vv.video.qq.com/getinfo?vids=' +
          encodeURIComponent(id) + '&platform=11001&charge=0&otype=json&defn=' + dn,
          { headers: { ...QQ_H, Referer: 'https://y.qq.com/' }, timeout: 10000 });
        const t = String(raw || '').replace(/^QZOutputJson=/, '').replace(/;\s*$/, '');
        const info = JSON.parse(t);
        const vi = info && info.vl && info.vl.vi && info.vl.vi[0];
        if (vi && vi.fvkey && vi.fn && vi.ul && vi.ul.ui && vi.ul.ui.length) {
          /* ⚠️ ui 里多数是 IP 形式（http://39.156.8.131/music.qqvideo.tc.qq.com/...），
             而 /api/proxy 的 SSRF 白名单按**域名后缀**判（U-44），IP 形式会被拒。
             每组都带一条域名项（video.dispatch.tc.qq.com），优先挑它；
             全是 IP 才退第一条（那种情况会在代理层被拦，前端自动落 B 站兜底）。 */
          const ui = vi.ul.ui;
          const dom = ui.find(x => {
            try { return /(^|\.)qq\.com$/i.test(new URL(x.url).hostname); } catch (e) { return false; }
          }) || ui[0];
          if (dom && dom.url) {
            return {
              ok: true, url: dom.url + vi.fn + '?vkey=' + vi.fvkey,
              ext: 'mp4', official: 'qq',
              quality: dn === 'fhd' ? '1080P' : (dn === 'shd' ? '720P' : (dn === 'hd' ? '480P' : '270P')),
              size: Number(vi.fs) || 0, title: String(vi.ti || '')
            };
          }
        }
      } catch (e) { /* 降档再试 */ }
    }
    return { ok: false, error: 'notfound' };
  }
  return { ok: false, error: 'notfound' };
}

/** B站取音频：bvid → cid → dash.audio（选带宽最高的一轨）
 *  opts.mv === true 时改走 fnval=1：拿 `data.durl[0]`，那是**音视频一体的普通 MP4**
 *  （ftyp→moov(faststart)→trak vide(avc1)+trak soun(mp4a)→mdat，无 moof/sidx），
 *  一个 <video> 就能出画面+声音，请求数与纯音频相同（实测 1 个），限流零增长。
 *  🔴 fnval 实测是二选一：16→dash、1→durl、17(16|1) 也只给 durl。所以「要画面」
 *    和「要高码率音频（dash 30280 约 183kbps）」只能取一个 —— 合并流音轨只有
 *    约 64~70kbps，这是 MV 模式唯一实质代价，别偷偷把默认模式也改成 fnval=1。 */
async function apiBiliResolve(bvid, targetDuration, opts) {
  const wantsMv = !!(opts && opts.mv);
  const { cookie } = await biliCtx();
  const H = { ...BILI_H, Cookie: cookie };
  const v = await getJSON(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: H, tries: 2, timeout: 15000 });
  if (v.code !== 0 || !v?.data?.cid) throw new Error('B站取视频信息失败：' + (v.message || v.code));
  const cid = v.data.cid;
  const vdur = v.data.duration || 0;
  const pu = await getJSON(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=${wantsMv ? 1 : 16}&fourk=1`, { headers: H, tries: 2, timeout: 15000 });
  if (wantsMv) {
    const durl = pu?.data?.durl || [];
    if (!durl.length || !(durl[0] && durl[0].url)) {
      const e = new Error('B站这个视频没有可取的音视频合并流（可能是付费/受限影片）');
      e.isNoSource = true; throw e;
    }
    /* 时长守卫：MV 模式**只做粗筛上限** —— `vdur > 原曲 × 1.5` 就拒，不用固定秒数。
       为什么连我上一版拍的 ±180s 也撤：scout 用 16 个样本量化过这条守卫 ——
       15 个能匹配原曲的样本里，90s 守卫只拦下 1 个（1565s 那个超长合集），命中率
       1/15；而标题里明写「神级现场」的那个只差 +38s 就大摇大摆过闸。**纯时长阈值
       根本抓不到现场版**。所以 MV 模式不负责挡现场版（用户要的就是这个视频的画面），
       只负责挡合集/超长视频（不挡就是白拉 25MB）。按比例而不是按秒数，是为了让
       长曲（6 分钟）也能容忍同量级的偏差，短曲不会被一个固定宽限放进去 2 倍长的内容。
       验算 scout 那批样本：以父之名 364 vs 334×1.5=501 过 ✅；富士山下现场
       298 vs 260×1.5=390 过 ✅；臻享 1565 vs 390 拒 ✅。
       ⚠️ 文本特征（现场/翻唱/Hi-Res）**不要做成拒绝闸门**：scout 本来想建议按标题
       过滤「无损/Hi-Res」，结果无头浏览器截帧发现那条**有真画面**（录音棚实景 +
       烧进画面的滚动歌词），过滤掉反而丢了好东西；「翻唱 富士山下」画面正常，同理。
       它们只适合做排序权重。 */
    if (targetDuration > 0 && vdur > 0 && vdur > targetDuration * 1.5) {
      const e = new Error(`B站该视频时长 ${fmtDur(vdur)} 超过原曲 ${fmtDur(targetDuration)} 的 1.5 倍（疑似合集/超长视频）`);
      e.isNoSource = true; throw e;
    }
    const qid = String(pu?.data?.quality || 16);
    const size = Number(durl[0].size) || 0;
    const bitRate = vdur ? Math.round(size * 8 / vdur) : 0;   // 音+视合在一起的码率
    return {
      url: durl[0].url, ext: 'mp4', mediaType: 'video',
      bitRate, size, sizeText: fmtSize(size),
      quality: qid === '32' ? '480P' : '360P', qualityKey: 'bili-mv',
      note: 'B站音视频合并流（MP4，含画面）'
    };
  }
  const audios = pu?.data?.dash?.audio || [];
  if (!audios.length) { const e = new Error('B站这个视频没有可取的音频轨（可能是付费/受限影片）'); e.isNoSource = true; throw e; }
  // 选带宽最高的一轨
  const best = audios.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
  // 时长偏差过大 → 很可能是合集/直播回放，不适合当单曲
  if (targetDuration && vdur && Math.abs(vdur - targetDuration) > 90) {
    const e = new Error(`B站该视频时长 ${fmtDur(vdur)} 与原曲 ${fmtDur(targetDuration)} 差太多（疑似合集/现场）`);
    e.isNoSource = true; throw e;
  }
  const bitRate = best.bandwidth || 128000;
  const size = vdur ? Math.round(bitRate / 8 * vdur) : 0;   // 由码率×时长估算，用于进度与完整性校验
  return {
    url: best.baseUrl, ext: 'm4a', bitRate, size, sizeText: fmtSize(size),
    quality: Math.round(bitRate / 1000) + 'K', qualityKey: 'bili',
    note: 'B站音频（m4a）'
  };
}

/* ---------------- 抖音（分享链接解析式接入） ----------------
 * 为什么抖音只能「粘链接」而不能像其它四个平台那样搜：
 *   抖音的搜索接口一律返回 status_code=2483「请先登录，再继续搜索吧」，
 *   而且 web 端所有接口都要 a_bogus/X-Bogus 签名（由页面里混淆的 JS 现算）。
 *   逆向签名算法能work，但它随抖音版本变，属于「今天能用下月就废」的东西，
 *   不适合放进一个要长期跑的工具里。
 *
 * 能稳拿到的是「单条内容详情」：
 *   握手拿 cookie（__ac_nonce → ttwid）后调 aweme/detail，返回里
 *   music.play_url.url_list 就是抖音自己的 MP3 CDN 直链，完整可下。
 *   所以抖音的入口是「粘贴分享链接/分享文案」，而不是搜索框。
 *
 * 歌词：抖音**不提供**文本歌词 —— 它的「歌词」是 KTV 动图，数据里只有
 *   lyric_short_position（图上文字出现的时间点），取不到词。所以抖音这条链路
 *   的歌词统一按「歌名 + 歌手」去酷狗匹配，和 B站 走的是同一个老办法。
 */
const DY_UA_M = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DY_UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DY_Q = 'device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1&version_code=190500&version_name=19.5.0&cookie_enabled=true&platform=PC&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=124.0.0.0&downlink=10&effective_type=4g&round_trip_time=50';

/* cookie 是「一次握手、30 分钟内复用」。抖音票会过期，过期就重握。
 *
 * 票（指纹）的来源，记下 src 便于排查：
 *   webview —— 端侧壳（APK 的 WebView / 桌面端的浏览器窗口）里真浏览器跑 mssdk
 *              生成的 uifid，并可能带上用户自己的登录态。唯一能过风控的路子。
 *   native  —— 纯 Node 握手。拿不到 uifid，基本必被风控，只作保底。
 *
 * ua 必须跟着票一起存：指纹是在这个 UA 下采出来的，发请求时换 UA 就等于
 * 拿着 A 设备的指纹冒充 B 设备，抖音一眼就能看出对不上。 */
const DY_FP_TTL = 30 * 60 * 1000;
let DY_JAR = { at: 0, cookies: {}, ua: '', src: '' };
const dyCookieStr = () => Object.entries(DY_JAR.cookies).map(([k, v]) => k + '=' + v).join('; ');

function dyAbsorb(res) {
  let list = [];
  try { list = res.headers.getSetCookie ? res.headers.getSetCookie() : []; } catch { list = []; }
  for (const c of list) {
    const kv = String(c).split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) DY_JAR.cookies[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
}

/** 从任意文本里认出抖音内容 id —— 用户往往是把整段分享文案粘进来的 */
const DY_ID_PATTERNS = [
  /(?:douyin|iesdouyin)\.com\/(?:share\/)?(?:video|note|slides)\/(\d{6,})/i,
  /[?&](?:modal_id|aweme_id|vid)=(\d{6,})/i,
  /^\s*(\d{15,})\s*$/
];
async function dyAwemeId(input) {
  const s = String(input || '').trim();
  if (!s) { const e = new Error('没给内容，把抖音分享链接粘进来'); e.isNoSource = true; throw e; }
  for (const re of DY_ID_PATTERNS) { const m = s.match(re); if (m) return m[1]; }
  // 短链 v.douyin.com/xxxx → 跟一次 302，Location 里就带着 id
  const sh = s.match(/https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+/i);
  if (sh) {
    for (let i = 0; i < 3; i++) {
      const r = await fetch(sh[0], {
        redirect: 'manual',
        headers: { 'User-Agent': DY_UA_M, 'Accept-Language': 'zh-CN,zh;q=0.9' },
        signal: AbortSignal.timeout(12000)
      }).catch(() => null);
      if (!r) break;
      dyAbsorb(r);
      const loc = r.headers.get('location') || '';
      for (const re of DY_ID_PATTERNS) { const m = loc.match(re); if (m) return m[1]; }
      // 没直接给 id，但给了新的可跟地址
      const next = loc.match(/https?:\/\/[^\s]+/);
      if (!next || next[0] === sh[0]) break;
      sh[0] = next[0];
    }
  }
  // 最后兜底：整段文案里但凡有个 19 位数字，大概率就是 id
  const m = s.match(/(\d{19})/);
  if (m) return m[1];
  const e = new Error('没认出抖音链接。把「复制链接」出来的整段文字粘进来就行（形如 https://v.douyin.com/xxxx/）');
  e.isNoSource = true; throw e;
}

/** 握手：首页拿 __ac_nonce → 视频页（PC）养票 → 分享页（移动）拿 ttwid。
 *  少任何一步都可能让 detail 接口返回空 body；这是实测出来的最小充分集合。
 *  只拿首页就发 detail 是不行的（这点踩过坑）。 */
const dySleep = ms => new Promise(r => setTimeout(r, ms));

/** 端侧（APK 的 WebView / 桌面壳的浏览器窗口）把真实浏览器里养出来的票送回来。
 *
 *  这是成功率最高的一条路：抖音的 uifid 由页面里的 mssdk 采集 canvas / WebGL /
 *  navigator 指纹算出来，纯 Node 环境根本造不出来。但 APK 本身就是 WebView，
 *  让它后台静默加载一次抖音页面，mssdk 会自己把 uifid 写进 cookie，我们取回来
 *  交给服务端复用即可。
 *
 *  注意 ua 要跟着票一起存：指纹是在这个 UA 下采的，发请求时换 UA 就等于
 *  拿着 A 设备的指纹冒充 B 设备，抖音一眼就能看出对不上。 */
function dySetFingerprint(cookieStr, ua, src) {
  const s = String(cookieStr || '').trim();
  if (!s) return { ok: false, error: 'cookie 是空的' };
  const jar = {};
  for (const part of s.split(';')) {
    const kv = String(part || '').trim();
    const i = kv.indexOf('=');
    if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  const names = Object.keys(jar);
  if (!names.length) return { ok: false, error: '没解析出 cookie' };
  DY_JAR = {
    at: Date.now(),
    cookies: jar,
    ua: String(ua || '').trim() || DY_UA_PC,
    src: String(src || '').trim() || 'webview'
  };
  const has = k => !!jar[k];
  console.log('  抖音指纹已更新 · 来源=' + DY_JAR.src + ' · 票数=' + names.length
    + ' · ttwid=' + (has('ttwid') ? '有' : '无')
    + ' · uifid=' + (has('uifid') ? '有' : '无'));
  return { ok: true, count: names.length, ttwid: has('ttwid'), uifid: has('uifid') };
}

/** 握手：优先复用端侧上报的票 → 拿不到就退回纯 Node 握手。
 *
 *  ── 为什么不自己拉浏览器（试过，已放弃）──
 *  「服务端跑一个无头 Chromium 去取指纹」这条路实测也能启动、也能过 uifid 那道关，
 *  但有两个过不去的坎：
 *    1) Chromium 是 118MB 的独立二进制，塞不进单文件 exe（SEA 只能打包 JS 资源）。
 *       用户拿到 exe 还得自己再装一份浏览器，等于把安装门槛抬到天上。
 *    2) 实测下来，抖音对**匿名**请求已经封死了单条详情接口 —— 浏览器自己访问
 *       视频页同样显示「视频不存在 + 登录弹窗」，detail 接口返回 aweme_detail:null。
 *       也就是说再多绕一层浏览器也拿不到东西，瓶颈是「没登录」，不是「没指纹」。
 *  而端侧的壳（APK 的 WebView / 桌面端的浏览器窗口）本身就是真浏览器，
 *  零体积、还能让用户在壳里登录一次抖音拿到登录态 —— 所以只保留端侧这条路。 */
async function dyHandshake(awemeId, force) {
  const isReal = DY_JAR.src === 'webview' || DY_JAR.src === 'endpoint';
  const hasTicket = !!(DY_JAR.cookies.ttwid || DY_JAR.cookies.uifid);
  if (!force && isReal && hasTicket && (Date.now() - DY_JAR.at < DY_FP_TTL)) return;

  DY_JAR = { at: Date.now(), cookies: {}, ua: DY_UA_PC, src: 'native' };
  const go = (url, ua, accept) => fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': ua, 'Accept': accept, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(15000)
  }).then(r => { dyAbsorb(r); return r; }).catch(() => null);

  await go('https://www.douyin.com/', DY_UA_PC, 'text/html,application/xhtml+xml');
  if (awemeId) {
    await go(`https://www.douyin.com/video/${awemeId}`, DY_UA_PC, 'text/html,application/xhtml+xml');
    // 分享页这一步才带出 ttwid —— 关键票，别省
    await go(`https://www.iesdouyin.com/share/video/${awemeId}/`, DY_UA_M, 'text/html');
  }
  await dySleep(400);          // 票刚下发别立刻用，抖音侧要一点点生效时间
}

async function dyDetail(awemeId) {
  await dyHandshake(awemeId, false);
  const url = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}&${DY_Q}`;
  let why = '';                                    // 抖音最后一次给的拒绝理由，用来出人话提示
  const call = async () => {
    const r = await fetch(url, {
      redirect: 'follow',
      headers: {
        /* UA 必须跟采指纹时那把一致，见 dySetFingerprint 的注释 */
        'User-Agent': DY_JAR.ua || DY_UA_PC,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9', Referer: 'https://www.douyin.com/',
        Cookie: dyCookieStr()
      },
      signal: AbortSignal.timeout(20000)
    });
    dyAbsorb(r);
    const t = await r.text();
    if (!t || t.length < 20) { why = '空响应（触发风控）'; return null; }
    let j = null; try { j = JSON.parse(t); } catch { why = '返回不是 JSON'; return null; }
    if (j && !j.aweme_detail) {
      /* 抖音现在对没登录的请求就是回一个「成功但内容为空」：
         status_code=0，aweme_detail=null，filter_detail.filter_reason 里给原因。
         不把它翻成人话，用户只会看到一个说不清为什么的失败。 */
      const fr = (j.filter_detail || {}).filter_reason || '';
      why = fr === 'core_dep' ? '需要登录后才有权限看这条'
        : (fr || ('status_code=' + j.status_code));
    }
    return j;
  };
  // 空响应是常态而非异常 → 拿不到就重握重试，最多 3 轮
  for (let i = 0; i < 3; i++) {
    const j = await call();
    if (j && j.aweme_detail) return j;
    await dyHandshake(awemeId, true);
    await dySleep(500 + i * 700);
  }
  const e = new Error('抖音这条取不到：' + (why || '没返回内容')
    + '。多数是内容已删除或设为私密；若提示要登录，在 App 里登录一次抖音就能看。');
  e.isNoSource = true; throw e;
}

/** 抖音标题清洗：「@某某创作的原声」这类要还原成人看得懂的名字 */
function dyTitle(raw, author) {
  let s = String(raw || '').trim()
    .replace(/^@/, '')
    .replace(/^[-\s]+/, '')
    .replace(/创作的原声/g, '的原声')
    .replace(/创作的原创/g, '的原创');
  if (!s) s = (author || '抖音') + '的原声';
  return s;
}
const dyIsOriginalSound = raw => /原声|原创|创作的原声/.test(String(raw || ''));
const dyImg = o => {
  const u = (o && (o.url_list || [])[0]) || '';
  return String(u).replace(/^http:\/\//i, 'https://');
};

/** 抖音单条内容 → 统一 song 对象（带音频直链） */
async function apiDouyinResolve(input) {
  const id = await dyAwemeId(input);
  const j = await dyDetail(id);
  const det = j && j.aweme_detail;
  if (!det) { const e = new Error('抖音没返回这条内容（可能已删除或设为私密）'); e.isNoSource = true; throw e; }
  const mu = det.music || {};
  const url = (mu.play_url?.url_list || [])[0] || '';
  if (!url) { const e = new Error('这条内容没有可取的音频（纯图文或已下架）'); e.isNoSource = true; throw e; }
  const author = mu.author || det.author?.nickname || '';
  const durS = Number(mu.duration) || Math.round((det.video?.duration || 0) / 1000) || 0;
  const original = dyIsOriginalSound(mu.title);
  return {
    source: 'douyin', sourceName: '抖音',
    id: String(det.aweme_id || id),
    hash: String(mu.id_str || mu.id || ''),
    songname: dyTitle(mu.title, author),
    singer: author || '抖音用户',
    album: mu.album || '',
    duration: durS,
    durationText: fmtDur(durS),
    vip: false,
    hints: ['抖音原声'],
    cover: dyImg(mu.cover_large || mu.cover_medium || mu.cover_thumb),
    /* 抖音特有：这条视频本身的说明与作者，界面上做区分展示 */
    dyDesc: det.desc || '',
    dyAuthor: det.author?.nickname || '',
    dyOriginal: original,            // 原声类没有「歌名」，歌词匹配意义不大
    audio: { url, ext: 'mp3', bitRate: 0, size: 0, quality: '抖音原声', qualityKey: 'douyin' }
  };
}

/** 抖音的 search 入口 = 单条解析，包成和其它平台一样的列表形状 */
async function apiDouyinSearch(input) {
  const it = await apiDouyinResolve(input);
  const { audio, ...rest } = it;
  return { list: [rest], total: 1 };
}


/* ---------------- 每日推荐（各平台公开榜单） ----------------
 * 为什么要有这块：打开应用面对一片空白是最差的落地体验。
 * 这里把五家的「公开榜单」接成默认内容 —— 全部匿名可取、无需登录，
 * 而且映射成统一 song 形状后，卡片点一下就能直接播 / 下载 / 换源。
 *
 * 榜单 id 都是实测拿到的稳定值（酷狗的 rankid、网易云的歌单 id、
 * QQ 的 topid、B站的 rid），不是猜的。
 */
const DAILY_CHARTS = [
  { key: 'all', title: '混合日推', sub: '四个平台各取一批，去重后交错编排' },
  { key: 'kugou', title: '酷狗 TOP500', sub: '每天更新', kind: 'kugou', id: '8888' },
  { key: 'kugouNew', title: '酷狗新歌榜', sub: '每日更新', kind: 'kugou', id: '74534' },
  { key: 'kugouHot', title: '网络热歌榜', sub: '每天更新', kind: 'kugou', id: '82831' },
  { key: 'netease', title: '网易云热歌榜', sub: '每天更新', kind: 'netease', id: '3778678' },
  { key: 'neteaseUp', title: '网易云飙升榜', sub: '每天更新', kind: 'netease', id: '19723756' },
  { key: 'qq', title: 'QQ音乐热歌榜', sub: '每天更新', kind: 'qq', id: '26' },
  { key: 'qqNew', title: 'QQ音乐新歌榜', sub: '每天更新', kind: 'qq', id: '27' },
  { key: 'bili', title: 'B站音乐区', sub: '三日排行', kind: 'bili', id: '3' }
];
const DAILY_MIX = ['kugou', 'netease', 'qq', 'bili'];   // 混合日推取这几张榜
const DAILY_POOL = 90;                                  // 每张榜一次取这么多首存成「当日池」

/* ── 排行榜页的三平台榜单目录（第 9 期）──
 *  业主口径「排行榜页要设计三个平台的榜单」。
 *  键名与 DAILY_CHARTS 完全对齐，这样 dailyFetchOne(chart) 可以直接吃 ——
 *  取数逻辑一行没重写（它自己按 kind 分 kugou / netease / qq / bili 四条路）。
 *  平台顺序 = 用户心智里的强弱序：酷狗（本家）→ QQ音乐 → 网易云 → B站。
 *  ⚠️ 这张表只管「精选榜」。酷狗那 56 个完整榜目录仍走 /api/rank/list，
 *     两者不冲突：酷狗 tab 显示 56 个，其它 tab 显示这里列的几个。 */
/* ── 榜单卡的「封面 + 前三名」（第 22 期）──
   业主口径「QQ音乐和网易云音乐排行榜样式也不统一于酷狗」。
   酷狗的 /rank/list 本来就带每榜前三首和封面，QQ / 网易云 / B站 那几个接口
   没有，于是同一页出现两种卡：酷狗是「封面 + 前三名」，另外两家只有一句
   「点开看这个榜」。这里替它们各取该榜前 3 首（代价就是 3 首），
   10 分钟内复用 —— 目录页只请求一次 /api/charts，不能每开一次就上游打八遍。 */
const CHART_PV_TTL = 10 * 60 * 1000;
const CHART_PV = new Map();
async function chartPreview(c) {
  const hit = CHART_PV.get(c.key);
  if (hit && Date.now() - hit.at < CHART_PV_TTL) return hit.data;
  let data = { cover: '', songs: [] };
  try {
    const got = await dailyFetchOne(c, 3);
    const list = (got.list || []).slice(0, 3);
    data = {
      cover: (list[0] && list[0].cover) || '',
      songs: list.map(x => ({ name: x.songname || '', singer: x.singer || '' }))
    };
  } catch (e) { /* 取不到就空着，前端退回「点开看这个榜」 */ }
  if (data.songs.length) CHART_PV.set(c.key, { at: Date.now(), data });
  return data;
}

const RANK_PLATS = [
  { key: 'kugou', name: '酷狗', items: [
    { key: 'kugou',    name: '酷狗 TOP500', sub: '每天更新', kind: 'kugou', id: '8888' },
    { key: 'kugouNew', name: '酷狗新歌榜',  sub: '每日更新', kind: 'kugou', id: '74534' },
    { key: 'kugouHot', name: '网络热歌榜',  sub: '每天更新', kind: 'kugou', id: '82831' }
  ] },
  { key: 'qq', name: 'QQ音乐', items: [
    { key: 'qq',    name: 'QQ音乐热歌榜', sub: '每天更新', kind: 'qq', id: '26' },
    { key: 'qqNew', name: 'QQ音乐新歌榜', sub: '每天更新', kind: 'qq', id: '27' }
  ] },
  { key: 'netease', name: '网易云', items: [
    { key: 'netease',   name: '网易云热歌榜', sub: '每天更新', kind: 'netease', id: '3778678' },
    { key: 'neteaseUp', name: '网易云飙升榜', sub: '每天更新', kind: 'netease', id: '19723756' }
  ] },
  { key: 'bili', name: 'B站', items: [
    { key: 'bili', name: 'B站音乐区', sub: '三日排行', kind: 'bili', id: '3' }
  ] }
];

/* 「有封面优先」—— 日推是个看脸的版面，一排没有图的灰块最伤观感。
   规矩：带封面的排前面；带封面的够撑起一整天（≥20 首）时，
   没封面那些直接不要（宁缺毋滥）。不够才把没图的补在后面兜底。
   池子从 60 提到 90 就是为了这一步：筛掉三成没图的之后，
   翻页依然有足够内容，不会「换一批」换两次就见底。 */
function dailyCoverFirst(list) {
  const a = [], b = [];
  (list || []).forEach(x => { (x && x.cover ? a : b).push(x); });
  return a.length >= 20 ? a : a.concat(b);
}

/* ── 每日推荐 · 按「天」冻结 ──
 * 需求是「每日打开都是当日推」：同一天里刷新多少次、重启多少次，
 * 拿到手的必须是同一份内容；跨过零点才换新。
 * 做法：
 *   ① 内存 + 磁盘双层缓存，缓存粒度 =「(日期, 榜单) 的整池」；
 *   ② 每张榜一次多取 60 首，「换一批」= 在当日池里翻页 ——
 *      当日内容池不变，但每点一次能翻到新的一批，而不是同一个死列表；
 *   ③ 日期按北京时间算（+8h 再取 UTC 日期），否则 UTC 会提前换日。
 * 榜单 id 都是实测拿到的稳定值（酷狗的 rankid、网易云的歌单 id、
 * QQ 的 topid、B站的 rid），不是猜的。 */
function todayKey() {
  return beijingDayKey(Date.now());
}
/* 注意：DATA_DIR 在文件后面才声明，这里不能立即求值，得用函数延迟取 */
const dailyCacheFile = () => path.join(DATA_DIR, 'daily-cache.json');
/* charts = 当日池（今天真抓到的）；stale = 兜底池（沿用来的 / 跨天前的那份）。
   两者必须分开：兜底池绝不能当当日池用 —— 否则今天一整天都不会再去抓，
   旧内容就一天天糊在那儿了（「day 变成今天但内容还是昨天的，明天会不会
   永远读到旧的」就是这个坑，分开之后就不会：新的一天 charts 是空的，
   照样会去抓一次，抓到了立刻换新，抓不到才继续用兜底那份）。 */
let DAILY_MEM = { day: '', charts: {}, stale: {} };
/* chartsFrom: { 榜单key: 'YYYY-MM-DD' } —— 每条内容**真正抓到的那天**。
   跟 day 一起落盘：day 照常推进到今天，内容沿用旧的也一眼看得出旧了几天。 */
let DAILY_FROM = {};

function dailyCacheLoad() {
  const day = todayKey();
  if (DAILY_MEM.day === day) return;
  const charts = {}, stale = {}, from = {};
  try {
    const j = JSON.parse(fs.readFileSync(dailyCacheFile(), 'utf8'));
    const ch = (j && j.charts && typeof j.charts === 'object') ? j.charts : {};
    const cf = (j && j.chartsFrom && typeof j.chartsFrom === 'object') ? j.chartsFrom : {};
    for (const k of Object.keys(ch)) {
      const arr = ch[k];
      if (!Array.isArray(arr) || !arr.length) continue;
      const src = cf[k];
      /* 只有「同一天」且「确实是今天抓来的」才算当日池。
         没写 chartsFrom 的老缓存按今天抓的处理，兼容改版前落下的文件。 */
      if (j.day === day && (!src || src === day)) { charts[k] = arr; continue; }
      stale[k] = arr;                              // 跨天的 / 沿用来的 → 只作兜底
      from[k] = src || j.day || '旧缓存';
    }
  } catch { /* 没缓存 / 文件坏了都当没有 */ }
  DAILY_MEM = { day, charts, stale };
  DAILY_FROM = from;
}
function dailyCacheSave() {
  try {
    /* 落盘的 = 今天抓到的 + 还没抓到 / 抓失败的沿用项。
       沿用项只写进磁盘，不进 DAILY_MEM.charts（理由见 stale 那段注释）。 */
    const merged = { ...DAILY_MEM.charts };
    for (const k of Object.keys(DAILY_MEM.stale || {})) {
      if (merged[k] && merged[k].length) continue;   // 今天已有新内容，不拿旧的盖
      const old = DAILY_MEM.stale[k];
      if (Array.isArray(old) && old.length) merged[k] = old;
    }
    /* 不整包覆盖：榜单是四个平台分批抓的，别的请求（甚至别的实例）
       可能刚把自己那份写进去，整体替换会把它们抹掉 ——
       表现出来就是「刚抓到的榜单，刷新一下没了」。
       跨天也不整包替换了：以前跨天用当前这份，等于把「今天还没抓到」的
       那一路直接抹掉（B站 ranking 返 -352 那次就是这样，前一天还在的
       51 条被别的榜落盘时抹没了，首页那一行直接空白）。 */
    /* 走 writeJSONMerge（读回 → 合并 → 原子写），不自己拼一遍：
       合并的语义只有一处实现，免得两边写法慢慢跑偏。 */
    const cur = readJSON(dailyCacheFile(), null);
    const charts = (cur && cur.day === DAILY_MEM.day
                    && cur.charts && typeof cur.charts === 'object')
      ? { ...cur.charts, ...merged }   // 同一天：按榜单 key 合并
      : merged;                        // 跨天或没有：用这份（已含沿用项）
    writeJSONMerge(dailyCacheFile(), { day: DAILY_MEM.day, charts, chartsFrom: DAILY_FROM });
  } catch { /* 落盘失败无妨，内存缓存还在 */ }
}

/** 网易云榜单：playlist/detail 直接给完整曲目数组 */
async function dailyNetease(id, size) {
  /* ★ 2026-10-18：`api/playlist/detail` 现在回 code=200 但 tracks 恒为空
     （榜单接口被降级），实测 `api/v6/playlist/detail` 正常给 100 条。
     日推页之前「看起来有数据」是因为 dailyCache 里有历史缓存，
     缓存过期后这一整块会空掉。所以直接换 v6，老接口留兜底。
     字段差异：v6 返回 ar/al/dt，没有 duration 字段。 */
  let tracks = [];
  try {
    const j6 = await getJSON(`https://music.163.com/api/v6/playlist/detail?id=${id}&n=${Math.min(500, Math.max(100, Number(size) || 100))}&s=0`, { headers: NE_H, tries: 2, timeout: 15000 });
    tracks = j6?.playlist?.tracks || (j6?.result && j6.result.playlist && j6.result.playlist.tracks) || [];
  } catch { /* 落到兜底 */ }
  if (!tracks.length) {
    try {
      const j0 = await getJSON(`https://music.163.com/api/playlist/detail?id=${id}`, { headers: NE_H, tries: 1, timeout: 15000 });
      tracks = j0?.result?.tracks || j0?.playlist?.tracks || [];
    } catch { /* 通不了就空 */ }
  }
  tracks = tracks.slice(0, size);
  const cov = await neCovers(tracks.map(s => s.id));      // 榜单接口不给封面，批量补
  return tracks.map(s => {
    /* v6 的时长在 dt（毫秒），老接口在 duration（秒）；只认 duration 会让
       整张榜单的时长全变「--:--」。 */
    const dur = Math.round((Number(s.dt || 0)) / 1000) || Math.round((s.duration || 0));
    const vip = s.fee === 1 || s.fee === 4;
    return {
      source: 'netease', sourceName: '网易云',
      id: String(s.id),
      songname: s.name || '',
      singer: (s.artists || s.ar || []).map(a => a.name).filter(Boolean).join('/') || '',
      album: (s.album && s.album.name) || (s.al && s.al.name) || '',
      albumId: String((s.album && s.album.id) || (s.al && s.al.id) || ''),
      duration: dur, durationText: fmtDur(dur), sizeText: '',
      vip, hints: vip ? ['会员'] : ['榜单'],
      cover: neImg(cov[String(s.id)] || (s.album && s.album.picUrl) || (s.al && s.al.picUrl))
    };
  });
}

/** QQ音乐榜单：老版 toplist 接口，字段是 songmid/songname 那一套 */
async function dailyQQ(topid, size) {
  const j = await getJSON(`https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=${topid}&format=json&page=detail&num=${size}&song_begin=0&tpl=3&platform=yqq.json&needNewCode=0`, { headers: QQ_H, tries: 2, timeout: 15000 });
  return (j?.songlist || []).map(x => x && x.data).filter(Boolean).map(s => {
    const dur = s.interval || 0;
    const vip = s.pay && s.pay.pay_play === 1;
    const mid = s.mid || s.songmid || '';
    const albmMid = (s.album && s.album.mid) || s.albummid || '';
    return {
      source: 'qq', sourceName: 'QQ音乐',
      id: String(mid),
      songname: s.name || s.songname || '',
      singer: (s.singer || []).map(x => x.name).filter(Boolean).join('/') || '',
      album: (s.album && s.album.name) || s.albumname || '',
      albumId: String(albmMid),
      duration: dur, durationText: fmtDur(dur), sizeText: '',
      vip, hints: vip ? ['付费'] : ['榜单'],
      cover: qqImg(albmMid)
    };
  }).filter(x => x.songname && x.id);
}

/* ── B站：只留「像一首歌」的那些 ───────────────────────────────
   音乐区排行里混着两种不是歌的东西：15 秒的短视频片段、和一两个小时的
   合集 / 直播回放。实测 rid=3 的 96 条里 <60s 有 22 条、>900s 有 23 条，
   真正落在单曲区间的只有 51 条。混进日推里就是「0:15」和「1:00:00」并排，
   观感最差的一行就是它；而且 apiBiliResolve 有「视频时长与曲目时长差 >90s
   判为合集 / 回放」的拒播，这些条目点了多半直接放不出来。
   所以先过滤再截断 —— 反过来（先 slice 再 filter）会把 90 首的池子
   筛到只剩一半，翻页一下就见底。 */
const BILI_SONG_MIN = 60, BILI_SONG_MAX = 900;
/* 过滤后至少得剩这么多，否则宁可不过滤。
   原因：apiDaily 只在池子 >= max(size,24) 时才落盘，池子太小 →
   整天不落盘 → 每次请求都实打实打一次上游，把一个「日缓存」用成「实时接口」。
   内容杂一点是一天的观感问题，不落盘是全天打上游的稳定性问题，后者更贵。 */
const BILI_MIN_KEEP = 24;
const isSongDur = d => Number.isFinite(d) && d >= BILI_SONG_MIN && d <= BILI_SONG_MAX;

/** B站音乐区排行 */
async function dailyBili(rid, size) {
  const { cookie } = await biliCtx();
  /* ⚠️ ranking/v2 这一路**不能带 Referer**，所以这里单独构造一份头。
     实测（固定 buvid、交替先后顺序、间隔 10s、6 轮）：
       带 Referer: https://www.bilibili.com/  → 6/6 全 {"code":-352}
       不带 Referer                           → 6/6 全 code=0 / 96 条
     同一个 Referer 打 popular 接口是通的，所以不是"全局封 Referer"，
     而是 ranking/v2 + www Referer 这一组合触发风控。
     ⚠️ 绝不要去改共享的 BILI_H：它被 B站搜索 / view / playurl 三条路共用，
     那三条现在能跑，改了会一起搞坏。要换头就只在这一处换。 */
  const RANK_H = { 'User-Agent': UA_PC, Cookie: cookie };
  const j = await getJSON(`https://api.bilibili.com/x/web-interface/ranking/v2?rid=${rid}&type=all`, { headers: RANK_H, tries: 2, timeout: 15000 });
  const all = (j?.data?.list || []).filter(v => v.bvid);
  const keep = all.filter(v => isSongDur(biliDur(v.duration)));
  const src = keep.length >= BILI_MIN_KEEP ? keep : all;   // 滤得太狠就退回未过滤
  return src.slice(0, size).map(v => {
    const raw = String(v.title || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
    const dur = biliDur(v.duration);
    return {
      source: 'bili', sourceName: 'B站',
      id: v.bvid,
      songname: biliTitleToSong(raw),
      singer: (v.owner && v.owner.name) || '',
      album: '', albumId: '',
      title: raw,
      duration: dur, durationText: fmtDur(dur), sizeText: '',
      vip: false, hints: ['B站', '完整'],
      cover: biliImg(v.pic)
    };
  });
}

/** 单张榜取 n 首（各平台的取法不一样，收口在这里）
 *  返回 { list, incomplete }：incomplete 表示这张榜这次没取到（网络抖动）。
 *  这个标记很重要 —— 见下面 apiDaily 里「空池不落盘」那段。 */
async function dailyFetchOne(chart, n) {
  let list = [];
  if (chart.kind === 'kugou') list = (await apiRankSongs(chart.id, 1, n)).list;
  else if (chart.kind === 'netease') list = await dailyNetease(chart.id, n);
  else if (chart.kind === 'qq') list = await dailyQQ(chart.id, n);
  else if (chart.kind === 'bili') list = await dailyBili(chart.id, n);
  list = (list || []).slice(0, n);   // QQ 的接口会无视 num 全量返回，得自己截
  return { list, incomplete: !list.length };
}

/** 混合日推：每张榜各拿一批 → 去重 → 按列交错（避免前排全被同一家占满）
 *  注意要「过量取样」：四个平台互相撞歌很常见（同名同歌手），
 *  按 n/4 去取的话去重完只剩六成，池子就撑不起翻页了。 */
async function dailyFetchMix(n) {
  const per = Math.max(6, Math.ceil(n / DAILY_MIX.length * 1.7));
  const safe = fn => fn().catch(() => ({ list: [], incomplete: true }));
  const groups = await Promise.all(DAILY_MIX.map(key => {
    const c = DAILY_CHARTS.find(x => x.key === key);
    return safe(() => dailyFetchOne(c, per));
  }));
  const incomplete = groups.some(g => g.incomplete);
  const seen = new Set(), out = [];
  for (let i = 0; i < per; i++) {
    for (const g of groups) {
      const it = (g.list || [])[i]; if (!it) continue;
      const k = normKey(it.songname) + '|' + normKey(it.singer);
      if (!it.songname || seen.has(k)) continue;
      seen.add(k); out.push(it);
      if (out.length >= n) break;
    }
    if (out.length >= n) break;
  }
  return { list: out, incomplete };
}
/** 取某张榜的「当日池」 */
async function dailyPoolFor(chart) {
  return chart.key === 'all'
    ? await dailyFetchMix(DAILY_POOL)
    : await dailyFetchOne(chart, DAILY_POOL);
}

/* 统一带上 id：酷狗那套字段里唯一键叫 hash，其它平台叫 id、B站叫 bvid。
   不补这一下，四条酷狗条目在「跨批去重 / 续播比对」时会被当成同一条。 */
function dailyWithId(list) {
  return (list || []).map(x => x.id ? x : { ...x, id: x.hash || x.bvid || x.songname || '' });
}

/**
 * 每日推荐。同一 (日期, 榜单) 返回同一份池子；
 * page 只在当日池里翻页 —— 所以「换一批」能翻新，但不会跳出今天。
 */
async function apiDaily(srcKey, size, page) {
  const n = Math.max(6, Math.min(60, Number(size) || 20));
  /* 键里有大写（kugouNew / neteaseUp / qqNew），而路由会把 src 统一转小写，
     所以必须忽略大小写比对 —— 否则会静默回落到「混合日推」。 */
  const want = String(srcKey || 'all').trim().toLowerCase();
  const chart = DAILY_CHARTS.find(c => c.key.toLowerCase() === want) || DAILY_CHARTS[0];

    dailyCacheLoad();
  let pool = DAILY_MEM.charts[chart.key];
  let keptFrom = '';                       // 非空 = 这次用的是沿用来的旧内容
  if (Array.isArray(pool) && pool.length) pool = dailyWithId(pool);
  if (!Array.isArray(pool) || !pool.length) {
    let got = await dailyPoolFor(chart);
    /* 一张榜都没取到：多半是网络抖了一下，喘口气再来一次。
       不重试的话，这一天的池子就会被「0 首」冻住，直到明天才好 —— 那是灾难。 */
    if (got.incomplete) {
      await new Promise(r => setTimeout(r, 1200));
      got = await dailyPoolFor(chart);
    }
    pool = dailyWithId(got.list);
    const gotLen = pool.length;
    /* ── 上游失败不许把旧缓存顶掉 ──
       B站那次就是：ranking 返 -352 → 这一路 0 条 → 落盘时把前一天还在的
       51 条抹掉 → 首页那一行空白。所以取空（或撑不满一页、而旧那份更长）
       就改用 DAILY_MEM.stale 里那份，并且**照旧落盘** —— 不落盘的话，
       别的榜一写盘又会把这一路抹掉，兜底就白兜了。
       只兜「0 条」和「明显偏少」，正常结果一律用新的：条数少不一定是故障
       （榜单本身也可能就短），拿旧数据挡掉新数据更糟；而且这条跟
       BILI_MIN_KEEP 不冲突 —— 那是「滤太狠就退回未过滤」，发生在取数内部，
       这里是「取数整体失败」，发生在取数之后。 */
    const old = DAILY_MEM.stale?.[chart.key];
    const oldLen = Array.isArray(old) ? old.length : 0;
    if (oldLen && (gotLen === 0 || (gotLen < n && oldLen > gotLen))) {
      pool = dailyWithId(old);
      keptFrom = DAILY_FROM[chart.key] || '旧缓存';
      console.log(`[daily] ${chart.key} 本次上游只取到 ${gotLen} 条，沿用 ${keptFrom} 的 ${oldLen} 条（不覆盖旧缓存）`);
    }
    /* 落盘条件：① 这次真取到了且够撑起一页；② 这次没取到、沿用了旧内容。
       ② 也必须落 —— 见上面那段。两种情况之外（取到一点但太少、且没有旧内容）
       仍然不落盘：宁可下次重试，也不要把一份残缺内容固化一整天。 */
    const freshEnough = !got.incomplete && pool.length >= Math.max(n, 24);
    if (freshEnough || keptFrom) {
      DAILY_MEM.charts[chart.key] = pool;
      if (freshEnough) delete DAILY_FROM[chart.key];
      else DAILY_FROM[chart.key] = keptFrom;
      dailyCacheSave();
    }
  }

  const total = pool.length;
  const pages = Math.max(1, Math.ceil(total / n));
  const p = (Math.max(0, Math.floor(Number(page) || 0))) % pages;   // 翻到头就回到第一页
  let list = pool.slice(p * n, p * n + n);
  if (list.length < n && pages > 1) list = list.concat(pool.slice(0, n - list.length));  // 尾页绕回补齐
  return {
    key: chart.key, title: chart.title, sub: chart.sub, charts: DAILY_CHARTS,
    day: DAILY_MEM.day, page: p, pages, total, list
  };
}


/* ---------------- 跨平台换源（"全覆盖"核心） ----------------
 * 某平台取不到音源（会员 / 付费 / 下架）时，去另外两个平台找「同名同歌手」的
 * 免费版本顶上 —— 这是多平台互补的正经用法，不是绕过付费墙：
 * 三个平台各自公开免费的曲目就摆在那里，我们只是把可用的那个找出来。
 * 全程只走未登录公开接口；三个平台都没有免费版本，就如实说没有。
 */
async function apiAltSource(name, singer, duration, exclude) {
  if (!name) { const e = new Error('缺少歌名'); e.isNoSource = true; throw e; }
  const kw = (name + ' ' + (singer || '')).trim();
  const safe = fn => fn().catch(() => null);
  const [k, ne, qq, bi] = await Promise.all([
    safe(() => apiSongSearch(kw, 1, 20)),
    safe(() => apiNeteaseSearch(kw, 1, 20)),
    safe(() => apiQQSearch(kw, 1, 20)),
    safe(() => apiBiliSearch(kw, 1, 15))
  ]);
  const nkName = normKey(name), nkSinger = normKey(singer);
  // 歌手匹配：strict=要求歌手名精确一致（多歌手用 / 拆开逐个比）；非 strict 才退化为包含匹配
  const sameArtist = (a, b, strict) => {
    const na = normKey(a), nb = normKey(b);
    if (!nb) return true;
    if (na === nb) return true;
    const pa = na.split('/').map(s => s.trim()).filter(Boolean);
    const pb = nb.split('/').map(s => s.trim()).filter(Boolean);
    if (strict) return pb.some(x => pa.indexOf(x) >= 0);
    return pa.some(x => nb.indexOf(x) >= 0 || x.indexOf(nb) >= 0) || pb.some(x => na.indexOf(x) >= 0);
  };

  const pool = [...(k?.list || []), ...(ne?.list || []), ...(qq?.list || [])]
    .filter(it => normKey(it.songname) === nkName)
    .filter(it => !exclude || String(it.id) !== String(exclude))
    .filter(it => !it.vip)                                  // 只认免费曲目
    .filter(it => !(duration && it.duration && Math.abs(it.duration - duration) > 60));  // 时长差太大视为异曲

  const strict = pool.filter(it => sameArtist(it.singer, singer, true));
  const loose = pool.filter(it => strict.indexOf(it) < 0 && sameArtist(it.singer, singer, false));

  // B站单列：它的 singer 是 UP 主不是原唱，改从「标题」里找歌名与歌手；
  // 因为标题匹配天然更糙，时长窗口收紧到 ±25 秒来防串歌。
  const biliCands = (bi?.list || [])
    .filter(it => { const tx = normKey((it.title || '') + ' ' + it.songname); return tx.indexOf(nkName) >= 0 && (!nkSinger || tx.indexOf(nkSinger) >= 0); })
    .filter(it => !exclude || String(it.id) !== String(exclude))
    .filter(it => !(duration && it.duration && Math.abs(it.duration - duration) > 25));

  /* ★ 候选池分两层，B站从「同池竞争」降成「兜底」。
     以前是 [...strict, ...loose, ...biliCands] 混在一起按「时长差 → SRC_RANK」
     排序，主 key 是时长差，SRC_RANK 只在时长差相等时才起作用。而 B站候选的
     时长窗口被收紧到 ±25 秒、比三家的 ±60 秒更准 —— 只要 B站那条时长更接近
     原曲，它就稳稳排到酷狗/网易云/QQ 前面。业主看到「来源：B站」就是这么来的。

     为什么用「两层硬隔离」而不是「给 B站加惩罚分」：惩罚分是软办法，某首歌
     三家候选的时长恰好差很多时，加了惩罚分照样被 B站翻过去。分层则无论时长
     怎么分布，B站都只有在 tierA 一个都没成才轮得到。

     ⚠️ 必须是 tierA.slice(0,8).concat(tierB.slice(0,4))，不能写
        tierA.concat(tierB).slice(0,8) —— 那样 tierA 满 8 条时 B站永远进不去，
        等于把兜底写死成「永远不用 B站」。 */
  var byDur = function (a, b) {
    var da = Math.abs((a.duration || 0) - (duration || a.duration || 0));
    var db = Math.abs((b.duration || 0) - (duration || b.duration || 0));
    return da - db;
  };
  var byDurThenRank = function (a, b) {
    var ra = SRC_RANK[a.source] == null ? 9 : SRC_RANK[a.source];
    var rb = SRC_RANK[b.source] == null ? 9 : SRC_RANK[b.source];
    return byDur(a, b) || (ra - rb);
  };
  // tierA：只装酷狗/网易云/QQ（strict + loose 都来自 pool，pool 已排除 B站）
  var tierA = strict.concat(loose).sort(byDurThenRank);
  // tierB：B站单列，只按时长差排，不跟三家比平台优先级
  var tierB = biliCands.slice().sort(byDur);
  var tryList = tierA.slice(0, 8).concat(tierB.slice(0, 4));
  for (var ci = 0; ci < tryList.length; ci++) {
    var it = tryList[ci];
    try {
      var audio = await apiResolveAny(it);
      return { source: it.source, sourceName: it.sourceName, song: it, audio };
    } catch (eAlt) { /* 该候选不行，试下一个 */ }
  }
  /* 文案要如实反映两层结构：写「四个平台都没找到」会让人以为是四家平权一起找
     过，排查时就会往「B站接口挂了」上跑，而真实情况多半是三家没免费版。 */
  var e = new Error('酷狗/网易云/QQ 都没有免费音源，B站也没有可用的（可能全平台会员/版权限制）');
  e.isNoSource = true; throw e;
}

/** 按 source 分流的统一解析（换源时复用） */
async function apiResolveAny(it, br = 'auto') {
  if (it.source === 'netease') return apiNeteaseResolve(it.id, it.duration);
  if (it.source === 'qq') return apiQQResolve(it.id, it.duration, 0, br);
  if (it.source === 'bili') return apiBiliResolve(it.id, it.duration);
  if (it.source === 'douyin') { const r = await apiDouyinResolve(it.id); return r.audio; }
  return resolveAudio({ hash: it.hash, sqhash: it.sqhash, h320hash: it.h320hash, reshash: it.reshash }, br);
}

/* ---------------- 多平台聚合搜索 ---------------- */
/* ★ U-18：upload **显式**登记，不要靠 `SRC_RANK[x] ?? 9` 的兜底巧合。
   说清楚它能做什么、不能做什么：
     ✅ 能做的：表意清晰。不写的话「上传排最后」依赖 ?? 9 这个 fallback，
        下一个人看不懂，将来有人动 ?? 9 就会翻车。
     ⚠️ 不能做的：**它不解决丢行**。`?? 9` 对未注册来源有兜底，
        不补 upload 也**不会**让行消失。
     🔴 真正会静默丢行的是 songname 为空（mergePlatforms 两处门禁），
        那是 searchUploads() 里那道 `if (!row.songname)` + 日志管的。
        两条是不同的问题，都要补，但不互相替代。
   另：SRC_RANK 第三个消费点在 autoAlt 候选池，那个池只装 kugou/netease/qq，
   上传根本进不去 —— 所以补这个常量**不会**把上传歌引进换源链路（符合红线二）。 */
const SRC_RANK = { kugou: 0, netease: 1, qq: 2, bili: 3, douyin: 4, upload: 9 };
const SRC_NAME = { kugou: '酷狗', netease: '网易云', qq: 'QQ音乐', bili: 'B站', douyin: '抖音', upload: '上传' };
const normKey = s => String(s || '').toLowerCase().replace(/[\s\-_·・()（）\[\]【】《》"'"'!！?？,.，。]/g, '');

/** 合并多平台结果：按「歌名+歌手」去重；同曲优先保留非会员、再按平台优先级
 *  kw 只用于最后的 rankSearchList（原唱优先 + B站后置），不参与去重 */
function mergePlatforms(groups, kw) {
  const all = groups.filter(Boolean).flatMap(g => g.list || []);
  const keep = new Map();               // key -> song
  for (const it of all) {
    if (!it || !it.songname) continue;
    const k = normKey(it.songname) + '|' + normKey(it.singer);
    const prev = keep.get(k);
    if (!prev) { keep.set(k, it); continue; }
    /* ★ 平台优先级在前、会员标签在后（2026-10-18 用户口径：搜索结果优先酷狗）。
       原来是反过来的：同曲只要别家有免费版本，就把酷狗的会员原版顶掉 ——
       用户搜「稻香」点进去听到的是翻唱。现在会员侧链路已打通
       （songinfo 单曲 album_id=0 修复），酷狗原版优先保留；真取不到音源时
       前端 Api.alt 仍会跨平台换源，所以不会出现「保留了但放不了」。 */
    const better = ((SRC_RANK[prev.source] ?? 9) - (SRC_RANK[it.source] ?? 9))
                || (Number(prev.vip) - Number(it.vip));
    if (better > 0) keep.set(k, it);
  }
  // 保持「酷狗在前」的原始顺序，其余平台的新增曲目依次追加
  const seen = new Set();
  const out = [];
  for (const g of groups.filter(Boolean)) {
    for (const it of g.list || []) {
      if (!it || !it.songname) continue;
      const k = normKey(it.songname) + '|' + normKey(it.singer);
      if (seen.has(k)) continue;
      if (keep.get(k) !== it) continue;   // 该曲被别的平台更优版本取代
      seen.add(k); out.push(it);
    }
  }
  return rankSearchList(out, kw, all);
}

/* ---------------- 搜索结果排序：原唱优先 + B站后置 ----------------
 * 2026-10-18 用户口径：一、B站整组放到最后，高优先显示酷狗/网易云/QQ；
 *                    二、每首歌的原唱排在前面（翻唱/伴奏/DJ 版往后靠）。
 *
 * 不用固定「原唱表」的理由：曲库每天在变，写死歌手名迟早过期。
 * 这里只用「能从数据里自证」的信号，加权叠加：
 *   · 标题与关键词完全一致          +60   《稻香》比《稻香 (DJ版)》靠前
 *   · 标题以关键词开头 / 包含       +28 / +10
 *   · 歌手与关键词互含（搜歌手）    +30 / +24
 *   · 与「原唱锚点」同歌手         +20   锚点 = 标题完全一致、无版本标记、且至少两个平台都有同名同歌手
 *   · 标题带翻唱/伴奏/版本标记        −22
 *   · 会员原版                       +1   与 mergePlatforms 去重口径一致
 *
 * 分组顺序：三端（酷狗/网易云/QQ）→ B站 → 上传。上传仍在最后（与改动前
 * 一致），promoteUploads 在这之后跑，精确命中的上传行照旧被提到最前（U-54 口径不变）。
 * 衔接：列表里的顺序就是用户看到的顺序（前端按 lastList 自己分页）。
 */
const SEARCH_VER_RE = /(翻唱|翻自|cover|伴奏|纯音乐|纯享|钢琴|吉他|口琴|尤克里里|古筝|二胡|萨克斯|小提琴|鼓版|dj|remix|mashup|串烧|慢速|降调|升调|加速|变调|女声|男声|童声|童音|合唱|群星|live|现场|演唱会|片段|铃声|3d|8d|环绕|抖音|热播|剪辑|清唱|和声|试听|karaoke|instrumental)/i;

/* ---------------- 原唱/翻唱/现场标注（2026-10-24 业主口径「各大平台要标明原唱」） ----------------
 * 每平台挑「能自证」的信号，按可信度用：
 *   网易云  originCoverType：1=原唱 2=非原唱（官方标注，实测最可信）；
 *           非原唱时 originSongSimpleData.artists 给原唱者（实测：周深《起风了》
 *           oCT=2，原唱=冯沁苑）。
 *   酷狗    trans_param.OriAuthName：只有翻唱/改编曲才带 → 带=翻唱，值=原唱者；
 *           实测多数翻唱此字段为空，所以标题启发式兜底。
 *   QQ      没有等价字段 → 纯标题启发式。
 * 标题启发式（通用，按序判，先中先得）：
 *   现场/演唱会/巡演/live → 现场；翻唱/翻自/cover → 翻唱；
 *   伴奏/纯音乐/karaoke → 伴奏；dj/remix → DJ版；
 *   括号里的「…版/改编/剪辑/串烧」→ 改版。
 * 全都不沾 → 原唱（曲库主力条目；网易云有 oCT=1 官方背书时更是实锤）。
 * 输出：otag ∈ 原唱/翻唱/现场/伴奏/DJ版/改版；osg = 原唱者（仅拿得到时）。 */
const OTAG_LIVE_RE  = /(现场|演唱会|巡演|live)/i;
const OTAG_COVER_RE = /(翻唱|翻自|翻版|cover)/i;
const OTAG_INST_RE  = /(伴奏|纯音乐|纯享|karaoke|instrumental)/i;
const OTAG_DJ_RE    = /(dj|remix|mashup)/i;
const OTAG_EDIT_RE  = /[(（][^)）]*(版|改编|剪辑|串烧|片段|铃声)[^)）]*[)）]/;
function songOtag(title, o) {
  const t = String(title || '');
  o = o || {};
  if (OTAG_LIVE_RE.test(t)) return { otag: '现场', osg: '', oc: 1 };
  if (o.oct === 2 || o.oriAuth) return { otag: '翻唱', osg: String(o.oriAuth || ''), oc: 1 };
  if (OTAG_COVER_RE.test(t)) return { otag: '翻唱', osg: '', oc: 1 };
  if (OTAG_INST_RE.test(t)) return { otag: '伴奏', osg: '', oc: 1 };
  if (OTAG_DJ_RE.test(t)) return { otag: 'DJ版', osg: '', oc: 1 };
  if (OTAG_EDIT_RE.test(t)) return { otag: '改版', osg: '', oc: 1 };
  /* 启发式「原唱」只是「没找到反面证据」，不是实锤 —— 净标题翻唱
     （九三《天龙八部之宿敌》）会被误标（2026-10-25 实测）。oc=1 只给
     网易云 oCT=1 的官方背书；前端摆「原唱」徽章只认 oc=1 或锚点 orig=1，
     排序信号（+12/+10）不受影响照旧。 */
  return { otag: '原唱', osg: '', oc: o.oct === 1 ? 1 : 0 };
}

function rankSearchList(list, kw, all) {
  const arr = Array.isArray(list) ? list.slice() : [];
  if (!arr.length) return arr;
  const nk = normKey(kw);
  const words = String(kw || '').toLowerCase().split(/[\s\-–—]+/).filter(Boolean);
  if (!nk && !words.length) return arr;

  /* 标题命中档位：完全相等 > 开头 > 包含（多词关键词拆开逐个试） */
  const titleHit = function (name) {
    if (!name) return 0;
    if (name === nk) return 60;
    let starts = false, has = false;
    for (let i = 0; i < words.length; i++) {
      const w = normKey(words[i]);
      if (!w) continue;
      if (w === name) return 60;
      if (name.indexOf(w) === 0) starts = true;
      if (name.indexOf(w) >= 0) has = true;
    }
    if (nk && name.indexOf(nk) === 0) return 28;
    if (starts) return 28;
    if (nk && name.indexOf(nk) >= 0) return 10;
    return has ? 10 : 0;
  };

  /* 原唱锚点：标题完全一致 + 无版本标记 + 至少两个平台都有同名同歌手才认。
     ⚠️ 平台计数必须用**去重前**的全量（all）：去重后同一个「歌名|歌手」只剩一条，
     永远数到 1，这条判据就形同虚设（实测 稻香|周杰伦 只有酷狗那条留下，
     QQ 那条已被去重吃掉 → 锚点选不出来 → 翻唱排在原唱前面）。 */
  const plat = new Map();
  for (const it of (Array.isArray(all) && all.length ? all : arr)) {
    const k = normKey(it.songname) + '|' + normKey(it.singer);
    if (!plat.has(k)) plat.set(k, new Set());
    plat.get(k).add(it.source);
  }
  let canon = null, canonPos = Infinity;
  /* ★ 锚点之争按「平台原始检索序」裁决（2026-10-25 实测病例：搜
     「天龙八部之宿敌」size=30 时锚点错选了九三的翻唱 —— 合并去重后
     九三那条排在许嵩前面，而许嵩在酷狗原始序里是第 1。平台自己的排序
     比我们的合并顺序更认得谁是原唱，所以同档候选里取 raw 位次最小的。 */
  const rawPos = new Map();
  (Array.isArray(all) && all.length ? all : arr).forEach((it, i) => {
    const k = normKey(it.songname) + '|' + normKey(it.singer);
    if (!rawPos.has(k)) rawPos.set(k, i);
  });
  for (const it of arr) {
    if (!it.singer || SEARCH_VER_RE.test(it.songname || '')) continue;
    if (titleHit(normKey(it.songname)) !== 60) continue;
    const k = normKey(it.songname) + '|' + normKey(it.singer);
    if (!plat.has(k) || plat.get(k).size < 2) continue;
    const pos = rawPos.has(k) ? rawPos.get(k) : Infinity;
    if (pos < canonPos) { canon = it; canonPos = pos; }
  }
  const canonSinger = canon ? normKey(canon.singer) : '';

  arr.forEach(function (it, i) {
    const name = normKey(it.songname), singer = normKey(it.singer);
    let s = titleHit(name);
    if (nk && singer) {
      /* 歌手里有一个词与关键词的某个词**完全相等**才算「就是这个人」——
         「周杰伦 稻香」时，周杰伦本人 +30，周杰伦/派伟俊 这类串烧只算包含 +24，
         否则串烧会把原唱挤出第一（实测过）。 */
      let exactSinger = singer === nk;
      if (!exactSinger) {
        for (let j = 0; j < words.length; j++) {
          if (normKey(words[j]) === singer) { exactSinger = true; break; }
        }
      }
      if (exactSinger) s += 30;
      else if (singer.indexOf(nk) >= 0 || nk.indexOf(singer) >= 0) s += 24;
      else {
        for (let j = 0; j < words.length; j++) {
          const w = normKey(words[j]);
          if (w && singer.indexOf(w) >= 0) { s += 24; break; }
        }
      }
    }
    /* orig=1 表示「这条就是原唱」：前端 web/index.html 的 rankScore 会认这个标记
       再抬一档（16px 前端跨端只靠文本相关度判不出谁是原唱，见那边的注释）。 */
    it.orig = (canonSinger && singer === canonSinger) ? 1 : 0;
    if (it.orig) s += 20;
    /* 第 18 期：songOtag 认定「原唱」的再抬一手 —— 锚点那套（it.orig）要求
       至少两平台同名同歌手才成立，单平台独有的时候锚点选不出来，
       原唱标就是唯一还能用的信号。 */
    if (it.otag === '原唱') s += 12;
    if (SEARCH_VER_RE.test(it.songname || '')) s -= 22;
    if (it.vip) s += 1;
    it.__s = s;
    it.__i = i;
  });

  /* 分组：0=三端（酷狗/网易云/QQ）与其他音频源，1=上传，2=B站
     2026-10-18 用户口径：B站整组放到最后，优先显示其他三端。 */
  const grpOf = function (it) { return it.source === 'bili' ? 2 : (it.source === 'upload' ? 1 : 0); };
  arr.sort(function (a, b) {
    return (grpOf(a) - grpOf(b)) || (b.__s - a.__s) || (a.__i - b.__i);
  });
  for (const it of arr) { delete it.__s; delete it.__i; }
  return arr;
}

/* ══════════════════════════════════════════════════════════════
   U-54 / R21：上传行「精确命中」提权
   ──────────────────────────────────────────────────────────────
   起因（实测，不是推测）：ups 在聚合数组里排最后，所以上传行永远追加在
   结果末尾 —— QA 实测落在第 88/89 位，手机 12 行一页要翻到第 8 页；
   更糟的是 mergePlatforms 按「歌名+歌手」去重时，只要外部平台有同名且
   免费的版本，SRC_RANK.upload=9 必输，上传行被**整行淘汰**，搜都搜不到。

   用户拍板：精确命中就提前。所以这里做两件事：
     ① 补位 —— 被同曲去重吃掉的精确命中上传行，补回来
     ② 提权 —— 把它们排到最前，其余行保持原有相对顺序

   ⚠️ 刻意不改 mergePlatforms 内部、也不动 SRC_RANK：那两处有别的消费方
      （autoAlt 候选池等），改了会连带伤到无关链路。这一层只在聚合之后叠加。
   ⚠️ upsList 可能是 null（聚合里 ups 是 safe() 包出来的，失败即 null），
      必须判空 —— 这里抛异常会让整个 /api/search 变成 500。
   ══════════════════════════════════════════════════════════════ */
function promoteUploads(list, upsList, kw) {
  try {
    if (!list || !list.length || !upsList || !upsList.length || !kw) return list || [];
    const words = String(kw).toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return list;

    /* 「精确命中」= 歌名或歌手与关键词的任一个词**完全相等**。
       「周杰伦 晴天」这类多词关键词，命中任一词就算 —— 与 searchUploads
        的拆词口径保持一致。不用 startsWith、不做模糊。 */
    const hit = [];
    for (const t of upsList) {
      if (!t || t.source !== 'upload' || !t.songname) continue;
      const sn = normKey(t.songname), sg = normKey(t.singer);
      for (const w of words) {
        const nw = normKey(w);
        if (nw && (sn === nw || sg === nw)) { hit.push(t); break; }
      }
    }
    if (!hit.length) return list;

    const hitIds = new Set();
    for (const t of hit) { if (t && t.id) hitIds.add(t.id); }

    /* ① 补位：list 里根本没有的（被同曲淘汰）补回来，别和已有行重复 */
    const have = new Set();
    for (const it of list) { if (it && it.id) have.add(it.id); }
    const add = [];
    for (const t of hit) { if (t && t.id && !have.has(t.id)) add.push(t); }

    /* ② 提权：精确命中的上传行排到最前，其余保持原相对顺序 */
    const lead = [], rest = [];
    for (const it of list) {
      if (it && it.id && hitIds.has(it.id) && it.source === 'upload') lead.push(it);
      else rest.push(it);
    }
    for (const t of add) lead.push(t);
    return lead.concat(rest);
  } catch (e) {
    console.log('[promoteUploads] 兜底跳过：' + (e && e.message));
    return list || [];
  }
}

/* ---------------- 酷狗网页播放接口：会员高码率的唯一通道 ----------------
 * 为什么必须加它：trackercdn 只认 hash 不认账号 —— 会员账号打 320K/无损
 * 照样返回 status=2（实测：同一 hash 带不带 token 结果一模一样）。
 * 真正认账号的是 wwwapi.kugou.com/play/songinfo，但它必须同时满足三条：
 *   ① 有效 token  ② 与之配对的 userid  ③ album_id
 *   - 缺 token / 伪 token / userid=0 → err_code=30020（SSA 滑块风控，脚本过不去）
 *   - 有 token 但缺 album_id        → status=1、br/filesize 都对，但 play_url 为空
 *
 * 好消息：album_id 不用前端给。只传 hash 的那次响应里就自带 album_id，
 * 所以「step1 拿 album_id → step2 拿 play_url」两步就能补齐，**前端零改动**。
 * 档位完全由 hash 决定（FileHash / HQFileHash / SQFileHash），正好和 LV 三档对应。
 * ⚠️ 千万不要顺手带上 encode_album_audio_id —— 一传就被压回 128K，
 *    这正是「以前怎么调都只有 128K」的真正原因。
 *
 * 登录态放 data/secrets.json 的 kugou 段；没有该段时整条链路直接跳过，
 * 行为与改动前完全一致（不会因为没配 token 而变慢或报错）。
 * ------------------------------------------------------------------ */
const KG_SONGINFO = 'https://wwwapi.kugou.com/play/songinfo';
const KG_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
const KG_ALBUM = new Map();          // hash -> album_id，省掉重复的 step1
const KG_ALBUM_MAX = 2000;

/* 酷狗登录系列接口（申请二维码 / 轮询扫码结果）。
   ⚠️ 两个坑，都是实测踩出来的：
      ① 必须带 `type=1`，漏了直接回 error_code=20010，连二维码都不给；
      ② 签名必须把 srcappid/clientver/clienttime/mid/uuid/dfid 一起签进去，
        只签业务参数同样 20010。
   二维码内容 = qrcode_txt + 'qrcode=' + qrcode；用户扫的是 qrcode_img 那张 PNG。 */
const KG_LOGIN = 'https://login-user.kugou.com';
const KG_QR_TXT = 'https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=1014&';
async function kgLoginGet(pathname, extra) {
  const now = String(Date.now());
  const k = (typeof SECRETS === 'object' && SECRETS && SECRETS.kugou) || {};
  const p = Object.assign({
    srcappid: '2919', clientver: '20000', clienttime: now,
    mid: k.mid || now, uuid: k.mid || now, dfid: k.dfid || ''
  }, extra || {});
  p.signature = md5(KG_SALT + Object.keys(p).sort().map(x => x + '=' + p[x]).join('') + KG_SALT);
  const qs = Object.keys(p).map(x => x + '=' + encodeURIComponent(p[x])).join('&');
  return await getJSON(KG_LOGIN + pathname + '?' + qs, {
    headers: { 'User-Agent': UA_PC, Referer: 'https://www.kugou.com/' },
    tries: 1, timeout: 10000
  });
}

/** 取登录态；未配置返回 null（调用方据此零成本跳过） */
function kgAuthCfg() {
  const k = (typeof SECRETS === 'object' && SECRETS) ? SECRETS.kugou : null;
  if (!k || !k.token || !k.userid) return null;
  return {
    token: String(k.token),
    userid: String(k.userid),
    mid: String(k.mid || ''),
    dfid: String(k.dfid || '')
  };
}

async function kgSonginfo(params, cfg) {
  const p = Object.assign({
    srcappid: '2919',
    clientver: '20000',
    clienttime: String(Date.now()),
    mid: cfg.mid, uuid: cfg.mid, dfid: cfg.dfid,
    appid: '1014', platid: '4',
    token: cfg.token, userid: cfg.userid
  }, params);
  p.signature = md5(KG_SALT + Object.keys(p).sort().map(k => k + '=' + p[k]).join('') + KG_SALT);
  const qs = Object.keys(p).map(k => k + '=' + encodeURIComponent(p[k])).join('&');
  return await getJSON(KG_SONGINFO + '?' + qs, { tries: 1, timeout: 8000 });
}

/**
 * 走 songinfo 拿某个 hash 对应档位的直链。
 * needUrl=false 只做 step1：返回的 br/filesize 已足够判断这一档有没有资源，
 * 探测（probeAll）用它，能省掉一次请求。
 */
async function kgByHash(hash, br, needUrl) {
  const cfg = kgAuthCfg();
  if (!cfg || !hash) return null;
  const ext = br === 'sq' ? 'flac' : 'mp3';
  try {
    let albumId = KG_ALBUM.get(hash);
    let meta = null;
    if (!albumId) {
      const d1 = await kgSonginfo({ hash }, cfg);
      meta = (d1 && d1.data) || null;
      if (!meta) return null;
      /* ★ album_id === 0 是「单曲」，不是「查不到专辑」。
         以前这行写的是 `!meta.album_id`，在 JS 里 0 是假值，
         于是所有单曲形态的会员曲都在这里被当成「没有专辑」直接放弃，
         连 step1 已经拿到的 play_url 一起丢掉；结果这批歌全部掉到
         别的平台翻唱（用户点「稻香」听到的是 96K 的 QQ 版）。
         实测 n=4：album_id 恒为 0，而 step1 响应里 play_url / filesize / bitrate 齐全。
         所以：step1 给了 play_url 就直接用，不再非要一个非 0 的 album_id。 */
      if (needUrl !== false && meta.play_url) {
        return {
          ok: true, url: meta.play_url, ext,
          bitRate: Number(meta.bitrate || 0) * 1000,
          size: Number(meta.filesize || 0), viaSonginfo: true
        };
      }
      if (meta.album_id === undefined || meta.album_id === null || meta.album_id === '') return null;
      albumId = String(meta.album_id);
      KG_ALBUM.set(hash, albumId);
      if (KG_ALBUM.size > KG_ALBUM_MAX) KG_ALBUM.delete(KG_ALBUM.keys().next().value);
    }
    if (!needUrl) {
      if (!meta) {
        const d0 = await kgSonginfo({ hash }, cfg);
        meta = (d0 && d0.data) || null;
      }
      if (!meta || !meta.filesize) return null;
      return { ok: true, url: '', ext, bitRate: Number(meta.bitrate || 0) * 1000, size: Number(meta.filesize || 0), viaSonginfo: true };
    }
    /* step2：带上 album_id 才给 play_url */
    const d2 = await kgSonginfo({ hash, album_id: albumId }, cfg);
    const b2 = (d2 && d2.data) || null;
    if (!b2 || !b2.play_url) return null;
    return { ok: true, url: b2.play_url, ext, bitRate: Number(b2.bitrate || 0) * 1000, size: Number(b2.filesize || 0), viaSonginfo: true };
  } catch {
    return null;
  }
}

/* ---------------- 酷狗手动体检（/api/admin/kg/probe） ----------------
 * 判据与 tools/kg-guard.py 的 probe_kugou 完全一致，同一首探活曲：
 * 《稻香》Hi-Res（3175kbps）是会员专属资源 ——
 *   token 失效 → songinfo 回 status≠1（全或无，连免费曲都如此）；
 *   权益降级   → status=1 但 bitrate < 320。
 * cron 巡检走 python 脚本，页面上的「立即体检」走这里，两边写同一个 kg-health.json。 */
const KG_PROBE_HASH = 'D987462A7FD98151845DB245FE214267';
const KG_PROBE_NAME = '周杰伦《稻香》Hi-Res';
async function kgProbe() {
  const cfg = kgAuthCfg();
  if (!cfg) {
    return { ok: false, level: 'critical', levels: [],
      message: '还没有酷狗登录凭证 —— 整条高码率链路是关着的，去下面扫码换证' };
  }
  let j = null;
  try { j = await kgSonginfo({ hash: KG_PROBE_HASH }, cfg); } catch { j = null; }
  if (!j) {
    return { ok: false, level: 'unknown', levels: [],
      message: '探活请求失败（网络问题，不代表凭证失效），稍后再试或等巡检' };
  }
  const st = Number(j.status || 0);
  const d = j.data || {};
  const br = Number(d.bitrate || 0);
  const size = Number(d.filesize || 0);
  if (st !== 1) {
    return { ok: false, level: 'critical', levels: [],
      message: 'token 已失效（songinfo 回 status=' + st + '）。整条高码率链路已断开，' +
        '会员曲会掉到别家低码率翻唱 —— 需要重新扫码换证。' };
  }
  if (br < 320) {
    return { ok: false, level: 'critical', levels: [],
      message: 'token 还在，但只给到 ' + br + 'kbps（会员态应为 3175kbps）—— ' +
        '会员权益已失效或账号降级，会员曲将无法出高码率。' };
  }
  return { ok: true, level: 'ok', levels: [],
    message: '正常：' + KG_PROBE_NAME + ' 拿到 ' + br + 'kbps / ' + size.toLocaleString('en-US') + ' 字节' };
}

/** 单档音源解析 */
async function tracker(hash, br, needUrl) {
  const key = md5(hash + 'kgcloudv2');
  const j = await getJSON(`http://trackercdn.kugou.com/i/v2/?key=${key}&hash=${hash}&br=${br}&appid=1005&pid=2&cmd=25&behavior=play`, { tries: 2, timeout: 10000 });
  if (j?.status === 1 && j.url?.[0]) {
    return { ok: true, url: j.url[0], ext: j.extName || (br === 'sq' ? 'flac' : 'mp3'), bitRate: j.bitRate || 0, size: j.fileSize || 0 };
  }
  /* ★ 会员高码率：tracker 认 hash 不认账号，所以这条路失败时先问 songinfo ——
     它才是唯一会看账号权益的接口。免费曲 tracker 直接成功，压根不会走到这里。 */
  const kg = await kgByHash(hash, br, needUrl !== false);
  if (kg && (kg.url || needUrl === false)) return kg;
  /* ★ 错误分类（云端实测 n=60）：免费曲 status=1 且带 url；付费曲 status=2 且无 url。
     以前两类都返回同一个 {ok:false}，报错统一写「多为会员/付费曲目」，
     把「付费」和「接口挂了」混成一类 —— 前端据此无法判断该不该换源。
     拆开的意义：付费曲换到 B站/网易云是有效的，接口异常换源毫无意义。 */
  const pay = j?.status === 2;
  // 兜底：getSongInfo 的 url
  if (br === '128') {
    try {
      const g = await getJSON(`https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}`, { tries: 1, timeout: 8000 });
      if (g?.url) return { ok: true, url: g.url, ext: g.extName || 'mp3', bitRate: (g.bitRate || 128) * 1000, size: g.fileSize || 0 };
    } catch { /* ignore */ }
  }
  return { ok: false, pay, upstream: !pay };
}

/* ---------------- 首选源取不到 → 服务端自己落到次选源 ----------------
 * 以前「取不到」是原样返回 ok:false 丢回前端，靠前端再发一次 /api/alt 去别的
 * 平台找。那条路除了多一次完整 HTTP 往返 + 四个平台再搜一遍，更要命的是：
 *   用户点播放 → 第 1 次 /api/resolve 失败 → Promise.then 里拿到第 2 次请求的结果
 *   → 此时早就不在「点击」那个手势里了，安卓 WebView 的自动播放策略直接把这次
 *     play() 挡掉。
 * 表现就是业主报的原话「开始播放键按不了，要疯狂连点才出声」——连点不是在碰运气，
 * 是在碰哪一次正好落在手势窗口里。
 *
 * 现在一次 /api/resolve 就把事办完：首选源失败，服务端顺着次选源往下试，首个
 * 成功的 url 直接放进**成功响应体**。前端成功分支第一时间拿到 url、挂上 src、
 * 调 play()，用户点一下就该出声。
 *
 * ⚠️ 响应体形状必须和正常成功体严丝合缝（url / ext / quality 一个都不能少）：
 *    前端只认这三个就往下播，少一个就变成「200 + 播不出来的 src」，比报错难查。
 * ------------------------------------------------------------------ */
/* 一次回落的死限。它是兜底上界，不是常规预期：
   apiAltSource 内部四家并行搜索（实测 ~2s）+ 最多 12 个候选逐个解析，正常 2~4s
   出结果，25s 留了约 6 倍余量；到点还没结果就放弃，让用户看到明确报错而不是干转。 */
const ALT_BUDGET_MS = 25000;
/* 补元数据（歌名/歌手/时长）那一步的硬天花板。kugouInfoByHash 内部还有 8s 的
   getJSON 超时，正常 200~500ms 就回来了；这个 cap 只防它自己卡死。
   它花掉的时间从 ALT_BUDGET_MS 里扣，不额外叠加。 */
const ALT_META_BUDGET_MS = 8000;

/** 酷狗：只有 hash 也能反查出 歌名/歌手/时长 —— 回落没有歌名歌手就去不了别的平台，
 *  没有时长则时长窗形同虚设（见 resolveFallback 里那段）。
 *  前端 Api.resolve 的请求串里只有 hash/sqhash/h320hash，不带 songname/singer
 *  （web/index.html 不在本次改动范围内），所以只能服务端自己补。走的是 tracker()
 *  已经在用的那条 m.kugou.com playInfo：不引新域名、不多一种网络依赖。 */
async function kugouInfoByHash(hash) {
  if (!hash) return null;
  try {
    const g = await getJSON(`https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}`, { tries: 1, timeout: 8000 });
    const singer = String(g?.singerName || g?.author_name || g?.choricSinger || '').trim();
    let name = String(g?.songName || '').trim();
    /* songName 缺失才退到 fileName（形如「周杰伦 - 稻香」）：认得歌手就剥前缀，
       认不得就把第一个「 - 」之前当歌手丢掉 —— 拿错至多是多搜一次，不会更坏。 */
    if (!name && g?.fileName) {
      const fn = String(g.fileName);
      name = (singer && fn.indexOf(singer + ' - ') === 0
        ? fn.slice(singer.length + 3)
        : fn.replace(/^[^-]{1,60}-\s*/, '')).trim();
    }
    /* 时长（秒）。⚠️ 付费曲 `timeLength` 恒为 0 —— 实测稻香(周杰伦)与
       我不难过(孙燕姿) 都是 0，而这两首恰好是「首选源取不到、最需要回落」的那类。
       好在 extra 里的 *timelength（毫秒）不管付费与否都给，付费曲只有这里拿得到：
         稻香童声版  timeLength=220   extra.128timelength=220000 → 220s
         稻香(周杰伦) timeLength=0    extra.128timelength=223503 → 223s
         我不难过(孙燕姿) timeLength=0 extra.128timelength=320444 → 320s
       四个档位的值实测只差不到 1 秒，取任何一个都够用。 */
    let duration = parseInt(g?.timeLength, 10) || 0;
    if (!(duration > 0)) {
      const ex = g?.extra || {};
      const ms = parseInt(ex['128timelength'], 10) || parseInt(ex['320timelength'], 10)
              || parseInt(ex['sqtimelength'], 10) || parseInt(ex['hightimelength'], 10) || 0;
      if (ms > 0) duration = Math.round(ms / 1000);
    }
    return name ? { name, singer, duration, upstreamMsg: String(g?.error || '') } : null;
  } catch { return null; }
}

/** 次选源回落：成功返回可直接当 /api/resolve 成功体的对象；次选源也没有则返回 null。
 *  name/singer 的来历按优先级：请求串自带 > 按 hash 反查（只有酷狗能反查）。
 *  ⚠️ 返回 null 时调用方要把**原始原因**如实报回去 —— 换成「都没戏」会把真正的
 *     病因（比如酷狗说「需要付费」）盖掉，线上就查不出是哪一家先挂的。 */
async function resolveFallback(fromSrc, Q) {
  let name = (Q('name') || Q('songname') || '').trim();
  let singer = (Q('singer') || '').trim();
  const hash = (Q('hash') || '').trim();
  let dur = parseFloat(Q('duration') || '0') || 0;
  /* ★ 预算从这一刻就开始算：补元数据也算在 ALT_BUDGET_MS 里，不叠加到 25s 之上。
     下面那个 race 是硬天花板（kugouInfoByHash 内部还有 8s 的 getJSON 超时），
     双保险只为防它自己卡住 —— 不能让「补个时长」把 /api/resolve 拖到没边。 */
  const t0 = Date.now();
  const durKnown = dur > 0;
  if (hash && fromSrc === 'kugou' && (!name || !singer || !durKnown)) {
    const info = await Promise.race([kugouInfoByHash(hash), sleep(ALT_META_BUDGET_MS).then(() => null)]);
    if (info) {
      if (!name) name = info.name;
      if (!singer) singer = info.singer;
      /* 🔴 只有补到**正数**时长才启用时长窗。
         apiAltSource 那两道闸写成 `!(duration && it.duration && ...)`：
         duration 为 0 时整条短路、任何时长的候选都放行。所以「补不到就留 0」
         恰好等于「维持不设防的老行为」—— 这是刻意的，不是漏判断。
         道理：宁可错配（可能落到异版、词对不上），也绝不能因为补不到时长
         把候选全否掉 —— 那会让原本能播的歌变成播不了，比串歌严重得多。 */
      if (!durKnown && info.duration > 0) {
        dur = info.duration;
        console.log('[回落] 时长补漏 from=' + fromSrc + '《' + name + '》 0 → ' + dur + 's（' + (Date.now() - t0) + 'ms）');
      }
    }
  }
  if (!name) {
    console.warn('[回落] 缺歌名，放弃回落 from=' + fromSrc + ' hash=' + hash.slice(0, 8));
    return null;
  }
  const metaMs = Date.now() - t0;
  /* 剩下的预算给选源：补元数据花了多少就从 25s 里扣掉多少。
     留 6s 地板是防极端情况 —— 万一补时长卡到接近上限，也不至于把选源
     的时间压成 0（那就等于代替上游判了死刑，同样是降低落源成功率）。 */
  const remain = Math.max(6000, ALT_BUDGET_MS - metaMs);
  let budgetTimer = null;
  const budget = new Promise((_, rej) => {
    budgetTimer = setTimeout(() => rej(new Error('回落总闸 ' + remain + 'ms 超时（含补时长 ' + metaMs + 'ms）')), remain);
    if (budgetTimer.unref) budgetTimer.unref();
  });
  try {
    const alt = await Promise.race([
      apiAltSource(name, singer, dur, (Q('id') || hash || '').trim()),
      budget
    ]);
    if (!alt || !alt.audio || !alt.audio.url) return null;
    console.log('[回落] ' + (SRC_NAME[fromSrc] || fromSrc) + ' 取不到 → 落到 ' +
      (alt.sourceName || alt.source) + '《' + name + '》' +
      (alt.song && alt.song.singer ? '(' + alt.song.singer + ')' : '') +
      ' dur窗=' + (dur > 0 ? dur + 's±60/25' : '未启用') + ' ' + (Date.now() - t0) + 'ms');
    return {
      ok: true,
      source: alt.source, sourceName: alt.sourceName,
      url: alt.audio.url, ext: alt.audio.ext, bitRate: alt.audio.bitRate,
      size: alt.audio.size, sizeText: alt.audio.sizeText, quality: alt.audio.quality,
      /* 留痕：从哪一家落过来、最终落成哪一首 —— 前端要改标题 / 来源标签认这两个字段 */
      autoAlt: { from: fromSrc, fromName: SRC_NAME[fromSrc] || fromSrc, song: alt.song }
    };
  } catch (eAlt) {
    console.warn('[回落] from=' + fromSrc + '《' + name + '》次选源也没戏（' + (Date.now() - t0) + 'ms）→ ' + ((eAlt && eAlt.message) || eAlt));
    return null;
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer);
  }
}

/* ★ Hi-Res 在最前面：probeAll 直接遍历这个数组，添一项就能自带探测。
   br 用 'sq' 是因为 ext 判定写的是 br==='sq' ? 'flac' : 'mp3'，Hi-Res 也是 flac。 */
const LV = [{ q: 'hires', key: 'reshash', br: 'sq', label: 'Hi-Res' }, { q: 'flac', key: 'sqhash', br: 'sq', label: '无损' }, { q: 'hq', key: 'h320hash', br: 'hq', label: '320K' }, { q: 'n128', key: 'hash', br: '128', label: '128K' }];

/** 探测全部音质档位（并行） */
async function probeAll(t) {
  const rs = await Promise.all(LV.map(async l => {
    const h = t[l.key];
    if (!h) return { q: l.q, label: l.label, ok: false };
    try {
      const r = await tracker(h, l.br, false);
      return r.ok ? { q: l.q, label: l.label, ok: true, ext: r.ext, bitRate: r.bitRate, size: r.size, sizeText: fmtSize(r.size), quality: qLabel(r.bitRate, r.ext) } : { q: l.q, label: l.label, ok: false };
    } catch { return { q: l.q, label: l.label, ok: false }; }
  }));
  return rs;
}

/** 解析：按偏好取，可降级 */
async function resolveAudio(t, prefer = 'auto') {
  /* ★ auto 不自动上 Hi-Res：它比无损再大一倍（稻香 88MB vs 26MB），
     默认就吃这个流量对手机用户不公平。用户在设置里显式选了 Hi-Res 才走这一档，
     选了但这首没有 Hi-Res 就顺着无损往下降（降级链必须带上，否则全部档位都是 hires 时会直接抛「没音源」）。 */
  const order = prefer === 'auto' ? ['flac', 'hq', 'n128']
    : [prefer, ...['hires', 'flac', 'hq', 'n128'].filter(x => x !== prefer)];
  for (const q of order) {
    const l = LV.find(x => x.q === q);
    if (!l || !t[l.key]) continue;
    const r = await tracker(t[l.key], l.br, true);
    if (r.ok) return { url: r.url, ext: r.ext, bitRate: r.bitRate, size: r.size, sizeText: fmtSize(r.size),
      /* Hi-Res 也是 flac，qLabel 对 flac 一律回「无损」——
         那用户就分不出 30MB（无损）和 55MB（Hi-Res）的差别，
         下载完看到文件名都写着「无损」。这一档的档位名比码率标签更有信息量。 */
      quality: l.q === 'hires' ? 'Hi-Res' : qLabel(r.bitRate, r.ext), qualityKey: l.q };
  }
  const e = new Error('该曲目没有公开可取的音源（多为会员/付费曲目）');
  e.isNoSource = true;
  throw e;
}

/* ---------------- 歌词 ----------------
 * 用户报的是两件事：「歌词老是搜不到」+「歌词显示和唱的对不上」。
 * 旧实现只有 17 行，方向是对的（先「歌名 - 歌手」、再「歌名 歌手」、再纯歌名），
 * 但把**最关键的一步「选哪条候选」整个交给了酷狗的排序**：它只取 candidates[0]。
 *
 * 酷狗那个排序是按它自己的相关度排的，不是按「这份词和你手上这首音频是不是同一版」排的。
 * 排第一的经常是翻唱、Live、伴奏、DJ 版、或者另一张专辑的重录版 ——
 * 词当然对不上。**这就是「唱的和词对不上」的直接来源。**
 *
 * 另外三条一起修：
 *   · download 失败就整条关键词放弃 —— accesskey 偶尔失效，明明后面还有好几个候选没试；
 *   · 没有任何下限判断 —— 就算第一个候选是另一首歌，也会原样返回（宁可不给，也别给错的）；
 *   · 全程静默 —— 前端只收到「没找到歌词」，到底是没搜到、下载失败、还是被判为不是同一首，谁也说不清。
 *
 * 现在的流程：搜出候选 → 逐条打分（时长差 + 歌名相似度 + 歌手相似度）→ 按分数从高往下试，
 * 试到真能下载出内容为止 → 全程留痕，让「某首歌为什么没词」可以被查出来。
 * ------------------------------------------------------------------ */

/* 缓存：命中缓存 6 小时，空结果只留 10 分钟。
   ⚠️ 空结果**绝不能**永久缓存 —— 上游偶尔抽风一次，这首歌就永远搜不到词了。 */
const LYRIC_CACHE = new Map();
const LYRIC_HIT_TTL = 6 * 3600 * 1000;
const LYRIC_MISS_TTL = 10 * 60 * 1000;
const LYRIC_CACHE_MAX = 500;
/* 最近一批「为什么没词」的原因，给 /api/lyric 回传用（容量有限，只留最近的） */
const lyricMissReason = new Map();
/* 每条关键词最多试几个候选（按分数从高往低） */
const LYRIC_TRY_PER_KW = 5;
/* 下限：歌名相似度低于这个值、或总分低于这个值，宁可说没找到，也不给一份八成是错的词。
   给错词比不给词更伤用户 —— 用户会以为软件坏了，而不是以为这首歌没词。 */
const LYRIC_MIN_NAME_SIM = 0.45;
const LYRIC_MIN_SCORE = 42;

function lyricLog(msg) { console.log('[歌词] ' + msg); }

function lyricCacheKey(name, singer, dur, hash) {
  /* hash 必须进 key：hash 是酷狗的召回升档开关，空 hash 和有 hash 召回到的是
     **不同的候选集**（同一首歌可能一边 0 候选、一边 20 个）。不进 key 的话
     两种请求会互相污染缓存 —— 带 hash 的请求会把空 hash 那次的结果缓存住，反之亦然。 */
  return [String(singer || ''), String(name || ''), Math.round(Number(dur) || 0), String(hash || '')].join('|');
}
function lyricCacheGet(k) {
  const e = LYRIC_CACHE.get(k);
  if (!e) return null;
  if (Date.now() - e.at > e.ttl) { LYRIC_CACHE.delete(k); return null; }
  return e;
}
function lyricCacheSet(k, val) {
  if (LYRIC_CACHE.size >= LYRIC_CACHE_MAX) {
    const oldest = LYRIC_CACHE.keys().next().value;
    if (oldest !== undefined) LYRIC_CACHE.delete(oldest);
  }
  LYRIC_CACHE.set(k, {
    at: Date.now(),
    val: val,
    ttl: val ? LYRIC_HIT_TTL : LYRIC_MISS_TTL   // 命中 → 6h；空 → 10min
  });
}

/** 归一化：全角转半角、去括号后缀（Live版/Remix/翻唱…）、去空白与标点。
    不这么做的话「晴天(Live版)」和「晴天」会被判成两首完全不同的歌。 */
function lyricNorm(s) {
  return String(s || '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .toLowerCase()
    .replace(/[\[\(（【][^\]\)）】]*[\]\)）】]/g, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，,。.、！!？?'"`~·\-_/\\|：:]/g, '');
}

/* ── 请求侧的清洗 ──────────────────────────────────────────────
   上游对歌手的口径有三套，不清洗就搜不到：
     · 网易云 server.mjs 是 artists.map(a=>a.name).join('/')  → 「周杰伦/温岚」
     · 酷狗自己是顿号                                          → 「温岚、周杰伦」
     · B站是 v.author（源码注释自己写了「这里是 UP 主，不是原唱」）→ 「影视飓风」
   实测：kw「屋顶 - 周杰伦/温岚」→ 0 候选；换成单歌手就有。
   所以按分隔符切分**只取第一个**（第一个通常是主唱/原唱）。 */
function lyricSinger(s) {
  return String(s || '').split(/[\/、,，&]/)[0].trim();
}
/* 歌名去装饰：(Live) (伴奏) (翻唱版) 【】《》 feat. 之类。
   带着这些去搜，等于主动去找一个「不是录音室原版」的候选。 */
function lyricName(s) {
  return String(s || '')
    .replace(/[\[\(（【《][^\]\)）】》]*[\]\)）】》]/g, '')
    .replace(/\b(feat|ft)\.?[^\s]*/gi, '')
    .trim();
}
/* 时长单位：同一个接口一会儿给秒（223）一会儿给毫秒（223000），
   实测搜「稻香」不带歌手时返回的就是 223000。统一折算成秒。 */
function lyricDurSec(v) {
  const n = Number(v) || 0;
  if (!n) return 0;
  return n > 1000 ? Math.round(n / 1000) : Math.round(n);
}
/* 版本后缀：现场 / 演唱会 / 伴奏 / 翻唱 / DJ / remix。
   请求时长为 0（上传歌恒 0、B站是视频时长）时没法按时长校验，
   这时候**录音室版才是大概率正确的**，带这些后缀的要扣分。 */
const LYRIC_LIVE_RE = /(live|现场|演唱会|巡回|音乐会|伴奏|翻唱|cover|remix|dj|纯音乐| instrumental)/i;
/* 歌词虚词：判「一个段是不是一整句话」（`我总算学会了`）。
   ⚠️ 这个常量曾经被我误删过一次，结果第三轮每跑必抛 `LYRIC_PART_RE is not defined`，
   异常被 fetchLyric 外层吞掉 → **整首歌直接没词**（点验三条全 MISS）。所以两个常量
   必须成对存在：LYRIC_PART_RE 管虚词，LYRIC_FRAG_RE 管歌词开头/结尾的常见措辞。 */
const LYRIC_PART_RE = /[的了我你他她是不]/;
/* 音质词 / 合集词：第三轮切段时用来剔掉「动态歌词」「无损音质」「合集」这类段。
   ⚠️ 刻意**不含** `version` 这类版本标记词 —— 那部分（`live` / `版`）的完整处理
   在 biliTitleToSong() 里，这里只做切段剔噪，判据窄一点更安全。 */
const LYRIC_NOISE_CUT = /(高清|无损|音质|完整版|字幕|动态歌词|滚动歌词|合集|串烧|精选|歌单|循环|纯享|伴奏|纯音乐|耳机|戴上|环绕|3D|8D)/;
/* 歌词碎片段：`如何去爱` `其实我也看出你有点不舍` 这类不是歌名。
   只在**第三轮脏标题切段**时用来剔噪声，不参与任何匹配判定。 */
const LYRIC_FRAG_RE = /^(如何|为何|如果|只是|就算|因为|所以|其实|可是|但是|于是|然后|不要|不能|没有|是否|多少|怎么|什么)|(学会|知道|记得|忘记|爱过|哭了|走了|来吧|好吗)$/;

/* 下载下来的 LRC 里认「这不是录音室原版」。
   ⚠️ 只看候选的 song/singer 字段**认不出来** —— 实测 duration=0 时排第一的那条
   字段是 song="周杰伦" singer="稻香"，一个「演唱会」的字样都没有，
   版本信息只写在 LRC 正文的 [al:周杰伦地表最强世界巡回演唱会] 里。
   所以必须在**下载之后**再判一次。 */
function lyricIsLive(lrc) {
  const al = String(lrc || '').match(/\[al:([^\]]*)\]/);
  const head = String(lrc || '').slice(0, 400);
  return LYRIC_LIVE_RE.test(al ? al[1] : '') || LYRIC_LIVE_RE.test(head);
}

/* ── 词曲/编舞这类「版权行」─────────────────────────────────────────
   有些 LRC 的正文前面挂的是**工作人员名单**，不是歌词。实测三类：
     · 广场舞/编舞视频：正文是「编舞：王广成 庄大庆 朱挺旺 等」这种编舞名单
     · 老版（如 2013 版）：前几行是「词：刘兵」「曲：李健」
     · 英文歌：首行是 `Written by: ...` / `Lyrics by: ...`
   这三类都**能命中**，所以命中率那一栏看不出问题，但用户看到的第一行是
   人名 —— 属于「命中但脏」，比不中还容易被拿去截图露馅。

/* ⚠️ 只认**行首**标记，不做全文替换 —— 正文里出现「爱」「曲」这类常见字
      绝不能被误伤（这就是要 `^` 锚定 + 要求冒号/` by ` 的原因）。
   ⚠️ 中文侧**要求有冒号**（`词：` `曲：` `编舞：`）。不要求冒号的话，
      一行以「词」开头的正常歌词会被误删 —— 保险起见只吃带冒号的那种。
      代价：「作词 丁晓雯」这种没冒号的漏网，但漏网只是没变干净，不会变错。
   ⚠️ 长词排在短词**前面**（`母带处理` 在 `母带` 之前、`录音棚` 在 `录音` 之前）：
      虽然正则回溯最终也能匹配上，但排对了读起来不会让人怀疑。
      实测补的词：芒种首行是 `母带处理：殇小谨`，`后期`/`混音` 都盖不住它。 */
const LYRIC_CREDIT_RE = /^(?:词|曲|词曲|作词|作曲|编曲|编舞|母带处理|母带|缩混|录音棚|录音室|演唱|录音|混音|制作|监制|和声|出品|发行|后期)\s*[:：]|^(?:written|composed|lyrics|produced|music|arranged|recorded|mixed|mastered)\s+by\b/i;

/* 返回 { lrc, cut }：cut = 删掉的版权行数。
   ⚠️ 不在这里判「删完还有没有词」—— 那是调用方的决定（要换下一个候选，
      不是返回一份空歌词）。标签行（[ti:] [ar:] 之类）原样保留，不动。 */
function lyricStripCredit(lrc) {
  const lines = String(lrc || '').split(/\r?\n/);
  let cut = 0;
  const out = lines.filter(function (ln) {
    if (!/\[\d{1,2}:\d{2}/.test(ln)) return true;          // 不是带时间轴的正文行
    const txt = ln.replace(/\[[^\]]*\]/g, '').trim();
    if (!txt) return true;
    if (LYRIC_CREDIT_RE.test(txt)) { cut++; return false; }
    return true;
  });
  return { lrc: out.join('\n'), cut: cut };
}
/* ── 被塞进正文的「拼接标题行」───────────────────────────────────────
   有些 LRC 的第一行不是歌词，是「歌名 (版本) - 歌手」被塞进了正文，比如
   `传奇 (2013版) - 李健`。上一单（c3e3c18）把词曲/编舞行剥掉了，但这一行还在，
   用户看到的第一行仍然不是歌词。

   🔴 判据必须**三条全中**才剥，缺一条都不剥：
     ① 只出现在正文**开头几行**（LYRIC_TITLE_SCAN_LINES）—— 标题只会在开头，
        扫全文只会增加误伤面；
     ② 剥掉时间轴后形如 `X - Y`（半角 `-` 与全角 `–` `—` `－` 都认）；
     ③ `X` 归一化后跟**当前这首歌名**相等或高度相似，
        `Y` 归一化后跟**歌手之一**相等（歌手可能带 `/`，按分隔符拆开逐个比）。
   为什么必须歌名和歌手**都对上**：歌词正文里本来就有 `A - B` 这种写法
   （对唱标记、段落标记），只看形态会误伤。两个都对上，误伤概率才压得住。 */
/* `+` 是因为真标题里有 `——`（两个全角破折号连用），只认一个会切成三段。 */
const LYRIC_TITLE_SEP_RE = /\s*[-–—－]+\s*/;
const LYRIC_TITLE_SCAN_LINES = 3;

function lyricStripTitle(lrc, name, singers) {
  var nn = lyricNorm(name);
  var want = [];
  for (var k = 0; k < (singers || []).length; k++) {
    var s = lyricNorm(singers[k]);
    if (s && want.indexOf(s) < 0) want.push(s);
  }
  var lines = String(lrc || '').split(/\r?\n/);
  var out = [], cut = 0, scanned = 0;
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (scanned < LYRIC_TITLE_SCAN_LINES && /\[\d{1,2}:\d{2}/.test(ln)) {
      scanned++;
      var txt = ln.replace(/\[[^\]]*\]/g, '').trim();
      var parts = txt.split(LYRIC_TITLE_SEP_RE);
      if (parts.length === 2 && lyricIsTitlePair(parts[0], parts[1], nn, want)) { cut++; continue; }
    }
    out.push(ln);
  }
  return { lrc: out.join('\n'), cut: cut };
}
/* 一行是不是「歌名 - 歌手」这一对。歌名用 lyricSim 兜底（`(2013版)` 这类装饰
   归一化后多数会被剥掉，但保险起见留相似度一档）；歌手按分隔符拆开逐个比。 */
function lyricIsTitlePair(a, b, nn, wantSingers) {
  var na = lyricNorm(a);
  if (!na || !nn || !wantSingers.length) return false;
  if (na !== nn && lyricSim(na, nn) < 0.9) return false;
  /* ⚠️ 歌手必须**先按分隔符切开再逐个归一化**，不能先归一化再切 ——
     lyricNorm 会把 `/` 一起吃掉（`陈奕迅/王菲` → `陈奕迅王菲`），
     先归一化就再也匹配不上合唱阵容里的单个歌手了。 */
  var parts = String(b || '').split(/[\/、,，&|]/);
  for (var i = 0; i < parts.length; i++) {
    if (wantSingers.indexOf(lyricNorm(parts[i])) >= 0) return true;
  }
  return false;
}
/* ── 被塞进正文的「制作者 / 表演者名单行」─────────────────────────────
   形态 `X：<内容>`，实测两类：
     · 广场舞 / 教学视频：`桂：王广成 庄大庆 朱挺旺 等`（一串 2~4 字人名）
     · 上传者自述：`阿阳：第一次制作`
   这两类**都能命中**，所以命中率那一栏看不出问题，但用户看到的第一行是一串人名。
   按项目明文原则「给错词比不给词更伤用户 —— 用户会以为软件坏了」，
   命中了也要判掉：这类行**不算收益**，宁可回「没找到歌词」。

   🔴 判据很窄，两条**任一**命中才剥：
     ① 冒号后按空格切成 ≥2 段，每段都是 2~4 个纯中文字（末尾允许一个「等/等等」）；
     ② 冒号后是 `第N次制作 / 录制 / 上传 / 翻唱`。
   ⚠️ 为什么必须这么窄：`男：半夜睡不着觉`、`女 依稀往梦似曾见` 这种
      **角色标记 + 真歌词**是最常见的正常写法，冒号后是一整段连续串，
      切不出 ≥2 段，两条判据都不命中 —— 这一条有专门的断言盯着，别改宽。
   ⚠️ 别放宽成「任意单字 + 冒号就剥」：正文里以「爱：」「说：」起头的正常歌词
      会被成片删掉，代价远大于漏掉几行名单（这一条上一轮已评估并否决过）。
   ⚠️ 冒号前限 1~4 字且不含空格/冒号：再长就是句子的一部分，不是名单标签。
   ⚠️ 冒号后**不许含句读标点**（，。！？；、）：人名串没有标点，
      带标点的基本是真歌词，多一道闸就少一次误伤。 */
const LYRIC_ROSTER_LABEL_RE = /^([^\s：:]{1,4})\s*[:：]\s*(.+)$/;
const LYRIC_ROSTER_NAME_RE = /^[\u4e00-\u9fa5]{2,4}$/;
/* 末尾的「等 / 等等」是名单收尾语，1~2 字，单独放行 —— 判据里「每段 2~4 字」
   这条如果不给它开口子，`王广成 庄大庆 朱挺旺 等` 反而因为最后一段 1 字而漏判。 */
const LYRIC_ROSTER_ETC_RE = /^等{1,2}$/;
const LYRIC_ROSTER_SELF_RE = /^第[一二三四五六七八九十两0-9]+次(?:制作|录制|上传|翻唱)$/;

function lyricIsRosterLine(txt) {
  const m = String(txt || '').match(LYRIC_ROSTER_LABEL_RE);
  if (!m) return false;
  const body = m[2].trim();
  if (/[，。！？；、,!?;]/.test(body)) return false;
  if (LYRIC_ROSTER_SELF_RE.test(body)) return true;
  const segs = body.split(/\s+/).filter(Boolean);
  if (segs.length < 2) return false;
  for (var i = 0; i < segs.length; i++) {
    if (LYRIC_ROSTER_NAME_RE.test(segs[i])) continue;
    if (i === segs.length - 1 && LYRIC_ROSTER_ETC_RE.test(segs[i])) continue;
    return false;
  }
  return true;
}

function lyricStripRoster(lrc) {
  const lines = String(lrc || '').split(/\r?\n/);
  let cut = 0;
  const out = lines.filter(function (ln) {
    if (!/\[\d{1,2}:\d{2}/.test(ln)) return true;
    const txt = ln.replace(/\[[^\]]*\]/g, '').trim();
    if (!txt) return true;
    if (lyricIsRosterLine(txt)) { cut++; return false; }
    return true;
  });
  return { lrc: out.join('\n'), cut: cut };
}

/* ── 裸角色标记行：`女：` 这种，冒号后**什么都没有** ──────────────────────
   实测样本：不得不爱（qq / netease 两个源都出现过）命中到的正文第一行就是一个
   孤零零的 `女：`。它算「命中」—— 因为正文里确实有一行有字 —— 但用户看到的是
   一个角色标记，等于没内容。按同一条原则（给错词比不给词更伤），这种行要剥掉。

   🔴 这是一条**独立的新规则**，不要去改上面的 LYRIC_ROSTER_*：
      名单规则要求「冒号后有内容」（`(.+)`），裸标记冒号后是空的，它压根进不去，
      把 LYRIC_ROSTER_LABEL_RE 的 `(.+)` 放宽成 `(.*)` 会让「冒号后任意内容」
      都进名单判据，误伤面一下子放大 —— 那正是我们反复否掉的放宽方向。

   ⚠️ 判据：整行（剥掉时间轴后）形如 `X：` / `X:`，冒号后**只允许空白**。
      `男：半夜睡不着觉`、`女：等一个人` 冒号后有内容，**不命中**，不许误伤。
   ⚠️ 冒号前限 1~4 字且不含空格：再长就是句子，不是角色标记。 */
const LYRIC_BARE_ROLE_RE = /^[^\s：:]{1,4}\s*[:：]\s*$/;

function lyricStripBareRole(lrc) {
  const lines = String(lrc || '').split(/\r?\n/);
  let cut = 0;
  const out = lines.filter(function (ln) {
    if (!/\[\d{1,2}:\d{2}/.test(ln)) return true;
    const txt = ln.replace(/\[[^\]]*\]/g, '').trim();
    if (!txt) return true;
    if (LYRIC_BARE_ROLE_RE.test(txt)) { cut++; return false; }
    return true;
  });
  return { lrc: out.join('\n'), cut: cut };
}

/* 还有没有真正的歌词行（带时间轴 + 有字）。用来判「删完是不是空了」。 */
function lyricHasLine(lrc) {
  const lines = String(lrc || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/\[\d{1,2}:\d{2}/.test(lines[i])) continue;
    if (lines[i].replace(/\[[^\]]*\]/g, '').trim()) return true;
  }
  return false;
}
/** 相似度 0~1：先判包含（去后缀后很常见），再用二元组 Dice 系数兜底。 */
function lyricSim(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.95;
  const A = new Set(), B = new Set();
  for (let i = 0; i < a.length - 1; i++) A.add(a.slice(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) B.add(b.slice(i, i + 2));
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return (2 * hit) / ((A.size + B.size) || 1);
}

/** 给候选打分（满分 100）。时长差是「是不是同一版」最硬的一条证据，
    所以超出容差要重罚，而不是轻轻扣一点。 */
function lyricScore(c, name, singer, wantDur) {
  /* ⚠️ 上游这两个字段是**反的**，实测证据：
       搜「稻香 - 周杰伦」 → c.song="周杰伦"  c.singer="稻香"
       搜「演员 - 薛之谦」 → c.song="薛之谦"  c.singer="演员"
       搜「起风了 - 买辣椒也用券」→ c.song="买辣椒也用券" c.singer="起风了"
       连查多首都这样，且这些条目 product_from 都是「第三方歌词」（UGC 上传填反了）。
     所以绝不能按字段名字面去比 —— 那样算出来歌名相似度约等于 0，
     所有候选都会被下限拦掉，反而一首词都搜不到（比改之前更糟）。
     两个方向都算一遍，取更像的那个方向，并且**按正确的方向回给前端**：
     旧代码 `title: c.song, artist: c.singer` 会把歌手显示成歌名、歌名显示成歌手。 */
  const nName = lyricNorm(name), nSinger = lyricNorm(singer);
  const cs = lyricNorm(c.song), ca = lyricNorm(c.singer);
  const straight = { nameSim: lyricSim(cs, nName), singerSim: lyricSim(ca, nSinger), swapped: false };
  const flipped = { nameSim: lyricSim(ca, nName), singerSim: lyricSim(cs, nSinger), swapped: true };
  const best = (flipped.nameSim + flipped.singerSim) > (straight.nameSim + straight.singerSim) ? flipped : straight;
  const nameSim = best.nameSim, singerSim = best.singerSim;
  let score = nameSim * 55 + singerSim * 25;

  /* 时长：单位可能是秒也可能是毫秒，统一折算后再比 */
  const cd = lyricDurSec(c.duration);
  const wd = lyricDurSec(wantDur);
  let durNote = '无时长信息';
  let durOk = true;                       // 「时长是否吻合」的硬判据
  if (cd > 0 && wd > 0) {
    const diff = Math.abs(cd - wd);
    if (diff <= 2) { score += 20; durNote = `时长差 ${diff}s（±2s 内，满分）`; }
    else if (diff <= 5) { score += 14; durNote = `时长差 ${diff}s`; }
    else if (diff <= 10) { score += 8; durNote = `时长差 ${diff}s（偏大）`; durOk = false; }
    else if (diff <= 20) { score += 2; durNote = `时长差 ${diff}s（很可疑）`; durOk = false; }
    else { score -= 15; durNote = `时长差 ${diff}s（重罚：基本不是同一版）`; durOk = false; }
  } else {
    score += 5;   // 没有时长可比对：给中间值，不奖不罚
    /* 请求时长为 0（上传歌恒 0、B站是视频时长）时**没法按时长校验**，
       这时候要靠「别选现场版」来兜底 —— 实测 duration=0 时酷狗排第一的是
       [al:周杰伦地表最强世界巡回演唱会]，逐句时间轴越往后漂得越多。 */
    if (LYRIC_LIVE_RE.test(String(c.song || '') + ' ' + String(c.singer || ''))) {
      score -= 25;
      durNote = '请求时长为 0，命中现场/伴奏版，重罚';
    }
  }

  /* 垃圾 UGC 特征：歌名和歌手写成同一个串（实测搜「稻香」不带歌手时，
     返回的 10 条全是 song="稻香" singer="稻香"，正文第一行还是
     「本歌曲翻唱由Vemus未音提供生产能力」这种广告）。真曲子几乎不会这样。 */
  if (cs && ca && cs === ca) score -= 20;

  /* 上游自己的 score（0~60 量级）当并列时的决胜依据，最多加 10 分 */
  score += Math.min(10, (Number(c.score) || 0) / 6);

  return { score, nameSim, singerSim, durNote, durOk, swapped: best.swapped, candDur: cd };
}

async function lyricSearch(kw, wantDur, hash) {
  const url = 'https://krcs.kugou.com/search?ver=1&man=yes&client=mobi' +
    `&keyword=${encodeURIComponent(kw)}&duration=${wantDur}&hash=${encodeURIComponent(hash || '')}`;
  /* tries=1 + 6s 超时：旧写法最坏会 3 关键词 × 2 请求 × 2 重试 × 12s ≈ 144s，
     前端一直卡在「取歌词…」。整条链路上限由 /api/lyric 那层 20s 总闸兜住
     （见 LYRIC_GATE_MS），子步骤的 6s 与总闸不冲突：谁先到算谁的。 */
  const s = await getJSON(url, { tries: 1, timeout: 6000 });
  return Array.isArray(s && s.candidates) ? s.candidates : [];
}

/* ── 「真歌手」兜底 ──────────────────────────────────────────────────
   B站 / 抖音 / 上传歌的 `singer` 字段**不是原唱**：B站是 UP 主（apiBiliSearch 里
   `singer: v.author || ''`，源码注释自己写了「不是原唱」），抖音是发布者，上传歌
   是用户填的。拿它去拼关键词等于往里塞噪音。

   真因在**召回层**，不在打分层 —— 28 首 B站曲目 51 条失败原因里，**51 条全是
   「搜索无候选」，0 条是「被判为不是同一首」**。直连上游实测：
       起风了   纯歌名 → 0 候选   起风了 - 买辣椒也用券 → 2 候选
       青花瓷   纯歌名 → 0 候选   青花瓷 - 周杰伦       → 10 候选
       海阔天空 纯歌名 → 0 候选   海阔天空 - BEYOND      → 10 候选
   必须带真歌手才召得回。所以 LYRIC_MIN_SCORE 那个下限**一个字都不动** ——
   它根本没机会登场，放宽只会把错词放进来。

   ⚠️ 别走「singer 留空」那条路：lyricSim() 里 `if (!a || !b) return 0`，
   歌手空算出来是 **0 分**，跟「歌手对不上」一个待遇；而带 UP 主名的那两条
   关键词偶尔还能撞出候选（实测「海阔天空」就是靠 `海阔天空 VV音乐局` 命中的）。
   20 首对照：留空 5/20 = 25%，比现状 7/20 = 35% **更差**。 */
var SINGER_GUESS = new Map();
var SINGER_GUESS_MAX = 2000;
/* 🔴 缓存值带写入时间戳（{ v, t }），读取时超过 SINGER_GUESS_TTL_MS 就当没命中，
   重新走一遍 guessSongInfo() 的上游查询。空结果（singer='' / dur=0）一样受 TTL
   管 —— 空结果恰恰是最需要过期的那一类：它意味着「那一次上游没给」，而不是
   「这首永远没有」。

   为什么是 24 小时（这是个拍脑袋的数，理由写在这里，后人觉得不合适可以直接改，
   但要连同理由一起改）：
     · 歌手信息本身变化**极低频** —— 一首歌的原唱不会今天一个明天一个，所以 TTL
       短了纯属浪费上游请求，而这次请求是要真打酷狗的，上限 SINGER_GUESS_MS = 4s，
       撞上就会拖慢整条取词链路。
     · 24h 真正要覆盖的是**「上游改了数据」这类低频事件**：某个条目昨天补到的是
       错歌手（比如有多位演唱者的歌取到了非目标版本），或者上游把脏数据修了。
       这类事一天之内发生一次就算多，24h 足够让它第二天自动纠正，不用重启进程。
     · 又不能太长：进程是长跑的，没有 TTL 时一个错误结果只要没被 LRU 挤掉就**永远
       是它**（这就是加 TTL 之前的状态）。24h 让「隔天再来」这个自然节奏成为纠偏点。

   ⚠️ 只加了时间维度，**容量 2000 一个字没动**（SINGER_GUESS_MAX 是调过的数）。
   两个维度各管各的：LRU 管内存上限，TTL 管新鲜度，互不影响。 */
var SINGER_GUESS_TTL_MS = 24 * 60 * 60 * 1000;
/* 哪些源的 singer 不可信、需要补真歌手。跟 /api/lyric 里 UNTRUSTED_DUR_SRC
   是同一批源（时长和歌手都不可信），但两处用途不同，不共用常量。 */
var UNRELIABLE_SINGER_SRC = { bili: 1, douyin: 1, upload: 1 };
/* 补歌手这一次上游查询的上限。为什么要限：apiSongSearch 内部要打两个域名、
   外加 apiComplexSearch，慢起来能到 10s 量级；而主链路三条关键词各自 6s，
   再叠一次就会把 20s 总闸撞开，用户看到的就变成「取词超时」而不是「没词」。
   超时按「查不到」处理，走原来的失败路径。 */
var SINGER_GUESS_MS = 4000;

/* 返回 Promise<{ singer, singer2, dur }>。
   三个值都从**同一条**酷狗搜索结果里取，只打一次上游。
     · singer：真歌手（B站 / 抖音 / 上传歌的 singer 字段不是原唱）
     · singer2：同一条 singer 字段里的**第二位**歌手（合唱曲的另一半），没有就是 ''
     · dur   ：这条曲目的时长（秒）。它同时是**召回**参数 —— 实测同一首歌
       duration 传 223 能召回录音室版，传 0 则 20 条候选全是现场版。
   ⚠️ dur 不是「顺手带的」，它是修「稻香拿到演唱会版」的主药，见 fetchLyric 里
      那段「为什么提前到第一轮之前」的说明。

   故意不写成 async function（红线：不新增 async 关键字），用 then/catch 链。

   ── 匹配口径（2026-10-16 调整，唯一一处改动）────────────────────────────
   原来是**归一化后精确同名**才认。实测它太硬，B站那类「标题里明明有正确歌名、
   只是带了 UP 主的装饰」的歌全部补不到歌手，于是关键词链全是垃圾、0 候选。
   日志实证（`补真歌手未命中` 那行上线后立刻抓到的）：
     请求串「五月天 玫瑰少年-」 → 上游返回 12 条，**第一条就是 `玫瑰少年/五月天`**
     （完全正确），但 `五月天玫瑰少年` ≠ `玫瑰少年`，精确比对不认 → 整首没词。
   所以放宽成「**包含**也算命中」，但同时加三条限制，缺一不认：
     · 两边归一化后长度都 ≥ 3 —— 两个字的词（`后来`/`演员`）包含关系太容易撞；
     · 优先取**带时长**的条目 —— 没时长的条目给不出召回参数，价值低；
     · 优先取**非现场版**（`lyricIsLive` 之外，这里按 songname/singer 里的
       live|现场|演唱会|伴奏… 判）—— 现场版的时间轴和录音室版差几十秒。
   🔴 仍然**不做**「相似度阈值模糊匹配」（那是另一回事，实测把命中率从 ~74%
      打到 50%：补错 duration 会把 krcs 的候选集整个换掉）。包含关系是**硬证据**，
      相似度是**猜测**，两者不能混为一谈。 */
function guessSongInfo(name) {
  var key = lyricNorm(name);
  var EMPTY = { singer: '', singer2: '', dur: 0 };
  if (!key) return Promise.resolve(EMPTY);
  if (SINGER_GUESS.has(key)) {
    var g = SINGER_GUESS.get(key);
    /* 新鲜就直接返回；过期了先删掉再往下走 —— 不删的话下面 keep() 重新 set，
       Map 的插入顺序会把这条挪到队尾，等于「读一次就续命」，LRU 就废了。 */
    if (Date.now() - g.t < SINGER_GUESS_TTL_MS) return Promise.resolve(g.v);
    SINGER_GUESS.delete(key);
  }

  function keep(o) {
    if (SINGER_GUESS.size >= SINGER_GUESS_MAX) SINGER_GUESS.delete(SINGER_GUESS.keys().next().value);
    SINGER_GUESS.set(key, { v: o, t: Date.now() });
    return o;
  }
  return apiSongSearch(String(name || '').trim(), 1, 12).then(function (r) {
    var list = (r && r.list) || [];
    /* 打分选条目（不再「第一条命中就返回」），取值越高越优先：
         +4 归一化后完全同名（原有口径，最可信）
         +2 包含关系（`五月天玫瑰少年` ⊃ `玫瑰少年`）—— 硬证据，不是相似度猜测
         +1 条目带时长（没时长就给不出召回参数）
         -3 现场/伴奏版（时间轴和录音室版差几十秒）
       实测对照：`五月天 玫瑰少年-` 的 12 条候选里，
         `玫瑰少年/五月天`            → 4(同名? 否，含) +1(有时长) = 3
         `玫瑰少年 (Mayday …上海站)/蔡依林、五月天` → 含 +1 时长 -3 现场 = 0
       所以会挑中第一条正确的录音室版。 */
    var best = null, bestRank = -99;
    /* 请求串按常见分隔符切段，用来判「短歌名是不是一个独立的词」。
       为什么要这一层：`刘若英-后来 后来 我总算学会了…` 里真歌名是 **2 个字**的
       「后来」，而 2 字名的包含关系太容易撞（`后来` 会命中 `后来的我们`），
       所以不能直接对 2 字名开包含。但**切段后独立成词**就是硬证据：
         `刘若英-后来…`  → 段里有「后来」   → 「后来/刘若英」 2 字也认
         `其实我也看出你有点不舍#…#演员 8D环绕` → 段里有「演员」→ 2 字也认
         `后来`           → 同时包含于「后来的我们」← 只有整体包含，不开 */
    const reqSegs = String(name || '').split(/[\s\-–—~·|｜:：,，、!！?？/\\()\[\]【】（）《》「」]+/);
    function isReqSegment(t) {
      for (var si = 0; si < reqSegs.length; si++) if (lyricNorm(reqSegs[si]) === t) return true;
      return false;
    }
    for (var i = 0; i < list.length; i++) {
      var cand = lyricNorm(list[i].songname);
      var isExact = cand === key;
      /* 包含关系分两档：
         · 两边都 ≥3 字 → 整体包含即可（`五月天玫瑰少年` ⊃ `玫瑰少年`）
         · 有一边只有 2 字 → 必须**独立成段**才认（见 reqSegs 的说明） */
      var shortSide = Math.min(cand.length, key.length);
      var contained = cand.indexOf(key) >= 0 || key.indexOf(cand) >= 0;
      var isContain = false;
      if (!isExact && contained && shortSide >= 2) {
        if (shortSide >= 3) isContain = true;
        else {
          var shorter = cand.length <= key.length ? cand : key;
          isContain = isReqSegment(shorter);
        }
      }
      if (!isExact && !isContain) continue;
      var s = lyricSinger(list[i].singer);
      if (!s) continue;
      var d = lyricDurSec(list[i].duration);
      /* 第二位歌手：**同一条** singer 字段里切出来的，不新增任何上游请求。
         🔴 只在「歌名 + 歌手」的组合关键词里用，绝不单独拿它去搜 ——
         拿单个歌手名去捞等于大海捞针，实测会捞回 Live / DJ 版和别人的歌。 */
      var s2 = String((list[i].singer || '').split(/[\/、,，&]/)[1] || '').trim();
      if (s2 && (lyricNorm(s2) === lyricNorm(s) || !s2)) s2 = '';
      var rank = (isExact ? 4 : 2) + (d ? 1 : 0);
      /* 候选名只有一小截出现在请求串里 → 它多半是噪声词的一部分，不是歌名。
         实测：脏标题的搜索结果里有 `歌曲串烧/…` `更新啦～GEM鄧紫棋/…` 这类条目，
         它们靠「包含」溜进来会带着错的歌手/时长，把召回关键词搞脏。 */
      if (isContain && cand.indexOf(key) < 0) rank -= 2;
      var isLive = LYRIC_LIVE_RE.test(String(list[i].songname || '') + ' ' + String(list[i].singer || ''));
      if (isLive) rank -= 3;
      if (rank > bestRank) {
        bestRank = rank;
        best = { singer: s, singer2: s2, dur: d, idx: i, how: isExact ? '精确' : '包含', live: isLive };
      }
      if (isExact && d) break;   // 同名且有时长：不可能更好，直接收工
    }
    if (best) {
      lyricLog('补真歌手：「' + name + '」→「' + best.singer + '」' + (best.dur ? '，时长 ' + best.dur + 's' : '，上游没给时长') +
        (best.singer2 ? '，第二歌手「' + best.singer2 + '」' : '') +
        '（' + best.how + '命中，来自酷狗搜索第 ' + (best.idx + 1) + ' 条' + (best.live ? '，是现场/伴奏版' : '') + '）');
      return keep({ singer: best.singer, singer2: best.singer2, dur: best.dur });
    }
    /* ★ 2026-10-16 唯一新增：**未命中也要留痕**。
       为什么加这一行（线上排查最缺的就是它）：命中时有日志，未命中时一行都没有，
       于是「补歌手悄悄失败」从外部完全看不出来 —— 只看到最终「没找到歌词」，
       分不清是没搜到、是比对没过、还是上游这次没给数据。
       而空结果会被缓存 24 小时（SINGER_GUESS_TTL_MS），一次偶然失败会让这首歌
       **一整天**都退化成裸歌名召回（实测 `晴天` 就是这样落到 63 分的 UGC 词上）。
       纯日志，不改任何控制流 —— 刻意**不做**「模糊补歌手」那类放宽：实测过，
       补错 duration 会把 krcs 的候选集整个换掉，命中率反而下降。 */
    lyricLog('补真歌手未命中：「' + name + '」上游返回 ' + list.length + ' 条' +
      (list.length ? '，前三条：' + list.slice(0, 3).map(function (x) { return x.songname + '/' + x.singer; }).join(' | ')
                   : '（上游没给数据，可能是限流或网络抖动）'));
    return keep(EMPTY);
  }).catch(function (e) {
    /* 查不到就查不到，绝不影响原来的失败路径 */
    return keep(EMPTY);
  });
}
async function lyricDownload(c) {
  const d = await getJSON(
    `https://lyrics.kugou.com/download?ver=1&client=pc&id=${c.id}&accesskey=${c.accesskey}&fmt=lrc&charset=utf8`,
    { tries: 1, timeout: 6000 });
  if (!d || !d.content) return null;
  return Buffer.from(String(d.content), 'base64').toString('utf8').replace(/^\uFEFF/, '');
}

async function fetchLyric(name, singer, duration, hash, opts) {
  const t0 = Date.now();
  const wantDur = Math.floor(Number(duration) || 0);
  const key = lyricCacheKey(name, singer, wantDur, hash);
  const reasons = [];
  /* force=1：跳过缓存。前端「⋯ 菜单 → 重新取词」要带这个参数，
     否则用户在 10 分钟空结果缓存期内点了也拿不到，会以为功能坏了。 */
  const force = !!(opts && opts.force);
  /* src 是「这个 singer 可不可信」的判据：bili / douyin / upload 的 singer
     不是原唱，三条关键词拼出来全是噪音，需要走 guessSongInfo 补真歌手那一路。
     前端 Api.lyric() 已经在传 src，这里零成本就能拿到。 */
  var src = (opts && opts.src) || '';

  /* ① 先看缓存（命中/空结果都缓存，但空结果只有 10 分钟） */
  const cached = force ? null : lyricCacheGet(key);
  if (cached) {
    if (cached.val) {
      return { ...cached.val, lyricDiag: { cached: true, ttl: 'hit' } };
    }
    reasons.push('缓存里是 10 分钟内的空结果');
    lyricLog(`「${name}」命中空结果缓存（10 分钟内已失败过一次），不再重复请求上游`);
    return null;
  }

  /* ② 关键词降级链：最精确到最宽松。
     歌名去装饰、歌手只取第一个（上游三种口径不清洗就搜不到，见 lyricSinger 的注释）。
     ⚠️ 最后一条**必须保留纯歌名**：L1 的结论是 hash 为空时召回会掉档，
     而「只有歌名」这一路是不带歌手噪声、命中率最高的一路；
     B站 / 抖音 / 上传歌（src=upload）本来就没有 hash，全靠这一路兜底。 */
  const nName = lyricName(name) || String(name || '').trim();
  const nSinger = lyricSinger(singer);

  /* ── 🔴 时长不可信的源：先向酷狗要「真歌手 + 真时长」，再开始第一轮 ────
     为什么必须提到第一轮**之前** —— 这是实测逼出来的，不是设计偏好：
       稻香 / src=bili 在生产上稳定拿到演唱会版，而它**第一轮就命中**：
         · singer=VV音乐局 → kw=稻香，        候选 duration 223000，首句 00:31
         · singer=周杰伦   → kw=稻香 - 周杰伦，候选 duration 213，
                            al=周杰伦地表最强世界巡回演唱会，首句 00:31
       也就是说「补歌手那一轮」压根走不到，把真时长只用在那一轮等于没改。

     根因链：/api/lyric 里 UNTRUSTED_DUR_SRC 把 bili 的时长置 0 → 召回参数
     duration=0 → 候选集里根本没有录音室版（这个现象 lyricDiag.durationUnknown
     那段注释里就写着：duration=0 → 20 条全是现场版，duration=223 → 才多出 223
     那两条）→ 打分也没法按时长筛 → 只能靠 lyricIsLive() 那一刀。
     而 lyricIsLive() 只看 [al:] 和正文开头，上面第一条 al 是空的，它判不出来。

     ⚠️ 只对 singer 不可信的源做（bili / douyin / upload，与 UNTRUSTED_DUR_SRC
     同一批）。kugou / netease / qq 一次都不打，行为逐字不变。 */
  var gSinger = '', gSinger2 = '', gDur = 0;
  if (UNRELIABLE_SINGER_SRC[src]) {
    var gi = await Promise.race([
      guessSongInfo(nName),
      new Promise(function (rs) { setTimeout(function () { rs({ singer: '', singer2: '', dur: 0 }); }, SINGER_GUESS_MS); })
    ]);
    gSinger = String((gi && gi.singer) || '');
    gSinger2 = String((gi && gi.singer2) || '');
    gDur = Number((gi && gi.dur) || 0);
  }
  /* 「可信时长」= 我们自己从酷狗补回来、且上游确实给了的那个值。
     🔴 只有它为真时下面的 B（下载到现场版就判无词）才生效 ——
     kugou / netease / qq 恒为 false，所以那几条链路的放行逻辑一个字没动。 */
  var durTrusted = gDur > 0;
  /* 召回与打分都用它：有可信时长就用可信时长，否则用请求带进来的（bili 恒 0） */
  var useDur = durTrusted ? gDur : wantDur;

  /* sg2 = 合唱曲的第二位歌手，只在**第一轮**（真歌手那一轮）传进来。
     🔴 为什么只在第一轮传：第二轮用的是原始 singer（B站 那是 UP 主名），
        在那轮追加第二歌手只会把「歌名 - UP主」这类噪音关键词翻倍，纯亏。
     🔴 追加的是「歌名 + 第二歌手」两种拼法，**没有**「只有第二歌手」这一条 ——
        拿单个歌手名去捞会捞回脏词（实测 5 首里 3 首是 Live/DJ 版或别人的歌）。 */
  function buildKws(sg, sg2) {
    var out = [];
    var arr = [sg ? nName + ' - ' + sg : '', sg ? nName + ' ' + sg : '', nName];
    /* 放在**尾部**是关键：前面是「歌名+第一歌手」「歌名」这两条召回最高的路，
       追加的两条只有在它们全失败时才付 lyricSearch 的代价 ——
       也就是**只在本来就要失败的歌上花钱**，命中正常的歌一个请求都不多打。
       （纯歌名仍在链上，只是位置从最后变成倒数第三，兜底作用没丢。） */
    if (sg2) { arr.push(nName + ' - ' + sg2, nName + ' ' + sg2); }
    for (var i = 0; i < arr.length; i++) {
      var t = String(arr[i] || '').trim();
      if (t && out.indexOf(t) < 0) out.push(t);
    }
    return out;
  }

  /* 两轮：
       第一轮 —— 补出来的真歌手 + 真时长（这一轮才召回得到录音室版）；
       第二轮 —— 原来的 singer + 同一个真时长，兜底用（万一补出来的歌手是错的，
                 别把本来能取到的词弄丢）。
     补不到东西时只有一轮（singer 用原值、时长用原值），行为与改动前一致。

     ⚠️ 不能写成「把两条关键词追加进同一个 for」。我第一版就是这么写的，结果补歌手
     那一轮**一次都没跑**：for-of 在开始遍历时就固定了迭代范围，追加不生效；改成
     下标循环也一样 —— 下标走到原长度时 `ki < kws.length` 已经不成立，那个追加
     分支根本进不去。分成两轮最直白，也不动内层那条链的任何一行。 */
  /* ── 可信 singer 源（kugou / netease / qq）的第二位歌手 ──────────────────
     这些源的 singer 字段本来就是真的，不走 guessSongInfo（UNRELIABLE_SINGER_SRC
     里没有它们），所以上面的 gSinger2 恒为空 —— 合唱曲只有第一歌手那三条关键词可用。

     实测（10 首合唱曲 × 3 轮，只测不改那轮）：
       千里之外  第一歌手 0/3，第二歌手 3/3（kugou / qq 各 3/3，netease 2/3）
       —— 这种歌的候选集里只有按第二位歌手搜才召回得到。
     🔴 只能**追加**在关键词链尾部（buildKws 的 sg2 参数），绝不替换第一歌手：
        美丽的神话 第一歌手 2/3、第二歌手 0/3 —— 替换会让本来能中的变不中。
        追加则不会：前面的关键词先试，全失败才轮到它。
     🔴 只对可信 singer 源做：bili / douyin / upload 传进来的是 UP 主名，
        从里面拆「第二位」只会拆出噪音（那条路由 gSinger2 负责，这里一个字不动）。
     ⚠️ 成本：追加的两条关键词排在尾部，命中正常的歌一次都不多打；
        只有本来就要失败的歌才多付最多两次 lyricSearch。 */
  var nSinger2 = '';
  if (!UNRELIABLE_SINGER_SRC[src]) {
    nSinger2 = String(String(singer || '').split(/[\/、,，&]/)[1] || '').trim();
    /* 同一个名字写了两遍（`周杰伦/周杰伦`）等于没第二位，别浪费那两次请求 */
    if (nSinger2 && lyricNorm(nSinger2) === lyricNorm(nSinger)) nSinger2 = '';
  }

  var rounds = [];
  if (gSinger && gSinger !== nSinger) {
    rounds.push({ singer: gSinger, kws: buildKws(gSinger, gSinger2), dur: useDur });
    reasons.push('补真歌手「' + gSinger + '」' + (durTrusted ? '、真时长 ' + gDur + 's' : '（酷狗没给时长）') +
      (gSinger2 ? '，并追加第二歌手「' + gSinger2 + '」的两种拼法' : ''));
  }
  rounds.push({ singer: nSinger, kws: buildKws(nSinger, nSinger2), dur: useDur });
  if (nSinger2) reasons.push('singer 字段里的第二位歌手「' + nSinger2 + '」追加两条关键词（尾部，前两条失败才用）');

  /* ── ★ 第三轮：脏标题专用（2026-10-16）────────────────────────────────
     只在**不可信 singer 源**（bili/douyin/upload）且标题里切得出更短的歌名段时追加。

     依据是一条决定性微测试（直连 krcs，同一个「真歌手 + 真时长」）：
       关键词「五月天 玫瑰少年- - 五月天」                    → **0 候选**
       关键词「玫瑰少年 - 五月天」                            → **10 候选**（全部 235s）
       关键词「五月天 玫瑰少年 Official Live Video - 五月天」  → **0 候选**
       关键词「玫瑰少年 - 五月天」                            → **10 候选**
       关键词「刘若英-后来 后来 我总算学会了 如何去爱… - 刘若英」→ 3 候选，但全是
                                                             185000s 的烂词
       关键词「后来 - 刘若英」                                → **13 候选**（339s）
     也就是说：**上游要的是干净歌名**，脏标题里带着 `Mayday…`/`feat.…`/`Official Live
     Video`/`后来 后来 我总算学会了…` 这类尾巴时，krcs 一条都不返回。
     而 `lyricName()` + `lyricTitleCandidates` 都清不掉这些（它们不是括号装饰）。

     为什么只取「**被分隔符独立隔开的** 2~12 字段」：
       `五月天 玫瑰少年-`            → 「玫瑰少年」（4 字）✅
       `刘若英-后来 后来 我总…`       → 「后来」（**2 字，但独立成段**）✅
       `其实我也看出你有点不舍#…#演员 8D环绕` → 「演员」（2 字，独立成段）✅
       `晴天 对唱R&B Ver. ｜原唱 周杰伦｜…`  → 会切出「原唱」这种词，但 2 字且
                                            rank 低，且第三轮排最后 —— 代价可控
     🔴 与「按标题抽歌手」那类被否掉的启发式不同：这里**不猜歌手**，用第一轮已经
        补到的真歌手；而且只在**本来就要失败**的歌上才多打这几个请求（排最后）。 */
  if (UNRELIABLE_SINGER_SRC[src]) {
    /* 先把 `feat.` / `ft.` 整块清掉：这两个词后面带人名（`五月天feat.蔡依林`），
       不先清的话切出来会剩一个「五月天feat」这种既不是歌名也不是人名的段
       （实测第一版就选中了它，还拼出了 `五月天feat - 五月天` 这种垃圾关键词）。
       🔴 分隔符里必须有 `#` / `＃`：话题标签是 B站标题里真歌名的常见位置
       （`其实我也看出你有点不舍#戴上耳机 #演员 8D环绕` 的真歌名是「演员」）。
       第一版漏了它，切出来的是「#演员」——`lyricNorm` **不剥 `#`**，于是
       既判不出长度、拼出的关键词还带井号（`#演员 - 秋思雨` → 0 候选）。
       实测漏了 `#` 时这段会选中「8D环绕」，白打一轮上游。 */
    var rawSegs = String(name || '').replace(/\b(?:feat|ft)\.?/gi, ' ').replace(/[.。]/g, ' ')
      .split(/[\s\-–—~·|｜:：,，、!！?？/\\()\[\]【】（）《》「」"“”#＃]+/);
    var nNameNorm = lyricNorm(nName);
    var picked = null, pickedScore = -1;
    /* 挑选规则：先把**绝对不可能是歌名**的段扔掉，剩下的按「越像歌名越优先」打分。
       硬条件（扔）：
         · 长度不在 2~12；纯拉丁段（`Official` `Mayday`）；与清洗后的原名相同（没清洗出东西）
         · 含歌词虚词且 >4 字（`我总算学会了`）；命中 LYRIC_FRAG_RE（`如何去爱`）
         · 就是这个源的歌手名 / 补到的真歌手名（`刘若英` 是歌手不是歌名）
       打分（不扔，只是降权 —— 这一层是被实测逼出来的）：
         · 基准 100，`|长度-4|` 每差 1 字扣 10（4 字最像歌名）
         · 命中音质/合集词（`戴上耳机` 里的「耳机」、`动态歌词`）扣 60
         · 命中 live/伴奏 扣 40
       为什么噪声段要**降权而不是扔掉**：`其实我也看出你有点不舍#戴上耳机 #演员 8D环绕`
       的真歌名是 2 字的「演员」。第一版把「戴上耳机」判定为「非噪声」直接选中、
       第二版又因为「演员」只有 2 字被长度条件扔掉，两次都没轮到正确的那一段。
       降权 + 保留 2 字段，才能让「演员」以 80 分胜出。 */
    for (var si = 0; si < rawSegs.length; si++) {
      var segRaw = String(rawSegs[si] || '').trim();
      var seg = lyricNorm(segRaw);
      if (seg.length < 2 || seg.length > 12) continue;
      if (seg === nNameNorm) continue;
      if (!/[\u4e00-\u9fa5]/.test(seg)) continue;
      if (LYRIC_PART_RE.test(seg) && seg.length > 4) continue;
      if (LYRIC_FRAG_RE.test(seg)) continue;
      if (gSinger && lyricNorm(gSinger) === seg) continue;
      if (nSinger && lyricNorm(nSinger) === seg) continue;
      var sc = 100 - Math.abs(seg.length - 4) * 10;
      if (LYRIC_NOISE_CUT.test(segRaw)) sc -= 60;
      if (LYRIC_LIVE_RE.test(segRaw)) sc -= 40;
      if (sc > pickedScore) { pickedScore = sc; picked = segRaw; }
    }
    if (picked) {
      var thirdSinger = gSinger || nSinger;
      rounds.push({ singer: thirdSinger, kws: buildKws2(picked, thirdSinger), dur: useDur, alt: true });
      reasons.push('脏标题切出更短的歌名段「' + picked + '」，按歌手「' + thirdSinger + '」加第三轮（只在前两轮全失败时才用）');
    }
  }

  /* 第三轮用的关键词：**只用干净歌名 + 歌手**，不要再拼脏原名 */
  function buildKws2(clean, sg) {
    var out = [];
    var arr = [sg ? clean + ' - ' + sg : '', sg ? clean + ' ' + sg : '', clean];
    for (var i = 0; i < arr.length; i++) {
      var t = String(arr[i] || '').trim();
      if (t && out.indexOf(t) < 0) out.push(t);
    }
    return out;
  }

  for (var round = 0; round < rounds.length; round++) {
    var rnd = rounds[round];
    var rSinger = rnd.singer;
    var rd = rnd.dur;
    var kws2 = rnd.kws;
    for (const kw of kws2) {
      let list = [];
      try {
        list = await lyricSearch(kw, rd, hash);
      } catch (e) {
        reasons.push(`关键词「${kw}」搜索失败：${(e && e.message) || e}`);
        continue;
      }
      if (!list.length) { reasons.push(`关键词「${kw}」搜索无候选`); continue; }

      /* ③ 打分排序，从最高分往下试 —— 不再盲取 candidates[0] */
      const ranked = list
        .map((c, i) => ({ c, i, ...lyricScore(c, nName, rSinger, rd) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, LYRIC_TRY_PER_KW);

      lyricLog(`「${kw}」候选 ${list.length} 个，取前 ${ranked.length} 个按分试：` +
        ranked.map(r => `#${r.i} ${r.c.song}/${r.c.singer} ${r.score.toFixed(1)}分(${r.durNote})`).join(' | '));

      let tried = 0;
      for (let ri = 0; ri < ranked.length; ri++) {
        const r = ranked[ri];
        /* ④ 下限拦截：歌名都不像，就别把别人的词当成这首的词返回 */
        if (r.nameSim < LYRIC_MIN_NAME_SIM || r.score < LYRIC_MIN_SCORE) {
          reasons.push(`候选「${r.c.song}」被判为不是同一首（歌名相似度 ${r.nameSim.toFixed(2)} / 总分 ${r.score.toFixed(1)}，低于下限）`);
          continue;
        }
        /* ④b 时长硬校验：差 >5s **且** 歌名不是严丝合缝，就换下一个候选。
           这条专治「对不上」—— 实测 duration=0 时酷狗排第一的是现场版，
           逐句时间轴越往后漂得越多（34.11→34.80、37.07→37.67…）。 */
        if (!r.durOk && r.nameSim < 0.95) {
          reasons.push(`候选「${r.c.song}」时长不吻合（${r.durNote}）且歌名非完全一致，换下一个`);
          continue;
        }
        tried++;
        let lrc = null;
        try {
          lrc = await lyricDownload(r.c);
        } catch (e) {
          /* ⑤ 下载失败（accesskey 失效等）**继续试下一个候选**，不再整条关键词放弃 */
          reasons.push(`候选「${r.c.song}」下载失败：${(e && e.message) || e}`);
          continue;
        }
        if (!lrc) { reasons.push(`候选「${r.c.song}」下载返回空内容`); continue; }

        /* ⑤c 剥掉版权行（词：/曲：/编舞：/Written by:）。放在版本判定**之前**，
           免得 `written by` 这种被下面的现场版正则误读。
           🔴 剥完**一行都不剩** → 这根本不是歌词，是名单/信息页 —— 按「未命中」
              处理去换下一个候选，**不返回一份空歌词冒充成功**
              （空歌词会让前端显示「歌词加载成功」但一片空白，比不中还糟）。 */
        const stripped = lyricStripCredit(lrc);
        if (!lyricHasLine(stripped.lrc)) {
          reasons.push(`候选「${r.c.song}」剥掉 ${stripped.cut} 行词曲/编舞等版权行后没有正文，判无词`);
          continue;
        }
        lrc = stripped.lrc;

        /* ⑤d 剥掉被塞进正文的拼接标题行（`歌名 (版本) - 歌手`）。
           跟 ⑤c 同一条规矩：剥完**一行都不剩**就按未命中换下一个候选，
           不返回空歌词冒充成功。歌名 + 歌手两个都对上才剥，见函数上方注释。 */
        const titled = lyricStripTitle(lrc, nName, [rSinger, gSinger, gSinger2]);
        if (!lyricHasLine(titled.lrc)) {
          reasons.push(`候选「${r.c.song}」剥掉 ${titled.cut} 行拼接标题后没有正文，判无词`);
          continue;
        }
        if (titled.cut > 0) reasons.push(`候选「${r.c.song}」剥掉 ${titled.cut} 行拼接标题行`);
        lrc = titled.lrc;

        /* ⑤e 剥掉被塞进正文的制作者 / 表演者名单行（`桂：王广成 庄大庆 朱挺旺 等`、
           `阿阳：第一次制作`）。跟 ⑤c / ⑤d 同一条规矩：剥完**一行都不剩** →
           按未命中换下一个候选，不返回空歌词冒充成功。
           判据很窄，`男：半夜睡不着觉` 这类角色标记 + 真歌词不受影响。 */
        const rostered = lyricStripRoster(lrc);
        if (!lyricHasLine(rostered.lrc)) {
          reasons.push(`候选「${r.c.song}」剥掉 ${rostered.cut} 行制作者/表演者名单后没有正文，判无词`);
          continue;
        }
        if (rostered.cut > 0) reasons.push(`候选「${r.c.song}」剥掉 ${rostered.cut} 行制作者/表演者名单行`);
        lrc = rostered.lrc;

        /* ⑤f 剥掉裸角色标记行（`女：` 这种冒号后没内容的）。跟前面几条同一条规矩：
           剥完**一行都不剩** → 按未命中换候选，不返回空歌词冒充成功。
           `男：半夜睡不着觉` 这类冒号后有真歌词的不受影响。 */
        const barEd = lyricStripBareRole(lrc);
        if (!lyricHasLine(barEd.lrc)) {
          reasons.push(`候选「${r.c.song}」剥掉 ${barEd.cut} 行裸角色标记后没有正文，判无词`);
          continue;
        }
        if (barEd.cut > 0) reasons.push(`候选「${r.c.song}」剥掉 ${barEd.cut} 行裸角色标记行`);
        lrc = barEd.lrc;

        /* ⑤b 下载之后再判一次版本：正文是现场/伴奏版就换下一个候选。
           这一条专治 duration=0：上传歌恒 0、B站传的是视频时长，
           这时候候选里排在前面的常常是演唱会版，逐句时间轴越往后漂得越多。

           🔴 放行条件从 `ri < ranked.length - 1` 扩成
              `|| durTrusted`：手上有可信时长还拿到现场版，说明这个关键词的候选集里
              就没有录音室版，换下一个候选也没用 —— 这时候**判无词**，不再把最后一个
              候选放出去。
              依据是本函数上方那条明文原则：给错词比不给词更伤用户。时间轴漂 31 秒
              的演唱会版，用户看到的就是「歌词比人声慢半拍、越来越离谱」，他只会
              以为软件坏了，不会以为这首歌没词。
           ⚠️ durTrusted 只在「时长是我们自己从酷狗补回来的」时为真，所以
              kugou / netease / qq 的放行逻辑一个字没动。 */
        if (lyricIsLive(lrc) && (ri < ranked.length - 1 || durTrusted)) {
          const al = (String(lrc).match(/\[al:([^\]]*)\]/) || [])[1] || '';
          reasons.push(`候选「${r.c.song}」下载到的是现场/伴奏版（[al:${al}]）` +
            (durTrusted ? '，且已有可信时长，判无词' : '，换下一个'));
          continue;
        }

        /* 按判定出来的正确方向回给前端（上游字段是反的，见 lyricScore 里的证据） */
        const title = r.swapped ? r.c.singer : r.c.song;
        const artist = r.swapped ? r.c.song : r.c.singer;
        /* ★ 超长视频不按单曲发词（2026-10-16）：实测那批 2200~33000s 的 B站条目
           全是合集/串烧/听歌向，给任何一首单曲的词都会让时间轴整首漂移，
           用户看到的是「歌词从头就对不上人声」——比没有歌词更糟。
           判据刻意**很窄**：只对 bili/douyin（它们的 duration 是视频长度）、
           只对 ≥25 分钟、而且只对「歌名与歌手是同一个串」的候选（`陈奕迅/陈奕迅`
           这种上游把歌手填成歌名的条目）。真单曲哪怕视频做长了也不受影响。
           实测拦下的：`陈奕迅 神级 合集39首…`（9314s）原本会配上 289s 的
           「陈奕迅 - 陈奕迅」47.3 分 —— 那就是一份和视频毫无关系的词。 */
        const rawVideoDur = UNRELIABLE_SINGER_SRC[src]
          ? Math.floor(parseFloat((opts && opts.videoDur != null) ? opts.videoDur : 0) || 0) : 0;
        /* ⚠️ 判据用 `nSinger`（这个源本来的 singer 字段）而不是 `artist`：
           `artist` 已经被 lyricScore 的「字段写反」修正逻辑翻转过了，
           拿它比会对不上（实测 `陈奕迅 - 陈奕迅` 那条就没拦住）。 */
        if (rawVideoDur >= 1500 && lyricNorm(title) === lyricNorm(nSinger)) {
          reasons.push(`候选「${r.c.song}」来自 ${rawVideoDur}s 的超长视频且歌名等于歌手名，判为合集/串烧，不发单曲词`);
          continue;
        }
        /* ★ 歌词碎片闸（2026-10-16）：候选歌名如果**就是请求标题开头/结尾的一整段话**
           （≥6 字），那它不是歌名，是 UP 主写的一句歌词被上游收成了同名曲。
           实测：请求 `其实我也看出你有点不舍#戴上耳机 #演员 8D环绕`（259s）配上了
           `其实我也看出你有点不舍/秋思雨`（281s）107.3 分 —— nameSim 1.00、
           时长也在合理范围内，旧的几道闸全部放行，用户看到的是**一句歌词的 DJ 版**。
           🔴 判据必须**窄**（写成「凡子串即拦」会把 `五月天 玫瑰少年` 这种正常写法
              也拦掉 —— 歌名就在请求串里是常态，不是异常）：只拦「≥6 字 **且**
              （是前缀 或 是后缀）」。所以 `玫瑰少年`(4字) `演员`(2字) `后来` 全部放行。 */
        const candNorm2 = lyricNorm(title), reqNorm2 = lyricNorm(nName);
        if (candNorm2.length >= 6 && candNorm2 !== reqNorm2 &&
            (reqNorm2.indexOf(candNorm2) === 0 || reqNorm2.lastIndexOf(candNorm2) === reqNorm2.length - candNorm2.length)) {
          reasons.push(`候选「${r.c.song}」是请求标题开头/结尾的一整段话（不是这首歌的歌名），判不是同一首`);
          continue;
        }
        const out = {
          lrc,
          title,
          artist,
          /* 上游一会儿给秒（223）一会儿给毫秒（223000），回给前端前统一折成秒。
             不折的话前端会收到 duration=319000 这种数，看着像 319000 秒。 */
          duration: lyricDurSec(r.c.duration),
          lyricDiag: {
            cached: false,
            keyword: kw,
            candidates: list.length,
            tried,
            picked: {
              song: title, singer: artist,
              rawFieldsSwapped: !!r.swapped,
              duration: Math.floor(Number(r.c.duration) || 0),
              score: Number(r.score.toFixed(1)),
              nameSim: Number(r.nameSim.toFixed(2)),
              singerSim: Number(r.singerSim.toFixed(2))
            },
            /* rd 是本轮实际用于召回与打分的时长（bili 等源会被替换成从酷狗
               补回来的真时长）。用 wantDur 的话，bili 恒为 0，
               durationUnknown 就永远是 true，看着像「还是没时长可用」。 */
            wantDuration: rd,
            durMatch: !!r.durOk,
            /* 请求时长为 0 时我们**无法**验证版本，而且实测这时候上游召回的
               候选集里根本没有录音室版（稻香：duration=0 → 20 条全是 213s 现场版，
               223s 的魔杰座一条都没有；duration=223 → 候选集里才多出 223 那两条）。
               所以这个值只能标出来给前端/排障看，服务端修不了根子。 */
            durationUnknown: rd <= 0,
            ms: Date.now() - t0
          }
        };
        lyricCacheSet(key, out);
        /* ⚠️ 这里的 duration 必须走 lyricDurSec 折成秒：上游这个字段一会儿给秒
           （223）一会儿给毫秒（207856），直接拼 `s` 会打出「207856s」这种看着像
           二十万秒的日志（打分那条链路用的是 lyricDurSec 之后的 cd / wd，没这问题）。
           原始值没丢 —— debug.picked.duration 里仍然是上游原样。 */
        lyricLog(`✅ 「${name}」取到词：选中「${r.c.song} - ${r.c.singer}」` +
          `${lyricDurSec(r.c.duration)}s（目标 ${wantDur}s），${r.score.toFixed(1)} 分`);
        return out;
      }
      if (!tried) reasons.push(`关键词「${kw}」的候选全部低于下限，一个都没试`);
    }
  }

  /* 全链路失败：缓存空结果 10 分钟，并把原因留下来。
     留原因是为了让 /api/lyric 能把「为什么没词」回给前端 ——
     以前前端只收到一句「没找到歌词」，到底是没搜到、下载失败还是被判为不同版本，谁也说不清。 */
  lyricCacheSet(key, null);
  lyricMissReason.set(key, { at: Date.now(), reasons: reasons.slice(0, 6) });
  if (lyricMissReason.size > 200) lyricMissReason.delete(lyricMissReason.keys().next().value);
  lyricLog(`❌ 「${name} - ${singer}」(${wantDur}s) 没取到歌词。原因：` + reasons.join('；'));
  return null;
}

/** 取最近一次「这首歌为什么没词」的原因，给 /api/lyric 用 */
function lyricMissOf(name, singer, duration, hash) {
  const e = lyricMissReason.get(lyricCacheKey(name, singer, Math.floor(Number(duration) || 0), hash));
  return e ? e.reasons : null;
}

/* ---------------- 后台下载任务队列 ----------------
 * 关键设计：下载**跑在服务端**，完全不经浏览器。
 *   → 浏览器里切歌、返回、关页面，都不会打断下载（物理上就是两条独立链路）
 *   → 播放器也永远不会被下载拖慢（不抢浏览器的连接和主线程）
 *   → 手机隔着隧道下单，文件直接落在这台电脑的 U 盘/硬盘上
 * 并发上限 2，流式落盘，实时记录字节进度。
 * ------------------------------------------------- */
const TASKS = new Map();
let TASK_SEQ = 0;
let TASK_MAX_CONCURRENCY = Math.min(4, Math.max(1, Number(CFG.concurrency) || 2));

/* ───────── 下载进度账本（2026-10-19）─────────
   为什么要**服务端**来记：三端要「看见下载进度」，能同时满足的通用解只有这一个。
   真正从外网搬字节的是这里（/api/proxy 边收边发），而四种落盘方式
   （桌面主进程写盘 / 安卓 SAF / iOS 分享表 / 浏览器自带下载）全都拿不到回调，
   老壳和老 APK 更是改不了。于是让页面给每次下载分配一个 dlid 塞进查询串，
   服务端按 dlid 记「总长 + 已发」，页面轮询 /api/dl/progress 就有百分比。
   四端 × 任意壳版本一律生效，谁都不用换包。

   ⚠️ 只记 dl=1（落盘）那一种：试听走的是同一条代理，拖一次进度条就是一个
      新请求，全记的话账本会被试听流量刷爆，而且播放本来也不需要进度条。
   ⚠️ dlid 由客户端生成（时间戳 36 进制 + 随机），只要不可猜即可 ——
      它暴露的信息只有「某次下载搬了多少字节」，不涉及账号与文件内容。 */
const DL_TRACK = new Map();          // dlid -> { total, done, finished, at }
const DL_TRACK_TTL = 10 * 60 * 1000; // 10 分钟没人取就清（页面崩了不会有人来取）
const DL_TRACK_MAX = 300;

function dlTrackBegin(id, total) {
  if (!id) return;
  DL_TRACK.set(id, { total: Math.max(0, total | 0), done: 0, finished: false, at: Date.now() });
  if (DL_TRACK.size <= DL_TRACK_MAX) return;
  const now = Date.now();
  for (const kv of DL_TRACK) {
    if (now - kv[1].at > DL_TRACK_TTL) DL_TRACK.delete(kv[0]);
  }
  /* 还是超量（说明有人狂刷）→ 按插入顺序丢最老的，Map 保证顺序 */
  while (DL_TRACK.size > DL_TRACK_MAX) {
    const first = DL_TRACK.keys().next();
    if (first.done) break;
    DL_TRACK.delete(first.value);
  }
}

/* 与 android/build-config.json 的 versionName 保持一致。
   一共四处，漏一处就会让用户看到两个不同的号：
     ① 这里（运营台「服务信息」读它）
     ② android/build-config.json 的 versionName + versionCode（APK 打出来是什么号）
     ③ data/app-update/manifest.json 的 version / apk.versionName / exe.version（更新弹窗读它）
     ④ build-installer.py 的 --ver（桌面端安装包标题）
   教训就写在眼前：以前这里漏改，停在 3.6.12，而 APK 已经发到 3.6.15，
   用户以为自己装错了版本。

   ⚠️ 2026-10-14 现状：四处**并没有**统一到同一个号，这是**有意为之**，不是漏改：
     · ①② 已经是 3.6.20 / versionCode 373
     · ③ 的顶层 version 是 3.6.20，但 apk.versionName / exe.version 仍停在 3.6.16
     · 原因：3.6.19 的安装包有问题已撤，372 / 373 是「改了数字但没真打包」的假版本号，
       所以发布清单不能跟着抬 —— 抬了用户会去下一个不存在的包。
   等真打出 3.6.20 的包、验证通过后，再把 ③ 的 apk/exe 字段一起抬上来。
   versionCode 的规律是「352 + 小版本号」：3.6.16→368，3.6.20→372。 */
const APP_VERSION = '3.9.0';
/* 首页构建戳注入（2026-10-19）
 * ──────────────────────────────────────────────────────────────
 * 事故：3.7.24 的桌面端大修上线后，用户看到的还是旧界面 ——
 *   他的桌面窗口从昨晚一直开着，页面没重新拉过一次；而「发布完让用户重启」
 *   不是工程做法。所以让页面**自己知道自己是不是旧的**：
 *   把 web/index.html 里的 __YM_BUILD__ 换成当前版本号再下发，
 *   页面拿它跟 /api/app/version 比，不一致就带 ?v=<版本> 自愈重载一次
 *   （查询串变了，任何缓存层都必须回源）。
 * 只在「版本 + 内容长度」变化时重算：index.html 有 1.4MB，每请求 split/join 一遍太浪费。
 *
 * 🔴 2026-10-19 第6期踩到的坑（这个缓存原来只认版本号，坑了两小时）：
 *    缓存键只有 APP_VERSION ⇒ **只要版本没变，改 web/index.html 永远不生效**，
 *    服务端把第一次读到的整份 HTML 一直吐出去。本地开发表现为
 *    「改完刷新没反应、以为 CSS 选择器写错了」，实际响应里根本没有新代码；
 *    OTA 覆盖层（update/ 目录整体换掉前端）同样需要重启进程才生效。
 *    现在键里带内容长度 —— 前端改一个字长度就变，缓存自然失效。
 *    已知局限：新版恰好与旧版**字节数完全相同**时会继续吐旧的，
 *    这种情况重启一次即可（不影响正确性，只影响这次预览）。 */
let _stampKey = null;
let _stampHtml = null;
function withBuildStamp(html) {
  const len = Buffer.isBuffer(html) ? html.length : (html ? String(html).length : 0);
  const key = APP_VERSION + ':' + len;
  if (_stampKey === key && _stampHtml != null) return _stampHtml;
  const src = Buffer.isBuffer(html) ? html.toString('utf8') : String(html);
  if (src.indexOf('__YM_BUILD__') < 0) {
    _stampKey = key; _stampHtml = html;
    return html;
  }
  _stampKey = key;
  /* ⚠️ 只替换**带引号的那个字面量**，别裸替 __YM_BUILD__ 这个标识符 ——
     2026-10-19 线上踩过：裸 replace 把属性名一起换了，下发出去是
     `window.3.7.25 = '3.7.25';`，整个 script 块直接 SyntaxError。 */
  _stampHtml = src.split("'__YM_BUILD__'").join("'" + APP_VERSION + "'");
  return _stampHtml;
}
/* 进程启动时刻：管理台首页要显示「已稳定运行多久」 */
const BOOT_AT = Date.now();

/* ---------------- 访问地址（给手机端用） ----------------
 * PWA 有个硬门槛：浏览器只在 HTTPS（或 localhost）下才允许「安装成 App」。
 * 局域网 http://192.168.x.x 在安卓上只能生成一个带地址栏的网页快捷方式，
 * 在 iOS 上因为读了 apple-mobile-web-app-capable 反而能全屏。
 * 所以把两条路都告诉用户：局域网直连（快，但要 PC 开机）和公网 https（能真正安装）。
 * --------------------------------------------------------- */
function lanAddrs() {
  const out = [];
  try {
    for (const [, arr] of Object.entries(os.networkInterfaces())) {
      for (const a of arr || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  } catch { /* ignore */ }
  return out;
}
function publicUrl() {
  // 内网穿透脚本会把最新地址写进 public-url.txt（快速隧道每次重启会变）
  try {
    const u = fs.readFileSync(path.join(APP_DIR, 'public-url.txt'), 'utf8').trim();
    return /^https?:\/\//.test(u) ? u.replace(/\/+$/, '') : '';
  } catch { return ''; }
}

/* 「本服务当前对外地址」——/addr.json 自愈锚点和 /download 下载页共用。
 *
 * 取值顺序：public-url.txt（穿透脚本/运维写的最新公网地址）> 局域网 IP > 本机回环。
 * 顺序不能反：局域网 IP 只对同网段的人有意义，公网地址才是所有人都打得开的那个。
 *
 * ⚠️ 绝不能返回空串。客户端拿到空串会当成「自愈成功」把空地址写进配置，
 *    那比不自愈更糟 —— 它连回退到内置地址的判断都会跳过。 */
function currentBase() {
  const pub = publicUrl();
  if (pub) return pub.replace(/\/+$/, '');
  const lan = lanAddrs()[0];
  if (lan) return 'http://' + lan + ':' + PORT;
  return 'http://127.0.0.1:' + PORT;
}

const taskPublic = t => ({
  id: t.id, name: t.name, singer: t.singer, source: t.source, sourceName: t.sourceName || '',
  quality: t.quality, ext: t.ext, status: t.status,
  received: t.received, total: t.total,
  receivedText: fmtSize(t.received), totalText: t.total ? fmtSize(t.total) : '',
  percent: t.total ? Math.min(100, Math.round(t.received / t.total * 100)) : null,
  path: t.path, dir: t.dir, error: t.error, startedAt: t.startedAt, endedAt: t.endedAt,
  /* skipped: 同体积的文件已经在，这次没重复下载（前端据此说「已经有了」） */
  skipped: !!t.skipped
});

function pumpTasks() {
  let slots = TASK_MAX_CONCURRENCY - [...TASKS.values()].filter(t => t.status === 'running').length;
  for (const t of TASKS.values()) {
    if (slots <= 0) break;
    if (t.status === 'queued') { slots--; runTask(t); }
  }
}

async function runTask(t) {
  t.status = 'running'; t.startedAt = Date.now();
  const tmpRef = { p: '' };
  try {
    fs.mkdirSync(t.dir, { recursive: true });
    const ext = safeName(t.ext || 'mp3');
    // 命名规则：用户可选「歌名 - 歌手」或「歌手 - 歌名」
    const pair = t.naming === 'singer-song'
      ? `${t.singer || '未知歌手'} - ${t.name || 'audio'}`
      : `${t.name || 'audio'} - ${t.singer || ''}`;
    const base = safeName(pair.replace(/\s+-\s+$/, ''));
    let file = path.join(t.dir, `${base}.${ext}`), i = 1;
    /* 同一首、同体积的文件已经在 → 认成「已完成」，不再下一份。
       以前是无条件改名成「歌名 (1).mp3」：同一首点两次就是两份 60MB，
       用户过两天发现整个下载目录全是 (1)(2)(3)，也不知道哪份是好的。
       只比体积不比哈希：这里判的是「上次那份是不是完整下完的」，而落盘前
       已经做过 90%+ 的完整性校验，体积对上就够；要防的是「同名不同版本」，
       那靠体积本来就拦不住，得靠用户改文件名。 */
    const existedSize = (() => {
      try { return fs.statSync(file).size; } catch { return -1; }
    })();
    /* 只看「文件在不在」就够：最终文件名是最后一步 rename 出来的，
       中途断掉的只会是 .part。所以这个名字下的文件 = 上次完整下完的那份。
       体积拿得到时再校一次，防的是同名不同版本被误判（差 4KB 以内算同一份）。 */
    if (!t.force && existedSize > 0 && (!t.total || Math.abs(existedSize - t.total) <= 4096)) {
      t.path = file; t.size = existedSize; t.sizeText = fmtSize(existedSize);
      t.status = 'done'; t.endedAt = Date.now(); t.skipped = true;
      if (t.lyric) {
        try { writeFileAtomic(file.replace(/\.(mp3|flac|m4a|ape|wav|ogg)$/i, '') + '.lrc', t.lyric, 'utf8'); } catch { /* ignore */ }
      }
      return;
    }
    while (fs.existsSync(file)) file = path.join(t.dir, `${base} (${i++}).${ext}`);
    t.path = file;

    // 磁盘余量检查（U 盘容易满，提前拦）
    try {
      const st = fs.statfsSync(t.dir);
      const free = st.bavail * st.bsize;
      if (t.total && free < t.total * 1.1) throw new Error(`目标盘剩余空间不足（剩 ${fmtSize(free)}）`);
    } catch (e) { if (/剩余空间不足/.test(e.message)) throw e; }

    /* U-52：逐跳安检。signal 用任务自己的 controller —— 取消下载必须还能取消 */
    const tf = await netFetch(t.url, {
      where: '/api/task',
      headers: { 'User-Agent': uaFor(t.url), Referer: refererFor(t.url) || undefined },
      signal: t.controller.signal
    });
    if (!tf.ok) throw new Error(tf.why ? ('这个地址不允许下载：' + tf.why) : ('音源拉取失败：' + humane(tf.err)));
    const up = tf.res;
    if (!up.ok) throw new Error('音源拉取失败 HTTP ' + up.status);
    const clen = Number(up.headers.get('content-length') || 0);
    if (clen) t.total = clen;

    const tmp = file + '.part'; tmpRef.p = tmp;
    const ws = fs.createWriteStream(tmp);
    const reader = up.body.getReader();
    let received = 0;
    for (; ;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      t.received = received;
      if (!ws.write(Buffer.from(value))) await new Promise(r => ws.once('drain', r));
    }
    await new Promise((ok, no) => ws.end(err => (err ? no(err) : ok())));

    const size = fs.statSync(tmp).size;
    // 完整性校验：拿不到预期体积就跳过；拿得到就必须达到 90% 以上
    if (t.total && size < t.total * 0.9) {
      throw new Error(`下载不完整（${fmtSize(size)} / ${fmtSize(t.total)}）`);
    }
    fs.renameSync(tmp, file);
    tmpRef.p = '';

    if (t.lyric) {
      /* 歌词是小文件，但半截的 lrc 会让播放器解析失败，一样走 tmp+rename */
      try { writeFileAtomic(file.replace(/\.(mp3|flac|m4a|ape|wav|ogg)$/i, '') + '.lrc', t.lyric, 'utf8'); } catch { /* ignore */ }
    }
    t.size = size; t.sizeText = fmtSize(size);
    t.status = 'done'; t.endedAt = Date.now();
  } catch (e) {
    if (t.status === 'canceled') { t.error = '已取消'; }
    else { t.status = 'failed'; t.error = e.name === 'AbortError' ? '已取消' : humane(e, '下载失败了，重试一下'); }
    t.endedAt = Date.now();
    try { if (tmpRef.p && fs.existsSync(tmpRef.p)) fs.unlinkSync(tmpRef.p); } catch { /* ignore */ }
  } finally {
    pumpTasks();
  }
}

/* ---------------- 磁盘与目录浏览（下载路径任意化：硬盘 / U 盘 / 移动硬盘） ---------------- */

/* 盘符类型探测：靠 Win32_LogicalDisk.DriveType 区分「U盘/移动盘」和「本机磁盘」。
 * Node 没有原生 API 能拿到这个信息（statfs 只给文件系统名，如 NTFS），
 * 唯一的可靠来源是 WMI。这里用 PowerShell 查一次、缓存 15 秒，并且：
 *   - 探测失败绝不抛错，静默退回盘符启发式（A/B 类软驱 + D 之后的盘符当可移动盘）
 *   - 15 秒 TTL 是为了「刚插上 U 盘再打开设置」也能刷新到
 *   - 加 windowsHide，避免黑框闪一下
 * DriveType 取值：2=可移动 3=本地固定 4=网络 5=光驱 6=RAM
 * ------------------------------------------------------------------------- */
let DRIVE_TYPES = { at: 0, map: {} };
function probeDriveTypes() {
  const now = Date.now();
  if (now - DRIVE_TYPES.at < 15000) return DRIVE_TYPES.map;
  DRIVE_TYPES.at = now;
  const map = {};
  if (process.platform === 'win32') {
    try {
      const sys = process.env.SystemRoot || 'C:\\Windows';
      const abs = path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const exe = fs.existsSync(abs) ? abs : 'powershell.exe';
      const cmd = 'Get-CimInstance Win32_LogicalDisk | ForEach-Object { $_.DeviceID + "|" + $_.DriveType }';
      const out = execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', cmd],
        { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of String(out).split(/\r?\n/)) {
        const m = line.trim().match(/^([A-Za-z]):\|(\d+)$/);
        if (m) map[m[1].toUpperCase()] = Number(m[2]);
      }
    } catch { /* 探测失败 → 空表，listDrives 里走启发式 */ }
  }
  DRIVE_TYPES.map = map;
  return map;
}

function listDrives() {
  const out = [];
  const types = probeDriveTypes();
  if (process.platform === 'win32') {
    for (let c = 65; c <= 90; c++) {          // A: ~ Z:
      const letter = String.fromCharCode(c);
      const root = letter + ':\\';
      try {
        if (!fs.existsSync(root)) continue;
        /* ⚠️ statfs 只用来「补容量」，绝不能拿来当准入条件。
         * 老写法是 `if (!st || !st.blocks) continue;` —— 而 Node 在 Windows 上
         * 的 statfsSync 对 U 盘 / 移动硬盘 / 部分读卡器会抛错或返回 0 块，
         * 于是这些盘被静默跳过：用户明明在「此电脑」里看得见 U 盘，
         * 下载位置里却没有它。现在的规矩是 —— existsSync 通过就算这块盘在，
         * 容量读不到就照实显示「容量未知」，而不是假装它不存在。 */
        let st = null;
        try { st = fs.statfsSync(root); } catch { st = null; }
        const hasCap = !!(st && st.blocks);
        const dt = types[letter];
        /* 空光驱：容量读不到 + WMI 说是光驱 → 跳过，免得刷出一排点进去是空的 */
        if (!hasCap && dt === 5) continue;
        out.push({
          root, letter,
          free: hasCap ? st.bavail * st.bsize : 0,
          total: hasCap ? st.blocks * st.bsize : 0,
          freeText: hasCap ? fmtSize(st.bavail * st.bsize) : '',
          totalText: hasCap ? fmtSize(st.blocks * st.bsize) : '',
          ready: hasCap,
          removable: dt != null ? dt === 2 : c > 67,   // 优先用真实盘型；测不到才退回启发式
          kind: dt == null ? 'unknown' : (dt === 2 ? 'removable' : dt === 4 ? 'network' : dt === 5 ? 'cdrom' : dt === 6 ? 'ram' : 'fixed')
        });
      } catch { /* 该盘不可用 */ }
    }
  } else {
    try { const st = fs.statfsSync('/'); out.push({ root: '/', letter: '/', free: st.bavail * st.bsize, total: st.blocks * st.bsize, freeText: fmtSize(st.bavail * st.bsize), totalText: fmtSize(st.blocks * st.bsize) }); } catch { /* ignore */ }
  }
  return out;
}

const SKIP_DIR = /^(System Volume Information|Config\.Msi|RECYCLE\.BIN|\$RECYCLE\.BIN|\$WinREAgent|\$SysReset|\$GetCurrent|Windows|Program Files|Program Files \(x86\)|ProgramData|AppData)$/i;

/* 「此电脑」里的常用位置 —— 用户挑下载目录时，八成是桌面 / 下载 / 文档 / 音乐之一，
   没必要每次都从盘符一层层点进去。返回时只留真实存在的那些。 */
/* 在文件管理器里打开 / 定位一个路径。
 * Windows 用 explorer，macOS 用 open，有桌面的 Linux 用 xdg-open；
 * **没有桌面环境的服务器（云端部署就是这种情况）直接跳过并返回 false**。
 *
 * 为什么要单独封一层：spawn 出来的进程如果启动失败（命令不存在、无 DISPLAY），
 * 会往 child 上抛 'error' 事件；没挂监听的话 Node 会把它当成未处理异常，
 * 直接把整个服务进程崩掉 —— 就因为有人点了一下界面上的「打开文件夹」。
 * 所以这里除了做平台判断，还给每个 spawn 兜了 .on('error')。 */
function spawnShell(cmd, args) {
  try {
    const c = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    c.on('error', () => { /* 打不开就算了，不能让它拖垮服务 */ });
    c.unref();
    return true;
  } catch { return false; }
}
function revealNative(target, select) {
  if (!target) return false;
  if (process.platform === 'win32') return spawnShell('explorer.exe', [select ? '/select,' + target : target]);
  if (process.platform === 'darwin') return spawnShell('open', [select ? '-R' : '', target].filter(Boolean));
  // Linux 上必须是「有桌面」才试：headless 服务器没 DISPLAY，xdg-open 必失败
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return spawnShell('xdg-open', [target]);
  return false;
}

function quickPlaces() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir() || '';
  const cands = [
    ['桌面', path.join(home, 'Desktop')],
    ['下载', path.join(home, 'Downloads')],
    ['文档', path.join(home, 'Documents')],
    ['音乐', path.join(home, 'Music')],
    ['视频', path.join(home, 'Videos')],
  ];
  return cands.filter(p => { try { return fs.existsSync(p[1]); } catch { return false; } })
    .map(p => ({ name: p[0], path: p[1] }));
}

/* ---------------- 服务端路径安全网（U-43）-------------------------------
 * /api/browse · /api/mkdir · /api/reveal 是三个**直接对服务端文件系统下手**的口子：
 * 一个列目录、一个递归建目录、一个开系统资源管理器。
 * 以前它们既不查登录、也不约束路径 —— 而生产机是公网可达的，
 * 等于任何人一条 curl 就能 GET /api/browse?dir=/etc 翻系统目录、
 * POST /api/mkdir {"dir":"/etc/x"} 在任意位置建目录。
 *
 * 三层防护，缺一不可：
 *   ① fsApiGuard()：查登录态，未登录 401；
 *   ② fsPathReachable()：白名单，不在允许区之内 403（本轮 D1 加的，排在黑名单之前）；
 *   ③ sysPathDeny()：系统敏感路径黑名单，命中 403。
 * 三层都要 —— 只查登录的话，任何一个注册用户照样能翻 /root；
 * 只查路径的话，不登录的人一样能列遍整台机器。
 *
 * ⚠️ 黑名单的准绳是「排除系统敏感路径」，**不是**「只允许一个写死目录」：
 *    这个选择器的正经用途就是给服务端挑下载目录，/opt/ymusic（云端部署目录）、
 *    /home、/mnt、/media、Windows 各数据盘根目录（D:\、E:\…）照常要能列能选，
 *    否则功能就废了。
 * ---------------------------------------------------------------------- */
/* Windows 系统盘上的系统目录。数据盘根目录（D:\、E:\…）不在此列，必须照常可用。 */
const SYS_DENY_WIN = [
  'windows', 'windows.old', 'winsxs', 'program files', 'program files (x86)', 'programdata',
  'documents and settings', 'system volume information', '$recycle.bin', 'recovery', 'perflogs',
  'users\\default', 'users\\default user', 'users\\all users', 'users\\administrator',
  'boot', 'bootmgr', 'hiberfil.sys', 'pagefile.sys', 'swapfile.sys',
];
/* Linux 系统目录。/opt /home /srv /mnt /media /data 等数据区一律放行。 */
const SYS_DENY_POSIX = [
  'bin', 'sbin', 'boot', 'dev', 'etc', 'lib', 'lib32', 'lib64', 'libx32', 'proc', 'root',
  'run', 'sys', 'usr', 'var', 'snap', 'selinux', 'lost+found', 'vmlinuz', 'initrd', 'vmlinux',
];

/* 把外部传进来的路径解析成一条**可比较**的绝对路径：
 * 先 path.resolve —— 顺带把 ../ 折叠掉，堵住 /opt/ymusic/../../etc 这种绕法；
 * 再 realpathSync 一次 —— 堵住「软链接指向系统目录」那种绕法。
 * 目标还不存在时（mkdir 的新目录）realpath 会抛，那就用解析值判，够用。 */
function normFsPath(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  let r = '';
  try { r = path.resolve(process.platform === 'win32' ? raw.replace(/\//g, '\\') : raw); } catch { return ''; }
  try { const rp = fs.realpathSync(r); if (rp) r = rp; } catch { /* 还不存在：按解析值判 */ }
  return r;
}

/* 命中系统敏感路径返回一句人话，没命中返回 ''。
 * 比法是：剥掉盘符/根，按**整段**前缀比对（/etcx 不算 /etc，/etc/xxx 才算）。 */
function sysPathDeny(p) {
  const raw = String(p || '').trim();
  if (!raw) return '这个位置不认识，换一个试试';
  const r = normFsPath(raw);
  if (!r) return '这个位置不认识，换一个试试';
  /* 用哪张表，看**传进来的路径长什么样**，而不是只看本机是什么系统：
     /etc 这种 POSIX 写法，就算是在 Windows 上递进来，也是冲着系统目录去的 ——
     不认它就会被 path.resolve 折成 D:\etc，然后真的在 D 盘根目录建出一个 etc。
     反过来 D:\dev 这种不带 / 的 Windows 写法，绝不会被 POSIX 那张表误伤。 */
  /* ⚠️ 盘符路径（C:/Windows、D:/data…）与 UNC（\\host\share）一律算 Windows 形态，
     与分隔符方向无关 —— 「里面有没有反斜杠」挑表会让 C:/Windows 判成 POSIX 形态、
     去查一张没有 windows 的表，直接绕过黑名单。同一个目录必须永远选中同一张表。 */
  const winDrive = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\');
  const posixShaped = !winDrive && (raw.charAt(0) === '/' || (raw.indexOf('/') >= 0 && raw.indexOf('\\') < 0));
  /* Windows 上两张表都查（取并集）：本机是 Windows 时，POSIX 写法（/etc）和
     盘符写法（C:/Windows）都可能是真攻击，二选一必然留半边选择题。 */
  const lists = process.platform !== 'win32'
    ? (posixShaped ? [SYS_DENY_POSIX] : [SYS_DENY_WIN])
    : [SYS_DENY_WIN, SYS_DENY_POSIX];
  let tail = r;
  try {
    const root = path.parse(r).root;
    if (root && tail.toLowerCase().startsWith(root.toLowerCase())) tail = tail.slice(root.length);
  } catch { /* 解析不出根就整体比 */ }
  /* 分隔符归一化：把 \ 统一折成 / 再比 —— C:\Windows、C:/Windows、C:/Windows\
     三种写法落到同一条 tail 上，不存在「换个斜杠方向就从禁止变放行」。 */
  tail = tail.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!tail) return '';     // 盘符根（C:\、D:\）本身放行：数据盘要能选
  for (const list of lists) {
    for (const d0 of list) {
      const d = d0.replace(/\\/g, '/');
      if (tail === d || tail.startsWith(d + '/')) return '系统目录不能碰：' + r;
    }
  }
  return '';
}

/* ---------------- D1 · 服务端路径白名单 -------------------------------
 * 背景（能力矩阵 §2.1 点名，P0 安全）：目录选择器没有根目录限制，
 * 云端部署时能一路点到 /etc、/proc、/root —— 生产是 Linux，这就是
 * 「任意用户能浏览整个服务器文件系统」。
 *
 * 上面那张 sysPathDeny() 是**黑名单**，而黑名单的准绳是「漏一个就是漏」：
 * /var/log、/home/别人的目录、/usr/lib 下面的东西，表上一个都没有，
 * 照样能从头翻到尾。所以这一轮在它前面加一道**白名单**：
 * 先框出「这台机器的允许根」，既不落在任何一根之下、也不是通往它们的上层目录的
 * 路径，一律拒绝。
 *
 * 两道闸的分工，谁也不能替谁：
 *   白名单 —— 负责「哪些区域是数据区」（跨盘、跨挂载点，随机器的配置和环境变，只能算）；
 *   黑名单 —— 负责「系统目录」（固定那几十个，逐个点名）。
 * 光有白名单不行：C:\Windows 落在允许根 C:\ 之下，白名单看不见；
 * 光有黑名单不行：/var/log 它压根没写。顺序是「白名单 → 黑名单」，两层都要过。
 *
 * ⚠️ 跨平台（开发机 Windows / 生产 Linux）的两条硬规矩：
 *   ① 比较口径按**路径形态**选，不用 path.sep 一把抓 —— path.sep === '/'
 *      那条分支在 Windows 开发机上根本走不到，写错了 CI 不红、日志不响，
 *      等到生产才开始泄数据。形态只有两种：盘符 / UNC → 走 win 口径；
 *      其余（包括 Windows 上递进来的 /etc）→ 走 path.posix 口径。
 *      这条判据与 sysPathDeny() 里挑表的那条完全同源，同一个路径两边必须同口径。
 *   ② POSIX 根 '/' **永远不许进允许列表**：任何 posix 路径都在 '/' 之下，
 *      把它放进来等于白名单作废（/etc 立刻合法）。
 * -------------------------------------------------------------------- */
/* 盘符后跟分隔符 **或直接结束** 都算 Windows 形态 ——
   'C:' 在 path.win32.resolve 里就是 C:\，用户在路径框里手敲时不带斜杠很常见，
   判成 POSIX 形态会被 path.posix.resolve 拼成 <cwd>/C: 这种怪物，直接误拒。 */
const WIN_PATH_SHAPE = /^[A-Za-z]:([\\/]|$)/;
/* 形态判据只看「有没有盘符 / 是不是 UNC」，与斜杠方向无关 ——
   C:/Windows 和 C:\Windows 必须永远判成同一种形态，否则换个写法就从一套口径
   跳到另一套，黑名单白名单同时被打穿。 */
function isWinShape(s) { const r = String(s || ''); return WIN_PATH_SHAPE.test(r) || r.startsWith('\\\\'); }
/* Windows 口径：折斜杠 + 整串小写（NTFS 不区分大小写） */
function cmpWin(p) { return String(p).replace(/\//g, '\\').toLowerCase().replace(/\\+$/, ''); }
/* POSIX 口径：一律 path.posix，不去碰 path 默认实现 —— 默认实现在开发机上是 win32。 */
function cmpPosix(p) {
  try { return path.posix.normalize(String(p).replace(/\\/g, '/')).replace(/\/+$/, '') || '/'; }
  catch { return String(p); }
}
/* child 是否等于 root 或落在 root 之下。按**整段**比：/homex 不算落在 /home 之下。 */
function pathUnder(root, child) {
  if (!root || !child) return false;
  const win = isWinShape(root) || isWinShape(child);
  const a = win ? cmpWin(root) : cmpPosix(root);
  const b = win ? cmpWin(child) : cmpPosix(child);
  if (!a || !b) return false;
  if (b === a) return true;
  if (win) return b.startsWith(a + '\\');
  return a === '/' ? true : b.startsWith(a + '/');
}
/* 白名单专用的路径解析（与 normFsPath() 分开的理由见下）。
 * 形态决定用哪个 path 实现：盘符/UNC 走 path.win32，其余走 path.posix ——
 * 不用默认 path.resolve，那台机器上它是什么取决于本机系统，测不到另一边。 */
function resolveFsPath(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  let r = '';
  try { r = isWinShape(raw) ? path.win32.resolve(raw) : path.posix.resolve(raw); } catch { return ''; }
  if (!r) return '';
  /* realpathSync 用来堵「软链接指向允许区之外」那种绕法；目标还不存在时它会抛，
     那就用解析值判（mkdir 的新目录就是这种情况）。 */
  try {
    const rp = fs.realpathSync(r);
    if (rp && isWinShape(rp) === isWinShape(r)) r = rp;
  } catch { /* 还不存在：维持解析值 */ }
  return r;
}
/* 计算允许根（真身）。每次都算一遍是最准的，但算一遍要 existsSync 二十几个盘符，
   而列目录时每个子项都要判一次 —— 400 个子项就是上万次 stat，
   接口会从「秒回」变成「肉眼可见地卡」。所以外面套一层短缓存：
   3 秒内复用，且**当前下载目录一变就作废**（改了目录立刻能选新的）。 */
function computeAllowedFsRoots() {
  const roots = [];
  const seen = new Set();
  const push = p => {
    const raw = String(p || '').trim();
    if (!raw) return;
    let n = '';
    try { n = isWinShape(raw) ? path.win32.resolve(raw) : path.posix.resolve(raw); } catch { return; }
    if (!n) return;
    if (!isWinShape(n) && cmpPosix(n) === '/') return;   // 🔴 POSIX 根绝不进表，见上方 ②
    const k = n.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k); roots.push(n);
  };
  /* ① 正在用的下载目录 + 程序目录：永远放行。
        用户连自己当前那个目录都列不出来，就没法管理它 —— 这是功能的下限。 */
  push(CFG.downloadDir);
  push(APP_DIR);
  /* ② 用户主目录：桌面 / 下载 / 文档都在这儿，Windows 上 USERPROFILE，Linux 上 HOME。 */
  const home = process.env.HOME || process.env.USERPROFILE || (() => { try { return os.homedir(); } catch { return ''; } })() || '';
  if (home) push(home);
  /* ③ 本机真实存在的挂载点。口径跟 listDrives() 一致（existsSync 通过就算在），
        不能用 statfsSync 当准入 —— U 盘在 Windows 上读不到容量，
        按容量过滤会把用户的移动硬盘静默藏掉。 */
  if (process.platform === 'win32') {
    for (let c = 65; c <= 90; c++) {
      const root = String.fromCharCode(c) + ':\\';
      try { if (fs.existsSync(root)) push(root); } catch { /* 这盘不在 */ }
    }
  } else {
    /* Linux 这条分支必须单独列，不能照抄「给根」的思路。
       Windows 上把盘符根（C:\、D:\…）放进去是可以的 —— 危险的是 C:\Windows
       这种，由黑名单逐个点名；而 Linux 的根 '/' 下面直接就是 /etc /proc /root，
       把它当盘符根放进去，白名单当场作废。
       所以 POSIX 侧只给**数据区**，每条都要说得出放它的理由：
         /mnt · /media —— 外挂盘/移动硬盘的挂载点，对应 Windows 的 U 盘（P0 需求点名的）。
         /srv · /data  —— 服务器上的数据区，运维常把下载目录放这儿。
       ⚠️ '/home' 和 '/opt' 刻意**不放**：这两个目录下会有别人的东西
         （/home/张三、/opt/张三的服务），放进来等于把同机其他租户的目录交给浏览器。
         真用到它们不必靠这张表 —— CFG.downloadDir / HOME / APP_DIR 都已单独入表，
         从根往下走到它们，靠的是 fsPathReachable() 里「通往允许区也算」那一条。 */
    for (const d of ['/mnt', '/media', '/srv', '/data']) {
      try { if (fs.existsSync(d)) push(d); } catch { /* ignore */ }
    }
  }
  return roots;
}
let ALLOW_ROOTS = { at: 0, key: '', list: [] };
function allowedFsRoots() {
  const key = String((CFG && CFG.downloadDir) || '');
  const now = Date.now();
  if (ALLOW_ROOTS.list.length && now - ALLOW_ROOTS.at < 3000 && ALLOW_ROOTS.key === key) return ALLOW_ROOTS.list;
  ALLOW_ROOTS = { at: now, key, list: computeAllowedFsRoots() };
  return ALLOW_ROOTS.list;
}
/* 路径是否被允许 —— 「列子项」和「接受一次请求」共用这一条判据，
 * 两条线同一个标准，才不会出现「列表里看得见、点进去却 403」这种病。
 *
 * 认可的比「落在允许根之下」宽一档：也认**通往**某个允许根的祖先
 *   （允许根是 HOME=/home/ubuntu 时，/ 和 /home 都要能列，否则用户走不过去）。
 * 配合 browseDir() 里的子项过滤，实际效果是：Linux 上 '/' 能列出来
 *   （用户点的就是 /api/drives 里那一项），但下一层只剩通往允许区的那几个孩子，
 *   /etc /proc /root 既列不出来、直接点也 403。 */
function fsPathReachable(rawPath) {
  const r = resolveFsPath(rawPath);
  if (!r) return false;
  const roots = allowedFsRoots();
  if (!roots.length) return false;
  for (const root of roots) if (pathUnder(root, r) || pathUnder(r, root)) return true;
  return false;
}

/* 请求是否来自本机回环。桌面端 / 本地脚本版就是这种；
 * 公网部署（HOST=0.0.0.0）时浏览器是直连，拿到的是真实公网 IP。
 * 与 /api/auth/smtp 那条「为了安全，只有本机可以改发信配置」是同一个判据。 */
function isLocalReq(req) {
  const a = ipOfReq(req);
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/* 这个目录**真的能写**吗 —— 建目录 + 写一个探针文件 + 删掉。
 *
 * 为什么不能只信 existsSync / accessSync(W_OK)：
 *   · existsSync 只说"在不在"，盘根永远存在，但写不进去；
 *   · accessSync(W_OK) 在 Windows 上对盘根会给出偏乐观的结果
 *     （ACL 允许但卷本身有写保护 / 是光驱 / 是只读挂载时它照样通过）。
 * 只有真的落一个文件下去，才知道下载器往后能不能在这儿干活。
 *
 * 探针文件带 pid + 时间戳，多进程/并发同时探测也不会互相踩；
 * 任何异常都收敛成 false，调用方按"不可写"处理，不往外抛。
 */
function pathWritable(dir) {
  let probe = '';
  try {
    /* ★ 已经存在的目录不要再 mkdir。
       Windows 上对盘根（D:\）调 mkdirSync(recursive:true) 会抛 EPERM ——
       哪怕它明明就在那儿、明明写得进去。实测：同一个进程里
       mkdirSync('D:\') → EPERM，writeFileSync('D:\.tmp') → 成功。
       原来无条件 mkdir 的写法把「本来能写的目录」判成不可写，
       前端于是拒绝保存下载位置，用户只看到一句"不能写入"却怎么换都不行。 */
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    probe = path.join(dir, '.ym-wtest-' + process.pid + '-' + Date.now());
    fs.writeFileSync(probe, 'ok');
    return true;
  } catch {
    return false;
  } finally {
    if (probe) { try { fs.unlinkSync(probe); } catch { /* 本来就没写成功，忽略 */ } }
  }
}

/* 三个磁盘接口的统一门禁：先查登录，再查路径。
 * 被拒时响应已经发出去了，返回 null 让调用方直接 return ——
 * 不抛异常，免得把请求处理链路打断、连接挂着不断。
 * rawPath 传 null 表示「这一跳没有真路径」（例如「此电脑」虚拟节点），只查登录。 */
function fsApiGuard(req, res, rawPath) {
  const sess = userOf(req);
  if (!sess || !sess.user) {
    sendJSON(res, { ok: false, needLogin: true, error: '操作服务端目录需要先登录账号' }, 401);
    return null;
  }
  if (rawPath != null) {
    /* 顺序：**白名单在前，黑名单在后**。理由见上面 D1 那一节 ——
       白名单负责「哪些区域是数据区」，黑名单负责「系统目录」，各管一段。
       合成一道查只会互相掩盖：到时候说不清到底是白名单漏了还是黑名单没写。 */
    if (!fsPathReachable(rawPath)) {
      /* 允许区算不出来时 fsPathReachable() 一律 false —— 宁可全拒也不能全放，
         全放就是本轮要堵的那个洞本身。 */
      sendJSON(res, { ok: false, deny: 'outside-allow', error: '这个位置不在允许访问的范围内：' + String(rawPath) }, 403);
      return null;
    }
    const why = sysPathDeny(rawPath);
    if (why) { sendJSON(res, { ok: false, deny: 'system', error: why }, 403); return null; }
  }
  return sess.user;
}

/* dir === '@pc' 是「此电脑」这个虚拟节点：只回盘符列表，不进任何目录。
   前端点「此电脑」时用它，避免空串被当成「回落当前下载目录」。 */
function browseDir(dir) {
  const raw = (dir || '').trim();
  if (raw === '@pc') return { dir: '@pc', parent: '', dirs: [], drives: listDrives(), quick: quickPlaces() };
  const target = raw || CFG.downloadDir;
  let st;
  try { st = fs.statSync(target); }
  catch (e) {
    /* 「盘不在」和「不让我看」是两种病，得开两张方子：
       · 盘符不存在（U 盘拔了 / 移动硬盘没插）→ 提示检查设备
       · 权限被拒（系统目录 / 别人的用户目录）→ 提示换个文件夹
       以前一股脑报「没有权限」，用户根本不知道该去插 U 盘还是改目录。 */
    const m = String((e && e.message) || e || '');
    if (/EACCES|EPERM|EROFS/i.test(m))
      throw new Error('这个文件夹不让读写，换一个试试：' + target);
    throw new Error('这个位置现在打不开，可能是盘没插上或文件夹已被删除：' + target);
  }
  if (!st.isDirectory()) throw new Error('这不是一个文件夹：' + target);
  let dirs = [];
  try {
    dirs = fs.readdirSync(target, { withFileTypes: true })
    .filter(d => {
      try { return d.isDirectory() && !SKIP_DIR.test(d.name) && !d.name.startsWith('.') && !d.name.startsWith('$'); } catch { return false; }
    })
    .map(d => d.name)
    /* D1：列出来的子项里只留「允许用户走进去」的那些。
       根这一层（/ 或 C:\）尤其重要 —— 从「此电脑」点下来就落在它上面，
       不滤的话等于把整台机器的顶层结构原样交给浏览器。
       fsPathReachable() 的口径见它自己的注释：既包含允许根之下的目录，
       也包含通往允许根的祖先（/home/ubuntu 允许时，/ 和 /home 要能列）。 */
    .filter(name => fsPathReachable(path.join(target, name)))
    .sort((a, b) => a.localeCompare(b, 'zh'));
  } catch (e) {
    const m = String((e && e.message) || e || '');
    if (/EACCES|EPERM|EROFS/i.test(m))
      throw new Error('看不到里面的内容，这个文件夹没给权限：' + target);
    throw new Error('读不出内容，检查一下这个位置还在不在：' + target);
  }
  /* 「向上一级」的 up 不另做裁剪：它与上面列子项共用 fsPathReachable() 同一条
     判据，一个标准判出来的一致性才有保障 —— 不会出现「列表里看得见、点进去 403」。 */
  const up = path.dirname(target);
  return { dir: target, parent: up && up !== target ? up : '', dirs: dirs.slice(0, 400), drives: listDrives(), quick: quickPlaces() };
}

/* ---------------- 数据文件：账号 / 播放记录 / 密钥 ----------------
 * 都落在 APP_DIR/data。脚本态是工程目录，打包态是 exe 同目录。
 *
 * secrets.json 单独一个文件，**不和 config.json 混**：
 * config.json 有可能被别的接口整体回读，SMTP 授权码不能有任何被顺手带出去的机会。
 * 任何接口都不会返回 pass 字段。
 * ------------------------------------------------------------------ */
const DATA_DIR = path.join(APP_DIR, 'data');
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

function readJSON(file, dflt) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : dflt; }
  catch { return dflt; }
}
/* ⚠️ 走 writeFileAtomic，不是 fs.writeFileSync —— 详见文件头「原子写」那一节。
 * 这里写的全是 data/*.json（账号、会话、密钥、公告、好友…），
 * 任何一个被写成半截，对应的功能就整体失效。 */
function writeJSON(file, obj) {
  return writeJSONAtomic(file, obj);
}
/* 只改要改的字段，不整包覆盖。
   典型场景是「多写者」文件：榜单缓存、统计计数这类，主服务在写、
   别的实例或管理台也在写。直接 writeJSON 会把别人刚落盘的键抹掉 ——
   表现出来就是「刚才还在的榜单，刷新一下没了」。
   所以这里先读回当前内容，浅合并一层再原子写回。 */
function writeJSONMerge(file, patch, dflt) {
  const cur = readJSON(file, dflt === undefined ? {} : dflt);
  const base = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? cur : {};
  return writeJSONAtomic(file, { ...base, ...patch });
}
let SECRETS = readJSON(SECRETS_FILE, {});
// USERS 用 uid 做主键，手机号/邮箱只是可查询的字段（一个账号可同时绑两者）
let USERS = readJSON(USERS_FILE, {});          // { uid: { uid, username, phone, email, gender, passHash, createdAt, lastLogin, history: [] } }
let SESSIONS = readJSON(SESSIONS_FILE, {});    // { token: { uid, exp } }

/* ---------------- 零依赖 SMTP（只用来发登录验证码） ----------------
 * 为什么不用 nodemailer：整个项目零依赖，而且最终要打进 SEA 单文件 exe ——
 * 外部的 node_modules 不会被内嵌进去，只有源码可用。发信协议本身很简单：
 *   220 → EHLO → AUTH LOGIN → (用户名) → (授权码) → MAIL FROM → RCPT TO → DATA → QUIT
 * 每一行都用 "3位数字 + 空格" 判断响应结束（"250-" 是多行续行，要跳过）。
 * ------------------------------------------------------------------ */
const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');
const mimeWord = s => '=?UTF-8?B?' + Buffer.from(String(s), 'utf8').toString('base64') + '?=';

function smtpSend(msg, cfg, timeoutMs = 18000) {
  return new Promise((resolve, reject) => {
    const c = cfg || {};
    const host = c.host || 'smtp.qq.com';
    const port = Number(c.port) || 465;
    const user = c.user, pass = c.pass, from = c.from || c.user;
    if (!user || !pass) return reject(new Error('SMTP 未配置（缺邮箱或授权码）'));

    const to = String(msg.to || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return reject(new Error('收件邮箱不合法'));

    let settled = false, sock = null;
    const timer = setTimeout(() => finish(new Error('SMTP 连接超时')), timeoutMs);
    function finish(err) {
      if (settled) return; settled = true;
      clearTimeout(timer);
      try { sock && sock.destroy(); } catch { /* ignore */ }
      err ? reject(err) : resolve(true);
    }

    // 主题可能有中文 → 走 RFC2047；正文一律 base64，既免转义也天然不会出现行首点
    const head = [
      'From: ' + mimeWord('YMusic') + ' <' + from + '>',
      'To: <' + to + '>',
      'Subject: ' + mimeWord(msg.subject || 'YMusic'),
      'Date: ' + new Date().toUTCString(),
      'Message-ID: <' + Date.now() + '.' + crypto.randomBytes(6).toString('hex') + '@ymusic>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64'
    ].join('\r\n');
    const bodyB64 = Buffer.from(String(msg.text || ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
    // 点填充：DATA 里任何以 "." 开头的行都要多写一个点，否则会被当成正文结束
    const data = (head + '\r\n\r\n' + bodyB64)
      .split('\r\n').map(l => (l.charAt(0) === '.' ? '.' + l : l)).join('\r\n') + '\r\n.\r\n';

    const plan = [
      { want: /^220[\s-]/, send: 'EHLO ymusic.local' },
      { want: /^250[\s-]/, send: 'AUTH LOGIN' },
      { want: /^334[\s-]/, send: b64(user) },
      { want: /^334[\s-]/, send: b64(pass) },
      { want: /^235[\s-]/, send: 'MAIL FROM:<' + from + '>' },
      { want: /^250[\s-]/, send: 'RCPT TO:<' + to + '>' },
      { want: /^250[\s-]/, send: 'DATA' },
      { want: /^354[\s-]/, send: data },
      { want: /^250[\s-]/, send: 'QUIT' },
      { want: /^221[\s-]/, send: null }
    ];
    let idx = 0, buf = '';

    sock = tls.connect({ host, port, servername: host }, () => { /* 握手完成后等 220 */ });
    sock.setEncoding('utf8');
    sock.on('error', e => finish(new Error('连不上发信服务器：' + e.message)));
    sock.on('close', () => { if (!settled) finish(new Error('SMTP 连接被关闭')); });
    sock.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!/^\d{3} /.test(line)) continue;         // "250-..." 只是续行，继续等最终行
        const cur = plan[idx];
        if (!cur) continue;
        if (!cur.want.test(line)) return finish(new Error('SMTP 应答异常：' + line.slice(0, 120)));
        const cmd = cur.send; idx++;
        if (cmd === null) return finish(null);
        sock.write(cmd + '\r\n');
      }
    });
  });
}

/* ---------------- 邮箱验证码登录 ----------------
 * 极简但完整的账号体系：只认「邮箱 + 6 位码」，没有密码。
 * 目的只是把播放记录和账号绑定、并让账号信息可跨设备保留。
 * 三防：验证码 5 分钟过期、同一邮箱 60 秒只能发一次、每小时最多 8 次；校验最多错 5 次。
 * ------------------------------------------------------ */
const CODES = new Map();        // email -> { code, exp, tries, sentAt, count, hourStart }
const CODE_TTL = 5 * 60 * 1000;

/* 发码与验码（登录码用裸 email 作 key，重置/绑定码带用途前缀，
   这样「正在登录」和「正在改密码」不会互相把验证码顶掉）。 */
async function issueCode(email, purpose, subject, text) {
  const key = purpose ? (purpose + ':' + email) : email;
  const cfg = smtpCfg();
  if (!cfg.user || !cfg.pass) return { ok: false, error: '服务端还没配置发信邮箱' };
  const now = Date.now();
  const prev = CODES.get(key);
  const hourStart = prev && now - prev.hourStart < 3600000 ? prev.hourStart : now;
  const count = prev && now - prev.hourStart < 3600000 ? prev.count : 0;
  if (prev && prev.sentAt && now - prev.sentAt < 60000) {
    return { ok: false, error: '慢一点，' + Math.ceil((60000 - (now - prev.sentAt)) / 1000) + ' 秒后可以再发' };
  }
  if (count >= 8) return { ok: false, error: '这个邮箱一小时内发得太多了，过会儿再试' };
  const code = String(Math.floor(100000 + Math.random() * 900000));
  try {
    await smtpSend({ to: email, subject: subject.replace('{code}', code), text: text.replace('{code}', code) }, cfg);
  } catch (e) {
    return { ok: false, error: humane(e, '验证码没发出去，检查一下邮箱设置') };
  }
  CODES.set(key, { code, exp: now + CODE_TTL, tries: 0, sentAt: now, count: count + 1, hourStart });
  return { ok: true, ttl: CODE_TTL / 1000, to: email.replace(/^(.{2}).*(@.*)$/, '$1***$2') };
}
/* 校验但不消费：成功返回 ok，调用方决定是否删除 */
function checkCode(email, code, purpose) {
  const key = purpose ? (purpose + ':' + email) : email;
  const rec = CODES.get(key);
  if (!rec || rec.exp < Date.now()) return { ok: false, error: '验证码过期了，重新发一次' };
  if (rec.tries >= 5) { CODES.delete(key); return { ok: false, error: '错误次数太多，请重新获取验证码' }; }
  if (rec.code !== String(code || '').trim()) {
    rec.tries++;
    return { ok: false, error: '验证码不对，还能试 ' + (5 - rec.tries) + ' 次' };
  }
  return { ok: true, key };
}
const SESSION_TTL = 90 * 24 * 3600 * 1000;   // 90 天，够手机长期免登
const normEmail = s => String(s || '').trim().toLowerCase();
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/* ---------------- 图形验证码（注册专用） ----------------
 * 用户拍板的是「手机号注册保留，加图形验证码」——不关注册、不接短信服务商，
 * 只在注册前多挡一道。它挡不住专业打码平台，目标是两件更常见的事：
 *   1) 脚本批量注册；
 *   2) 更常见的那个 —— 拿注册接口去探测「这个手机号注册过没有」。
 * 第 2 条能不能挡住，完全取决于 /api/auth/register 里的**校验顺序**：
 * 验证码要是排在 findUser({phone}) 查重之后，照样能靠「手机号已注册」
 * 这句回显去枚举，验证码就成了摆设。所以顺序写死在下面那条注释里。
 *
 * 三条硬规矩：
 *   1. 答案只存在内存 Map 里，id 是 16 字节随机串（猜不动），5 分钟过期；
 *   2. 验过一次立刻删 —— 一个 id 不能使第二次（防重放）；
 *   3. 取验证码本身也限速（同 IP 每秒至多 1 张、每分钟至多 20 张），
 *      IP 只认 req.socket.remoteAddress。XFF 是请求头，谁都能随手伪造，
 *      这里一旦信了它，限速就等于没做（同一条教训见 /api/admin/claim）。
 * ------------------------------------------------------ */
const CAPTCHA = new Map();        // id -> { code, exp, tries }
const CAPTCHA_TTL = 5 * 60 * 1000;
const CAPTCHA_RATE = new Map();   // ip -> [ts, ...]，只保留最近 60 秒
const CAPTCHA_MAX = 3000;         // 内存兜底，攒过头就从最早的开始丢
/* 字形表里剔掉 0 O 1 I l：这五个印刷体和手写体都容易看混，
   用户输错一次就被当成机器人，体验比安全性先崩。 */
const CAPTCHA_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CAPTCHA_INK = ['#eafff2', '#bbf7d0', '#86efac', '#fef08a', '#a5f3fc'];
const CAPTCHA_NOISE = ['#22c55e', '#4ade80', '#38bdf8', '#94a3b8'];

/* ---------------- U-47 游客试听配额：游客只能试听 5 首 ----------------
 * 用户原话：「再加一条游客只能搜和听5首歌，并给出剩余歌曲提示，
 *           需要注册登录才能继续用，现在好多游客，收紧了」。
 * 拍板口径：只限试听；搜索 / 歌词 / 榜单 / 歌单一律放开不计数；额度一次性，用完就没。
 *
 * 完整论证见 docs/游客限流-方案调研.md 与 docs/U-47-游客限流-实施规格.md。
 * 这里只钉四条最容易被后人推翻的决定：
 *
 *  1. 计数关口在 /api/resolve（并对 /api/alt 补同一道闸），不在 /api/proxy。
 *     /api/proxy 是流式 + Range，一首歌会发多次请求（拖一次进度条就是一个新请求），
 *     按次计数会把「拖进度条」算成一首歌；而且它同时承载 dl=1 下载语义。
 *
 *  2. 游客身份 = 服务端下发的匿名 sid（httpOnly Cookie），不用 IP。
 *     IP 在公司 / 学校 / 小区宽带 / CGNAT 下是几百上千人共用的，第 6 个人来就被拦，
 *     误伤不可接受。IP 在这里只当「异常突发」辅助闸，不参与正常计数。
 *
 *  3. 额度只放内存、重启清零 —— 这是**算过账之后主动放弃**落盘，不是「没必要」落盘：
 *       sid 方案本身就允许「清 Cookie / 换浏览器 / 开无痕窗口」绕过，绕过成本已经
 *       低到「用户动动手指」。既然想绕过的人本来就能绕过，重启再送 5 首并没有
 *       **额外**降低绕过门槛 —— 没有新增任何一条绕过路径。
 *       而落盘的代价是实打实的：writeFileAtomic 是同步的、且每次全量重写整个文件
 *       （writeUploads() 已经在「每次上传歌从 0 播放」时这么干过一次，是本项目
 *       已存在的 I/O 放大器）；更糟的是 writeJSONAtomic 会吞异常并返回 false、
 *       readJSON 解析失败也静默回落默认值 —— 写失败时计数会**静默丢失**，服务端
 *       毫无察觉。用一个「实打实的 I/O 风险 + 静默丢数据」去换一个「本来就能被
 *       绕过的防绕过收益」，不对等。
 *     ⚠️ 千万别把上面这段改写成「重启很少发生，重启清零无所谓」——那句话在本项目
 *        是**错的**：我们每次发版都会重启服务，重启清零是常态。上面那段才是本方案
 *        成立的真正理由，两者在未来会导向完全不同的决定。
 *     ⚠️ 如果哪天要改成「落盘保留」，必须同时解决上面两个前提（节流合并写 +
 *        检查 writeJSONAtomic 的返回值），否则不要动。
 *
 *  4. 额度用完、但「这首歌已经听过 / 已经在播」时，必须放行、不打断。
 *     打断正在播放的声音是最伤的体验，而且那首歌本来就已经计过数了，
 *     再放一次不产生新的「一首」。
 * ---------------------------------------------------------------------- */
const GUEST_FREE = 5;                       // 游客免费试听首数（用户原话指定 5）
const GUEST_Q_MAX = 20000;                  // GUEST_Q 容量上限，单条约 200B → 满表约 4MB
const GUEST_Q_TRIM = 0.2;                   // 超限时清掉最旧的 20%（按 at 升序）
const GUEST_Q_TTL = 7 * 24 * 3600 * 1000;   // 7 天：既用于记录淘汰，也用作 sid 的 Max-Age（同一个数两处用）
const GUEST_IP_NEW_SID_MAX = 50;            // 同 IP 一个窗口内新生成 sid 的上限（初值放宽，先观察）
const GUEST_IP_WIN_MS = 3600000;            // IP 辅助闸的滑动窗口：1 小时

const GUEST_Q = new Map();          // sid -> { songs: [key...], at: ts, burst: bool }
const GUEST_IP_NEW_SID = new Map(); // ip   -> { t0, n }

function pruneCaptcha() {
  const now = Date.now();
  CAPTCHA.forEach((v, k) => { if (v.exp < now) CAPTCHA.delete(k); });
  const over = CAPTCHA.size - CAPTCHA_MAX;
  if (over > 0) {
    const it = CAPTCHA.keys();      // Map 保持插入顺序，先丢最早的
    for (let i = 0; i < over; i++) CAPTCHA.delete(it.next().value);
  }
}
/* 纯 Node 手搓 SVG —— 项目是零依赖的，为一个验证码去装 npm 包不值得，
 * 而且 SVG 体积比位图小两个数量级，还能无损缩放。 */
function captchaSvg(code) {
  const W = 128, H = 46, n = String(code || '').length || 4;
  const r1 = (a, b) => a + Math.random() * (b - a);
  const fx = v => v.toFixed(1);
  let s = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">';
  s += '<rect width="' + W + '" height="' + H + '" rx="7" fill="#0d1512"/>';
  // 干扰线：先画线后写字，线在字底下，不糊笔画
  for (let i = 0; i < 4; i++) {
    s += '<line x1="' + fx(r1(0, W)) + '" y1="' + fx(r1(0, H)) + '" x2="' + fx(r1(0, W)) + '" y2="' + fx(r1(0, H))
      + '" stroke="' + CAPTCHA_NOISE[i % CAPTCHA_NOISE.length] + '" stroke-width="' + fx(r1(0.6, 1.4)) + '" opacity="' + fx(r1(0.25, 0.5)) + '"/>';
  }
  /* ⚠️ SVG 是**明文**返回的，字就在 <text> 里 —— 只要解析就拿到答案，
     这是「服务端画 SVG」这种形态的天花板，加噪加线都改变不了。
     能做的是别让解析出来就是答案本身：掺 3 个 opacity=0 的诱饵字符，
     随机插在真字符中间。屏幕上完全看不见（不影响人看），
     但解析出来是 7 个字符、哪 4 个是真的、顺序如何都不知道 ——
     直接把命中率从 1/1 拉到 1/C(7,4)。挡不住愿意写 OCR 的人，
     只是让「顺手正则一下」这条路不再通。真要挡专业打码得换短信/第三方。 */
  const glyphs = [];
  for (let i = 0; i < n; i++) {
    const x = 18 + i * (30 + r1(-2, 2));
    const y = 31 + r1(-3, 3);
    const size = r1(23, 29);
    const rot = r1(-16, 16);
    glyphs.push('<text x="' + fx(x) + '" y="' + fx(y) + '" text-anchor="middle" font-family="Menlo,Consolas,monospace"'
      + ' font-size="' + fx(size) + '" font-weight="700" fill="' + CAPTCHA_INK[Math.floor(Math.random() * CAPTCHA_INK.length)] + '"'
      + ' transform="rotate(' + fx(rot) + ' ' + fx(x) + ' ' + fx(y) + ')">' + code[i] + '</text>');
  }
  for (let i = 0; i < 3; i++) {
    const x = r1(8, W - 8), y = r1(14, H - 6);
    glyphs.push('<text x="' + fx(x) + '" y="' + fx(y) + '" text-anchor="middle" font-family="Menlo,Consolas,monospace"'
      + ' font-size="' + fx(r1(23, 29)) + '" font-weight="700" fill="#0d1512" opacity="0">'
      + CAPTCHA_CHARS[Math.floor(Math.random() * CAPTCHA_CHARS.length)] + '</text>');
  }
  for (let i = glyphs.length - 1; i > 0; i--) {          // 洗牌，别让真字符总排在最前
    const j = Math.floor(Math.random() * (i + 1));
    const t = glyphs[i]; glyphs[i] = glyphs[j]; glyphs[j] = t;
  }
  s += glyphs.join('');
  // 噪点：压在字上面但小而淡，够恶心 OCR，不挡人眼
  for (let i = 0; i < 48; i++) {
    s += '<circle cx="' + fx(r1(0, W)) + '" cy="' + fx(r1(0, H)) + '" r="' + fx(r1(0.3, 1.2)) + '"'
      + ' fill="' + CAPTCHA_NOISE[Math.floor(Math.random() * CAPTCHA_NOISE.length)] + '" opacity="' + fx(r1(0.2, 0.6)) + '"/>';
  }
  return s + '</svg>';
}
function newCaptcha() {
  let code = '';
  for (let i = 0; i < 4; i++) code += CAPTCHA_CHARS[Math.floor(Math.random() * CAPTCHA_CHARS.length)];
  pruneCaptcha();
  const id = crypto.randomBytes(16).toString('base64url');   // 16 字节随机，猜不动
  CAPTCHA.set(id, { code, exp: Date.now() + CAPTCHA_TTL, tries: 0 });
  return { id, svg: captchaSvg(code), ttl: CAPTCHA_TTL / 1000 };
}
/* 取验证码的限速：每秒 1 张、每分钟 20 张（滑动窗口） */
function captchaRate(ip) {
  const now = Date.now();
  if (CAPTCHA_RATE.size > 5000) CAPTCHA_RATE.clear();        // 兜底，别让 IP 表无限涨
  let hits = CAPTCHA_RATE.get(ip);
  if (!hits) { hits = []; CAPTCHA_RATE.set(ip, hits); }
  while (hits.length && now - hits[0] > 60000) hits.shift();
  if (hits.length && now - hits[hits.length - 1] < 1000) return { ok: false, error: '慢一点，1 秒只能换一张' };
  if (hits.length >= 20) return { ok: false, error: '取验证码太频繁了，歇一会儿再试' };
  hits.push(now);
  return { ok: true };
}
/* 校验并消费。错/过期/没这个 id 返回同一句话 ——
   否则攻击者能靠文案差异去试「这个 id 还活着吗」。 */
function checkCaptcha(id, input) {
  const BAD = '图形验证码不对或已过期，换一张试试';
  const key = String(id || '').trim();
  const rec = CAPTCHA.get(key);
  if (!rec) return { ok: false, error: BAD };
  if (rec.exp < Date.now()) { CAPTCHA.delete(key); return { ok: false, error: BAD }; }
  if (String(input || '').trim().toUpperCase() !== rec.code) {
    rec.tries = (rec.tries || 0) + 1;
    if (rec.tries >= 5) CAPTCHA.delete(key);   // 一张图最多猜 5 次，猜完必须重新取
    return { ok: false, error: BAD };
  }
  CAPTCHA.delete(key);                         // 一次性：验过就废，不能拿同一个 id 使第二次
  return { ok: true };
}
/* 弱密码：最小长度仍然是 6，不抬到 8（抬了会被用户骂）。
   这里只挡「一眼就猜得到」的那几种，不做打分细则。 */
function weakPassReason(p) {
  const s = String(p || '');
  if (s.length < 6) return '密码至少 6 位';
  if (/^\d+$/.test(s)) return '密码不能全是数字';
  if (/^(.)\1+$/.test(s)) return '密码不能是同一个字符重复';
  const SEQ = '0123456789abcdefghijklmnopqrstuvwxyz';
  const lo = s.toLowerCase();
  if (SEQ.indexOf(lo) >= 0 || SEQ.split('').reverse().join('').indexOf(lo) >= 0) return '密码太简单了（别用连续字符，像 123456）';
  return '';
}

function smtpCfg() {
  const s = SECRETS.smtp || {};
  return { host: s.host || 'smtp.qq.com', port: Number(s.port) || 465, user: s.user || '', pass: s.pass || '', from: s.from || s.user || '' };
}
function allowList() {
  const a = SECRETS.auth && Array.isArray(SECRETS.auth.allow) ? SECRETS.auth.allow : [];
  return a.map(normEmail).filter(Boolean);
}
/* 白名单为空 = 不限制（本机自用）。一旦设了，就只有名单里的邮箱能登录。
 * 之所以默认要设：这服务挂在公网隧道上，不设白名单谁都能注册。 */
function isAllowed(email) {
  const allow = allowList();
  return allow.length === 0 || allow.includes(email);
}
function pruneSessions() {
  const now = Date.now();
  let changed = false;
  for (const [t, s] of Object.entries(SESSIONS)) if (!s || s.exp < now) { delete SESSIONS[t]; changed = true; }
  if (changed) writeJSON(SESSIONS_FILE, SESSIONS);
}
function userOf(req) {
  const h = req.headers['authorization'] || '';
  const token = (h.startsWith('Bearer ') ? h.slice(7) : '') || (new URL(req.url, 'http://x')).searchParams.get('token') || '';
  if (!token) return null;
  const s = SESSIONS[token];
  if (!s || s.exp < Date.now()) return null;
  const u = USERS[s.uid];
  if (!u) return null;
  /* 顺手刷新属地：IP 没变就只更新时间戳，变了才解析一次（实测 1.09 微秒）。
     前端心跳 30 秒一次，所以换地方联网后别人最多 30 秒看到新属地 —— 与抖音体感一致。 */
  touchIpGeo(s.uid, ipOfReq(req));
  return { uid: s.uid, user: u, token };
}

/* ---- U-47：游客的匿名身份 ----
 * 第一次访问时下发一个 httpOnly 的 sid，之后靠 Cookie 认回来。
 *
 * 为什么是 Cookie 而不是 IP：见上面 U-47 常量区第 2 条。一句话版 —— IP 在公司/
 * 学校/CGNAT 下是几百人共用的，用 IP 计数会把「第 6 个来的人」直接拦死；Cookie
 * 每个浏览器独立，几乎零误伤。
 *
 * 为什么敢用 Cookie（它清掉就重置）：见 U-47 常量区第 3 条。一句话版 —— 想绕过的
 * 人本来就能绕过，我们的目标是「促使注册」，不是「做到无法绕过」。
 *
 * 为什么不用设备指纹：前端是严格 ES5 单文件，采集 + 上报 + 哈希的实现量与
 * 「促使注册」这个目标不成比例，而且照样能伪造。
 *
 * ⚠️ 用 res.setHeader 而不是改 sendJSON 的签名：send() 内部是
 *    res.writeHead(code, {...CORS, ...headers})，writeHead 会合并已经 setHeader
 *    过的值，所以「先 setHeader 再 sendJSON」是安全的，也不用动任何现有调用点。
 * ⚠️ 不要加 Secure：生产是 http://127.0.0.1:8788，加了 Cookie 直接不下发。 */
function guestSid(req, res) {
  const m = /(?:^|;\s*)ym_sid=([a-zA-Z0-9]{16,64})/.exec(String(req.headers.cookie || ''));
  if (m) { touchGuest(m[1]); return m[1]; }

  const sid = crypto.randomBytes(16).toString('hex');
  /* 同一个 IP 短时间内冒出大量「新 sid」= 有人在批量清 Cookie 刷额度。
     阈值放宽到 GUEST_IP_NEW_SID_MAX(50) 是先观察，别一上来就把公司/学校 NAT 卡死。
     命中只 console.warn + 把这个新 sid 标记成 burst —— 老 sid 照旧能听，不受牵连。 */
  const ip = ipOfReq(req);
  const now = Date.now();
  let rec = GUEST_IP_NEW_SID.get(ip);
  if (!rec || now - rec.t0 > GUEST_IP_WIN_MS) { rec = { t0: now, n: 0 }; GUEST_IP_NEW_SID.set(ip, rec); }
  rec.n++;
  const burst = rec.n > GUEST_IP_NEW_SID_MAX;
  if (burst) console.warn('[guest] IP 新 sid 突发 ip=' + ip + ' n=' + rec.n
                          + ' 窗口=' + GUEST_IP_WIN_MS + 'ms 阈值=' + GUEST_IP_NEW_SID_MAX);

  newGuest(sid, burst);
  res.setHeader('Set-Cookie', 'ym_sid=' + sid + '; Path=/; Max-Age=' + Math.floor(GUEST_Q_TTL / 1000)
                + '; HttpOnly; SameSite=Lax');
  return sid;
}
/* 账号查找：手机号和邮箱都能当登录名 */
function findUser({ email, phone } = {}) {
  const e = normEmail(email), ph = String(phone || '').trim();
  if (!e && !ph) return null;
  for (const u of Object.values(USERS)) {
    if (e && normEmail(u.email) === e) return u;
    if (ph && String(u.phone || '') === ph) return u;
  }
  return null;
}
function findByAccount(acc) {
  const s = String(acc || '').trim();
  if (!s) return null;
  return isEmail(s) ? findUser({ email: s }) : findUser({ phone: s });
}

/* ---------------- 注册来源 / 最后登录设备 ----------------
 * 管理台要靠它回答「这个号是手机上注册的还是电脑上注册的」。
 *
 * 重要边界：只有脚本版（8802）跑的是这份源码，才能记下来源。
 * exe / 桌面版内嵌的是打包那一刻的旧代码，改不动（也不重打包）——
 * 它们靠「目录联接」把 users.json 写进同一份主库，所以账号不会丢，
 * 但字段是空的，管理台那边会显示成「本地客户端」。
 * -------------------------------------------------------- */
function deviceOf(req) {
  const ua = String(req.headers['user-agent'] || '');
  /* ⚠ 只认 socket 远端地址，不看 X-Forwarded-For。
     云上是端口直连、没有反向代理解 XFF，这个头是**客户端想写多少就写多少**的：
     谁都能发一个 `X-Forwarded-For: 1.2.3.4` 把审计日志里的 IP 改成任意值，
     事后查"这个码是谁在刷"就查了个寂寞，留着它等于把证据交给对方编辑。

     写法上也不能写「XFF 非空就用 XFF、空了才回落到 socket」——
     那种写法只要攻击者带一个假 XFF 就永远不会走到 socket 分支，等于没改。
     XFF 要留也得由真正部署在前面的那层反向代理来写（且只信任它追加的那一段），
     在没有那层的情况下，唯一可信的就是 TCP 连接的对端地址。 */
  const ip = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  let kind = 'pc', label = '电脑';
  if (/Electron/i.test(ua)) { kind = 'desktop'; label = '桌面客户端'; }
  else if (/iPad/i.test(ua)) { kind = 'mobile'; label = 'iPad'; }
  else if (/iPhone|iPod/i.test(ua)) { kind = 'mobile'; label = 'iPhone'; }
  else if (/Android/i.test(ua)) {
    kind = 'mobile';
    const m = ua.match(/Android[^;]*;\s*([^;)]+)/);
    label = m ? String(m[1]).trim() : 'Android';
  } else if (/Mobile|HarmonyOS/i.test(ua)) { kind = 'mobile'; label = '手机'; }
  else if (/Windows/i.test(ua)) { label = 'Windows'; }
  else if (/Macintosh/i.test(ua)) { label = 'Mac'; }
  else if (/Linux/i.test(ua)) { label = 'Linux'; }
  if (/MicroMessenger/i.test(ua)) label += '·微信';
  else if (/QQ\//i.test(ua)) label += '·QQ';
  return { kind, label, ip, ua: ua.slice(0, 240), at: Date.now() };
}
/* 把一次登录/注册的设备信息落到账号上（只追加，不覆盖已有注册来源） */
function stampDevice(u, dev, isRegister) {
  if (!u) return;
  if (isRegister) {
    u.regSrc = dev.kind; u.regDevice = dev.label; u.regIp = dev.ip; u.regUa = dev.ua;
  }
  u.lastSrc = dev.kind; u.lastDevice = dev.label; u.lastIp = dev.ip; u.lastUa = dev.ua;
  u.lastLogin = Date.now();
}
function createUser(fields = {}) {
  const uid = 'u' + crypto.randomBytes(8).toString('hex');
  USERS[uid] = {
    uid,
    username: String(fields.username || '').trim().slice(0, 20) || '听众',
    phone: String(fields.phone || '').trim(),
    email: normEmail(fields.email),
    gender: fields.gender === 'female' ? 'female' : fields.gender === 'male' ? 'male' : '',
    passHash: fields.passHash || '',
    createdAt: Date.now(), lastLogin: 0, history: [], favs: []
  };
  return USERS[uid];
}
/* ---------------- 账号回传（PC 端 exe → 主库）----------------
 * 别人机器上装的 exe 有自己一份 users.json，不回传的话管理台永远看不见。
 * 解决办法：exe 同目录放一个 sync.json，注册/登录时把账号推到主服务的
 * /api/sync/push，按手机号归并进主库 —— 手机端和 PC 端就成同一套账号了。
 *
 * 归并铁律：只补空字段 + 收藏历史做并集，
 * 绝不覆盖已有的密码 / 手机 / 邮箱（登录凭证以先有的那方为准）。
 * ------------------------------------------------------------ */
const SYNC_FILE = path.join(APP_DIR, 'sync.json');
let SYNC_CFG = readJSON(SYNC_FILE, null);

function mergeRemoteUser(u, clientId) {
  if (!u || typeof u !== 'object') return null;
  let t = (u.phone && findUser({ phone: u.phone }))
    || (u.email && findUser({ email: u.email }))
    || USERS[u.uid];
  const isNew = !t;
  if (isNew) {
    t = createUser({
      username: u.username, phone: u.phone, email: u.email,
      gender: u.gender, passHash: u.passHash || ''
    });
    if (u.createdAt) t.createdAt = u.createdAt;
  } else {
    if (!t.username || t.username === '听众') t.username = u.username || t.username;
    if (!t.phone && u.phone) t.phone = u.phone;
    if (!t.email && u.email) t.email = u.email;
    if (!t.gender && u.gender) t.gender = u.gender;
    if (!t.passHash && u.passHash) t.passHash = u.passHash;
  }
  /* 收藏 / 历史：按 key 做并集，时间倒序 */
  for (const k of ['favs', 'history']) {
    const a = Array.isArray(t[k]) ? t[k] : [];
    const b = Array.isArray(u[k]) ? u[k] : [];
    const map = new Map();
    for (const it of [...b, ...a]) {
      map.set(String(it && (it.key || [it.source, it.id || it.hash || it.songname || it.name].join(':'))), it);
    }
    t[k] = [...map.values()].sort((x, y) => (Number(y && y.at) || 0) - (Number(x && x.at) || 0)).slice(0, 1000);
  }
  if (u.lastLogin && (!t.lastLogin || u.lastLogin > t.lastLogin)) {
    t.lastLogin = u.lastLogin;
    if (u.lastSrc) { t.lastSrc = u.lastSrc; t.lastDevice = u.lastDevice || ''; }
  }
  if (u.regSrc && (!t.regSrc || t.regSrc === 'unknown')) { t.regSrc = u.regSrc; t.regDevice = u.regDevice || ''; }
  t.syncedFrom = clientId || t.syncedFrom || '';
  t.syncedAt = Date.now();
  return { user: t, isNew };
}

/* 客户端上报：有 sync.json 才发，没有就完全静默；失败也绝不影响本地使用 */
function syncPush(user) {
  if (!SYNC_CFG || !SYNC_CFG.url) return;
  try {
    const u = new URL(String(SYNC_CFG.url));
    const mod = u.protocol === 'https:' ? https : http;
    const payload = user
      ? { clientId: SYNC_CFG.clientId || '', user }
      : { clientId: SYNC_CFG.clientId || '', users: USERS };
    const body = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (SYNC_CFG.key) headers['x-sync-key'] = String(SYNC_CFG.key);
    const req = mod.request({
      host: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
      path: '/api/sync/push', method: 'POST', headers, timeout: 8000
    }, r => { r.resume(); });
    req.on('error', () => { });
    req.on('timeout', () => req.destroy());
    req.write(body);
    req.end();
  } catch { /* 静默 */ }
}

function issueToken(uid, dev) {
  const token = crypto.randomBytes(24).toString('hex');
  SESSIONS[token] = { uid, exp: Date.now() + SESSION_TTL };
  if (dev) Object.assign(SESSIONS[token], { src: dev.kind, device: dev.label, ip: dev.ip, ua: dev.ua, at: dev.at });
  pruneSessions();
  writeJSON(SESSIONS_FILE, SESSIONS);
  return token;
}
/* ---------------- 互斥登录 ----------------
 * 为什么要：同一个账号同时在手机、桌面版、网页上挂着时，两边都在改同一份
 * 收藏 / 播放历史 / 下载记录，写回时后写的覆盖先写的，用户看到的现象就是
 * 「数据莫名其妙倒退」，而且服务端判定「在线」会出现幽灵会话。
 *
 * 规矩改成：**一个账号只保留最后一次登录**。每次登录成功后，把这个 uid
 * 名下的其它 token 全部清掉；被踢的那一端下一个请求会拿到 401，
 * 前端据此弹「账号已在别处登录」并退回登录页。
 *
 * 注意只踢「同一个 uid」的会话，绝不碰别人的。
 * ------------------------------------------------------------------ */
/* ---------------- 被顶号记录 ----------------
 * kickOthers 把旧会话从 SESSIONS 里删掉之后，服务端就再没有"这个人被踢过"
 * 的任何痕迹了 —— 那条会话从服务端的角度看和一个从来没存在过的 token 完全一样。
 * 结果就是：被踢的那一端来问"我还登录着吗"，我们只能答"不知道这个 token"，
 * 端上据此给出的文案只能是含糊的"登录状态没了"，而真相是"你的号在别处登了"。
 * 这两种对端上的人是要分开处理的（一个会立刻被重新登录，一个会以为软件坏了）。
 *
 * 所以在这里留一张回执：token → uid + 时间戳。它只用于回答那一个问题，
 * 不带任何权限，拿到这张回执也不会让任何人能继续用这个 token。
 * TTL 到了自然消失，不用落盘 —— 服务重启后旧 token 本来就也没意义了。
 * ------------------------------------------------------------------ */
const KICKED = new Map();
const KICKED_TTL = 24 * 3600 * 1000;
function noteKicked(token, uid) {
  if (!token) return;
  const now = Date.now();
  /* 顺手清过期项：只在踢人时走一遍，平时不占任何开销 */
  for (const [t, v] of KICKED) if (!v || v.at + KICKED_TTL < now) KICKED.delete(t);
  KICKED.set(token, { uid, at: now });
}
function kickedOf(token) {
  if (!token) return null;
  const v = KICKED.get(token);
  if (!v) return null;
  return v.at + KICKED_TTL >= Date.now() ? v : null;   // 过期回执等同于没踢过
}
function kickOthers(uid, keepToken) {
  let killed = 0;
  for (const t of Object.keys(SESSIONS)) {
    const s = SESSIONS[t];
    if (!s || s.uid !== uid) continue;
    if (t === keepToken) continue;
    delete SESSIONS[t]; noteKicked(t, s.uid); killed++;
  }
  if (killed) writeJSON(SESSIONS_FILE, SESSIONS);
  return killed;
}
/* 对外暴露的账号资料 —— 永远不含 passHash */
const publicUser = u => ({
  uid: u.uid, username: u.username, phone: u.phone ? u.phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') : '',
  email: u.email, gender: u.gender, createdAt: u.createdAt, lastLogin: u.lastLogin,
  historyCount: (u.history || []).length, favCount: (u.favs || []).length,
  /* role 跟着登录态一起下发：前端靠它决定"要不要显示管理入口" */
  role: roleOf(u),
  /* 头像：只下发「已通过审核」的那一张（avatarUrlOf 内部卡这道闸）。
     下面两个是给本人看的：换完头像还压在审核队列里时要显示"审核中"，
     被驳回了要把管理员写的理由原样念给他听，而不是默默什么都没发生。 */
  avatar: avatarUrlOf(u),
  avatarPending: !!u.avatarPending,
  avatarReason: String(u.avatarReason || '')
});

/* 下载闸门：游客只能用搜索/试听/歌词，落盘一律要求登录。
 * 这是服务端硬拦 —— 前端把按钮藏起来只是顺带的体验优化，不是安全边界。 */
function denyGuest(res, what) {
  return sendJSON(res, { ok: false, needLogin: true, error: (what || '这个操作') + '需要先登录账号' }, 401);
}

/* ---------------- U-47：游客试听闸门 ----------------
 * 调用点：/api/resolve 与 /api/alt（换源是 resolve 失败后的兜底路径，也是独立路由，
 * 不给它加闸的话，游客直接构造 /api/alt?name=..&singer=.. 就能无限听）。
 *
 * 返回值：
 *   { ok: true,  guest: null }              —— 已登录，不是游客，完全不受影响
 *   { ok: true,  guest: { total, left } }   —— 放行（含「这首歌已经听过」的放行，不扣）
 *   { ok: false }                           —— 额度用尽，响应已由 guestOut() 发出
 * ---------------------------------------------------- */

function newGuest(sid, burst) { GUEST_Q.set(sid, { songs: [], at: Date.now(), burst: !!burst }); trimGuestQ(); }
function touchGuest(sid) {
  const g = GUEST_Q.get(sid);
  if (g) { g.at = Date.now(); return; }
  GUEST_Q.set(sid, { songs: [], at: Date.now(), burst: false });
  trimGuestQ();
}

/* 容量上限：超了清最旧的 20%（按 at 升序），**不是**整体 clear。
   照抄 captchaRate 的「size > 5000 就 clear」在这里不成立：那会把正在听的老游客
   一起抹掉，让他凭空多拿 5 首。清最旧 20% 只淘汰最不活跃的那批。 */
function trimGuestQ() {
  if (GUEST_Q.size <= GUEST_Q_MAX) return;
  const arr = [...GUEST_Q.entries()].sort((a, b) => a[1].at - b[1].at);
  const cut = Math.max(1, Math.floor(arr.length * GUEST_Q_TRIM));
  for (let i = 0; i < cut; i++) GUEST_Q.delete(arr[i][0]);
}

/* 计数键的分级降级。
   🔴 为什么要降级：/api/resolve 的查询串里**本来没有** name 和 singer（只有
      src/id/hash/sqhash/h320hash/duration/size/br），而计数键要用「歌手｜歌名」。
      前端 Api.resolve 补两行 name/singer 是最好的解，但那属于 web/index.html，
      本轮窗口不动前端。在那之前服务端必须能独立工作 —— 拿不到 name/singer
      就一路降级，绝不能返回空串了事：键为空 = 不计数 = 「限流好像没生效」，
      而服务端一片安静，谁也查不出为什么。
   所以每一级降级都打 trace 日志，要能一眼看出「这一票到底计没计数」。 */
function guestSongKey(Q, rawQuery) {
  const name = String(Q('name') || '').trim();
  const singer = String(Q('singer') || '').trim();
  if (name && singer) return { key: songKey({ name, artist: singer }), level: 'L1:name+singer' };

  const id = String(Q('id') || '').trim();
  if (id) return { key: 'id:' + id, level: 'L2:id' };

  /* L3 优先取平台侧的曲目标识（hash / url），比整条查询串稳：
     查询串里的 br、duration 会随请求变（换音质、前端回填时长），
     拿整串当键会把「同一首歌换个音质」算成两首。 */
  const h = String(Q('hash') || Q('url') || Q('sqhash') || Q('h320hash') || '').trim();
  if (h) return { key: 'hash:' + h, level: 'L3:hash/url' };

  const raw = String(rawQuery || '').trim();
  if (raw) return { key: 'raw:' + raw, level: 'L4:raw' };

  return { key: '', level: 'L0:none' };
}

/* trace：一行看完「这一票到底计没计数」。日志统一用 [guest] 前缀，方便 grep。 */
function guestTrace(where, sid, info) {
  console.log('[guest] ' + where
    + ' sid=' + String(sid || '-').slice(0, 8)
    + ' keyL=' + info.level
    + ' key=' + (info.key || '-')
    + ' counted=' + (info.counted ? 1 : 0)
    + ' used=' + info.used + '/' + GUEST_FREE
    + ' left=' + info.left);
}

function guestOut(res, sid, info) {
  guestTrace('OUT', sid, info);
  sendJSON(res, {
    ok: false, needLogin: true, quotaOut: true,
    guest: { total: GUEST_FREE, left: 0 },
    error: '游客的 5 首试听已用完，再听一首都不行，注册登录后可以继续听'
  }, 401);
  /* 🔴 必须显式返回 { ok:false }：sendJSON → send → res.end 的返回值是 undefined，
     直接 `return guestOut(...)` 会让调用方拿到 undefined，然后在
     `if (!gq.ok)` 上抛 "Cannot read properties of undefined (reading 'ok')"，
     被外层 catch 打成一条 [500] /api/resolve —— 客户端那头其实已经收到 401 了，
     但日志里会多一条假的 500，把真正的 500 淹掉。 */
  return { ok: false };
}

function guestPlayGate(req, res, where, Q, rawQuery) {
  const sess = userOf(req);
  if (sess) return { ok: true, guest: null };                 // 登录用户完全不受影响

  const sid = guestSid(req, res);
  const g = GUEST_Q.get(sid) || { songs: [], at: Date.now(), burst: false };
  if (!GUEST_Q.has(sid)) GUEST_Q.set(sid, g);

  const info = { level: '-', key: '', counted: false, used: g.songs.length, left: Math.max(0, GUEST_FREE - g.songs.length) };
  if (g.burst) {
    info.level = 'burst'; info.used = g.songs.length; info.left = 0;
    return guestOut(res, sid, info);
  }

  const k = guestSongKey(Q, rawQuery);
  info.level = k.level; info.key = k.key;
  const stay = () => ({ ok: true, guest: { total: GUEST_FREE, left: Math.max(0, GUEST_FREE - g.songs.length) } });

  /* ★ 第一原则：这首歌已经听过 → 放行、不打断、不重复扣。
     典型场景：游客正在听第 5 首时额度归零，此时他切回去重听这一首、或者暂停再点
     播放，都**必须**放行。那首歌本来就已经计过数了，再放一次不产生新的「一首」；
     而掐断正在播放的声音是最伤的体验 —— 那是打断，不是限流。
     换源也落在这一支：键是「歌手｜歌名」，换到另一个平台的同名版本键不变。 */
  if (k.key && g.songs.indexOf(k.key) >= 0) {
    guestTrace('HIT', sid, info);
    return stay();
  }

  if (!k.key) {                                               // 实在拿不到键：宁可漏记，也不能瞎扣
    guestTrace('NOKEY', sid, info);
    return stay();
  }

  if (g.songs.length >= GUEST_FREE) {
    info.used = g.songs.length; info.left = 0;
    return guestOut(res, sid, info);
  }

  /* ★ 这里只做「预判放行」，**不记账**。真正记账延后到 okGuest()（成功出口）那一刻。
     为什么不在这一刻就记：/api/resolve 后面还要去上游取音源，取不到（会员/付费/
     下架，实测占比不低）会走 catch 返回 ok:false —— 用户一首都没听到。若在入口就
     记账，游客点 5 首里有 3 首播不了也会把额度耗光，这既不是限流也不像话。
     所以：只有真的解析出可播的 url、要发给前端那一刻，才算「听了一首」。 */
  const pend = stay();
  pend._pending = true; pend._sid = sid; pend._key = k.key; pend._level = k.level; pend._where = where;
  return pend;
}

/* 成功出口：真正记账 + 带上 guest 字段（只有游客有），前端靠它显示「还剩 N 首」。 */
function okGuest(res, payload, g) {
  if (!g || !g.guest) return sendJSON(res, payload);
  if (g._pending) {
    const rec = GUEST_Q.get(g._sid);
    if (!rec) return sendJSON(res, { ...payload, guest: g.guest });
    if (rec.songs.indexOf(g._key) < 0) rec.songs.push(g._key);
    rec.at = Date.now();
    g.guest.left = Math.max(0, GUEST_FREE - rec.songs.length);
    guestTrace(g._where, g._sid, { level: g._level, key: g._key, counted: true, used: rec.songs.length, left: g.guest.left });
  }
  return sendJSON(res, { ...payload, guest: g.guest });
}

/* 失败出口：不记账，但照样把当前剩余数带回去 —— 前端每次请求都要能刷新「还剩几首」，
   不能因为这一首没取到音源就让剩余提示断掉。 */
const failGuest = (res, payload, g) => sendJSON(res, (g && g.guest) ? { ...payload, guest: g.guest } : payload);

/* 密码：scrypt + 每用户随机盐，比对用 timingSafeEqual 防时序侧信道 */
function hashPass(pw) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
function checkPass(pw, stored) {
  try {
    const [alg, saltHex, hashHex] = String(stored || '').split('$');
    if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
    const got = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64);
    const want = Buffer.from(hashHex, 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch { return false; }
}
const isPhone = s => /^1[3-9]\d{9}$/.test(String(s || '').trim());
const cleanName = s => String(s || '').trim().slice(0, 20);

/* ---------------- 前端静态资源（磁盘优先，打包后读 SEA 内嵌资产） ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8'
};

/* -------------------------------------------------------------------------
 * OTA 覆盖层准入：只有「不比本程序更旧」的覆盖层才允许接管页面
 * -------------------------------------------------------------------------
 * UPDATE_DIR 跟着 exe 所在目录走（APP_DIR/update），于是**任何躺在 exe 旁边的
 * update/ 目录都会劫持它加载的页面**。真实踩过一次：dist/update/ 里留着 3.5.5 的
 * 页面和第 5 代死地址，发出去的 exe 因此加载古董页面，最后只能靠人工改名隔离。
 * 换个目录名它还会再犯，所以这里加一道下限校验。
 *
 * 三条原则，顺序不能反：
 *
 *  ① 判「有没有变」用 md5，跟 checkAppUpdate() 同一套口径 ——
 *     版本号是手填的、会漂（上一轮刚被它坑过一次：manifest 停在 3.6.10，
 *     而 APK 已经 3.6.12），md5 才是文件的事实。
 *
 *  ② 判「变新还是变旧」只能靠版本号 —— md5 没有方向性，给不出新旧。
 *     这是全流程里唯一用版本号的地方，且只在「确实不一样」时才需要它出场。
 *
 *  ③ ⚠️ **判不出「更旧」就一律放行**。
 *     挡错一次的代价是「这个 exe 以后永远更新不了」，比「多加载一次旧页面」
 *     严重得多 —— 后者下一次自检就会自己纠正回来。
 *     所以：版本号缺失 / 格式不认识 / 比较不出结果，全部按「不是更旧」处理。
 *-------------------------------------------------------------------------- */
function cmpVersion(a, b) {
  const pa = String(a === undefined || a === null ? '' : a).split(/[.\-+_]/);
  const pb = String(b === undefined || b === null ? '' : b).split(/[.\-+_]/);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = parseInt(pa[i], 10);
    const y = parseInt(pb[i], 10);
    /* 有一段不是纯数字（'3.6.12-beta'、'v3' 之类）→ 比不出来，交给调用方放行 */
    if (!Number.isFinite(x) || !Number.isFinite(y)) return NaN;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/* 内置资源的指纹。算一次缓存起来：index.html 有 580KB，
   每个静态请求都重算一遍纯属浪费。 */
const BUILTIN_MD5 = new Map();
function builtinMd5(rel) {
  if (BUILTIN_MD5.has(rel)) return BUILTIN_MD5.get(rel);
  let h = '';
  try {
    const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (clean && !clean.includes('..')) {
      if (IS_SEA) {
        try { h = md5(Buffer.from(SEA.getAsset('web/' + clean))); } catch { h = ''; }
      } else {
        const fp = path.join(WEB_DIR, clean);
        if (fs.existsSync(fp)) h = md5(fs.readFileSync(fp));
      }
    }
  } catch { h = ''; }
  BUILTIN_MD5.set(rel, h);
  return h;
}

let OVERLAY_OK = null;      // null = 还没判过
let OVERLAY_WHY = '';
function overlayUsable() {
  if (OVERLAY_OK !== null) return OVERLAY_OK;

  const l = localUpdate();
  if (!l || !Array.isArray(l.files) || !l.files.length) {
    /* 没有 update.json 的 update/ 目录不是覆盖层，是残留。
       checkAppUpdate() 每次下完包都会写 update.json，所以正常情况下
       有覆盖层就必然有这个文件 —— 缺它就说明这份东西来历不明，不认。 */
    OVERLAY_OK = false;
    OVERLAY_WHY = 'update.json 缺失或 files 为空，不认作覆盖层';
    console.log('[overlay] 已忽略覆盖层：' + OVERLAY_WHY + '（' + UPDATE_DIR + '）');
    return false;
  }

  /* ① 覆盖层内容与内置资源是否其实一模一样 —— 一样就没有新旧之分，直接用 */
  let allSame = true;
  let anyKnown = false;
  for (const f of l.files) {
    const rel = String((f && f.rel) || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.includes('..')) continue;
    const bi = builtinMd5(rel);
    if (!bi) continue;                    // 内置没有这个文件，无从比较
    anyKnown = true;
    if (String((f && f.md5) || '').toLowerCase() !== bi) { allSame = false; break; }
  }
  if (anyKnown && allSame) {
    OVERLAY_OK = true;
    OVERLAY_WHY = '覆盖层与内置资源 md5 一致，新旧无从谈起';
    /* 这条也要落日志 —— 上一次排查 update/ 劫持时，只能靠"服务端到底选了哪边"
       这条线索反推，缺任何一种出口的记录就会又变成猜谜 */
    console.log('[overlay] 采用覆盖层：' + OVERLAY_WHY + '（' + UPDATE_DIR + '）');
    return true;
  }

  /* ② 内容确实不一样 —— 用版本号判方向，比不出来一律放行（原则 ③） */
  const c = cmpVersion(l.version, APP_VERSION);
  if (Number.isNaN(c)) {
    OVERLAY_OK = true;
    OVERLAY_WHY = '覆盖层版本号「' + l.version + '」无法与内置 ' + APP_VERSION + ' 比较，按「不是更旧」放行';
  } else if (c >= 0) {
    OVERLAY_OK = true;
    OVERLAY_WHY = '覆盖层版本 ' + l.version + ' >= 内置 ' + APP_VERSION;
  } else {
    OVERLAY_OK = false;
    OVERLAY_WHY = '覆盖层版本 ' + l.version + ' 低于内置 ' + APP_VERSION + '，已忽略';
  }
  console.log('[overlay] ' + (OVERLAY_OK ? '采用覆盖层' : '已忽略覆盖层') + '：' + OVERLAY_WHY
    + '（' + UPDATE_DIR + '）');
  return OVERLAY_OK;
}

function readWeb(rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.includes('..')) return null;
  const isText = /\.(html|css|js|json|webmanifest|svg|txt|map)$/i.test(clean);
  if (overlayUsable()) {
    try {
      /* ① OTA 覆盖层最高优先级 —— 远程推来的新版前端 */
      const of = path.join(UPDATE_DIR, clean);
      if (fs.existsSync(of)) return fs.readFileSync(of);
    } catch { /* ignore */ }
  }
  try {
    // SEA.getAsset 不带编码时返回 ArrayBuffer，而 res.end() 只吃 string/Buffer/Uint8Array
    // —— 少了 Buffer.from 会直接抛 ERR_INVALID_ARG_TYPE 把连接打断（踩过）
    if (IS_SEA) {
      try { return Buffer.from(SEA.getAsset('web/' + clean, isText ? 'utf8' : undefined)); }
      catch { return null; }        // 内嵌里没有这个资源，继续回落磁盘
    }
    const fp = path.join(WEB_DIR, clean);
    if (!fs.existsSync(fp)) return null;
    return fs.readFileSync(fp);
  } catch { return null; }
}

/* -------------------------------------------------------------------------
 * OTA 客户端：只在 exe（SEA）里跑。脚本态直接读 web/，永远是最新，不需要自检。
 *
 * 自举设计：打包时写死一个更新源地址；每次拉到的清单里带上「下次该去哪」，
 * 写回本地 update.json。这样以后隧道换地址，老 exe 也能跟着迁到新地址。
 * ------------------------------------------------------------------------- */
/* 打包前由 一键打包.py 自动改写成当时的在线地址；改错也没关系，
 * 运行脚本态会优先用 public-url.txt 里的实时值。 */
const DEFAULT_UPDATE_BASE = 'http://127.0.0.1:8788';
const UPDATE_CHECK_MS = 30 * 60 * 1000;
const UPDATE_ALLOW_EXT = /\.(html|css|js|json|webmanifest|svg|txt|map|png|ico|woff2?)$/i;

function localUpdate() {
  try { return JSON.parse(fs.readFileSync(UPDATE_MANIFEST, 'utf8')); } catch { return null; }
}

/* ---------------- Windows 桌面端的安装包信息 ----------------
 * 以前 /api/app/version 只管 APK，桌面端照样会弹「有新版本」，
 * 可拿回去的包里一个 Windows 相关字段都没有 —— 用户点了「立即更新」也无处可去。
 * 现在补上一块 exe，跟 apk 对称。
 *
 * 取数的规矩：
 *  ① 清单元数据（version / note / force / file）看 data/app-update/manifest.json 的 exe 块；
 *  ② **size 和 md5 一律以磁盘上那个真实文件为准**，不信清单里写的值 ——
 *     清单是手填的，早晚会和实际文件对不上，客户端拿错 md5 会直接判定"包损坏不可用"。
 *  ③ 文件不存在就返回 null：桌面端由此知道「这一版还没上传 Windows 包」，
 *     只继承 APK 的更新逻辑，不会弹一个点了下不下来包的按钮。
 * ------------------------------------------------------------------ */
/* md5 要读 89MB 的文件算，每次请求都算一遍太贵。按「路径+体积+修改时间」缓存，
 * 换了文件自动失效，不用手动清。 */
let EXE_MD5_CACHE = { key: '', md5: '' };
function readExeMeta() {
  const mf = readJSON(RELEASE_MANIFEST, null) || {};
  const raw = (mf && typeof mf.exe === 'object' && mf.exe) ? mf.exe : {};
  const rel = String(raw.file || 'YMusic.exe').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.includes('..')) return null;
  const fp = path.join(RELEASE_DIR, rel);
  if (!fs.existsSync(fp)) return null;

  let size = 0, mt = 0;
  try { const st = fs.statSync(fp); size = st.size; mt = st.mtimeMs; } catch { size = Number(raw.size) || 0; }

  const key = fp + '|' + size + '|' + mt;
  if (EXE_MD5_CACHE.key !== key) {
    let h = '';
    /* 走 md5FileSync 流式算，别把 180MB 整包读进堆（详见 md5FileSync 上方注释）。 */
    try { h = md5FileSync(fp); } catch { h = String(raw.md5 || ''); }
    EXE_MD5_CACHE = { key, md5: h };
  }
  return {
    version: String(raw.version || mf.version || APP_VERSION),
    file: rel,
    url: '/api/app/exe',
    size,
    md5: EXE_MD5_CACHE.md5 || String(raw.md5 || ''),
    note: String(raw.note || mf.note || '修复已知问题，提升使用体验'),
    force: !!raw.force,
    at: Number(raw.at) || Number(mf.at) || 0
  };
}

function otaFetch(url, binary) {
  return new Promise(resolve => {
    const lib = /^https:/i.test(url) ? https : http;
    const req = lib.get(url, { timeout: 10000 }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        try { return resolve(otaFetch(new URL(r.headers.location, url).href, binary)); }
        catch { return resolve(null); }
      }
      if (r.statusCode !== 200) { r.resume(); return resolve(null); }
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const b = Buffer.concat(chunks);
        resolve(binary ? b : b.toString('utf8'));
      });
      r.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/* 读一份 APK 发布元信息，转成下发给客户端的形状。
 * 用户端和管理端共用这一份逻辑，只是元信息文件和下载地址不同 ——
 * 两边的包名、签名都不一样，绝不能混。 */
function readApkMeta(metaPath, url) {
  try {
    const a = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!a || !a.file) return null;
    return {
      versionCode: a.versionCode | 0,
      versionName: String(a.versionName || ''),
      url,
      size: a.size || 0,
      md5: a.md5 || '',
      note: a.note || '修复已知问题，提升使用体验',
      force: !!a.force,
      at: a.at || 0
    };
  } catch { return null; }
}

async function checkAppUpdate() {
  if (!IS_SEA) return null;                        // 脚本态不自检
  const local = localUpdate() || {};
  const base = String(local.base || publicUrl() || DEFAULT_UPDATE_BASE).replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return null;

  const txt = await otaFetch(base + '/api/app/version', false);
  if (!txt) return null;
  let m; try { m = JSON.parse(txt); } catch { return null; }
  if (!m || !m.ok || !m.version) return null;

  /* ⚠️ 判等依据**不能**是 version 字符串。
     以前这里写的是 `String(m.version) === String(local.version)`，
     而 manifest.json 的 version 是**手填的、给人看的**，实际发布流程里
     前端改了好几版它都没跟着涨（停在 3.6.10，APK 却已经到 3.6.12）。
     后果：远端文件早就变了，exe 却因为 version 相等直接 return null，
     覆盖层永远停在第一次拉到的那一版 —— 表现为「发了新版，老 exe 死活不更新」。
     md5 才是「文件到底变没变」的唯一事实，所以改成逐个比对 files 的 md5。 */
  const remoteFiles = Array.isArray(m.files) ? m.files : [];
  const localFiles = Array.isArray(local.files) ? local.files : [];
  if (remoteFiles.length && localFiles.length) {
    const localMd5 = new Map();
    for (const f of localFiles) {
      const rel = String((f && f.rel) || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (rel) localMd5.set(rel, String((f && f.md5) || ''));
    }
    /* 只有「远端每一个文件，本地都有且 md5 完全一致」才判定没变。
       少一张表、少一个文件、md5 对不上，一律当成「变了」去更新 ——
       判不出「一样」就当「不一样」，否则只是换个姿势复现同一个 bug。 */
    const same = remoteFiles.every(f => {
      const rel = String((f && f.rel) || '').replace(/\\/g, '/').replace(/^\/+/, '');
      return !!rel && localMd5.has(rel) && localMd5.get(rel) === String((f && f.md5) || '');
    });
    if (same) return null;                                    // 确实没变
  }

  const files = remoteFiles;
  const changed = [];
  for (const f of files) {
    const rel = String(f.rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.includes('..') || !UPDATE_ALLOW_EXT.test(rel)) continue;
    /* 已有且 md5 一致就跳过，省流量 */
    if (f.md5) {
      try { if (md5(fs.readFileSync(path.join(UPDATE_DIR, rel))) === f.md5) continue; } catch { /* 不存在，继续下载 */ }
    }
    const body = await otaFetch(base + '/api/app/file?rel=' + encodeURIComponent(rel), true);
    if (!body || !body.length) continue;
    if (f.md5 && md5(body) !== f.md5) continue;     // 校验不过绝不落地，防中间人篡改
    try {
      const dest = path.join(UPDATE_DIR, rel);
      /* 同样要原子写：index.html 写成半截 = 用户打开是白屏，而且短期内恢复不了 */
      writeFileAtomic(dest, body);
      changed.push(rel);
    } catch { /* 只读介质就静默放弃 */ }
  }
  /* 写回清单（含新的 base，完成自举）。
   * 这个文件一旦写坏，exe 下次就不知道去哪儿更新了 —— 必须原子写。 */
  try {
    writeFileAtomic(UPDATE_MANIFEST, JSON.stringify({
      version: m.version, base: m.base || base, files, at: Date.now()
    }, null, 2), 'utf8');
  } catch { /* ignore */ }
  /* ⚠️ 落地成功之后必须让覆盖层判定重新算一遍 —— 见 overlayUsable() 里那个
     模块级 OVERLAY_OK：它是「进程内只判一次、之后永久缓存」的。
     exe 启动时 server.listen 的回调会**立刻**开浏览器，那次请求必然早于
     3 秒后的首次自检；于是判定在覆盖层还是旧内容（或者压根还没有）的时候
     就被写死成「忽略」，之后哪怕 OTA 把新文件一字不差地落了地，页面也永远
     是内置那份，只有重启进程才会变 —— 表现就是「更新了但没变化」，
     而且服务端一行报错都没有，只能靠真机跑完整 OTA 才看得见。
     所以这里把缓存置空，让下一次 readWeb() 重新判定。

     只在 changed 非空时失效：自检是每 30 分钟跑一次的定时任务，无条件重置
     等于把「判一次缓存」退化成「每次请求都 stat + 比版本」，白把 OTA 的收益
     还回去。判一次缓存这个设计本身是对的，坏的是它没有失效时机。 */
  if (changed.length) OVERLAY_OK = null;
  return { version: m.version, changed };
}
/* ⚠️ 这是**白名单**：web/ 下新加任何文件，忘了往这里加就会 404。
   （manifest.webmanifest 就是这么漏的 —— 文件在、MIME 也注册了，
     但路由不认，iOS 端拿不到 manifest，加到主屏幕只能得到个普通书签。） */
const WEB_ASSET_RE = /^\/(index\.html|admin\.html|install\.html|app\.(css|js)|sw\.js|favicon\.ico|manifest\.webmanifest|icons\/[\w.@-]+|logo[\w.-]*\.svg)$/;
/* 这几个改了必须立刻生效，不能吃缓存 */
const NO_CACHE_ASSET = new Set(['sw.js', 'index.html', 'admin.html', 'install.html', 'manifest.webmanifest']);

/* ---------------- HTTP ---------------- */
/* 管理台 EXE / APK 是从 file:// 或别的源调过来的，必须放开跨域。
 * 鉴权全靠 Authorization: Bearer <token>，不用 Cookie，所以 * 不带来 CSRF 风险。
 * ⚠️ send() 里的 writeHead 会覆盖掉提前 setHeader 的同名头，
 *    所以跨域只在这里配一处，别在请求处理里再写一遍。 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Sync-Key',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Max-Age': '86400'
};
const send = (res, code, body, headers = {}) => { res.writeHead(code, { ...CORS, 'Cache-Control': 'no-store', ...headers }); res.end(body); };
const sendJSON = (res, o, code = 200) => send(res, code, JSON.stringify(o), { 'Content-Type': 'application/json; charset=utf-8' });

/* ⚠️ HTTP 头按规范只能是 ISO-8859-1，写中文进去 Node 会直接抛
 *   TypeError [ERR_INVALID_CHAR]: Invalid character in header content
 * —— 而且是**抛在 writeHead 里**，客户端收不到任何响应头，只看到一个 500。
 * 用户端叫「YMusic-3.6.12.apk」全是 ASCII，所以这个雷一直没响；
 * 管理端叫「YMusic管理台-1.0.3.apk」，一接上 /api/app/admin-apk 就炸。
 *
 * 按 RFC 6266 同时给两个名字：filename 放 ASCII 兜底（老客户端只认它），
 * filename* 放 RFC 5987 编码的真名（现代浏览器和 DownloadManager 优先用它）。 */
function contentDisposition(name) {
  const raw = String(name || 'download');
  const ascii = raw.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(raw);
}

/* ── HTTP Range 解析（U-27）──────────────────────────────────────────
   <audio> 能拖进度条、能报出有限的总时长，前提是服务端**真的**支持 Range：
   浏览器第一次只取 `bytes=0-`，从响应头 Content-Range 里的 total 才知道整首
   多长；随后拖进度条再取中间的某一段。

   之前这里只声明了 `Accept-Ranges: bytes`，带 Range 的请求却照回 200 整段；
   而 `send()` 走的是 writeHead + end(buffer)，Node 在这种情况下默认用
   chunked、不发 Content-Length，于是浏览器拿到一个「流式无长度」的响应，
   audio.duration === Infinity，页面上时长永远是 --:--。

   返回：
     { full: true }            —— 没带 Range / 单位不是 bytes / 形式不认，按 200 整段回
     { full: false,start,end } —— 合法单区间，end 已按 size 收口
     { bad: true }             —— 区间越界，按 RFC 7233 §4.4 回 416
   只支持单区间：多区间一律按「不支持」处理（回 200 整段）。音频播放用不到
   multipart/byteranges，硬上反而要引入边界拼接和顺序解析，得不偿失。 */
function parseRange(header, size) {
  const m = /^bytes=(.+)$/i.exec(String(header || '').trim());
  /* 没带、或者单位不是 bytes → 服务器可以不满足 Range，正常回 200 */
  if (!m) return { full: true };
  const spec = m[1];
  if (spec.indexOf(',') >= 0) return { full: true };      // 多区间：不支持，给全量
  const parts = spec.split('-');
  if (parts.length !== 2) return { full: true };
  const a = parts[0].trim(), b = parts[1].trim();
  let start, end;
  if (a === '') {
    /* suffix-byte-range-spec：`bytes=-500` 要末尾 500 字节 */
    if (!/^\d+$/.test(b)) return { full: true };
    const n = parseInt(b, 10);
    if (size === 0 || n <= 0) return { bad: true };
    end = size - 1;
    start = Math.max(0, size - n);
  } else {
    if (!/^\d+$/.test(a)) return { full: true };
    start = parseInt(a, 10);
    if (b === '') end = size - 1;                          // `bytes=1000-` 到文件尾
    else if (/^\d+$/.test(b)) end = parseInt(b, 10);
    else return { full: true };
  }
  if (size === 0) return { bad: true };
  /* last-byte-pos 超出长度是允许的：按 RFC 7233 收口到 size-1，不判 416；
     只有 first-byte-pos 落在文件之外（或区间为空）才是真正拿不到字节。 */
  if (start >= size || start > end) return { bad: true };
  if (end > size - 1) end = size - 1;
  return { full: false, start, end };
}

/* ══════════════════════════════════════════════════════════════
   把底层异常翻译成人话，再回给用户
   ──────────────────────────────────────────────────────────────
   服务端的错误来得很"底层"：fs 抛 `ENOENT: no such file or directory`、
   取源抛 `getaddrinfo ENOTFOUND`、发信抛 `535 Authentication failed`。
   这些原文只该进日志 —— 用户在界面上看到的必须是一句能懂的话。

   ⚠️ 顺序很重要：先看是不是我们自己 throw 的中文业务话
   （「剩余空间不足，换个大点的盘」这种），是就原样放行；
   但中文里**混进了技术特征**的（"创建失败：EACCES…"）不能放行。
   ══════════════════════════════════════════════════════════════ */
const TECH_HINT = /ENOENT|EACCES|EPERM|ENOSPC|ENOTDIR|EISDIR|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|getaddrinfo|socket hang up|fetch failed|HTTP \d{3}|\bTLS\b|\bSSL\b|certificate|EAUTH|535|SMTP|non-JSON|JSON/i;
function humane(e, fallback) {
  const m = String((e && e.message) || e || '');
  if (!m) return fallback || '出了点小问题，稍后再试';
  /* 我们自己写的中文业务话，且没夹技术特征 → 原样用 */
  if (/[\u4e00-\u9fa5]/.test(m) && !TECH_HINT.test(m)) return m;
  if (/ENOSPC|空间不足|no space left/i.test(m)) return '磁盘空间不够了，换个盘或清点东西';
  if (/EACCES|EPERM|permission denied/i.test(m)) return '没有权限读写这个位置';
  if (/ENOENT|EISDIR|ENOTDIR/i.test(m)) return '这个路径不存在，或者它不是一个文件夹';
  /* Node 自己的 fetch 失败长这样，跟浏览器的措辞不一样，得单独认一下 */
  if (/Failed to fetch|NetworkError|ERR_|socket hang up|fetch failed/i.test(m)) return '连不上对方服务器，稍后再试';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|getaddrinfo/i.test(m))
    return '连不上对方服务器，稍后再试';
  if (/aborted|AbortError/i.test(m)) return '已取消';
  if (/ETIMEDOUT|timeout|timed out/i.test(m)) return '对方响应太慢，超时了';
  if (/certificate|TLS|SSL|self.signed/i.test(m)) return '安全连接没建立起来，稍后再试';
  if (/EAUTH|535|SMTP|smtp/i.test(m)) return '发信邮箱配置有问题，检查一下邮箱设置';
  if (/HTTP 5\d\d/i.test(m)) return '对方平台暂时不可用，稍后再试';
  if (/HTTP 4\d\d/i.test(m)) return '对方平台拒绝了这次请求';
  if (/non-JSON|JSON/i.test(m)) return '对方平台返回的内容看不懂';
  return fallback || '出了点小问题，稍后再试';
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    let tooBig = false;
    req.on('data', c => {
      /* ⚠️ 超限后绝不能 req.destroy()：socket 一掐，这个请求就再也回不了
       * 任何状态码 —— 客户端 fetch 抛 TypeError，前端只能显示「网络问题」，
       * 用户永远看不到真正的原因。而且 destroy 之后 'end' 也不一定会来，
       * 这个 Promise 可能永远悬着，连接直接挂死。
       * 正确做法：置标志 → 后面来的数据照常消费掉（把请求体排空，让连接
       * 能正常收尾）但不再拼进 b（不无上限吃内存）→ 到 'end' 时 reject，
       * 由调用方/最外层 catch 写回一个真正的 413。 */
      if (tooBig) return;
      b += c;
      if (b.length > 4e6) { tooBig = true; b = ''; req._bodyTooBig = true; }
    });
    req.on('end', () => {
      if (tooBig) {
        try { req.resume(); } catch { }
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        return;
      }
      try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); }
    });
  });
}
const int = (v, d, min = 1, max = 100) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

/* ---- 账号文件热重载 ----
 * 账号管理台（admin/，8803）会直接改 data/users.json、sessions.json、secrets.json。
 * 如果主服务一直用内存里的旧副本，下一次写回（有人登录、有人收藏）就会把管理台的改动盖掉。
 * 所以每个请求进来先按 mtime 看一眼：文件被外部改过就重新加载。
 * 代价只是一次 stat，可忽略。
 */
const _mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

/* 表驱动热重载。
   以前是三段复制粘贴的 if —— 加一个文件就得再抄一遍，抄漏的那个
   就永远「改了不生效」（daily-cache 就是这么漏掉的：榜单缓存不在这里，
   外部改了主服务看不见，下一次落盘又把它盖回旧值）。
   现在加文件只往这张表里添一行，逻辑只有一份。
   ⚠️ 只放「会被外部改动」的文件：账号管理台（admin/）直接写
   users/sessions/secrets，主服务必须跟着变，否则下一次写回会盖掉管理台的改动。
   别把这里当万能钩子 —— 请求进来每个都要 stat 一次，表越长越贵。 */
const HOT_FILES = [
  { key: 'users',    file: () => USERS_FILE,    set: v => { USERS = v; } },
  { key: 'sessions', file: () => SESSIONS_FILE, set: v => { SESSIONS = v; } },
  { key: 'secrets',  file: () => SECRETS_FILE,  set: v => { SECRETS = v; } }
];
const _mt = Object.create(null);
for (const h of HOT_FILES) _mt[h.key] = _mtime(h.file());
_mt.daily = _mtime(dailyCacheFile());

function refreshData() {
  try {
    for (const h of HOT_FILES) {
      const f = h.file();
      const m = _mtime(f);
      if (!m || _mt[h.key] === m) continue;
      _mt[h.key] = m;
      const v = readJSON(f, null);
      if (v) h.set(v);
    }
    /* daily-cache 不走 readJSON：它是单日缓存，跨天要整体作废，
       所以交给 dailyCacheLoad() 自己判断，这里只负责发现「文件被动过」。 */
    const dm = _mtime(dailyCacheFile());
    if (dm && _mt.daily !== dm) { _mt.daily = dm; dailyCacheLoad(); }
  } catch { /* 读不到就继续用内存里的 */ }
}

/* ---------------- 防 DDoS 入口闸门（U-41）---------------------------------
 * 三条硬约束，改这块前先读一遍：
 *   ① 不误伤真实用户 —— 档位默认宽松，上线后照 `[rate] 429` 日志再收，
 *      绝不提前收紧。阈值集中在下面 RL_LIMIT 一张表里，收档改一个数字。
 *   ② 逃生口 —— 回环 / 健康检查 / 管理员不限；真误伤了还有 data/rate.json
 *      能全场放行，不用回滚代码、不用重推版本。
 *   ③ 日志必须回答「谁被限、为什么」—— ip / 路由 / 档位 / 当前计数 / 体积全打。
 *
 * 分档按**运行时 stat 出来的真实 size**，不按路由名写死：覆盖层 673KB 会随
 * 版本变，写死的那天就是误伤的开始。只有超过 RL_BIG_SIZE 的才进大文件档。
 *
 * 各档额度**彼此独立**（key 里带档位名）：封面把出网档吃光、覆盖层把 exe 档
 * 吃光这种「互相饿死」必须隔开 —— 调研 §5 那张按路由名的原表就是栽在这上面，
 * 实测单客户端第一次 OTA 就会在 apk 上吃 429。
 * ---------------------------------------------------------------------- */
const RL_FILE = path.join(APP_DIR, 'data', 'rate.json');
const RL_BIG_SIZE = 10 * 1024 * 1024;   // 超过这个体积算大文件（运行时 stat 判，不写死路由名）
const RL_BIG_CONC = 2;                  // per-IP 大文件并发上限；不做全局并发（会误伤一群人同时下载）
const RL_MAX_KEYS = 50000;              // 计数 key 上限，超了按 LRU 淘汰一批
const RL_LIMIT = {
  big:    { limit: 5,    win: 600000 },  // 大文件：exe / apk（八端两个 exe，装全套 2 次 + 重试）
  out:    { limit: 120,  win: 600000 },  // 出网：/api/search /api/proxy（一次真实搜索只打 1 个请求）
  img:    { limit: 1500, win: 600000 },  // 封面：一次搜索极端扇出约 300 张，1500 是它的 5 倍
  login:  { limit: 8,    win: 600000 },  // 登录：key 带 username，NAT 后面几十个用户不互相踩
  normal: { limit: 600,  win: 600000 },  // 其余：一次 OTA 打 5 个请求，600 扛约 119 个同 IP 客户端
};
/* 这三个走 login 档（key 带账号），不在入口按普通档记 —— 否则 NAT 出口后面
   一个人输错密码会把同 IP 所有人的普通额度一起吃掉。 */
const RL_AUTH_PATH = ['/api/auth/login', '/api/auth/codelogin'];
const RL_HITS = new Map();      // key -> [ts,...]；Map 的插入序就是 LRU 序
const RL_BIG_LIVE = new Map();  // ip -> 正在进行的大文件下载数
let RL_SWITCH = { mt: -1, at: 0, enforce: true };

/* 全局开关：data/rate.json 写 {"enforce":false} 就全场只打日志、不返回 429。
   限流是八端全量生效的东西，留这个口子是为了误伤时改一个文件就能放行。
   按 mtime 缓存，最多 10 秒生效；文件不存在 = 默认开（限流生效）。 */
function rlEnforce() {
  const now = Date.now();
  if (RL_SWITCH.mt >= 0 && now - RL_SWITCH.at < 10000) return RL_SWITCH.enforce;
  let enforce = true, mt = -1;
  try { mt = fs.statSync(RL_FILE).mtimeMs; } catch { mt = -1; }
  if (mt >= 0) {
    try {
      const o = JSON.parse(fs.readFileSync(RL_FILE, 'utf8'));
      if (o && typeof o.enforce === 'boolean') enforce = o.enforce;
    } catch { enforce = true; }   // 文件写坏了按「开」处理：宁可限住，不能悄悄放行
  }
  RL_SWITCH = { mt, at: now, enforce };
  return RL_SWITCH.enforce;
}

/* 滑动窗口计数 + LRU 封顶。
   LRU 不是可选加固：定时清扫只能保证「窗口滚过去之后不涨」，窗口内涌进来的
   那一波照样能把内存顶穿 —— 两道都要有，缺一道顶不住真打进来的那十分钟。 */
function rlHit(key, bucket) {
  const cfg = RL_LIMIT[bucket] || RL_LIMIT.normal;
  const now = Date.now();
  let arr = RL_HITS.get(key) || [];
  let i = 0;
  while (i < arr.length && now - arr[i] >= cfg.win) i++;
  if (i) arr = arr.slice(i);
  arr.push(now);
  RL_HITS.set(key, arr);            // 重新 set：把这个 key 挪到 Map 末尾（最近用过）
  if (RL_HITS.size > RL_MAX_KEYS) {
    let n = Math.ceil(RL_MAX_KEYS * 0.1);
    for (const k of RL_HITS.keys()) { RL_HITS.delete(k); if (--n <= 0) break; }
  }
  return { n: arr.length, limit: cfg.limit, win: cfg.win, over: arr.length > cfg.limit };
}

/* 定时清扫：只删整个窗口都滑过去的 key。unref 是必须的 —— 别让这个定时器
   把本该退出的进程吊住。 */
const RL_SWEEP_MS = 600000;
setInterval(() => {
  const now = Date.now();
  let dropped = 0;
  for (const k of Array.from(RL_HITS.keys())) {
    const arr = (RL_HITS.get(k) || []).filter(t => now - t < RL_SWEEP_MS);
    if (!arr.length) { RL_HITS.delete(k); dropped++; } else RL_HITS.set(k, arr);
  }
  if (dropped) console.log('[rate] 清扫过期计数 ' + dropped + ' 个，剩 ' + RL_HITS.size);
}, RL_SWEEP_MS).unref();

/* 清单读取按 mtime 缓存：大文件档每次都要 stat 落点，不能每个请求都解一遍 JSON */
const RL_META_CACHE = new Map();
function rlJsonCached(f) {
  try {
    const st = fs.statSync(f);
    const c = RL_META_CACHE.get(f);
    if (c && c.mt === st.mtimeMs) return c.obj;
    const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
    RL_META_CACHE.set(f, { mt: st.mtimeMs, obj });
    return obj;
  } catch { return null; }
}
function rlSizeOf(fp) { try { return fs.statSync(fp).size; } catch { return 0; } }

/* 把路由解析成磁盘落点再 stat —— 判大档靠真实字节，不靠路由名 */
function rlTargetSize(p, u) {
  if (p === '/api/app/file') {
    const r = String((u && u.searchParams.get('rel')) || '');
    if (!r || r.indexOf('..') >= 0) return 0;
    return rlSizeOf(path.join(RELEASE_DIR, r));
  }
  if (p === '/api/app/exe') {
    const m = rlJsonCached(RELEASE_MANIFEST);
    return (m && m.exe && m.exe.file) ? rlSizeOf(path.join(RELEASE_DIR, String(m.exe.file))) : 0;
  }
  if (p === '/api/app/apk') {
    const a = rlJsonCached(APK_META);
    return (a && a.file) ? rlSizeOf(path.join(RELEASE_DIR, String(a.file))) : 0;
  }
  if (p === '/api/app/admin-apk') {
    const a = rlJsonCached(ADMIN_APK_META);
    return (a && a.file) ? rlSizeOf(path.join(RELEASE_DIR, String(a.file))) : 0;
  }
  return 0;
}
function rlBucket(p, u) {
  if (p === '/api/img') return { bucket: 'img', size: 0 };
  if (p === '/api/search' || p === '/api/proxy') return { bucket: 'out', size: 0 };
  const size = rlTargetSize(p, u);
  return size > RL_BIG_SIZE ? { bucket: 'big', size } : { bucket: 'normal', size };
}

/* 逃生口。返回非空字符串表示放行，返回值进日志便于核对。
   ⚠️ 回环这条能成立是因为生产是 systemd 直接 HOST=0.0.0.0 裸跑、链路里没有
   反代（deploy/ymusic.service:17），ipOfReq 拿到的就是真实客户端 IP。
   哪天前面挂了 Nginx，这一条会变成「所有人都不限」，改之前先确认链路。 */
function rlExempt(req, p) {
  if (p === '/api/ping') return 'ping';
  const ip = ipOfReq(req);
  if (!ip || ip === '127.0.0.1' || ip === '::1') return 'loopback';
  try {
    const s = userOf(req);
    if (s && s.user && isAdmin(s.user)) return 'admin';
  } catch { /* 认不出身份就按普通请求记，不放行 */ }
  return '';
}

/* 真正拦。返回 true 表示已经把 429 发出去了（调用方直接 return）。
   开关关掉时只打日志、不拦 —— 日志照样记，这样「关掉之后到底有没有人被打」
   回头还能查。 */
function rlDeny(req, res, p, bucket, size, n, limit, how) {
  const line = '[rate] 429 ' + p + ' ip=' + ipOfReq(req) + ' bucket=' + bucket
    + ' count=' + n + '/' + limit + ' size=' + size + ' 原因=' + how;
  if (!rlEnforce()) { console.warn(line + '（全局开关关闭 → 只记不拦）'); return false; }
  console.warn(line);
  const win = (RL_LIMIT[bucket] || RL_LIMIT.normal).win;
  try {
    send(res, 429, JSON.stringify({ ok: false, error: '请求太频繁，稍后再试', bucket, count: n, limit }),
      { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(Math.ceil(win / 1000)) });
  } catch { /* 连接已经没了 */ }
  return true;
}

/* 入口闸门。返回 true = 已发 429，调用方 return；false = 放行。 */
function rateGate(req, res, p, u) {
  if (rlExempt(req, p)) return false;
  if (RL_AUTH_PATH.indexOf(p) >= 0) return false;   // 登录走 login 档，在各路由里记（要带账号）
  const ip = ipOfReq(req) || 'unknown';
  const { bucket, size } = rlBucket(p, u);
  const h = rlHit(ip + '|' + bucket, bucket);
  if (!h.over) {
    /* 并发只压大文件档：普通请求限并发会误伤（一屋子人同时点播放），
       而 per-IP 配额已经把单 IP 压住了，全局并发换不来多少额外保护。 */
    if (bucket === 'big') {
      const live = RL_BIG_LIVE.get(ip) || 0;
      if (live >= RL_BIG_CONC) return rlDeny(req, res, p, bucket, size, live + 1, RL_BIG_CONC, '并发');
      RL_BIG_LIVE.set(ip, live + 1);
      res.on('close', () => {
        const n = (RL_BIG_LIVE.get(ip) || 1) - 1;
        if (n <= 0) RL_BIG_LIVE.delete(ip); else RL_BIG_LIVE.set(ip, n);
      });
    }
    return false;
  }
  return rlDeny(req, res, p, bucket, size, h.n, h.limit, '窗口');
}

/* 登录档：key 带账号，所以只能等 body 读出来之后再记 —— 放在路由里调，
   不放入口（入口拿不到账号，按纯 IP 记会误伤整个 NAT 出口）。 */
function rlLoginGate(req, res, p, account) {
  const ip = ipOfReq(req) || 'unknown';
  const h = rlHit(ip + ':' + String(account || '').toLowerCase() + '|login', 'login');
  if (!h.over) return false;
  return rlDeny(req, res, p, 'login', 0, h.n, h.limit, '窗口');
}

/* ══════════════════════════════════════════════════════════════════════
   统一收件箱的**构建函数**（2026-10-16 重构第 3 步：从 /api/msg/list 抽出）

   为什么非抽不可：`unread` 这个数字原先是在 /api/msg/list **拼完列表后顺带数出来的**，
   于是"铃铛要一个数字"就得把整个列表拉一遍 —— 三端各自拉、各自算，口径自然就漂。
   这正是业主说的"消息系统混乱"里最隐蔽的一条：没人改错，但三个数字对不上。
   抽成函数之后，列表接口与新增的 /api/msg/summary 用的是**同一份真值**，
   前端不许、也不必再自己相加。

   ⚠️ 纯搬运：函数体与改动前逐字节等价（只把 Q('hide')/Q('all') 换成 opts，
      return 换成对象）。一旦和新增端点混在一起改，出问题就分不清是谁的锅。
   ══════════════════════════════════════════════════════════════════════ */
function buildMsgList(uid, opts) {
  const out = [];

  /* ── 归档开关（2026-10-16 加）───────────────────────────────────────
     业主的要求：「**用户查看的消息就不再显示了才对**」。
     为什么做成**查询参数 opt-in** 而不是直接改默认行为：
       服务端与前端是**分别部署**的（前端走 OTA / 直传，服务端改完立刻生效）。
       如果直接把"已读就不返回"设成默认，那么在前端还没跟上、或某个用户
       还在跑缓存里旧前端的这段时间里，**公告会在他眼前凭空消失**，
       而且他没有任何办法找回来 —— 这种"服务端先动"的窗口期事故不值得冒。
     所以：默认行为**一字不改**（老客户端完全无感）；
       新前端带上 `hide=1` 才启用"看过的通知不再占列表"。
     `all=1` 是反向开关：显式要全量（含已读），给"历史消息"入口用。
     ⚠️ 置顶（top）公告即使已读也**不隐藏** —— 它是常驻说明，
        藏起来用户就找不到"怎么改头像"这类操作说明了。 */
  const hideRead = !!(opts && opts.hide);
  const showAll = !!(opts && opts.all);
  const arcMap = (uid ? (readJSON(NOTICE_ARCHIVE, {})[uid] || {}) : {});

  /* ① 管理员公告 + 版本更新 */
  const allN = readJSON(NOTICE_FILE, { list: [] });
  const nl = Array.isArray(allN.list) ? allN.list.slice() : [];
  nl.sort((a, b) => (!!b.top - !!a.top) || ((b.at || 0) - (a.at || 0)));
  const readMap = readJSON(NOTICE_READ, {});
  const rd = (uid && Array.isArray(readMap[uid])) ? readMap[uid] : [];
  const hidMap = readJSON(MSG_HIDDEN_FILE, {});
  const hid = (uid && Array.isArray(hidMap[uid])) ? hidMap[uid] : [];
  /* 公布的最近一版版本号，给没写 version 的老更新公告兜底。
   * 为什么要带版本号：前端要靠它判断「这条更新消息还能不能点」——
   * 已经是最新版的时候，按钮应该变成「重新下载安装包」而不是「更新到 X」。 */
  const relVer = String((readJSON(RELEASE_MANIFEST, null) || {}).version || '');
  for (const n of nl.slice(0, MSG_PAGE_MAX)) {
    if (hid.indexOf('nt_' + n.id) >= 0) continue;   // 我删掉的那条不再出现
    const kind = n.type === 'update' ? 'update' : 'notice';
    const ver = String(n.version || (kind === 'update' ? relVer : '') || '');
    const isUnread = rd.indexOf(n.id) < 0;
    /* hide=1：看过的通知不再占列表（置顶除外，见上面那段注释）。
       ⚠️ 判断放在**遍历内**而不是先收集再过滤，是为了让下面的
          "ID 集合里剔掉被隐藏的项" 这一步天然成立（也就不需要额外剔除逻辑）。 */
    if (hideRead && !showAll && !isUnread && !n.top) continue;
    /* 🔴 by / byName：公告与更新的**发布者**（2026-10-16 加）。
       为什么必须补这一段：同一份数据在 /api/notice 里**本来就有** by/byName
       （实测线上 notices.json：by='u342a10aded5524d6'、byName='朗霁.'），
       但 /api/msg/list 一直没带出去 —— 于是消息中心里公告永远只能画一个
       通用图标，业主的原话是「谁发的，发的什么，描述要描述好」，
       而"谁发的"这一半数据我们其实是有的，只是没接上。
       ⚠️ 纯增量：老前端忽略这两个字段，行为不变。 */
    out.push({
      id: 'nt_' + n.id,
      kind,
      title: n.title || '', body: n.body || '',
      points: Array.isArray(n.points) ? n.points : [],
      version: ver,
      by: String(n.by || ''), byName: String(n.byName || ''),
      at: n.at || 0, top: !!n.top,
      unread: isUnread,
      /* 已读时刻（毫秒，0=没记过）。前端可用它做"最近看过的排后面"，
         也可以据此在展开态显示"已于 X 读过"。 */
      readAt: Number(arcMap[n.id] || 0) || 0,
      data: { noticeId: n.id, version: ver }
    });
  }

  if (uid) {
    /* ② 好友申请 */
    const s = readSocial();
    for (const r of s.requests.filter(x => x.to === uid && x.state === 'pending')) {
      if (hid.indexOf('fr_' + r.id) >= 0) continue;   // 我删掉的申请不再出现
      const u = USERS[r.from];
      const nm = u ? (u.username || '有人') : '有人';
      out.push({
        id: 'fr_' + r.id, kind: 'friend',
        title: nm + ' 想加你为好友',
        body: r.msg || '', at: r.at || 0, unread: true,
        data: { reqId: r.id, uid: r.from, name: nm, avatar: avatarUrlOf(u || {}) }
      });
    }

    /* ②-b 好友申请的**结果**通知（2026-10-16 加，重构第 2 步）
     *
     * 与上面的"申请"是两回事、方向也相反：
     *   · `friend`（fr_ 前缀）      = 别人申请加**我** → 要我去处理（待办）；
     *   · `friendResult`（frr_ 前缀）= **我**申请的结果 → 通知我看一眼就行。
     * 为什么分开成两种 kind：`friend` 是"待处理"（处理完自己就消失），
     * `friendResult` 是"消息"（看即消失）。混成一种会让前端的 tab 与清空
     * 逻辑都失去意义 —— 这正是业主说的"消息系统混乱"的一个来源。
     *
     * ⚠️ id 前缀必须用 `frr_`，且 `/api/msg/read` 里要**单独开一条分支**：
     *    本文件既有注释多次警告过同类事故（`md` 若不单独开分支会被 `mm` 吸走
     *    → 已读置不上 → 红点永远消不掉）。前缀分派是这里最容易出无声 bug 的地方。
     */
    for (const n of (Array.isArray(s.friendNotes) ? s.friendNotes : [])) {
      if (n.to !== uid) continue;
      if (hid.indexOf('frr_' + n.id) >= 0) continue;   // 我自己删掉的不再出现
      /* hide=1：**看过的**好友结果也不再占列表（msg5 补）。
         为什么原来只有公告那一档有这条：hide 是 msg2 先给公告做的；
         而「看即消失」这条规则是**对所有通知类**成立的 ——
         friendResult / moment 跟公告一样是"看完就该消失"的一次性通知，
         漏掉它们的话列表会越攒越长，业主说的"混了太多不相干的东西"就治不干净。
         ⚠️ friend（待处理的申请）与 invite（房间里等我）不在此列：
            它们不是"看过就完"，而是"处理完才完"。 */
      if (hideRead && !showAll && n.read) continue;
      const u = USERS[n.from];
      const nm = u ? (u.username || '有人') : '有人';
      out.push({
        id: 'frr_' + n.id,
        kind: 'friendResult',
        title: n.accept ? (nm + ' 通过了你的好友申请')
                        : (nm + ' 拒绝了好友申请'),
        /* 通过时给一句可操作的下一步；拒绝时不加多余的话。 */
        body: n.accept ? '现在可以和他聊天了' : '',
        at: n.at || 0,
        unread: !n.read,
        data: {
          uid: n.from, name: nm, avatar: avatarUrlOf(u || {}),
          accept: !!n.accept
        }
      });
    }

    /* ③ 一起听邀请 —— 通知的角色行就是从这里出去的
     *
     * 房间的 host / guest 就是两个收件人：一边是「别人邀我」，
     * 一边是「我邀了别人」。不另开一张"已发通知"表 ——
     * 房间本身就是这条通知的原始凭证：客人加入了就从 invite 变 announcing，
     * 房间过期了邀请自动消失（正好是"过期就没意义"那条原始设计）。
     *
     * 以前这条路压根没接上（3065 那行注释规划了 invite，body 里没有），
     * 于是邀请只能出现在好友页那块横幅上 —— 客人不在好友页就永远看不见，
     * 房间卡在 inviting 直到过期，用户看到的就是「一直等对方加入」。 */
    const rms = readRooms().rooms || [];
    const nowMs = Date.now();
    for (const r of rms) {
      if (r.state !== 'inviting' && r.state !== 'active') continue;
      if (nowMs - Number(r.updatedAt || r.at || 0) > ROOM_IDLE) continue;
      const sg = r.song || {};
      const sName = String(sg.name || sg.songname || '');
      const sWho = String(sg.artist || sg.singer || '');
      const sub = sName ? ('《' + sName + '》' + (sWho ? ' · ' + sWho : '')) : '';
      const id = 'lv_' + r.id;
      if (hid.indexOf(id) >= 0) continue;             // 我删掉的这条不再出现
      if (r.guest === uid) {
        const h = USERS[r.host];
        const nm = h && h.username ? h.username : '有人';
        out.push({
          id, kind: 'invite',
          title: nm + ' 邀请你一起听',
          body: sub, at: Number(r.updatedAt || r.at) || 0,
          /* 没加入之前算未读（要你去点），加入之后还留在列表里 ——
             给一条"回到房间"的路，但不再亮红点。 */
          unread: r.state === 'inviting',
          data: { roomId: r.id, song: sg, state: r.state, name: nm, mine: false,
                  uid: r.host, avatar: avatarUrlOf(h || {}) }
        });
      } else if (r.host === uid) {
        const g = USERS[r.guest];
        const nm = g && g.username ? g.username : '对方';
        out.push({
          id, kind: 'invite',
          title: (r.state === 'inviting' ? '已邀请 ' : '正在和 ') + nm + ' 一起听',
          body: sub + (r.state === 'inviting' ? ' · 等 TA 加入' : ' · 进行中'),
          at: Number(r.updatedAt || r.at) || 0,
          /* 我自己发出去的动作，不再给自己计未读 ——
             红点代表"有件事等你处理"，我自己的事不算。 */
          unread: false,
          data: { roomId: r.id, song: sg, state: r.state, name: nm, mine: true,
                  uid: r.guest, avatar: avatarUrlOf(g || {}) }
        });
      }
    }

    /* ④ 音乐圈互动 —— 有人赞了 / 评论了「我」发的动态
     *
     * 以前这一路是**完全静音**的：/api/moment/like 和 /api/moment/comment
     * 只写 moments.json，作者收不到任何通知、任何红点，
     * 只有自己主动翻到那一屏才看得见 —— 跟朋友圈的预期正好是反的。
     *
     * 未读口径跟好友申请一致：记在记录自己的 read 字段上，
     * 看过之后由 /api/msg/read 置 true；从收件箱划掉走 /api/msg/del。
     * 名字和头像在这里现查 USERS，不在消息里存快照。 */
    const mlist = readMoments().list || [];
    for (const x of readMomentMsgs().list) {
      if (!x || x.to !== uid) continue;
      if (hid.indexOf(x.id) >= 0) continue;             // 我删掉的那条不再出现
      if (hideRead && !showAll && x.read) continue;     // 看过的互动也不再占列表（msg5）
      const u = USERS[x.from];
      const nm = u && u.username ? u.username : '有人';
      const isC = x.act === 'comment';
      out.push({
        id: x.id, kind: 'moment',
        title: nm + (isC ? ' 评论了你的动态' : ' 赞了你的动态'),
        /* 评论：正文就是评论内容；点赞：退回动态本身的摘要，
           否则整行只有标题、右边空一大片，看着像没加载出来。 */
        body: isC ? String(x.text || '') : momentBrief(mlist.find(y => y.id === x.momentId)),
        at: x.at || 0,
        unread: !x.read,
        data: { momentId: x.momentId, act: x.act, from: x.from, name: nm,
                text: String(x.text || ''), avatar: avatarUrlOf(u || {}) }
      });
    }

    /* ⑤ 音乐圈每日汇总 —— 今天有几位用户上传了新歌
     *
     * 放在 if (uid) 里是刻意的：游客 userOf() 返回 null，压根进不来这个分支，
     * 所以「不给游客推」零新增判定代码（游客身份是 httpOnly Cookie ym_sid，
     * 只活在内存，users.json 里查不到，也就没有任何字段可判）。
     *
     * 去重键 = 用户 + 北京时间自然日：汇总以 day 为主键，全局一天最多存在
     * 一条记录，所以「每人每天最多 1 条」是数据结构保证的，不需要
     * lastSentDay 之类的 per-user 去重表，也不存在"重复推送"这个故障模式。
     *
     * id 必须是 'md' + YYYYMMDD 且随天变：
     *   · 用 mm 前缀会被 /api/msg/read 的前缀分派吸进 moment-msg.json 分支，
     *     在它自己那张表里永远找不到自己 → 已读置不上 → 红点永远消不掉；
     *   · id 不随天变的话，网页 MSG_SEEN[m.id] 会永久记住它，第二天起
     *     toast 不再弹；桌面 setUnread() 在「未读数没变」时直接 return，
     *     系统通知也会静默。 */
    const dRec = ensureMomentDaily();
    /* hide=1：今天这条读过了就不再占列表（msg5；跟公告/好友结果同一条规则） */
    if (dRec && dRec.day && hid.indexOf(dRec.id) < 0
        && !(hideRead && !showAll && momentDailyReadDay(uid) === dRec.day)) {
      const nn = MOMENT_DAILY_N_SOURCE === 'song'
        ? (dRec.songAuthors || 0)      // 🔴 拍板口径：只算带歌的
        : (dRec.n || 0);
      const nmz = Array.isArray(dRec.names) ? dRec.names.slice(0, MOMENT_DAILY_NAME_MAX) : [];
      const who = nmz.join('、') || '有人';
      /* body 必须恒为非空：前端 msgSummary() 对 kind==='moment' 且 body 为空的
         兜底是「（这条动态已删除）」，汇总落到那个兜底上是明显错误。 */
      const body = (nn <= 1 ? who : (nmz.length >= nn ? who : who + ' 等 ' + nn + ' 位'))
                 + '上传了新歌，点开就能听';
      out.push({
        id: dRec.id, kind: 'moment',
        title: '今天有 ' + nn + ' 位用户上传了新歌',
        body: body,
        at: dRec.at || 0,
        unread: momentDailyReadDay(uid) !== dRec.day,
        data: {
          day: dRec.day, n: dRec.n, count: dRec.count,
          songCount: dRec.songCount, songAuthors: dRec.songAuthors,
          names: nmz,
          songs: Array.isArray(dRec.songs) ? dRec.songs : [],
          momentIds: Array.isArray(dRec.momentIds) ? dRec.momentIds : [],
          daily: true, go: 'moments'
        }
      });
    }
  }

  out.sort((a, b) => (!!b.unread - !!a.unread) || ((b.at || 0) - (a.at || 0)));
  const byKind = { notice: 0, update: 0, friend: 0, friendResult: 0, invite: 0, moment: 0 };
  let unread = 0;
  for (const x of out) {
    if (!x.unread) continue;
    unread++;
    if (byKind[x.kind] != null) byKind[x.kind]++;
  }
  return { out, unread, byKind };
}

/* 私聊未读总数（**另一个口径**）。
   为什么单独一个函数：通知未读来自 msg/list、私聊未读来自 social.chat，
   两套数据各算各的正是"数字与列表条数对不上"的成因。汇总端点必须把两者
   在**同一处**相加 —— 所以这里只留一个谓词（to==我 && !read），
   /api/chat/list 的逐会话未读与 /api/msg/summary 的 chatUnread 都走它。
   s 可传入已读好的 social，避免同一请求里重复读盘。 */
function chatUnreadOf(uid, s) {
  if (!uid) return 0;
  const soc = s || readSocial();
  let n = 0;
  for (const x of soc.chat) {
    if (x.to !== uid || x.read) continue;
    /* ⚠️ 我在自己这一侧删掉的不算未读（msg6）：`hide` 是"谁把自己那份删了"，
       不过滤的话会出现"消息删了、铃铛数字还在"——数字与列表当场打架。 */
    if (Array.isArray(x.hide) && x.hide.indexOf(uid) >= 0) continue;
    n++;
  }
  return n;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;
  const Q = k => u.searchParams.get(k) || '';
  try {
    refreshData();
    /* ---- U-41 入口闸门（在业务路由之前，OPTIONS 之后）---- */
    if (rateGate(req, res, p, u)) return;
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (p === '/api/ping') return sendJSON(res, {
      ok: true, service: 'kugou-downloader', version: 3, app: APP_VERSION, port: PORT,
      dir: CFG.downloadDir, sea: IS_SEA, concurrency: TASK_MAX_CONCURRENCY,
      lan: lanAddrs().map(ip => `http://${ip}:${PORT}`),
      publicUrl: publicUrl(),
      bind: BIND_HOST,
      /* 属地库有没有加载起来。false 时所有 prov 都是空串，前端不渲染，其余功能照旧。 */
      ipgeo: IPGEO_OK
    });

    /* ---- /addr.json：客户端冷启动的「自愈锚点」 ----
     * 老 APK / 老 exe 里烧的地址总会过期（服务器换 IP、隧道换域名），
     * 所以它们冷启动时先打这个地址拿 {"url":"..."}，再直连真实服务。
     *
     * ⚠️ 这个锚点以前是外站 ymusic-boot.app.workbuddy.host 上的引导页。
     *    它死了 17 次：站点本身还活着（HTTP 200），坏的是**发布通道**，
     *    内容一直停在 10-10 13:46 写进去的那个死地址上。
     *    于是「自愈」变成了「自杀」—— 老包每次启动都去拉那个死地址，
     *    并**覆盖掉**自己已经记住的好地址，第二次启动即砖。
     *
     *    现在锚点由服务端自己提供：服务活着，锚点就是对的；
     *    服务挂了，锚点也打不开（客户端拿不到地址就会回退到内置地址），
     *    永远不会给出一个错的地址。这是自愈机制唯一安全的形态。
     *
     * ⚠️ 必须无鉴权：这是冷启动的第一个请求，那一刻没有任何登录态。
     * ⚠️ 必须 no-store：这个响应一旦被任何中间层缓存住，自愈就直接失效。 */
    if (p === '/addr.json') return send(res, 200, JSON.stringify({ url: currentBase() }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });

    /* ---- 抖音指纹：端侧上报 / 查询 ----
     * 抖音的 uifid 是设备指纹，由页面里的 mssdk 采 canvas / WebGL / navigator 算出来，
     * 纯 Node 造不出来 —— 缺了它就 403。
     *
     * 但 APK 的壳本身就是 WebView（真 Chromium 内核），桌面壳也是浏览器窗口：
     * 让它后台静默加载一次抖音页面，mssdk 会自己把 uifid 写进 cookie，
     * 端侧取回来 POST 到这里，服务端存下复用。这是成功率最高的一条路。
     *
     * GET  = 查询当前有没有能用的票（端侧据此决定要不要重取）
     * POST = 上报新票 */
    if (p === '/api/dy/fp') {
      const fresh = !!DY_JAR.src && DY_JAR.src !== 'native'
        && !!(DY_JAR.cookies.ttwid || DY_JAR.cookies.uifid)
        && (Date.now() - DY_JAR.at < DY_FP_TTL);
      if (req.method === 'POST') {
        const b = await readBody(req).catch(() => ({}));
        const r = dySetFingerprint(b.cookies, b.ua, b.src);
        if (!r.ok) return sendJSON(res, { ok: false, error: r.error });
        return sendJSON(res, { ok: true, ...r });
      }
      return sendJSON(res, {
        ok: true, fresh, src: DY_JAR.src || '',
        age: DY_JAR.at ? Date.now() - DY_JAR.at : -1,
        uifid: !!DY_JAR.cookies.uifid, ttwid: !!DY_JAR.cookies.ttwid
      });
    }

    /* ---- OTA：本机充当「更新源」，供已分发出去的 exe 回来拉新版前端 ----
     * 只下发前端静态资源（几百 KB），不动 exe 本体，所以不用重发 80MB 安装包。 */
    if (p === '/api/app/version') {
      const m = readJSON(RELEASE_MANIFEST, null) || {};
      /* Windows 桌面端安装包。文件没上传时为 null ——
       * 客户端据此判断「这版没有 Windows 包」，别给用户一个下载失败按钮。 */
      const exe = readExeMeta();
      const apk = readApkMeta(APK_META, '/api/app/apk');
      /* 管理台 APK（com.ymusic.admin）。
       * 以前只下发 apk，管理端根本没得可更新 —— 上云之后只能人工发 APK。
       * 注意字段与判定完全独立：两边包名/签名都不同，共用一份会互相拉错包。 */
      const adminApk = readApkMeta(ADMIN_APK_META, '/api/app/admin-apk');
      if (!m.version) return sendJSON(res, { ok: false, error: '尚未发布任何版本', apk, adminApk, exe });
      /* changelog：发布时逐条填的更新说明。老版本没这个字段就用 note 兜底成一条，
       * 免得旧清单在新客户端上显示成空白。 */
      let cl = Array.isArray(m.changelog) ? m.changelog.filter(Boolean) : [];
      if (!cl.length && m.note) cl = [m.note];
      /* base 的取值顺序改过了，这里要说清楚为什么：
       *   public-url.txt（publicUrl()）> manifest.base > 空
       * 以前是 m.base 优先，而那是**打包那一刻**烧进去的地址。
       * 隧道每次重启都会换域名，包发出去之后 m.base 就成了一条死链 ——
       * 用户手里那个版本的唯一升级通道跟着一起断掉。
       * public-url.txt 是运维端唯一真源，隧道续起来了改这一个文件，
       * 所有还活着的老客户端下一次自检就能自己迁回来（自举链路重新接上）。
       * m.base 留作兜底：有人完全离线部署、不维护 public-url.txt 时还能用。 */
      return sendJSON(res, { ok: true, version: m.version, base: publicUrl() || m.base || '', note: m.note || '',
        changelog: cl, at: m.at, force: !!m.force, files: releaseOverlayFiles(), apk, adminApk, exe });
    }

    /* ---- 消息中心：公告 + 版本更新记录 ----
     * 客户端进来拉一次，和「未读列表」比对出红点。已读按用户存，换手机也同步。 */
    if (p === '/api/notice') {
      const all = readJSON(NOTICE_FILE, { list: [] });
      let list = Array.isArray(all.list) ? all.list.slice() : [];
      list.sort((a, b) => (!!b.top - !!a.top) || ((b.at || 0) - (a.at || 0)));
      const me = userOf(req);
      const uid = me && me.uid ? me.uid : '';
      const readMap = readJSON(NOTICE_READ, {});
      const read = (uid && Array.isArray(readMap[uid])) ? readMap[uid] : [];
      return sendJSON(res, { ok: true, list: list.slice(0, MSG_PAGE_MAX), read, uid });
    }
    /* 标记已读。不登录也能调（只影响本地显示），登录了才跨设备同步。 */
    if (p === '/api/notice/read' && req.method === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const ids = Array.isArray(b && b.ids) ? b.ids.map(String) : [];
      const me = userOf(req);
      const uid = me && me.uid ? me.uid : '';
      if (uid && ids.length) {
        const map = readJSON(NOTICE_READ, {});
        const cur = Array.isArray(map[uid]) ? map[uid] : [];
        const set = new Set(cur.concat(ids));
        map[uid] = Array.from(set).slice(-MSG_KEEP_READ);
        writeJSON(NOTICE_READ, map);
      }
      return sendJSON(res, { ok: true, read: ids });
    }

    /* ══════════════════════════════════════════════════════════════
       统一收件箱 —— 消息不止一个来源
       管理员公告、版本更新、好友申请、一起听邀请，都从这个口子出去，
       前端才做得成真正的「消息中心」，而不是一块公告板。
       kind 决定前端怎么画、点下去干什么：
         notice / update → 看内容，已读按 notice-read 记
         friend          → 接受 / 忽略（处理完自然消失）
         invite          → 进入房间
       未读口径：公告查已读表；好友申请和邀请本身就是「待处理」，
       处理完就不在列表里了，不需要再记一份已读。
       ══════════════════════════════════════════════════════════════ */
    if (p === '/api/msg/list') {
      const me = userOf(req);
      const uid = me && me.uid ? me.uid : '';
      /* 归档开关（hide/all）的来龙去脉见 buildMsgList 上方那段注释；
         这里只负责把查询参数翻成 opts —— 默认行为一字不改。 */
      const built = buildMsgList(uid, { hide: Q('hide') === '1', all: Q('all') === '1' });
      return sendJSON(res, { ok: true, list: built.out, unread: built.unread, byKind: built.byKind, uid });
    }

    /* 未读汇总：铃铛的**唯一真值**（重构第 3 步）
     *
     * 以前铃铛要一个数字，前端只能把 /api/msg/list 整个拉下来自己数；
     * 而私聊未读又只在 friends 那一行上单独画 —— 于是同屏三个数字：
     *   · 铃铛里的（服务端 msg/list 数的，只含非私聊）
     *   · 好友行上的（服务端 chat/list 数的，只含私聊）
     *   · 左下角好友入口的（前端自己拿 kind:'friend' 点亮的）
     * 用户数不出"这个数字到底在数什么"，这就是「已读未读不对」的根。
     *
     * 现在：unread（通知未处理）+ chatUnread（私聊未读）= total，**在这一处相加**。
     * ⚠️ 前端不许再拿两个接口的数字本地累加：一旦有本地副本，多端就会不一致。
     * ⚠️ 不返回 list（这正是它存在的意义：轻量，红点不用拉全量）。
     */
    if (p === '/api/msg/summary') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const built = buildMsgList(me.uid, {});
      const soc = readSocial();
      const chatUnread = chatUnreadOf(me.uid, soc);
      return sendJSON(res, {
        ok: true,
        unread: built.unread,          // 通知/互动：未处理数
        byKind: built.byKind,          // 每个 tab 自己的角标
        chatUnread,                    // 私聊：对方发来且我没看
        total: built.unread + chatUnread,
        uid: me.uid,
        at: Date.now()
      });
    }

    /* 从收件箱里删掉一条。
       只决定「我」还看不看得见，不碰别人的数据，也不替用户做决定：
       好友申请删了仍然是 pending（对方那边还是「等对方确认」），
       只是从我眼前挪走 —— 免得手滑一点就把人拒了。 */
    if (p === '/api/msg/del' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      /* ── 批量删除（2026-10-16 加）────────────────────────────────────
         业主明确要「多选删除」这种大厂标配。以前一次只能删一条，
         多选就得前端循环发 N 个请求 —— 那种写法在半途失败时会留下
         "删了一半"的状态，用户看到的就是"我选了 8 条，删完还剩 3 条"。
         所以这里让接口直接吃数组，一次请求删完。
         ⚠️ **向后兼容**：老的单个 `id` 参数照旧支持（前端的单条删除、
            以及可能还在跑的旧前端都用它），两种形式可以同时用。
         ⚠️ 上限 200：多选删除是"用户手动勾"的场景，200 条远超任何真实操作；
            设上限是为了防止有人构造一个超大数组把 msg-hidden.json 撑爆
            （那个文件本身也有 MSG_KEEP_HIDDEN 的滚动上限）。 */
      const one = String((b && b.id) || '').trim();
      const many = Array.isArray(b && b.ids) ? b.ids.map(x => String(x || '').trim()).filter(Boolean) : [];
      const ids = [];
      if (one) ids.push(one);
      for (const x of many) { if (ids.indexOf(x) < 0) ids.push(x); }
      if (!ids.length) return sendJSON(res, { ok: false, error: '缺少 id' }, 400);
      const capped = ids.slice(0, 200);
      const map = readJSON(MSG_HIDDEN_FILE, {});
      const cur = Array.isArray(map[me.uid]) ? map[me.uid] : [];
      const added = [];
      for (const id of capped) {
        if (cur.indexOf(id) < 0) { cur.push(id); added.push(id); }
      }
      if (added.length) {
        map[me.uid] = cur.slice(-MSG_KEEP_HIDDEN);   // 只记最近这些，别让它越攒越长
        writeJSON(MSG_HIDDEN_FILE, map);
      }
      /* 返回 `id`（单条形式的老字段，老前端照旧能读）+ `ids`/`deleted`（新形式） */
      return sendJSON(res, {
        ok: true,
        id: one || capped[0],
        ids: capped,
        deleted: added.length
      });
    }

    /* 把一条标成已读（T-04）。
       按 id 前缀分派到各自该去的地方：
         nt_ → 公告的已读表 notice-read.json，跟 /api/notice/read 写的是同一份，
               两条路都能标，不会各记一套最后对不上；
         mm  → 音乐圈互动消息，read 直接落在记录上；
         md  → 音乐圈每日汇总，read 落在「天」上（read[uid] = 'YYYY-MM-DD'）。
         frr_ → 好友申请的**结果**通知（2026-10-16 加），read 落在 friendNotes 上。
       好友申请（fr_）和一起听邀请不需要：处理完自己就不在列表里了。 */
    if (p === '/api/msg/read' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const ids = Array.isArray(b && b.ids) ? b.ids.map(String) : [];
      const ntIds = ids.filter(x => x.indexOf('nt_') === 0).map(x => x.slice(3)).filter(Boolean);
      /* ⚠️ mmIds 用 `indexOf('mm') === 0`（不带下划线），所以**任何以 mm 开头**的 id
         都会被它吸走。frr_ 不受影响；但将来新增前缀时要留意这条既有判据。 */
      const mmIds = ids.filter(x => x.indexOf('mm') === 0);
      /* frr_ → 好友申请结果（重构第 2 步）。
         🔴 必须单独开这条分支，理由与本文件既有注释里 md_ 那次事故完全一样：
            前缀分派是"一条 catch-all 顺手吸走"的地方，被吸走的表现是
            **已读置不上 → 红点永远消不掉**，而且不报任何错。
            只置 `to === me.uid` 那几条 —— 别人的结果通知不该被我标已读。 */
      const frrIds = ids.filter(x => x.indexOf('frr_') === 0).map(x => x.slice(4)).filter(Boolean);
      if (frrIds.length) {
        const sF = readSocial();
        let hitF = 0;
        for (const n of (Array.isArray(sF.friendNotes) ? sF.friendNotes : [])) {
          if (n.to === me.uid && frrIds.indexOf(n.id) >= 0 && !n.read) { n.read = true; hitF++; }
        }
        if (hitF) writeSocial(sF);
      }
      if (ntIds.length) {
        const map = readJSON(NOTICE_READ, {});
        const cur = Array.isArray(map[me.uid]) ? map[me.uid] : [];
        const set = new Set(cur.concat(ntIds));
        map[me.uid] = Array.from(set).slice(-MSG_KEEP_READ);
        writeJSON(NOTICE_READ, map);
        /* ── 归档时间戳（2026-10-16 加，配合 /api/msg/list?hide=1）────────
           业主的要求是「**用户查看的消息就不再显示了才对**」。
           notice-read.json 只记"读过哪些 id"，没有时间，做不出「看过的排到后面/不显示」
           这类交互。这里另存一份 `{uid: {noticeId: 读取时刻}}`：
             · **不动 notice-read.json 的格式**（它已经被前端与老逻辑读着，改格式风险大）；
             · 上限沿用 MSG_KEEP_READ，超了就丢最旧的，与已读表同一个口径。
           为什么不用一个文件同时记两件事：读已读表的地方有 3 处，
           而需要"归档时间"的只有列表这一处 —— 分开存，耦合最小。 */
        try {
          const am = readJSON(NOTICE_ARCHIVE, {});
          const mine = (am[me.uid] && typeof am[me.uid] === 'object') ? am[me.uid] : {};
          const now = Date.now();
          for (const nid of ntIds) mine[nid] = now;
          const keys = Object.keys(mine);
          if (keys.length > MSG_KEEP_READ) {
            keys.sort((a, b) => (mine[a] || 0) - (mine[b] || 0));
            for (const k of keys.slice(0, keys.length - MSG_KEEP_READ)) delete mine[k];
          }
          am[me.uid] = mine;
          writeJSON(NOTICE_ARCHIVE, am);
        } catch (e) {
          /* ⚠️ 归档写失败绝不能让"已读"这件事失败（已读已经写成功在上面）。
             按本文件既有铁律：通知类异常在函数内部吃干净，不能把请求打成 500。 */
          console.warn('[notice-archive] 写入失败（不影响已读）：' + (e && e.message || e));
        }
      }
      if (mmIds.length) {
        const db = readMomentMsgs();
        const list = Array.isArray(db.list) ? db.list : [];
        let hit = 0;
        for (const x of list) {
          if (x.to === me.uid && mmIds.indexOf(x.id) >= 0 && !x.read) { x.read = true; hit++; }
        }
        if (hit) { db.list = list; writeMomentMsgs(db); }
      }
      /* md → 音乐圈每日汇总：已读落在「天」上，不落在消息上。
         🔴 必须单独开这条分支：汇总不在 moment-msg.json 里，若复用 mm 前缀，
         上面的循环找不到它 → 已读永远置不上 → 红点永远消不掉。
         只往前推不回退：标记一个更早的日子不该把更晚的已读状态冲掉。 */
      const mdIds = ids.filter(x => x.indexOf('md') === 0);
      if (mdIds.length) {
        const db = readMomentDaily();
        let hit = 0;
        for (let i = 0; i < mdIds.length; i++) {
          const d = mdIds[i].slice(2);
          if (!/^\d{8}$/.test(d)) continue;
          const key = d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);
          if (String(db.read[me.uid] || '') < key) { db.read[me.uid] = key; hit++; }
        }
        if (hit) {
          writeMomentDaily(db);
          MOMENT_DAILY_MEM.obj = null; MOMENT_DAILY_MEM.day = '';
        }
      }
      return sendJSON(res, { ok: true, read: ids });
    }

    /* ══════════════════════════════════════════════════════════════
       在线状态
       客户端每 30 秒报一次心跳；隐身的人对好友显示离线，
       但管理端直接读 presence.json，能看到真实状态。
       ══════════════════════════════════════════════════════════════ */
    if (p === '/api/presence' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const all = readJSON(PRESENCE_FILE, {});
      const ua = String(req.headers['user-agent'] || '');
      const now = Date.now();
      const prev = all[me.uid];
      /* 隐身选择持久化在 presence.json。新开关可以传 invisible:true/false，
       * 当前前端心跳传 state:'invisible'/'online'，两种写法都支持；
       * 若请求完全没带可见性字段（例如只更新歌曲），则保留上次选择。 */
      let invisible = !!(prev && prev.state === 'invisible');
      if (b && typeof b.invisible === 'boolean') invisible = b.invisible;
      else if (b && b.state === 'invisible') invisible = true;
      else if (b && b.state === 'online') invisible = false;
      const st = invisible ? 'invisible' : 'online';
      /* 两次有效心跳之间的间隔算在线，超过 180 秒视为已经中断，不追补。
       * 跨北京时间 0 点时，总时长记完整间隔；today 只接收零点之后那一段。 */
      const duration = nextPresenceDurations(prev, now);
      const dayKey = duration.day;
      const total = duration.total;
      const today = duration.today;
      /* 设置隐身的请求可以只带 invisible，不应顺手清掉正在听的歌；
       * 真正心跳会显式带 song（包括 null），届时再更新。 */
      let song = prev && prev.song ? prev.song : null;
      if (b && Object.prototype.hasOwnProperty.call(b, 'song')) {
        song = null;
        if (b.song && String(b.song.name || '').trim()) {
          song = {
            name: String(b.song.name || '').slice(0, 200),
            artist: String(b.song.artist || '').slice(0, 200),
            key: songKey(b.song)
          };
        }
      }
      all[me.uid] = {
        state: st, at: now, total, today, day: dayKey, song,
        device: /Android/i.test(ua) ? '安卓' : (/iPhone|iPad/i.test(ua) ? '苹果' : '电脑'),
        /* 同 deviceOf()：XFF 客户端可随便写，presence 里的 ip 只认 socket 对端 */
        ip: String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '')
      };
      writeJSON(PRESENCE_FILE, all);
      return sendJSON(res, { ok: true, state: st, invisible, day: dayKey, today, total });
    }
    if (p === '/api/presence') {
      const ids = String(Q('uids') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 200);
      const out = {};
      for (const id of ids) out[id] = onlineOf(id, false);
      const me = userOf(req);
      const mine = me ? presenceRecord(me.uid) : null;
      const state = mine && mine.state === 'invisible' ? 'invisible' : 'online';
      return sendJSON(res, {
        ok: true,
        online: out,
        state,
        invisible: state === 'invisible',
        day: beijingDayKey(Date.now()),
        today: presenceTodayMs(mine, Date.now()),
        total: Math.max(0, Number(mine && mine.total) || 0)
      });
    }

    /* 「几人正在听这首」：按心跳里上报的当前歌曲统计。
     * 隐身的人不出现在别人眼里，但自己一定要看得见自己。 */
    if (p === '/api/nowplaying') {
      const me = userOf(req);
      const want = songKey({ name: Q('name') || '', artist: Q('artist') || '' });
      if (!want || want === '|') return sendJSON(res, { ok: true, count: 0, users: [] });
      const all = readJSON(PRESENCE_FILE, {});
      const now = Date.now();
      const users = [];
      for (const [uid, p] of Object.entries(all)) {
        if (!p || !p.at || now - p.at > ONLINE_WINDOW) continue;
        if (!p.song || songKey(p.song) !== want) continue;
        const self = !!me && uid === me.uid;
        if (!self && p.state === 'invisible') continue;
        const u = USERS[uid];
        users.push({
          uid, self,
          username: (u && u.username) || (p.song && p.song.name) || '听友',
          device: p.device || ''
        });
      }
      users.sort((a, b) => (b.self ? 1 : 0) - (a.self ? 1 : 0));
      return sendJSON(res, { ok: true, count: users.length, users: users.slice(0, 50) });
    }

    /* ══════════════════════════════════════════════════════════════
       好友：搜人 → 发请求 → 同意/拒绝 → 列表 / 删除
       ══════════════════════════════════════════════════════════════ */
    if (p === '/api/friend/find') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const kw = String(Q('kw') || '').trim();
      if (!kw) return sendJSON(res, { ok: true, list: [] });
      const em = normEmail(kw), ph = kw.replace(/\s/g, '');
      const out = [];
      for (const u of Object.values(USERS)) {
        if (u.uid === me.uid) continue;
        const hit = (ph && String(u.phone || '') === ph)
          || (em && normEmail(u.email) === em)
          || (String(u.username || '') === kw);
        if (hit) out.push(publicCard(u));
        if (out.length >= 20) break;
      }
      return sendJSON(res, { ok: true, list: out });
    }

    if (p === '/api/friend/add' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const to = String((b && b.to) || '').trim();
      const target = USERS[to];
      if (!target) return sendJSON(res, { ok: false, error: '找不到这个用户' }, 404);
      if (to === me.uid) return sendJSON(res, { ok: false, error: '不能加自己' }, 400);
      const s = readSocial();
      const mine = s.friends[me.uid] || [];
      if (mine.indexOf(to) >= 0) return sendJSON(res, { ok: false, error: '你们已经是好友了' }, 400);
      const dup = s.requests.find(r => r.from === me.uid && r.to === to && r.state === 'pending');
      if (dup) return sendJSON(res, { ok: true, id: dup.id, tip: '请求已发出，等对方确认' });
      const item = {
        id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        from: me.uid, to, msg: String((b && b.msg) || '').slice(0, 100),
        at: Date.now(), state: 'pending'
      };
      s.requests.unshift(item);
      s.requests = s.requests.slice(0, 500);
      writeSocial(s);
      return sendJSON(res, { ok: true, id: item.id, tip: '已发送，等对方确认' });
    }

    if (p === '/api/friend/requests') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const s = readSocial();
      const mine = s.requests
        .filter(r => r.to === me.uid && r.state === 'pending')
        .map(r => {
          const u = USERS[r.from];
          return { id: r.id, at: r.at, msg: r.msg, from: u ? publicCard(u) : { uid: r.from, username: '用户' } };
        });
      /* 我发出去的、对方还没处理的，也列出来，免得重复发 */
      const sent = s.requests
        .filter(r => r.from === me.uid && r.state === 'pending')
        .map(r => {
          const u = USERS[r.to];
          return { id: r.id, at: r.at, to: u ? publicCard(u) : { uid: r.to, username: '用户' } };
        });
      return sendJSON(res, { ok: true, incoming: mine, sent });
    }

    if (p === '/api/friend/handle' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const id = String((b && b.id) || '').trim();
      const accept = !!(b && b.accept);
      const s = readSocial();
      const r = s.requests.find(x => x.id === id && x.to === me.uid && x.state === 'pending');
      if (!r) return sendJSON(res, { ok: false, error: '请求不存在或已处理' }, 404);
      r.state = accept ? 'accepted' : 'rejected';
      if (accept) {
        s.friends[me.uid] = (s.friends[me.uid] || []).concat([r.from]).filter(Boolean);
        s.friends[r.from] = (s.friends[r.from] || []).concat([me.uid]).filter(Boolean);
        s.friends[me.uid] = Array.from(new Set(s.friends[me.uid]));
        s.friends[r.from] = Array.from(new Set(s.friends[r.from]));
      }
      /* ── 给**申请人**留一条结果通知（2026-10-16 加，重构第 2 步）────────
         为什么必须有：在此之前，别人通过或拒绝我的好友申请时，
         申请人那边是**完全静音**的 —— 只能自己去好友列表碰运气看加没加上。
         业主的要求原话是「捎带吧三段的好友功能的消息…都正确溶进来」。
         ⚠️ 只给 **to = r.from**（申请人）写，不给操作者自己写 ——
            是"他知道我的决定了"，不是"我又做了一遍这件事"。
         ⚠️ 上限 200 条，与 chat 的滚动上限同一个思路：这是个通知流水，
            不是审计日志，攒太长既占空间又没人翻。 */
      try {
        s.friendNotes = Array.isArray(s.friendNotes) ? s.friendNotes : [];
        s.friendNotes.push({
          id: 'fn' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          to: r.from,            // 收件人 = 当初的申请人
          from: me.uid,          // 动作发出者 = 我（同意/拒绝的那个人）
          accept: accept,
          at: Date.now(),
          read: false
        });
        if (s.friendNotes.length > 200) s.friendNotes = s.friendNotes.slice(-200);
      } catch (e) {
        /* ⚠️ 通知写失败绝不能让"接受/拒绝"这件事失败（好友关系已经改好了）。
           按本文件既有铁律：通知类异常在函数内部吃干净，不能把请求打成 500。 */
        console.warn('[friend/handle] 结果通知写入失败（不影响好友关系）：' + (e && e.message || e));
      }
      writeSocial(s);
      return sendJSON(res, { ok: true, accepted: accept });
    }

    if (p === '/api/friend/list') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const s = readSocial();
      const ids = Array.from(new Set(s.friends[me.uid] || []));
      const list = ids.map(id => {
        const u = USERS[id];
        if (!u) return null;
        const c = publicCard(u);
        c.online = onlineOf(id, false);
        const pr = presenceOf(id);
        c.device = pr ? (pr.device || '') : '';
        return c;
      }).filter(Boolean);
      return sendJSON(res, { ok: true, list });
    }

    if (p === '/api/friend/remove' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const uid = String((b && b.uid) || '').trim();
      const s = readSocial();
      s.friends[me.uid] = (s.friends[me.uid] || []).filter(x => x !== uid);
      s.friends[uid] = (s.friends[uid] || []).filter(x => x !== me.uid);
      writeSocial(s);
      return sendJSON(res, { ok: true });
    }

    /* ══════════════════════════════════════════════════════════════
       分享歌曲：把一首歌发给好友，对方能直接点开听
       ══════════════════════════════════════════════════════════════ */
    if (p === '/api/share/send' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const to = String((b && b.to) || '').trim();
      const song = b && b.song;
      if (!USERS[to] || !song || !song.name) {
        return sendJSON(res, { ok: false, error: '参数不对' }, 400);
      }
      /* 只给好友发，避免变成陌生人互相骚扰 */
      const s0 = readSocial();
      if ((s0.friends[me.uid] || []).indexOf(to) < 0) {
        return sendJSON(res, { ok: false, error: '只能分享给好友' }, 403);
      }
      const s = readSocial();
      const item = {
        id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        from: me.uid, to, song: {
          name: String(song.name || '').slice(0, 200),
          artist: String(song.artist || '').slice(0, 200),
          album: String(song.album || '').slice(0, 200),
          id: String(song.id || '').slice(0, 100),
          hash: String(song.hash || '').slice(0, 100),
          cover: String(song.cover || '').slice(0, 500),
          source: String(song.source || '').slice(0, 40)
        },
        msg: String((b && b.msg) || '').slice(0, 200),
        at: Date.now(), read: false
      };
      s.shares.unshift(item);
      s.shares = s.shares.slice(0, 1000);
      /* 🔴 同时落一条**私聊消息** —— 这是「分享给好友」能不能被收到的关键。
         排查发现：分享只写进 shares 表，而前端从来没有读过 /api/share/list，
         于是发送方看到「已发给 XX」，接收方在聊天、消息中心、好友页
         全都没有入口 —— 等于分享出去就丢了。
         微信/QQ音乐的口径本来也是「分享给好友 = 会话里多一条歌卡」，
         所以这里补一条 chat 记录：聊天里能看见、能直接点开听，
         未读也会进铃铛和好友行角标。shares 表保留（历史数据 + 兼容老接口）。 */
      s.chat.push({
        id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        from: me.uid, to,
        text: item.msg || '',
        song: item.song,
        at: item.at, read: false
      });
      /* 不能引用 CHAT_KEEP：它是 const，声明在这个函数之后，
         这里读到会抛 TDZ（ReferenceError: Cannot access before initialization），
         表现是分享接口直接 500 —— 实测踩过。2000 与那边保持同一个数。 */
      if (s.chat.length > 2000) s.chat = s.chat.slice(s.chat.length - 2000);
      writeSocial(s);
      return sendJSON(res, { ok: true, id: item.id });
    }

    if (p === '/api/share/list') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const s = readSocial();
      const got = s.shares.filter(x => x.to === me.uid).slice(0, 100).map(x => {
        const u = USERS[x.from];
        return Object.assign({}, x, {
          fromUser: u ? publicCard(u) : { uid: x.from, username: '用户' }
        });
      });
      const sent = s.shares.filter(x => x.from === me.uid).slice(0, 50).map(x => {
        const u = USERS[x.to];
        return Object.assign({}, x, {
          toUser: u ? publicCard(u) : { uid: x.to, username: '用户' }
        });
      });
      return sendJSON(res, { ok: true, got, sent });
    }

    if (p === '/api/share/read' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const ids = Array.isArray(b && b.ids) ? b.ids.map(String) : [];
      const s = readSocial();
      const set = new Set(ids);
      if (!ids.length) {
        for (const x of s.shares) if (x.to === me.uid) x.read = true;
      } else {
        for (const x of s.shares) if (x.to === me.uid && set.has(x.id)) x.read = true;
      }
      writeSocial(s);
      return sendJSON(res, { ok: true });
    }

    /* ══════════════════════════════════════════════════════════════
       私聊：好友之间发文字、发歌，来回对话
       ──────────────────────────────────────────────────────────────
       跟上面的「分享歌曲」是两回事：分享是一次性的歌曲卡片，
       私聊是能你一句我一句的聊天记录 —— 用户要的是后者。
       只认好友，陌生人不能互发，免得变成骚扰通道。
       上限 2000 条：聊天记录会一直涨，不封顶这个 JSON 迟早拖慢启动。
       ══════════════════════════════════════════════════════════════ */
    const CHAT_KEEP = 2000;

    if (p === '/api/chat/send' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const to = String((b && b.to) || '').trim();
      const text = String((b && b.text) || '').slice(0, 500);
      const song = b && b.song;
      if (!USERS[to]) return sendJSON(res, { ok: false, error: '找不到这个用户' }, 404);
      if (to === me.uid) return sendJSON(res, { ok: false, error: '不能跟自己聊' }, 400);
      if (!text && !(song && song.name)) return sendJSON(res, { ok: false, error: '说点什么，或者带一首歌' }, 400);
      const s = readSocial();
      if ((s.friends[me.uid] || []).indexOf(to) < 0) {
        return sendJSON(res, { ok: false, error: '只能跟好友聊天' }, 403);
      }
      const item = {
        id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        from: me.uid, to, text,
        song: (song && song.name) ? {
          name: String(song.name || '').slice(0, 200),
          artist: String(song.artist || '').slice(0, 200),
          album: String(song.album || '').slice(0, 200),
          id: String(song.id || '').slice(0, 100),
          hash: String(song.hash || '').slice(0, 100),
          cover: String(song.cover || '').slice(0, 500),
          source: String(song.source || '').slice(0, 40)
        } : null,
        at: Date.now(), read: false
      };
      s.chat.push(item);
      if (s.chat.length > CHAT_KEEP) s.chat = s.chat.slice(s.chat.length - CHAT_KEEP);
      writeSocial(s);
      return sendJSON(res, { ok: true, id: item.id, at: item.at });
    }

    /* 与某人的完整聊天记录（收 + 发混在一起，按时间正序） */
    if (p === '/api/chat/thread') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const uid = String(Q('uid') || '').trim();
      if (!uid) return sendJSON(res, { ok: false, error: '缺少 uid' }, 400);
      const s = readSocial();
      const u = USERS[uid];
      const list = chatWith(s.chat, me.uid, uid).sort((a, b) => a.at - b.at).slice(-200);
      return sendJSON(res, {
        ok: true,
        peer: u ? publicCard(u) : { uid, username: '用户' },
        online: onlineOf(uid, false),
        list
      });
    }

    /* 会话列表：每个聊过的人一条，带最后一句和未读数 */
    if (p === '/api/chat/list') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const s = readSocial();
      const seen = {};
      const peers = [];
      for (const x of s.chat) {
        if (x.from !== me.uid && x.to !== me.uid) continue;
        const other = x.from === me.uid ? x.to : x.from;
        if (!seen[other]) { seen[other] = 1; peers.push(other); }
      }
      const list = peers.map(id => {
        const th = chatWith(s.chat, me.uid, id);
        const last = th[th.length - 1] || null;
        const unread = th.filter(x => x.to === me.uid && !x.read).length;
        const u = USERS[id];
        return {
          uid: id,
          user: u ? publicCard(u) : { uid: id, username: '用户' },
          online: onlineOf(id, false),
          last: last ? {
            text: last.text || '',
            song: last.song || null,
            at: last.at,
            mine: last.from === me.uid
          } : null,
          unread
        };
      }).filter(x => x.last);
      list.sort((a, b) => (b.last ? b.last.at : 0) - (a.last ? a.last.at : 0));
            /* 总数走 chatUnreadOf()：与 /api/msg/summary 的 chatUnread 同一个谓词，
         免得"会话列表加起来"与"汇总端点"两处各算一遍。 */
      return sendJSON(res, { ok: true, list, unread: chatUnreadOf(me.uid, s) });
    }

    /* 打开某个会话 = 对方发来的那些全部已读 */
    if (p === '/api/chat/read' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const uid = String((b && b.uid) || '').trim();
      const s = readSocial();
      let n = 0;
      const now = Date.now();
      for (const x of s.chat) {
        if (x.to === me.uid && x.from === uid && !x.read) {
          x.read = true;
          /* ── readAt（msg6 加，重构第 7 步）──────────────────────────────
             为什么单布尔不够：`read` 只说"读过"，而**已读回执**要显示
             "对方什么时候读的"（大厂都是"已读 / 22:31 已读"）。
             ⚠️ 纯增量：`read` 原样保留，老前端只认它，行为一字不改。 */
          x.readAt = now;
          n++;
        }
      }
      if (n) writeSocial(s);
      return sendJSON(res, { ok: true, read: n });
    }

    /* ── 删掉会话里的某几条（msg6 加，重构第 7 步）────────────────────────
       单侧删除：只把我加进这条消息的 `hide` 数组（chatWith() 早就按人过滤了），
       对方那一份一个字都不动 —— "我删了聊天记录"不该影响别人。
       ⚠️ 为什么吃数组：多选删除要**一次请求删完**，前端循环发 N 个请求
          在半途失败时会留下"删了一半"的状态（业主看到的正是"我选了 8 条还剩 3 条"）。
       ⚠️ 上限 200：多选是用户手勾的场景，200 已远超真实操作，设上限是防止
          有人构造超大数组把 social.json 撑爆。 */
    if (p === '/api/chat/del' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const ids = Array.isArray(b && b.ids) ? b.ids.map(x => String(x || '').trim()).filter(Boolean) : [];
      if (!ids.length) return sendJSON(res, { ok: false, error: '缺少 ids' }, 400);
      const capped = ids.slice(0, 200);
      const s = readSocial();
      let n = 0;
      for (const x of s.chat) {
        if (capped.indexOf(String(x.id || '')) < 0) continue;
        /* 只允许删**与我有关**的消息 */
        if (x.from !== me.uid && x.to !== me.uid) continue;
        x.hide = Array.isArray(x.hide) ? x.hide : [];
        if (x.hide.indexOf(me.uid) < 0) { x.hide.push(me.uid); n++; }
      }
      if (n) writeSocial(s);
      return sendJSON(res, { ok: true, deleted: n, ids: capped });
    }

    /* ── 撤回自己刚发的那条（msg6 加，重构第 7 步）────────────────────────
       规则照大厂：**只能撤回自己发的**，且**两分钟内**；
       撤回后不删除记录，而是打上 `recalled` —— 对方那一侧要看到
       "对方撤回了一条消息"（静默消失会让人以为消息丢了）。
       ⚠️ 文本与歌一起清掉：留着的话"撤回"就成了摆设（对方刷新还能看到内容）。 */
    if (p === '/api/chat/recall' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const id = String((b && b.id) || '').trim();
      if (!id) return sendJSON(res, { ok: false, error: '缺少 id' }, 400);
      const s = readSocial();
      const RECALL_MS = 2 * 60 * 1000;
      const hit = s.chat.find(x => String(x.id || '') === id);
      if (!hit) return sendJSON(res, { ok: false, error: '找不到这条消息' }, 404);
      if (hit.from !== me.uid) return sendJSON(res, { ok: false, error: '只能撤回自己发的消息' }, 403);
      if (hit.recalled) return sendJSON(res, { ok: true, recalled: true });
      if (Date.now() - Number(hit.at || 0) > RECALL_MS) {
        return sendJSON(res, { ok: false, error: '超过两分钟，撤不回了' }, 409);
      }
      hit.recalled = true;
      hit.recallAt = Date.now();
      hit.text = '';
      hit.song = null;
      writeSocial(s);
      return sendJSON(res, { ok: true, recalled: true, id });
    }

    /* 清空跟某人的聊天记录 —— 同样只是"我"这一侧消失。
       对方没清的话 TA 还能看到，所以不做物理上的互相抹除。 */
    if (p === '/api/chat/clear' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const uid = String((b && b.uid) || '').trim();
      if (!uid) return sendJSON(res, { ok: false, error: '缺少 uid' }, 400);
      const s = readSocial();
      const other = uid;
      const before = s.chat.length;
      s.chat = s.chat.map(x => {
        const relat = (x.from === me.uid && x.to === other) || (x.from === other && x.to === me.uid);
        if (!relat) return x;
        x.hide = Array.isArray(x.hide) ? x.hide : [];
        if (x.hide.indexOf(me.uid) < 0) x.hide.push(me.uid);
        return x;
      });
      /* 两边都删过的，这条就没留着的必要了 */
      s.chat = s.chat.filter(x => {
        const relat = (x.from === me.uid && x.to === other) || (x.from === other && x.to === me.uid);
        if (!relat) return true;
        const pe = x.from === me.uid ? x.to : x.from;
        return !((x.hide || []).length >= 2 || ((x.hide || []).indexOf(pe) >= 0));
      });
      writeSocial(s);
      return sendJSON(res, { ok: true, cleared: before - s.chat.length });
    }

    /* 删自己这一侧的聊天记录 —— 只在"我"这边消失，对方那头不受影响。
       ⚠️ 不能用 id 全局过滤：那条消息是两个人共有的，按 id 删会把对方
       的记录也抹掉，等于谁都能替对方删东西。改成给消息打 hide 名单。
       两边都删过的，物理移除，缓存才真的会缩。 */
    if (p === '/api/chat/del' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const id = String((b && b.id) || '').trim();
      const s = readSocial();
      const m = s.chat.find(x => x.id === id && (x.from === me.uid || x.to === me.uid));
      if (m) {
        m.hide = Array.isArray(m.hide) ? m.hide : [];
        if (m.hide.indexOf(me.uid) < 0) m.hide.push(me.uid);
        /* 双方都删干净了就没留着的必要，这条才真正出局 */
        const other = m.from === me.uid ? m.to : m.from;
        if (m.hide.indexOf(other) >= 0) {
          s.chat = s.chat.filter(x => x.id !== id);
        }
        writeSocial(s);
      }
      return sendJSON(res, { ok: true });
    }

    if (p === '/api/share/delete' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const id = String((b && b.id) || '').trim();
      const s = readSocial();
      s.shares = s.shares.filter(x => !(x.id === id && (x.to === me.uid || x.from === me.uid)));
      writeSocial(s);
      return sendJSON(res, { ok: true });
    }

    /* ── 分片上传：零件目录 / 装配 ────────────────────────────
     * 为什么要分片：手机在公网 HTTP 上一次推几十 MB，上行链路、运营商 NAT、
     * 中间设备、Node 默认的 300s requestTimeout —— 任何一处掐一下，客户端
     * fetch 就抛 TypeError（连响应都拿不到），前端只能显示「连接中断」，
     * 而且已经传上去的几十 MB 全白扔，用户永远看不到真正的原因。
     * 分片之后：单片 2MB（几秒就完，谁也掐不到）；网络抖一下只丢当前这一片、
     * 自动重试；中途退出/断网，下次点上传先问服务端「收到哪几片了」接着传。
     * 协议：POST /api/upload?sid=&idx=&total=…（单片）／GET 同一个 sid = 续传探测。
     * 不带 sid 的老请求（含 ?kind=avatar）行为完全不变。 */
    const UP_CHUNK = 2 * 1024 * 1024;          // 约定的单片大小，前端照此切片
    const UP_CHUNK_MAX = 4 * 1024 * 1024;      // 单片上限，留一倍余量
    const UP_PART_DIR = path.join(UPLOAD_DIR, '_parts');
    const UP_PART_MAX_AGE = 12 * 3600 * 1000;  // 弃用的零件最多留 12 小时
    const UP_EXT_OK = ['mp3', 'flac', 'wav', 'm4a', 'ogg', 'aac'];

    /* 零件名带 uid 摘要：sid 是客户端生成的，别人猜到也污染不了你的上传 */
    function upPartKey(uid, sid) { return md5(Buffer.from(String(uid) + ':' + sid)).slice(0, 20); }
    function upPartFile(uid, sid, idx) { return path.join(UP_PART_DIR, upPartKey(uid, sid) + '.' + idx); }
    function upPartHave(sid, uid) {
      const pre = upPartKey(uid, sid) + '.';
      try {
        return fs.readdirSync(UP_PART_DIR)
          .filter(n => n.indexOf(pre) === 0)
          .map(n => parseInt(n.slice(pre.length), 10))
          .filter(n => n >= 0)
          .sort((a, b) => a - b);
      } catch { return []; }
    }
    /* 只在每次新上传的第一片顺手清一次，不额外加定时器。
       两道闸：① 超过 12 小时的零件一律删；② 零件总数超过 UP_PART_MAX 时，
       从最旧的开始删到 UP_PART_MAX 以内 —— 别让「传一半人跑了」把磁盘吃光。 */
    const UP_PART_MAX = 300;
    let UP_SWEEP_AT = 0;
    function upSweepParts() {
      /* 60 秒节流：分片 2MB 一片、几秒就传完，每片都 readdir 一遍纯属浪费。
         节流放在函数里而不是调用点，调用点就能无条件调，不会漏。 */
      const now = Date.now();
      if (now - UP_SWEEP_AT < 60000) return;
      UP_SWEEP_AT = now;
      let list = [];
      try { list = fs.readdirSync(UP_PART_DIR); } catch { return; }   // 目录还不存在
      for (const n of list) {
        const f = path.join(UP_PART_DIR, n);
        try { if (now - fs.statSync(f).mtimeMs > UP_PART_MAX_AGE) fs.unlinkSync(f); } catch { /* 已被别的请求清掉 */ }
      }
      let left = [];
      try { left = fs.readdirSync(UP_PART_DIR); } catch { return; }
      if (left.length <= UP_PART_MAX) return;
      const aged = left.map(n => {
        try { return { n, t: fs.statSync(path.join(UP_PART_DIR, n)).mtimeMs }; } catch { return { n, t: now }; }
      }).sort((a, b) => a.t - b.t);
      for (let i = 0; i < aged.length - UP_PART_MAX; i++) {
        try { fs.unlinkSync(path.join(UP_PART_DIR, aged[i].n)); } catch { /* ignore */ }
      }
    }
    /* 读请求体，超限也把剩下的排空再 reject —— ⚠️ 绝不 req.destroy()：
       一掐 socket，下面那句 413 就写不回客户端了。 */
    function upReadBody(req, limit) {
      return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0, tooBig = false;
        req.on('data', c => {
          if (tooBig) return;                 // 剩下的照常读完丢弃，连接能正常收尾
          total += c.length;
          if (total > limit) { tooBig = true; chunks.length = 0; reject(new Error('too big')); return; }
          chunks.push(c);
        });
        req.on('end', () => { if (!tooBig) resolve(Buffer.concat(chunks)); });
        req.on('error', reject);
      });
    }
    async function upHandleChunk(req, res, me, sid, Q) {
      const total = int(Q('total'), 0, 1, 512);
      const idx = int(Q('idx'), -1, 0, 511);
      const name = String(Q('name') || '').trim().slice(0, 120);
      if (idx < 0 || idx >= total) return sendJSON(res, { ok: false, error: '分片参数不对' }, 400);
    /* U-41：不再只在 idx===0 时扫。原来那条意味着「只有新上传的第一片才清」，
       攻击者不停开新上传之外的路径就能绕；改成每次上传都进、函数内部按 60 秒
       节流，既堵住绕过又不让每片都 readdir 一遍。 */
    upSweepParts();
      let buf;
      try {
        buf = await upReadBody(req, UP_CHUNK_MAX);
      } catch {
        try { req.resume(); } catch { /* ignore */ }
        return sendJSON(res, { ok: false, error: '单片超过 ' + (UP_CHUNK_MAX / 1048576) + 'MB 了' }, 413);
      }
      /* 分片请求体只有 2MB，下面这些 400 不会「传了一半才拒」 */
      if (!buf || !buf.length) return sendJSON(res, { ok: false, error: '分片是空的' }, 400);
      if (!name) return sendJSON(res, { ok: false, error: '歌名不能为空' }, 400);
      try { fs.mkdirSync(UP_PART_DIR, { recursive: true }); } catch { /* ignore */ }

      /* ★ 防「中途换了文件再续传」：同一个 sid 认一个文件。
         前端每片都带上总大小和头尾采样指纹，第一片时记进 .meta，
         之后每一片都比一次 —— 文件换过了就把旧零件全清掉让他从头传，
         绝不把两首歌拼成一首。 */
      const declSize = int(Q('size'), 0, 1, MAX_UPLOAD);
      const fp = String(Q('fp') || '').slice(0, 16);
      const metaFile = path.join(UP_PART_DIR, upPartKey(me.uid, sid) + '.meta');
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* 还没有 */ }
      if (idx === 0 || !meta) {
        meta = { fp, size: declSize, total, at: Date.now() };
        try { writeFileAtomic(metaFile, Buffer.from(JSON.stringify(meta))); } catch { /* ignore */ }
      } else if ((meta.fp && fp && meta.fp !== fp) || (meta.size && declSize && meta.size !== declSize)) {
        for (let k = 0; k < 512; k++) { try { fs.unlinkSync(upPartFile(me.uid, sid, k)); } catch { /* ignore */ } }
        try { fs.unlinkSync(metaFile); } catch { /* ignore */ }
        return sendJSON(res, { ok: false, error: '文件和上次不一样，请重新上传' }, 400);
      }

      try {
        writeFileAtomic(upPartFile(me.uid, sid, idx), buf);
      } catch (e) {
        return sendJSON(res, { ok: false, error: '存分片失败：' + humane(e) }, 500);
      }
      const have = upPartHave(sid, me.uid);
      if (have.length < total) {
        return sendJSON(res, { ok: true, sid, idx, done: false, received: have.length, total });
      }
      /* 收齐了：按 0..total-1 顺序拼回整首歌 */
      const parts = [];
      let size = 0;
      for (let i = 0; i < total; i++) {
        let b;
        try { b = fs.readFileSync(upPartFile(me.uid, sid, i)); }
        catch { return sendJSON(res, { ok: false, error: '第 ' + (i + 1) + ' 个分片丢了，请重新上传' }, 400); }
        size += b.length;
        if (size > MAX_UPLOAD) {
          for (let k = 0; k <= i; k++) { try { fs.unlinkSync(upPartFile(me.uid, sid, k)); } catch { /* ignore */ } }
          return sendJSON(res, { ok: false, error: '文件超过 40MB 了' }, 413);
        }
        parts.push(b);
      }
      const all = Buffer.concat(parts);
      /* 拼出来的长度必须等于前端声明的总大小，否则就是拼错了 */
      if (declSize && all.length !== declSize) {
        for (let k = 0; k < total; k++) { try { fs.unlinkSync(upPartFile(me.uid, sid, k)); } catch { /* ignore */ } }
        try { fs.unlinkSync(metaFile); } catch { /* ignore */ }
        return sendJSON(res, { ok: false, error: '分片拼起来的大小对不上（' + all.length + '≠' + declSize + '），请重新上传' }, 400);
      }
      const ct = String(req.headers['content-type'] || '');
      let ext = extOf(ct);
      const fn = String(Q('filename') || '');
      const m = fn.match(/\.([a-z0-9]{2,5})$/i);
      if (m && (!ALLOW_CT.test(ct) || ct.indexOf('octet-stream') >= 0)) ext = m[1].toLowerCase();
      if (UP_EXT_OK.indexOf(ext) < 0) return sendJSON(res, { ok: false, error: '只支持 mp3 / m4a / flac / wav 等音频格式' }, 400);
      try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch { /* ignore */ }
      const id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      try {
        writeFileAtomic(path.join(UPLOAD_DIR, id + '.' + ext), all);
      } catch (e) {
        return sendJSON(res, { ok: false, error: '存文件失败：' + humane(e) }, 500);
      }
      const o = readUploads();
      o.list.unshift({
        id, file: id + '.' + ext, uid: me.uid, name,
        artist: String(Q('artist') || '').trim().slice(0, 120),
        album: String(Q('album') || '').trim().slice(0, 120),
        /* ★ U-54：上传即上架（2026-10-12 用户拍板「免审直接进搜索池」）。
           以前这里写 'pending'，必须管理员点「通过」才进搜索池 —— 本机 13 条
           上传里 12 条永远停在 pending，等于用户传完谁也搜不到。
           现在直接写 approved：搜索 / 取音源 / 放文件 / 播放全是既有逻辑，
           一个字都不用改就全通；管理端「驳回」把它置成 rejected 即刻下架
           —— 审核从事前门槛变成事后下架。 */
        ext, size: all.length, state: 'approved', at: Date.now(), reason: '', plays: 0
      });
      o.list = o.list.slice(0, 3000);
      writeUploads(o);
      for (let i = 0; i < total; i++) { try { fs.unlinkSync(upPartFile(me.uid, sid, i)); } catch { /* ignore */ } }
      try { fs.unlinkSync(metaFile); } catch { /* ignore */ }
      console.log('[upload]', me.uid, name, all.length, '分片' + total + '块');
      return sendJSON(res, { ok: true, id, state: 'approved', tip: '已上传，大家现在就能搜到这首歌了', done: true });
    }

    /* ══════════════════════════════════════════════════════════════
       用户上传音频 + 审核
       上传后是「待审核」，管理端通过之后才对所有人可见。
       ══════════════════════════════════════════════════════════════ */
    if (p === '/api/upload' && (req.method === 'POST' || req.method === 'GET')) {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);

      /* 分片上传：POST 带 sid/idx/total 走分片；GET 同一个 sid = 续传探测 */
      const upSid = String(Q('sid') || '');
      if (/^[A-Za-z0-9_-]{6,40}$/.test(upSid)) {
        if (req.method === 'GET') {
          return sendJSON(res, { ok: true, sid: upSid, chunk: UP_CHUNK, have: upPartHave(upSid, me.uid) });
        }
        return await upHandleChunk(req, res, me, upSid, Q);
      }
      if (req.method === 'GET') return sendJSON(res, { ok: false, error: '不支持的请求' }, 405);

      /* 换头像走同一个上传通道（?kind=avatar），只是校验规则换成图片那套。
         刻意不另起 /api/avatar/upload：读请求体、原子落盘、写队列这套逻辑
         两处完全一样，拆开只会让「超限怎么回 413」这类坑修一边漏一边。 */
      if (String(Q('kind') || '').trim() === 'avatar') {
        const fn = String(Q('filename') || '').toLowerCase();
        const m2 = fn.match(/\.([a-z0-9]{2,5})$/);
        /* 图片后缀优先看文件名：<input type=file> 有时给的 content-type 是
           octet-stream，只认 content-type 会把正常图片挡在外面。 */
        let aext = m2 ? m2[1] : extOf(String(req.headers['content-type'] || ''));
        if (AVATAR_EXT.indexOf(aext) < 0) {
          return sendJSON(res, { ok: false, error: '只支持 jpg / png / webp / gif 图片' }, 400);
        }
        let abuf;
        try {
          abuf = await readRaw(req, MAX_AVATAR);
        } catch (e) {
          try { req.resume(); } catch { }      // 排空剩余请求体，连接不会挂死
          return sendJSON(res, { ok: false, error: '头像超过 3MB 了' }, 413);
        }
        if (!abuf || !abuf.length) return sendJSON(res, { ok: false, error: '文件是空的' }, 400);
        /* 再验一次文件头：后缀能改，魔数改不了，别让人把别的东⻄传上来 */
        if (!imgMagicOK(abuf, aext)) return sendJSON(res, { ok: false, error: '这不是一张正常的图片' }, 400);

        try { fs.mkdirSync(AVATAR_DIR, { recursive: true }); } catch { }
        const aid = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const afile = aid + '.' + aext;
        try {
          writeFileAtomic(path.join(AVATAR_DIR, afile), abuf);
        } catch (e) {
          return sendJSON(res, { ok: false, error: '存文件失败：' + humane(e) }, 500);
        }
        const ao = readAvatars();
        /* 一个人只留一张待审：再传一张就把上一张待审的连文件一起清掉，
           免得队列里堆着同一个人的一堆废图。已通过 / 已驳回的历史留着，
           管理端要能翻旧账。 */
        ao.list = ao.list.filter(x => {
          if (x.uid !== me.uid || x.state !== 'pending') return true;
          try { fs.rmSync(path.join(AVATAR_DIR, String(x.file || '').replace(/[\\/]/g, '')), { force: true }); } catch { }
          return false;
        });
        /* 开发者（最高权限那个号）换自己的头像免审，直接生效。
           ⚠️ 免的是「审」，不是「验」：上面 3MB / 后缀 / 魔数三道照走，
              管理员身份不会让一个非法文件变合法。
           为什么还要往队列里记一条 approved：审计链不能断 —— 管理端翻得到
           「什么时候换的、谁换的」，只是它不进待审列表、不占 avatarPending 角标。 */
        const mu = me && me.user;              // userOf() 的包装里，账号是 .user
        const selfPass = isSuper(mu);
        const nowAt = Date.now();
        ao.list.unshift({
          id: aid, file: afile, ext: aext, uid: me.uid,
          /* ⚠️ userOf() 给的是 { uid, user, token } 包装，账号本身在 .user 上
             —— 直接写 me.username 是 undefined（别处踩过，见 adminOf 的注释）。 */
          username: (mu && mu.username) || '', size: abuf.length,
          state: selfPass ? 'approved' : 'pending',
          at: nowAt, reason: '',
          reviewAt: selfPass ? nowAt : 0, reviewBy: selfPass ? 'self' : ''
        });
        ao.list = ao.list.slice(0, 2000);
        writeAvatars(ao);
        if (!mu) {
          console.log('[avatar]', me.uid, aid, abuf.length);
          return sendJSON(res, { ok: true, id: aid, state: 'pending', tip: '头像已上传，等管理员审核' });
        }
        if (selfPass) {
          /* 直通：跟管理端点「通过」走的是同一套收尾动作 —— 换 avatar、
             回收上一张的实体文件、清掉待审与驳回理由。口径一模一样，
             所以 /api/avatar/file、管理端用户列表、别人的 publicCard
             立刻就能看到新图，不需要任何额外分支。 */
          const old = mu.avatar;
          mu.avatar = { id: aid, file: afile, ext: aext, at: nowAt };
          mu.avatarPending = ''; mu.avatarReason = '';
          if (old && old.file && old.file !== afile) {
            try { fs.rmSync(path.join(AVATAR_DIR, String(old.file).replace(/[\\/]/g, '')), { force: true, maxRetries: 2, retryDelay: 150 }); } catch { }
          }
          writeJSON(USERS_FILE, USERS);
          console.log('[avatar]', me.uid, aid, abuf.length, 'self-approved');
          return sendJSON(res, { ok: true, id: aid, state: 'approved', tip: '头像已更新' });
        }
        /* ⚠️ 关键：这里只记 avatarPending，**不动账号的 avatar**。
           对外（publicUser / publicCard / 头像文件接口）认的是 avatar，
           所以审核通过之前，别人看到的仍然是旧头像或字母块。 */
        mu.avatarPending = aid;
        writeJSON(USERS_FILE, USERS);
        console.log('[avatar]', me.uid, aid, abuf.length);
        return sendJSON(res, { ok: true, id: aid, state: 'pending', tip: '头像已上传，等管理员审核' });
      }

      const name = String(Q('name') || '').trim().slice(0, 120);
      const artist = String(Q('artist') || '').trim().slice(0, 120);
      const album = String(Q('album') || '').trim().slice(0, 120);
      if (!name) return sendJSON(res, { ok: false, error: '歌名不能为空' }, 400);
      const ct = String(req.headers['content-type'] || '');
      /* 浏览器传 octet-stream 的情况很常见（选文件时类型识别不出来），
       * 这时按文件名后缀兜底，别把正常的歌挡在外面。 */
      let ext = extOf(ct);
      const fn = String(Q('filename') || '');
      const m = fn.match(/\.([a-z0-9]{2,5})$/i);
      if (m && (!ALLOW_CT.test(ct) || ct.indexOf('octet-stream') >= 0)) ext = m[1].toLowerCase();
      if (['mp3', 'flac', 'wav', 'm4a', 'ogg', 'aac'].indexOf(ext) < 0) {
        return sendJSON(res, { ok: false, error: '只支持 mp3 / m4a / flac / wav 等音频格式' }, 400);
      }
      let buf;
      try {
        /* 读请求体的活儿已经抽到 readRaw()（头像分支共用同一份），
           那句「超限不能 destroy socket」的坑在 readRaw 里有完整注释。 */
        buf = await readRaw(req, MAX_UPLOAD);
      } catch (e) {
        try { req.resume(); } catch { }   // 排空剩余请求体，连接不会挂死
        return sendJSON(res, { ok: false, error: '文件超过 40MB 了' }, 413);
      }
      if (!buf || !buf.length) return sendJSON(res, { ok: false, error: '文件是空的' }, 400);

      try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch { }
      const id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const file = id + '.' + ext;
      /* 这首歌会被别人下载听，写了一半的 mp3 没法播 —— 走原子写 */
      try {
        writeFileAtomic(path.join(UPLOAD_DIR, file), buf);
      } catch (e) {
        return sendJSON(res, { ok: false, error: '存文件失败：' + humane(e) }, 500);
      }
      const o = readUploads();
      o.list.unshift({
        id, file, uid: me.uid, name, artist, album, ext,
        /* ★ U-54：同分片通道，上传即 approved（口径见上面那段注释） */
        size: buf.length, state: 'approved', at: Date.now(), reason: '', plays: 0
      });
      o.list = o.list.slice(0, 3000);
      writeUploads(o);
      /* 注意：主服务没有管理台那个 log()，这里只能用 console */
      console.log('[upload]', me.uid, name, buf.length);
      return sendJSON(res, { ok: true, id, state: 'approved', tip: '已上传，大家现在就能搜到这首歌了' });
    }

    /* ══════════════════════════════════════════════════════════════
       头像：取图 / 批量查 uid → 头像地址
       ══════════════════════════════════════════════════════════════ */
    /* 头像文件：只吐「已通过审核」的。
       ⚠️ 刻意不要求登录：<img src> 不带 Authorization 头，要鉴权的头像在
          评论区压根加载不出来。头像本来就是公开资料（跟昵称一样谁都看得见），
          而且这里只放已通过的；未过审的一律 404 —— 跟 publicUser/publicCard
          对外那套口径保持一致，不会出现"列表里没有但拼 URL 能扒到"。 */
    if (p === '/api/avatar/file') {
      const id = String(Q('id') || '').trim();
      const t = readAvatars().list.find(x => x.id === id);
      if (!t || t.state !== 'approved' || !t.file) {
        return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      const fp = path.join(AVATAR_DIR, String(t.file).replace(/[\\/]/g, ''));
      if (!fs.existsSync(fp)) return send(res, 404, '文件没了', { 'Content-Type': 'text/plain; charset=utf-8' });
      return send(res, 200, fs.readFileSync(fp), {
        'Content-Type': AVATAR_MIME[t.ext] || 'image/jpeg',
        'Cache-Control': 'private, max-age=86400'
      });
    }
    /* 批量查：前端渲染评论 / 点赞 / 好友列表时手里只有 uid，
       一次问一批，省得 N 行列表发 N 个请求。同样只回已通过的。 */
    if (p === '/api/avatars/map') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const uids = String(Q('uids') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 200);
      const map = {};
      for (const uid of uids) {
        const u = USERS[uid];
        const url = u ? avatarUrlOf(u) : '';
        if (url) map[uid] = url;
      }
      return sendJSON(res, { ok: true, map: map });
    }

    if (p === '/api/music/mine') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const o = readUploads();
      return sendJSON(res, {
        ok: true, list: o.list.filter(t => t.uid === me.uid).map(pubTrack)
      });
    }
    /* 公开曲库：只给审核通过的 */
    if (p === '/api/music/list') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const kw = String(Q('kw') || '').trim().toLowerCase();
      const o = readUploads();
      let list = o.list.filter(t => t.state === 'approved');
      if (kw) list = list.filter(t => (t.name + ' ' + t.artist + ' ' + t.album).toLowerCase().indexOf(kw) >= 0);
      const out = list.slice(0, 200).map(t => {
        const x = pubTrack(t);
        const u = USERS[t.uid];
        x.uploader = u ? (u.username || '用户') : '用户';
        return x;
      });
      return sendJSON(res, { ok: true, list: out });
    }
    /* 别人的主页：TA 上传并已通过的歌 */
    if (p === '/api/music/user') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const uid = String(Q('uid') || '').trim();
      const o = readUploads();
      const u = USERS[uid];
      return sendJSON(res, {
        ok: true,
        user: u ? publicCard(u) : null,
        online: u ? onlineOf(uid, false) : false,
        list: o.list.filter(t => t.uid === uid && t.state === 'approved').map(pubTrack)
      });
    }
    /* 播放/下载一个音频：必须是登录用户，且这首歌已通过审核或是自己传的 */
    if (p === '/api/music/file') {
      const id = String(Q('id') || '').trim();
      const o = readUploads();
      const t = o.list.find(x => x.id === id);
      if (!t) return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      const sig = Q('sig'), exp = Q('exp'), uid = Q('uid');
      if (sig) {
        /* ① 票据通路（搜索结果里点播走这条，R13 / U-00）。
           票据 60 秒有效、绑定 id + uid → 换歌 / 换人 / 超时一律 403。
           为什么必须走票据而不是裸 token：这里的 URL 会被 /api/proxy 拿去
           服务端 fetch，那次请求不带 Authorization，裸 token 通路根本用不上；
           而把 90 天有效的 session token 塞进 URL 又等于把整个账号交出去。 */
        if (!verifyUploadTicket(id, uid, exp, sig)) {
          return send(res, 403, '链接已失效', { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        /* 口径与下面 token 通路逐字对齐：approved || 本人 */
        if (!(t.state === 'approved' || t.uid === uid)) {
          return send(res, 403, '这首歌还没通过审核', { 'Content-Type': 'text/plain; charset=utf-8' });
        }
      } else {
        /* ② 原有 token 通路（别人主页那处直接播放，零新增代码） */
        const me = userOf(req);
        if (!me) return send(res, 401, '未登录', { 'Content-Type': 'text/plain; charset=utf-8' });
        if (t.state !== 'approved' && t.uid !== me.uid && !Q('admin')) {
          return send(res, 403, '这首歌还没通过审核', { 'Content-Type': 'text/plain; charset=utf-8' });
        }
      }
      const fp = path.join(UPLOAD_DIR, String(t.file || '').replace(/[\\/]/g, ''));
      if (!fs.existsSync(fp)) return send(res, 404, '文件没了', { 'Content-Type': 'text/plain; charset=utf-8' });
      /* ★ U-27：plays 只在「从头请求」时才 +1。
         支持 Range 之后，一次播放浏览器会发好几个请求（首帧 `bytes=0-`、
         拖一次进度条再发一段），照原样每次累加会把播放数刷成三四倍。
         口径：没带 Range，或者 Range 是从第 0 字节开始的 —— 才算一次播放起点。
         ⚠️ 本行是本次为了配合 Range 才加的，可以单独回退，不影响下面 Range 逻辑。 */
      const st = fs.statSync(fp);
      const total = st.size;
      let rg = parseRange(req.headers.range, total);

      const ct = ({ mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', aac: 'audio/aac' })[t.ext] || 'audio/mpeg';
      const base = {
        'Content-Type': ct,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
        /* ETag + Last-Modified 只是为了让浏览器 / CDN 敢缓存、能发条件请求，
           本站不做 304 判断（文件一旦落盘就不会变，没必要）。 */
        ETag: '"' + total + '-' + Math.floor(st.mtimeMs) + '"',
        'Last-Modified': st.mtime.toUTCString()
      };
      const isHEAD = req.method === 'HEAD';

      /* ⓪ If-Range：客户端带着「我缓存的那一份」的 ETag 来续传，对不上就说明
            文件已经换过了 —— 这时必须忽略 Range 回 200 整段，照旧切一段给它
            会把新文件的字节拼进旧数据里，出来的是坏音频。RFC 7233 §3.2。 */
      const ifRange = String(req.headers['if-range'] || '').trim();
      if (ifRange && ifRange !== base.ETag && !rg.full && !rg.bad) rg = { full: true };
      if (rg.full || rg.start === 0) { t.plays = (t.plays || 0) + 1; writeUploads(o); }

      /* ① 越界：RFC 7233 §4.4 —— 416 + Content-Range: bytes * /total，让客户端
            自己拿 total 去重算区间。空文件也走这条（拿不到任何字节）。 */
      if (rg.bad) {
        res.writeHead(416, {
          ...CORS, 'Content-Type': 'text/plain; charset=utf-8',
          'Content-Range': 'bytes */' + total, 'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store', 'Content-Length': '0'
        });
        return res.end(isHEAD ? undefined : '');
      }

      /* ② 没带 Range（或不认的形式）：200 + Content-Length 整段。
         ⚠️ Content-Length 必须显式给 —— 不给的话 Node 走 chunked，
         duration 又会变回 Infinity，等于白修。整段走流，不 readFileSync，
         40MB 的文件不会一次性压进内存。 */
      const from = rg.full ? 0 : rg.start;
      const to = rg.full ? total - 1 : rg.end;
      if (rg.full) {
        res.writeHead(200, { ...CORS, ...base, 'Content-Length': String(total) });
      } else {
        /* ③ 合法 Range：206 + Content-Range: bytes start-end/total。
           total 这一项就是浏览器拿总时长的依据。 */
        res.writeHead(206, {
          ...CORS, ...base,
          'Content-Range': 'bytes ' + from + '-' + to + '/' + total,
          'Content-Length': String(to - from + 1)
        });
      }
      /* HEAD 只回头不回体：头必须和 GET 逐字一致（含 Content-Length），
         否则客户端按 HEAD 的 Content-Length 去收 GET 的体会错位。 */
      if (isHEAD) return res.end();
      try {
        return await pipeline(fs.createReadStream(fp, { start: from, end: to }), res);
      } catch (e) {
        /* 拖进度条 / 切歌 / 弱网中断是常态，不是故障：头已经发出去就只能拆连接，
           没发出去还能回一句 500。就地兜住，别让它冒到最外层把日志刷满。 */
        if (!res.headersSent) {
          try { send(res, 500, '读取失败：' + humane(e), { 'Content-Type': 'text/plain; charset=utf-8' }); } catch { /* 连接已经没了 */ }
        } else {
          try { res.destroy(); } catch { /* 连接已经没了 */ }
        }
      }
      return;
    }
    if (p === '/api/music/delete' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const id = String((b && b.id) || '').trim();
      const o = readUploads();
      const t = o.list.find(x => x.id === id);
      if (!t) return sendJSON(res, { ok: false, error: '找不到这首歌' }, 404);
      if (t.uid !== me.uid) return sendJSON(res, { ok: false, error: '只能删自己传的' }, 403);
      o.list = o.list.filter(x => x.id !== id);
      writeUploads(o);
      try { fs.unlinkSync(path.join(UPLOAD_DIR, String(t.file || '').replace(/[\\/]/g, ''))); } catch { }
      return sendJSON(res, { ok: true });
    }

    /* ── 上传歌的时长回填（U-27）─────────────────────────────────
       为什么不在上传时算：mp3 / m4a / flac / wav 各有各的容器格式，
       零依赖逐个解析代码量大，VBR 的 mp3 还常常算错；而用户自己的浏览器
       反正要把整首解出来才能播，audio.duration 是现成且准的。
       所以改成「谁播谁知道，播完回传」：前端 loadedmetadata 拿到真时长后
       POST 回来，这里写进 uploads.json，之后列表 / 搜索 / 主页全部有时长。
       ⚠️ 位置硬约束：必须在 /api/upload 那一块（行号会漂，认注释
          「分片上传：零件目录 / 装配」那一段）**之外**，
          那块是分片上传，正被别人改，这里不碰。 */
    if (p === '/api/music/duration' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const id = String((b && b.id) || '').trim();
      /* 1 秒 ~ 10 小时之外的一律不认：浏览器在元数据没解完时会给 Infinity / NaN，
         那种值写进 JSON 会变成 null，列表上又变成「没有时长」，白跑一趟。 */
      const sec = Math.round(Number((b && b.duration) || 0));
      if (!id || !isFinite(sec) || sec < 1 || sec > 36000) {
        return sendJSON(res, { ok: false, error: '时长不合法' }, 400);
      }
      const o = readUploads();
      const t = o.list.find(x => x.id === id);
      if (!t) return sendJSON(res, { ok: false, error: '找不到这首歌' }, 404);
      /* 已有真值就不再覆盖：第一个播的人报的为准，避免不同端解码差异来回抖 */
      if (Number(t.duration) > 0) return sendJSON(res, { ok: true, duration: Number(t.duration), kept: true });
      t.duration = sec;
      writeUploads(o);
      return sendJSON(res, { ok: true, duration: sec });
    }

    /* ══════════════════════════════════════════════════════════════
       用户主页 / YTop3 活跃榜
       ══════════════════════════════════════════════════════════════ */
    if (p === '/api/user/profile') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const uid = String(Q('uid') || '').trim();
      const u = USERS[uid];
      if (!u) return sendJSON(res, { ok: false, error: '用户不存在' }, 404);
      const s = readSocial();
      const pre = presenceOf(uid);
      const stat = presenceRecord(uid);
      const o = readUploads();
      return sendJSON(res, {
        ok: true,
        user: publicCard(u),
        self: uid === me.uid,
        friend: (s.friends[me.uid] || []).indexOf(uid) >= 0,
        online: onlineOf(uid, false),
        device: pre ? (pre.device || '') : '',
        today: presenceTodayMs(stat, Date.now()),
        total: stat ? Math.max(0, Number(stat.total) || 0) : 0,
        songs: o.list.filter(t => t.uid === uid && t.state === 'approved').map(pubTrack),
        songCount: o.list.filter(t => t.uid === uid && t.state === 'approved').length
      });
    }
    if (p === '/api/top') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const n = Math.min(10, Math.max(1, Number(Q('n') || 3) || 3));
      return sendJSON(res, {
        ok: true,
        today: topActive(n, 'today'),
        total: topActive(n, 'total'),
        me: (function () {
          const p = presenceRecord(me.uid);
          return {
            uid: me.uid,
            today: presenceTodayMs(p, Date.now()),
            total: p ? Math.max(0, Number(p.total) || 0) : 0
          };
        })()
      });
    }

    /* ══════════════════════════════════════════════════════════════
       音乐圈：发动态（可带歌）、点赞、评论、撤回
       撤回是**真删**：整条从列表里移除，挂在它上面的点赞、评论一并带走，
       任何人的列表里都不会再出现这条（也不留「已撤回」占位）。
       ══════════════════════════════════════════════════════════════ */
    if (p === '/api/moment/list') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const s = readSocial();
      const friends = new Set((s.friends[me.uid] || []).concat([me.uid]));
      /* 「大家共享」是默认口径：音乐圈是个广场，发出来就是给所有人看的。
         只有前端显式要 scope=friend 时才收窄到好友 + 自己。
         （旧写法是『默认好友、显式 all 才公开』，而前端从来没传过 all，
          于是广场一直是个只有好友的空房间。） */
      const scope = Q('scope') === 'friend' ? friends : null;   // 默认：所有人
      const o = readMoments();
      const list = o.list
        .filter(m => !scope || friends.has(m.uid))
        .slice(0, 100)
        .map(m => {
          const u = USERS[m.uid];
          /* 点赞者在列表里只存裸 uid（老数据就是这么写的，改结构会炸），
             用户名在这儿现查 —— 存量 uid 照样能查出来，不用迁移。 */
          const likeUids = (m.likes || []).map(x => String(x));
          return {
            id: m.id, uid: m.uid, at: m.at,
            text: m.text || '',
            song: m.song || null,
            user: u ? publicCard(u) : { uid: m.uid, username: '用户' },
            online: onlineOf(m.uid, false),
            mine: m.uid === me.uid,
            liked: likeUids.indexOf(me.uid) >= 0,
            likeCount: likeUids.length,
            /* 点赞者头像堆用得到：uid 用来点头像进主页，name 用来生成首字头像 */
            likeUsers: likeUids.map(uid => {
              const lu = USERS[uid];
              return { uid, name: lu ? (lu.username || '用户') : '用户' };
            }),
            comments: (m.comments || []).map(c0 => {
              const c = c0 || {};
              const cu = USERS[c.uid];
              const rt = String(c.replyTo || '');
              const ru = rt ? USERS[rt] : null;
              return {
                uid: c.uid, text: c.text, at: c.at,
                /* cid 可能为空：老数据还没补上、或是灰度期拿到的缓存。
                   前端据此决定给不给「删除」—— 没有就不给，不自欺。 */
                cid: String(c.cid || ''),
                replyTo: rt,
                /* 被回复人的名字：优先用写盘时的快照 replyName。
                   那个人可能已经改名、甚至注销了，历史评论里该显示的
                   是当时的名字；现查会变成「undefined 回复」。
                   没有快照（老数据）才退回现查 USERS。 */
                replyName: String(c.replyName || (ru ? (ru.username || '用户') : '')),
                name: cu ? (cu.username || '用户') : '用户',
                /* 前端靠它决定这条评论给不给「删除」。 */
                mine: !!c.uid && c.uid === me.uid
              };
            })
          };
        });
      return sendJSON(res, { ok: true, list });
    }

    if (p === '/api/moment/post' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const text = String((b && b.text) || '').slice(0, 500).trim();
      const sg = b && b.song;
      if (!text && !(sg && sg.name)) {
        return sendJSON(res, { ok: false, error: '说点什么，或者带一首歌' }, 400);
      }
      const o = readMoments();
      let song = null;
      if (sg && sg.name) {
        song = {
          name: String(sg.name || '').slice(0, 200),
          artist: String(sg.artist || '').slice(0, 200),
          album: String(sg.album || '').slice(0, 200),
          id: String(sg.id || '').slice(0, 100),
          hash: String(sg.hash || '').slice(0, 100),
          cover: String(sg.cover || '').slice(0, 500),
          source: String(sg.source || '').slice(0, 40),
          /* ★ U-27：补上 duration。前端发动态时一直带着这个字段，
             但白名单里没有，被静默丢掉，于是音乐圈卡片永远显示不出时长。
             ⚠️ 必须做校验再收：
               · 浏览器元数据没解完时会给 Infinity / NaN，写进 JSON 会变 null，
                 列表上又变成「没有时长」，等于白存；
               · 字符串、负数、天文数字一律不认，宁可存 0（前端按「未知」处理）。
             取整数秒，合法区间 1 秒 ~ 10 小时。 */
          duration: (() => {
            const n = Number(sg.duration);
            if (!isFinite(n) || n <= 0) return 0;
            const sec = Math.round(n);
            return (sec >= 1 && sec <= 36000) ? sec : 0;
          })()
        };
      }
      const item = {
        id: 'mo' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        uid: me.uid, text, song, at: Date.now(),
        likes: [], comments: []
      };
      o.list.unshift(item);
      o.list = o.list.slice(0, 1000);
      writeMoments(o);
      return sendJSON(res, { ok: true, id: item.id });
    }

    if (p === '/api/moment/recall' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const id = String((b && b.id) || '').trim();
      const o = readMoments();
      const i = o.list.findIndex(x => x.id === id);
      if (i < 0) return sendJSON(res, { ok: false, error: '找不到这条' }, 404);
      if (o.list[i].uid !== me.uid) return sendJSON(res, { ok: false, error: '只能撤回自己说的' }, 403);
      /* 真删：整条摘掉。点赞和评论本来就是挂在条目上的，跟着一起走，
         不会留下任何孤儿数据；存量 recalled 条目由 readMoments 统一清。 */
      o.list.splice(i, 1);
      writeMoments(o);
      /* ★ T-04：这条动态产生过的通知一起带走。
         既然动态是「真删」，收件箱里再留一条点进去空空如也的通知就是纯脏数据 ——
         用户只会觉得这个红点是 bug。 */
      dropMomentMsgs(id);
      /* 汇总里也挂着这条动态：摘掉并重算。当天因此变成 0 条就整条删掉，
         不留「今天有 0 位用户上传了新歌」的空壳。 */
      dropMomentDailyRefs(id);
      return sendJSON(res, { ok: true });
    }

    if (p === '/api/moment/like' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const id = String((b && b.id) || '').trim();
      const o = readMoments();
      const m = o.list.find(x => x.id === id);
      if (!m) return sendJSON(res, { ok: false, error: '找不到这条' }, 404);
      m.likes = m.likes || [];
      const i = m.likes.indexOf(me.uid);
      if (i >= 0) m.likes.splice(i, 1); else m.likes.push(me.uid);
      writeMoments(o);
      /* ★ T-04：把这次互动投进作者的收件箱。
         ⚠️ 两个门槛，少一个就是事故：
           · 只有「真的赞上了」才通知 —— i < 0 是新增点赞，i >= 0 是取消赞。
             取消赞还去戳一下对方，是最招人烦的那种通知；
           · 自己赞自己的动态不通知 —— 红点代表「有件事等你处理」，
             自己的动作不算，否则光刷自己的动态就能把红点亮满。
         撤回的动态走不到这儿：readMoments() 已经把 recalled 的清掉了，
         上面的 find 直接落空走 404。 */
      if (i < 0 && m.uid && m.uid !== me.uid) {
        pushMomentMsg(m.uid, m.id, me.uid, 'like', '');
      }
      return sendJSON(res, { ok: true, liked: i < 0, likeCount: m.likes.length });
    }

    if (p === '/api/moment/comment' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const id = String((b && b.id) || '').trim();
      const text = String((b && b.text) || '').slice(0, 300).trim();
      if (!text) return sendJSON(res, { ok: false, error: '评论不能为空' }, 400);
      const o = readMoments();
      const m = o.list.find(x => x.id === id);
      if (!m) return sendJSON(res, { ok: false, error: '找不到这条' }, 404);
      /* ★ U-25：回复某人。扁平二级 —— 跟微信朋友圈一样，不搞多级递归：
         无论回复的是谁，都追加到评论列表尾部，只显示「A 回复 B」。
         ⚠️ replyTo 必须服务端校验：客户端传什么就信什么的话，
            谁都能伪造一个 uid 让自己的评论显示成「A 回复 <随便谁>」。
            不在 USERS 里的 uid 一律置空（宁可不显示，也不能被伪造）。 */
      let replyTo = String((b && b.replyTo) || '').slice(0, 64);
      const ru = replyTo ? USERS[replyTo] : null;
      if (!ru) replyTo = '';
      /* replyName 是**昵称快照**：被回复的人以后改名、甚至注销，
         历史评论里显示的仍然是当时的名字。动态作者那边是实时查
         publicCard（作者一定还在，否则动态也没了），评论不一样。 */
      const replyName = ru ? String(ru.username || '用户').slice(0, 64) : '';
      const c = {
        /* cid 是评论的稳定主键。以前评论根本没有 id，
           「删除自己的评论」无处下手（拿数组下标当主键会被 slice(-100) 漂掉）。 */
        cid: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        uid: me.uid, text, at: Date.now(),
        replyTo, replyName
      };
      m.comments = (m.comments || []).concat([c]).slice(-100);
      writeMoments(o);
      /* ★ T-04：同上，评论也通知作者。
         评论**不合并** —— 每条评论内容本身不同，折叠会丢正文；
         只有点赞那种「同一个动作反复发生」的才需要折叠成一条。 */
      if (m.uid && m.uid !== me.uid) {
        pushMomentMsg(m.uid, m.id, me.uid, 'comment', text);
      }
      /* 把落盘的那条回给前端：乐观更新画出来的临时条目要换成真 cid，
         否则「回复 / 删除」这两条路都认不到它（临时 cid 是 tmp 前缀的）。
         ⚠️ 取名字必须走 me.user.username —— userOf() 返回的是
            { uid, user, token } 包装对象，直接写 me.username 恒为 undefined，
            前端拿到的就是「用户」两个字（评论发出去的一瞬间昵称会跳变）。 */
      return sendJSON(res, { ok: true, c: {
        cid: c.cid, uid: c.uid, text: c.text, at: c.at,
        replyTo: c.replyTo, replyName: c.replyName,
        name: String((me.user && me.user.username) || '用户'), mine: true
      } });
    }

    /* ★ U-25：删除**自己**的某一条评论。
       以前评论没有主键（{uid,text,at} 三件套），「删自己的评论」无处下手；
       cid 由 readMoments 给老数据补齐、由 /api/moment/comment 给新评论写上。
       ⚠️ 两个硬门槛，少一个就是事故：
         · 只能删自己的（comments[i].uid !== me.uid → 403）。前端把按钮藏起来
           只是体验，不能当安全边界；
         · 删完要把它产生的那条互动消息一起撤掉。评论是「真删」的，
           作者收件箱里再留一条点进去空空如也的通知就是纯脏数据
           （U-42 铃铛读的就是 data/moment-msg.json）。 */
    if (p === '/api/moment/comment/del' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const id = String((b && b.id) || '').trim();
      const cid = String((b && b.cid) || '').trim();
      if (!id || !cid) return sendJSON(res, { ok: false, error: '参数不对' }, 400);
      const o = readMoments();
      const m = o.list.find(x => x.id === id);
      if (!m) return sendJSON(res, { ok: false, error: '找不到这条' }, 404);
      const cs = Array.isArray(m.comments) ? m.comments : [];
      const i = cs.findIndex(c => c && String(c.cid || '') === cid);
      if (i < 0) return sendJSON(res, { ok: false, error: '找不到这条评论' }, 404);
      if (cs[i].uid !== me.uid) return sendJSON(res, { ok: false, error: '只能删自己的评论' }, 403);
      const gone = cs[i];
      cs.splice(i, 1);
      m.comments = cs;
      writeMoments(o);
      /* 自己评论自己的动态时 pushMomentMsg 根本没推（见 /api/moment/comment
         里的 m.uid !== me.uid 门槛），这里同理，不用去清一条不存在的通知。 */
      if (m.uid && m.uid !== me.uid) {
        dropMomentCommentMsg(m.id, me.uid, gone.text, gone.at);
      }
      return sendJSON(res, { ok: true });
    }

    /* ══════════════════════════════════════════════════════════════
       一起听：邀请好友同步听同一首歌
       没有长连接，靠客户端每 2 秒拉一次房间状态，够用也好实现。
       ══════════════════════════════════════════════════════════════ */
    if (p === '/api/listen/invite' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const to = String((b && b.to) || '').trim();
      const sg = b && b.song;
      /* 以前这里只校验 sg.name —— 而搜索出来的歌是 songname/singer 那套键，
         客户端要先把整首翻成 name/artist 才敢发过来，一不留神就漏；
         现在客户端把整首歌原样传上来，服务端自己归一化（见 roomSong）。 */
      const songName = String((sg && (sg.songname || sg.name)) || '').trim();
      if (!USERS[to] || !sg || !songName) {
        return sendJSON(res, { ok: false, error: '参数不对' }, 400);
      }
      const s0 = readSocial();
      if ((s0.friends[me.uid] || []).indexOf(to) < 0) {
        return sendJSON(res, { ok: false, error: '只能邀请好友一起听' }, 403);
      }
      const o = readRooms();
      o.rooms = o.rooms.filter(r => Date.now() - (r.updatedAt || r.at) < ROOM_IDLE);
      /* ── 同一对人只留一个房间（第 9 期修）──
       * 改之前每点一次「一起听」就 unshift 一条，聊天页多点两下会在消息中心
       * 堆出好几条同人邀请，双方各自点进去还是**不同的房间** —— 客人进了 A，
       * 房主在 B 里推进度，两个人根本没连上。这是「功能用起来是错的」里最典型的一类。
       * 现在：已有未结束的房间就直接复用（把歌换成这次选的，state 不动）。 */
      const dup = o.rooms.find(r =>
        (r.state === 'inviting' || r.state === 'active')
        && ((r.host === me.uid && r.guest === to) || (r.host === to && r.guest === me.uid)));
      if (dup) {
        /* state 不能动：已 active 的房间被顶回 inviting 会让客人的未读判据
           （unread = state === 'inviting'）重新亮起来，铃铛莫名其妙又响一次。 */
        dup.song = roomSong(sg);
        dup.updatedAt = Date.now();
        delete dup.guestLeft;          // 重新发起 = 邀请对方回来
        writeRooms(o);
        return sendJSON(res, { ok: true, id: dup.id, reused: true });
      }
      const room = {
        id: 'lr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        host: me.uid, guest: to,
        song: roomSong(sg),
        state: 'inviting',            // inviting → active → ended
        progress: 0, playing: false,
        at: Date.now(), updatedAt: Date.now()
      };
      o.rooms.unshift(room);
      o.rooms = o.rooms.slice(0, 200);
      writeRooms(o);
      return sendJSON(res, { ok: true, id: room.id });
    }

    if (p === '/api/listen/invites') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const o = readRooms();
      const now = Date.now();
      const mine = o.rooms
        .filter(r => (r.guest === me.uid || r.host === me.uid)
          && (r.state === 'inviting' || r.state === 'active')
          /* 客人已经退出的房间不该再出现在**客人自己**的邀请列表里 ——
             否则他会看到一个「继续一起听」，点进去立刻又变 ended。 */
          && !(r.guest === me.uid && r.guestLeft)
          && now - (r.updatedAt || r.at) < ROOM_IDLE)
        .map(r => {
          const h = USERS[r.host];
          return {
            id: r.id, state: r.state, at: r.at, song: r.song,
            host: h ? publicCard(h) : { uid: r.host, username: '用户' },
            isHost: r.host === me.uid
          };
        });
      return sendJSON(res, { ok: true, list: mine });
    }

    if (p === '/api/listen/join' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const id = String((b && b.id) || '').trim();
      const accept = b && b.accept !== false;
      const o = readRooms();
      const r = o.rooms.find(x => x.id === id);
      if (!r) return sendJSON(res, { ok: false, error: '邀请不存在或已过期' }, 404);
      if (r.guest !== me.uid && r.host !== me.uid) {
        return sendJSON(res, { ok: false, error: '这不是你的邀请' }, 403);
      }
      /* ⚠️ 只有**客人接受**才算房间成立。房主自己也会调 join（前端 openRoom 是
       * 统一入口，建完房间后房主自己也会走一遍），那次调用绝不能把 inviting
       * 顶成 active —— 客人侧的未读判据就是 unread: r.state === 'inviting'，
       * 一旦被房主顺手顶成 active，这条判据恒为 false，消息中心的邀请永远
       * 不亮红点、铃铛一次都不会响（线上实测 3 轮 × 2 分钟，0 次亮）。
       * 房主调 join 只是"我要看这个房间"，不该改变房间状态：只回当前状态。
       *
       * 副作用查过了：state 没有被当成别的闸门用 ——
       *   /api/listen/sync（房主推进度）不看 state，房主在 inviting 期间照推不误；
       *   /api/listen/ask / grant / end 也都不看 state。
       *   唯一消费 state 的地方是 /api/msg/list 的 unread 和面板上那句
       *   「等对方加入…」，而这两处**本来就该**在客人没加入时保持 inviting。 */
      if (r.guest === me.uid) {
        r.state = accept ? 'active' : 'ended';
        r.updatedAt = Date.now();
        writeRooms(o);
      }
      return sendJSON(res, { ok: true, state: r.state, room: r });
    }

    if (p === '/api/listen/room') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const id = String(Q('id') || '').trim();
      const o = readRooms();
      const r = o.rooms.find(x => x.id === id);
      if (!r) return sendJSON(res, { ok: false, error: '房间不存在' }, 404);
      if (r.host !== me.uid && r.guest !== me.uid) {
        return sendJSON(res, { ok: false, error: '你不在这个房间里' }, 403);
      }
      const h = USERS[r.host], g = USERS[r.guest];
      /* 客人已经退出（guestLeft）时，**对客人自己这一侧的视角**就是结束了；
       * 对房主仍然是 active，只是多带一个 peerLeft 让他知道对方走了 ——
       * 这就是「离开」与「散场」的区别，见 /api/listen/end 那段长注释。 */
      const isGuest = r.host !== me.uid;
      const stateForMe = (isGuest && r.guestLeft) ? 'ended' : r.state;
      return sendJSON(res, {
        ok: true, room: {
          id: r.id, state: stateForMe, song: r.song,
          progress: r.progress || 0, playing: !!r.playing,
          updatedAt: r.updatedAt, isHost: r.host === me.uid,
          ask: r.ask || null,                       // 客人申请接管时房主能看到
          /* 点歌（第 9 期）：客人搜到任意一首歌就能甩进房间，
           * 房主侧弹一条「TA 点了《X》」+ 放/跳过两颗按钮。
           * 这里连 fromUid 一起回，客人自己那侧才知道「这条是我点的」，
           * 不然会把自家点歌画成"对方点的"，文案正好反了。 */
          pick: (r.pick && r.pick.song) ? {
            from: r.pick.from, at: r.pick.at, song: r.pick.song
          } : null,
          /* 房主侧：对方已经离开（不影响自己继续听，但界面上要说） */
          peerLeft: isGuest ? false : !!r.guestLeft,
          host: h ? publicCard(h) : { uid: r.host, username: '用户' },
          guest: g ? publicCard(g) : { uid: r.guest, username: '用户' },
          hostOnline: onlineOf(r.host, false), guestOnline: onlineOf(r.guest, false)
        }
      });
    }

    /* 房主把进度推上来，客人拉的时候跟着走 */
    if (p === '/api/listen/sync' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const id = String((b && b.id) || '').trim();
      const o = readRooms();
      const r = o.rooms.find(x => x.id === id);
      if (!r) return sendJSON(res, { ok: false, error: '房间不存在' }, 404);
      if (r.host !== me.uid && r.guest !== me.uid) {
        return sendJSON(res, { ok: false, error: '你不在这个房间里' }, 403);
      }
      /* 只有房主能改进度，客人只上报自己是否在线，避免两边互相拉扯。
       * 顺带把「我现在放的是哪首」一起推上来 —— 房主可能在房间里换了歌，
       * 客人这一侧是靠这个字段才发现要换碟的。 */
      if (r.host === me.uid) {
        r.progress = Math.max(0, Number(b.progress) || 0);
        r.playing = !!b.playing;
        if (b.song && typeof b.song === 'object' && (b.song.songname || b.song.name)) {
          const before = r.song ? (String(r.song.name) + '|' + String(r.song.artist)) : '';
          r.song = roomSong(b.song);
          /* 房主真的换了碟才清点歌条目（同一首歌反复推不算换碟）。
           * 不清的话，房主放了对方点的那首之后，那条「TA 点了《X》」
           * 会一直挂在面板上，房主会以为还没放。 */
          const after = String(r.song.name) + '|' + String(r.song.artist);
          if (after !== before) r.pick = null;
        }
      }
      r.updatedAt = Date.now();
      writeRooms(o);
      return sendJSON(res, { ok: true });
    }

    /* ── 点歌（第 9 期）──────────────────────────────────────────
     * 业主口径：「让他们随意获取歌，可以一起听」。
     * 以前客人只有一条路 —— 申请接管控制权，房主同意后**整个控制权都交出去**。
     * 只想听某首歌也得先夺权，动作太重，房主也不愿意放权。
     * 现在拆出一个更轻的动作：客人搜到任意一首（全平台搜索/收藏/最近都行）
     * 直接甩进房间，房主侧看到「TA 点了《X》」自己决定放不放。
     * 传 song=null 是清空：房主点「跳过」用它，房主换碟时由 /listen/sync 自动清。
     * 房主也能点（前端不给他走这条路，但接口不拦 —— 拦了只是让"房主点歌"
     * 这件事在接口层缺席，前端以后想复用还得再改一次服务端）。 */
    if (p === '/api/listen/pick' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const id = String((b && b.id) || '').trim();
      const sg = b && b.song;
      const o = readRooms();
      const r = o.rooms.find(x => x.id === id);
      if (!r) return sendJSON(res, { ok: false, error: '房间不存在' }, 404);
      if (r.host !== me.uid && r.guest !== me.uid) {
        return sendJSON(res, { ok: false, error: '你不在这个房间里' }, 403);
      }
      if (r.state === 'ended') return sendJSON(res, { ok: false, error: '房间已经散了' }, 410);
      if (sg && typeof sg === 'object' && (sg.songname || sg.name)) {
        r.pick = { from: me.uid, at: Date.now(), song: roomSong(sg) };
      } else {
        r.pick = null;
      }
      r.updatedAt = Date.now();
      writeRooms(o);
      return sendJSON(res, { ok: true, pick: r.pick });
    }

    /* 客人想自己放歌：先申请，房主同意后控制权才移交。
     * 不直接抢，是避免两个人同时拖进度把彼此的播放打乱。 */
    if (p === '/api/listen/ask' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const id = String((b && b.id) || '').trim();
      const o = readRooms();
      const r = o.rooms.find(x => x.id === id);
      if (!r) return sendJSON(res, { ok: false, error: '房间不存在' }, 404);
      if (r.guest !== me.uid) return sendJSON(res, { ok: false, error: '只有客人能申请接管' }, 403);
      r.ask = { from: me.uid, at: Date.now() };
      r.updatedAt = Date.now();
      writeRooms(o);
      return sendJSON(res, { ok: true, tip: '已申请，等对方同意' });
    }

    if (p === '/api/listen/grant' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const id = String((b && b.id) || '').trim();
      const accept = !!(b && b.accept);
      const o = readRooms();
      const r = o.rooms.find(x => x.id === id);
      if (!r) return sendJSON(res, { ok: false, error: '房间不存在' }, 404);
      if (r.host !== me.uid) return sendJSON(res, { ok: false, error: '只有房主能决定是否移交' }, 403);
      if (accept && r.ask && r.ask.from === r.guest) {
        /* 双方身份对调，原来的客人变成房主 */
        const oldHost = r.host;
        r.host = r.guest;
        r.guest = oldHost;
      }
      r.ask = null;
      r.updatedAt = Date.now();
      writeRooms(o);
      return sendJSON(res, { ok: true, handed: accept });
    }

    if (p === '/api/listen/end' && req.method === 'POST') {
      const me = userOf(req);
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const id = String((b && b.id) || '').trim();
      const o = readRooms();
      const r = o.rooms.find(x => x.id === id);
      if (!r) return sendJSON(res, { ok: false, error: '房间不存在' }, 404);
      if (r.host !== me.uid && r.guest !== me.uid) {
        return sendJSON(res, { ok: false, error: '你不在这个房间里' }, 403);
      }
      /* ── 谁退出，语义不一样（第 9 期修）──
       * 业主口径「社交里的一些功能使用起来，是错误的，不合理的」。
       * 改之前：**任何一方关掉面板都会把整场结束** ——
       *   客人只是不想听了，房主那边却收到「这次一起听结束了」并被暂停，
       *   这是把「离开」和「散场」混成了一件事。
       * 现在：
       *   房主退出 → state='ended'（整场散场，两位都收尾）
       *   客人退出 → guestLeft=true，房间对**房主**仍然 active，
       *              房主会看到「对方离开了」并可以自己继续听或结束；
       *              对客人自己的 /api/listen/room 则直接回 ended。
       * 这样「客人退出把房主一起带走」这个不合理行为就没了。
       */
      if (r.guest === me.uid && r.state !== 'ended') {
        r.guestLeft = true;
        r.guestLeftAt = Date.now();
      } else {
        r.state = 'ended';
      }
      r.updatedAt = Date.now();
      writeRooms(o);
      return sendJSON(res, { ok: true });
    }
    /* 前端点「立即更新」时调这个：立刻去更新源拉一次覆盖层，别让用户等到下一个定时周期 */
    if (p === '/api/app/update-now') {
      const r = await checkAppUpdate().catch(() => null);
      return sendJSON(res, { ok: true, updated: !!(r && r.changed && r.changed.length), detail: r || null });
    }
    /* 安卓 APK 下载：手机端自检更新后从这里拉包。
     * 用户端与管理端共用这段下发逻辑，只有元信息文件不同 ——
     * 两个包都从 data/app-update 出，但文件名、包名、签名各走各的，别混。 */
    const serveApk = (metaPath) => {
      let a = null;
      try { a = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { a = null; }
      if (!a || !a.file) return send(res, 404, 'no apk', { 'Content-Type': 'text/plain; charset=utf-8' });
      const rel = String(a.file).replace(/\\/g, '/').replace(/^\/+/, '');
      if (rel.includes('..')) return send(res, 400, 'bad file', { 'Content-Type': 'text/plain; charset=utf-8' });
      const fp = path.join(RELEASE_DIR, rel);
      if (!fs.existsSync(fp)) return send(res, 404, 'apk file missing', { 'Content-Type': 'text/plain; charset=utf-8' });
      return send(res, 200, fs.readFileSync(fp), {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': contentDisposition(rel),
        'Cache-Control': 'no-cache'
      });
    };
    if (p === '/api/app/apk') return serveApk(APK_META);
    if (p === '/api/app/admin-apk') return serveApk(ADMIN_APK_META);
    if (p === '/api/app/file') {
      const rel = String(Q('rel') || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!rel || rel.includes('..')) return send(res, 400, 'bad rel', { 'Content-Type': 'text/plain; charset=utf-8' });

      /* ① 严格文件名白名单：不在清单里引用的名字一律不认。
         以前是「文件存在就吐」，于是 4 个 exe 里没被引用的那 448 MiB 匿名可拉。 */
      if (!releaseFileAllow().has(rel)) {
        console.warn('[app-file] 已拒绝：清单里没有引用这个文件 -> ' + rel);
        return send(res, 404, 'manifest 里没有引用这个文件：' + rel, { 'Content-Type': 'text/plain; charset=utf-8' });
      }

      /* ② 落点必须真的在发布目录里。
         上面那条是「名字」层面，这条是「真实落点」层面：挡的是名字过关但
         实际指向别处的情况（软链接指出去、path.join 的怪异拼接）。
         只做①不做②，等于把安全寄托在「发布目录里没有软链接」这个没人在保的假设上。 */
      const fp = path.join(RELEASE_DIR, rel);
      const real = path.resolve(fp);
      const root = path.resolve(RELEASE_DIR);
      if (real !== root && !real.startsWith(root + path.sep)) {
        console.warn('[app-file] 已拒绝：解析后越出发布目录 -> ' + rel + ' => ' + real);
        return send(res, 404, '这个文件不在发布目录里：' + rel, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });

      /* ③ 流式吐，不 readFileSync 整包进堆。
         190MB × N 个并发 = N×190MB 同时驻留，这是本项目最狠的一个放大器。
         （md5FileSync() 是算 md5 用的，跟这件事无关，别混。） */
      const ext = path.extname(rel).toLowerCase();
      const head = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Content-Length': fs.statSync(fp).size,
      };
      if (req.method === 'HEAD') { res.writeHead(200, head); res.end(); return; }
      res.writeHead(200, head);
      try { await pipeline(fs.createReadStream(fp), res); }
      catch { try { res.destroy(); } catch { /* 连接已经没了 */ } }
      return;
    }

    /* ---- 前端：PC 与手机共用同一套（PWA），exe 里读内嵌资产 ---- */
    if (p === '/' || p === '/index.html') {
      const html = readWeb('index.html');
      if (html != null) return send(res, 200, withBuildStamp(html), { 'Content-Type': 'text/html; charset=utf-8' });
      /* ⚠️ 这里的兜底原来是 fs.readFileSync(path.join(APP_DIR, 'index.html'))，
       * 和已经删掉的 /legacy 是同一个模板：那是前端搬到 web/ 之前的老路径。
       *
       * 它必死，而且比 /legacy 更糟 —— 这是**根路径**的兜底。
       *     · APP_DIR 和 web/ 根本不是一回事：WEB_DIR 是 __dirname/web（永远跟着
       *       server.mjs 走），而 APP_DIR 在 Electron 壳里是用户数据目录、在 SEA 里是
       *       exe 所在目录。拿 APP_DIR 去拼 index.html 从一开始就指错了地方。
       *     · 于是这个分支一旦走到就是 ENOENT → 冒到外层 catch → 记一行
       *       `[500] / Error: ENOENT...`。用户访问根路径看到 500，
       *       日志里只有一句看不出该补哪个文件的 ENOENT。
       *
       * 但它不能像 /legacy 那样直接删掉让分支消失：readWeb() 确实可能返回 null
       * —— SEA 态内嵌资产缺失、脚本态 web/index.html 不在、OTA 覆盖层也没有，
       * 三种情况都会走到这里。删掉分支就等于 send(res, 200, null)，
       * res.end(null) 直接抛错，结果更糟。
       *
       * 也不能给 404：/legacy 是「这个地址没有了」，而这里是「服务没装全」。
       * 根路径拿不到页面时给 404，会把排查的人引到完全相反的方向。
       * 所以回 500 并**把该补的文件路径直接写在响应里**。 */
      return send(res, 500,
        '前端入口缺失：index.html 三个来源都取不到。\n' +
        '① OTA 覆盖层  ' + path.join(UPDATE_DIR, 'index.html') + '\n' +
        '② SEA 内嵌资产 web/index.html（仅 exe 态）\n' +
        '③ 磁盘        ' + path.join(WEB_DIR, 'index.html') + '\n' +
        '请确认第 ③ 项存在且可读。',
        { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    /* 管理台：单文件控制台，网页版 / EXE / APK 三端共用同一份。
     * 放在 web/admin.html 里，这样 exe 打包时会自动跟着 web/ 一起内嵌进去。
     *
     * ⚠️ 这里说的「exe 打包」是**主程序那个 exe**（dist/YMusic.exe，它整包内嵌 web/），
     *    不是「账号管理台 exe」（dist/YMusic账号管理台.exe）。
     *
     *    工程里有两个都叫「管理台」的东西，它们是两个不同产品，页面不通用：
     *      ① 本路由 /admin  —— 运营管理台（审核 / 公告 / 用户角色）
     *         页面 web/admin.html，后端是本文件 server.mjs 的 /api/admin/* + /api/auth/*
     *      ② admin/ 目录    —— 账号管理台（数据源归集 / 备份 / 发布）
     *         页面 admin/index.html，后端是 admin/server.mjs 的 /api/state、/api/users 等
     *
     *    曾经有人（包括我）只看下面那句注释就断定「设计意图是统一到 web/admin.html、
     *    是 build/admin-sea-config.json 没跟上」，差点把 ① 的页面塞进 ② 的 exe。
     *    实测后果：② 的后端一个 /api/admin/* 都没有，页面会每次请求都 404。
     *    详见 admin/README.md。 */
    if (p === '/admin' || p === '/admin/') {
      const html = readWeb('admin.html');
      if (html == null) return send(res, 404, '管理台未安装', { 'Content-Type': 'text/plain; charset=utf-8' });
      return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    }
    /* 安装引导页：把本页链接发给别人，页面会自己判断设备给出对应指引 */
    if (p === '/install') {
      const html = readWeb('install.html');
      if (html == null) return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    }
    /* ★ 2026-10-18：酷狗凭证守护页。
       高码率链路对 token 是全或无的门槛，凭证一失效会员曲就哑火，
       而症状和「会员到期」分不出来。页面本身公开无所谓，
       数据全走 /api/admin/kg/*，由 adminOf() 鉴权。 */
    if (p === '/kg' || p === '/kg.html') {
      const html = readWeb('kg.html');
      if (html == null) return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    }
    /* ---- Windows 桌面端安装包下载 ----
     * 以前这里是 fs.readFileSync 一把把整个 89MB 读进内存再吐出去：
     * 三个人同时点下载，进程堆上就摆着 270MB，云上 2G 内存撑不住。
     * 改成流式：边读边发，内存只占一个读缓冲区。
     *
     * 文件名不再写死 YMusic.exe，跟清单里的 exe.file 对齐 ——
     * 那样以后发「YMusic-3.7.0.exe」这种带版本号的文件名，
     * 不用连服务端一起改。 */
    if (p === '/api/app/exe') {
      const e = readExeMeta();
      if (!e) return send(res, 404, 'Windows 安装包还没上传，先用在用的版本吧',
        { 'Content-Type': 'text/plain; charset=utf-8' });
      const fp = path.join(RELEASE_DIR, e.file);
      const st = fs.statSync(fp);
      const fname = e.file.replace(/[\\/]/g, '_');
      /* ★ 2026-10-18：加 Range。实测原来连 `Range: bytes=0-1023` 都回 200 全量
         （191,504,896 字节）—— 182MB 安装包在弱网下一断就得从头下，
         而这是用户拿桌面版的唯一入口。语义与 /api/proxy 一致：
         合法 Range 回 206 + Content-Range，其余回 200。
         ⚠️ 必须显式 Accept-Ranges，否则浏览器 / 迅雷这类下载器不会发 Range。 */
      const rgh = String(req.headers.range || '');
      const rm = /^bytes=(\d*)-(\d*)$/.exec(rgh.trim());
      let from = 0, to = st.size - 1, partial = false;
      if (rm && (rm[1] || rm[2])) {
        if (rm[1] === '') {                       // bytes=-1024 → 末尾 N 字节
          const n = parseInt(rm[2], 10);
          if (n > 0) { from = Math.max(0, st.size - n); to = st.size - 1; partial = true; }
        } else {
          from = parseInt(rm[1], 10);
          if (rm[2]) to = Math.min(parseInt(rm[2], 10), st.size - 1);
          partial = true;
        }
        /* 越界 / 倒序的 Range 不报 416，直接当「没传 Range」处理 ——
           宁可多发一点，也别给用户一个白屏。 */
        if (!(from >= 0 && from < st.size && to >= from)) { from = 0; to = st.size - 1; partial = false; }
      }
      const hdrs = {
        ...CORS,
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': contentDisposition(fname),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache'
      };
      if (partial) {
        res.writeHead(206, {
          ...hdrs,
          'Content-Range': 'bytes ' + from + '-' + to + '/' + st.size,
          'Content-Length': String(to - from + 1)
        });
      } else {
        res.writeHead(200, { ...hdrs, 'Content-Length': String(st.size) });
      }
      if (req.method === 'HEAD') return res.end();
      /* 读的过程中出错（文件被替、盘被拔）也不能把进程带崩，安静收掉连接即可 */
      const sk = fs.createReadStream(fp, partial ? { start: from, end: to } : {});
      sk.on('error', () => { try { res.end(); } catch { /* ignore */ } });
      sk.pipe(res);
      return;
    }
    /* ---- 鸿蒙（HarmonyOS .hap）安装包：现在还没有这一端 ----
     * 留占位、返回 200 + available:false，而不是 404：
     * 客户端探测「有没有 hap 包」时拿到的是明确的「还没有」，
     * 而不是一个 404 的 HTML 错误页 —— 老客户端会把 404 的 body
     * 当 JSON 去解析，然后抛一个谁也看不懂的语法错。
     * 等真有鸿蒙端了，照 /api/app/exe 那套补上文件下发即可。 */
    if (p === '/api/app/hap') {
      return sendJSON(res, { ok: true, available: false, note: '鸿蒙端还没发布' });
    }
    /* ---- iOS 端（未签名 IPA，给巨魔 / TrollStore 装）----
     * 包放在 data/app-update/*.ipa，取文件名排序后的最后一个
     * （文件名里带版本号，字典序天然等于版本序，跟 /download 里找 hap 同一个套路）。
     *
     * 跟 exe 一样必须支持 Range：
     *   壳包 8~15MB，手机在移动网下一断就得从头下是最烦的；
     *   而且 TrollStore 的安装器本身也会发 Range 探测。
     *
     * 没有包时回 200 + available:false，理由同 /api/app/hap ——
     * 探测端拿到的是明确的「还没有」，不是一个 404 的 HTML 错误页。 */
    if (p === '/api/app/ipa' || p === '/api/app/ios') {
      let ipa = null;
      try {
        ipa = fs.readdirSync(RELEASE_DIR)
          .filter(n => /\.ipa$/i.test(n))
          .sort()
          .pop() || null;
      } catch { ipa = null; }
      if (!ipa) {
        return sendJSON(res, { ok: true, available: false, note: 'iOS 安装包还没发布' });
      }
      const fp = path.join(RELEASE_DIR, ipa);
      let st;
      try { st = fs.statSync(fp); } catch { return sendJSON(res, { ok: true, available: false, note: 'iOS 安装包读取失败' }); }
      const fname = ipa.replace(/[\\/]/g, '_');
      const rgh = String(req.headers.range || '');
      const rm = /^bytes=(\d*)-(\d*)$/.exec(rgh.trim());
      let from = 0, to = st.size - 1, partial = false;
      if (rm && (rm[1] || rm[2])) {
        if (rm[1] === '') {
          const n = parseInt(rm[2], 10);
          if (n > 0) { from = Math.max(0, st.size - n); to = st.size - 1; partial = true; }
        } else {
          from = parseInt(rm[1], 10);
          if (rm[2]) to = Math.min(parseInt(rm[2], 10), st.size - 1);
          partial = true;
        }
        if (!(from >= 0 && from < st.size && to >= from)) { from = 0; to = st.size - 1; partial = false; }
      }
      const hdrs = {
        ...CORS,
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': contentDisposition(fname),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache'
      };
      if (partial) {
        res.writeHead(206, {
          ...hdrs,
          'Content-Range': 'bytes ' + from + '-' + to + '/' + st.size,
          'Content-Length': String(to - from + 1)
        });
      } else {
        res.writeHead(200, { ...hdrs, 'Content-Length': String(st.size) });
      }
      if (req.method === 'HEAD') return res.end();
      const sk = fs.createReadStream(fp, partial ? { start: from, end: to } : {});
      sk.on('error', () => { try { res.end(); } catch { /* ignore */ } });
      sk.pipe(res);
      return;
    }

    /* ---- 一键加桌面：Web Clip 配置描述文件 ----
     *
     * 为什么需要它：iOS 上真正「点链接就能装」的东西只有三种 —— App Store、
     * 巨魔 IPA、配置描述文件。前两种我们给不了（没有开发者账号 / 没有 Mac 出包），
     * 而手动「分享 → 添加到主屏幕」对不熟悉 iPhone 的人挺绕，还经常在微信里
     * 找不到那个菜单。
     *
     * 描述文件里的 com.apple.webClip.managed 是系统原生载荷：装完桌面上直接
     * 多一个图标，点开就是全屏的 YMusic，**不需要签名、不需要账号、不受
     * iOS 版本限制**。对 iOS 端来说这是链路最短的方案。
     *
     * 三个注意点：
     *  ① Content-Type 必须是 application/x-apple-aspen-config，
     *     否则 Safari 只会把 XML 当文本显示出来；
     *  ② Icon 要 base64 的 PNG 原文（不是 data: 前缀那种），现读磁盘上的
     *     apple-touch-icon.png，换图标不用改代码；
     *  ③ URL 用 currentBase() 实时取 —— 换域名/换端口后重新下一个就对了，
     *     别把地址写死在描述文件里。 */
    if (p === '/api/app/webclip.mobileconfig' || p === '/YMusic.mobileconfig') {
      let iconB64 = '';
      try {
        iconB64 = fs.readFileSync(path.join(WEB_DIR, 'icons/apple-touch-icon.png')).toString('base64');
      } catch { /* 没图标也能装，只是桌面显示空白方块 */ }
      const base = currentBase();
      const iconXml = iconB64
        ? '<key>Icon</key><data>' + iconB64 + '</data>'
        : '';
      const plist = '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        + '<plist version="1.0"><dict>'
        + '<key>PayloadContent</key><array><dict>'
        + '<key>PayloadType</key><string>com.apple.webClip.managed</string>'
        + '<key>PayloadIdentifier</key><string>com.ymusic.webclip</string>'
        + '<key>PayloadUUID</key><string>6B1F0C24-9D3A-4E7B-8C15-2A9F4D6E1B70</string>'
        + '<key>PayloadVersion</key><integer>1</integer>'
        + '<key>PayloadDisplayName</key><string>YMusic 桌面图标</string>'
        + '<key>Label</key><string>YMusic</string>'
        + '<key>URL</key><string>' + base + '/</string>'
        + iconXml
        + '<key>IsRemovable</key><true/>'
        + '<key>FullScreen</key><true/>'
        + '</dict></array>'
        + '<key>PayloadType</key><string>Configuration</string>'
        + '<key>PayloadIdentifier</key><string>com.ymusic.webclip.profile</string>'
        + '<key>PayloadUUID</key><string>2E7C4A18-53B6-42D9-9F0A-7C8B1E3D5A92</string>'
        + '<key>PayloadVersion</key><integer>1</integer>'
        + '<key>PayloadDisplayName</key><string>YMusic 加到主屏幕</string>'
        + '<key>PayloadDescription</key><string>把 YMusic 装到 iPhone / iPad 桌面，点开即用，不需要 Apple ID。</string>'
        + '<key>PayloadOrganization</key><string>YMusic</string>'
        + '<key>PayloadRemovalDisallowed</key><false/>'
        + '</dict></plist>\n';
      return send(res, 200, plist, {
        'Content-Type': 'application/x-apple-aspen-config; charset=utf-8',
        'Content-Disposition': 'attachment; filename="YMusic.mobileconfig"',
        'Cache-Control': 'no-cache'
      });
    }

    /* ⚠️ 这里以前是 /legacy，读 APP_DIR/index.html 并直接 200 返回。
       那条路由是**版本控制之前**就有的老代码：那时候前端入口确实放在工程根目录，
       后来前端整体搬到了 web/index.html，根目录那份文件早就不存在了。
       于是每次请求它都抛 ENOENT，被外层 catch 打成 [500] ——
       一个无人调用的死路由，稳定地往日志里吐服务器错误，还会触发告警。

       全仓（web/、admin/、两端安卓、两端桌面、脚本、文档）grep 过：
       没有任何地方引用 /legacy。
       所以删掉它，让它落到最底下那个 `send(res, 404, 'not found')`。
       对老书签来说，404 也比 500 诚实 —— 500 意味着「服务器坏了」，
       而事实只是「这个地址没有了」。 */
    /* ---- /ios/trollstore：一条链接装巨魔，装完再一条链接装 YMusic ----
     *
     * 用户的诉求是「一步到位、尽量少操作」。能压缩到什么程度，取决于系统版本
     * 和芯片 —— 这不是我们偷懒，是巨魔本身的安装矩阵决定的：
     *
     *   · 设备端直接装（不用电脑）：TrollInstallerX（jailbreaks.app 上有企业签名
     *     版本，Safari 点一下就装）、TrollHelperOTA（老系统）。
     *   · 必须电脑：iOS 17.0 只能走 TrollRestore（替换「提示」App）。
     *   · iOS 17.0.1 以上：永远没有。
     *
     * 所以这页不假装「一键」，而是：认版本 → 只显示你这台该点的那一个按钮 →
     * 装完回来点第二个按钮。真正能做成一步的是第二步 —— TrollStore 支持
     * apple-magnifier://install?url=<ipa>，有 IPA 时这里直接给深链，
     * 点一下就从浏览器跳进巨魔装 App，不用下文件、不用找分享菜单。
     *
     * ⚠️ 深链必须 encodeURIComponent，否则 ipa 地址里的 :// 会把参数截断。
     */
    if (p === '/ios/trollstore' || p === '/ios/trollstore/') {
      let hasIpa = false, ipaSize = '';
      try {
        const f = fs.readdirSync(RELEASE_DIR).filter(n => /\.ipa$/i.test(n)).sort().pop();
        if (f) {
          hasIpa = true;
          const st = fs.statSync(path.join(RELEASE_DIR, f));
          ipaSize = st.size >= 1048576
            ? (st.size / 1048576).toFixed(1) + ' MB'
            : Math.max(1, Math.round(st.size / 1024)) + ' KB';
        }
      } catch { /* 没有就没有 */ }

      const base = currentBase();
      /* 装完巨魔后的一步安装：深链进 TrollStore 直接装 IPA。 */
      const tsLink = 'apple-magnifier://install?url=' + encodeURIComponent(base + '/api/app/ipa');
      const installStep = hasIpa
        ? '<a class="btn" href="' + tsLink + '">一键装进巨魔（' + ipaSize + '）</a>'
          + '<p class="hint"><b>点了没反应</b> = 巨魔还没装好，或者巨魔 Settings 里的 '
          + '<b>URL 安装</b> 没打开。<br>'
          + '<b>不要用 Safari 下载 IPA</b> —— iOS 会把 .ipa 存成一个没有扩展名的'
          + '「数据」文件（下载列表里那个 131 KB 的就是它），「文件」App 里打不开、'
          + '转发给巨魔也认不出来。这条路走不通，别再试了。</p>'
        : '<a class="btn off">YMusic 的 iOS 包还在出（见下方说明）</a>'
          + '<p class="hint">装好巨魔后先回主屏幕也能用 —— 现在这一版 YMusic 的界面全在网页里，'
          + '加到桌面就是全屏的，功能一样。</p>';

      const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>装巨魔 · YMusic</title>
<meta name="theme-color" content="#0A120D">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<style>
:root{--bg:#050806;--card:#0f1712;--line:#1e2b23;--txt:#e8f2ea;--sub:#8fa396;--acc:#25d07a;--warn:#e8cf9f}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;padding:calc(env(safe-area-inset-top) + 16px) 16px calc(env(safe-area-inset-bottom) + 26px);
 background:var(--bg);color:var(--txt);font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
 min-height:100vh;min-height:100dvh;-webkit-text-size-adjust:100%}
.wrap{max-width:560px;margin:0 auto}
h1{margin:0 0 4px;font-size:20px}
.sub{margin:0 0 14px;color:var(--sub);font-size:13px}
.step{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:12px}
.step h2{margin:0 0 4px;font-size:15.5px;display:flex;align-items:center;gap:8px}
.n{width:22px;height:22px;border-radius:50%;background:#14261c;border:1px solid #21472f;color:var(--acc);
 font-size:12px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex:none}
.step p{margin:0 0 10px;color:var(--sub);font-size:13px}
.banner{border-radius:12px;padding:11px 13px;font-size:13px;line-height:1.6;margin-bottom:14px;border:1px solid}
.banner.good{background:#0d1f14;border-color:#1d4a2c;color:#9fe7b8}
.banner.warn{background:#201a0d;border-color:#4a3c1d;color:var(--warn)}
.banner.bad{background:#200f10;border-color:#4a1d20;color:#f0b0b3}
a.btn{display:block;text-align:center;text-decoration:none;background:var(--acc);color:#04120a;font-weight:700;
 border-radius:12px;padding:14px;font-size:15px;margin-top:8px}
a.btn.ghost{background:transparent;color:var(--txt);border:1px solid var(--line);font-weight:500}
a.btn.off{background:#1a2a22;color:#7b9486;pointer-events:none}
a.btn.blue{background:#2b7cf6;color:#fff}
ol{margin:8px 0 0;padding-left:19px;font-size:13.5px}
ol li{margin-bottom:7px}
b{color:#d8f2e2}
.hint{font-size:12px;color:#7d9186;line-height:1.65;margin:10px 0 0}
details{border-top:1px solid var(--line);margin-top:12px;padding-top:10px}
summary{cursor:pointer;color:var(--acc);font-size:13px;outline:none}
details ol{margin-top:10px}
.pick{display:flex;gap:8px;margin-top:10px}
.pick a{flex:1;text-align:center;text-decoration:none;background:#13221a;border:1px solid #22422f;
 color:var(--txt);border-radius:10px;padding:11px 8px;font-size:13px}
.pick a.on{background:var(--acc);color:#04120a;border-color:var(--acc);font-weight:700}
.pick .tiny{display:block;font-size:11px;opacity:.65;margin-top:2px}
.branch{display:none}.branch.on{display:block}
/* 17.0.1 起巨魔永久无解：这一页对他只剩「别试了」这一个作用 */
.only-no{display:none}
html.no-troll .only-no{display:block}
html.no-troll .only-ok{display:none}
/* 第 2、3 步全是「巨魔装好之后」才有意义的动作，17.0.1+ 上留着就是死按钮 */
html.no-troll #step2,html.no-troll #step3{display:none}
footer{text-align:center;color:#5d7267;font-size:12px;padding:10px 0 6px;line-height:1.9}
</style></head><body><div class="wrap">
<h1>装巨魔，再装 YMusic</h1>
<p class="sub">先认你的系统，再只给你点那一个按钮</p>

<div id="verdict" class="banner">正在认你的系统…</div>

<section class="step">
  <h2><i class="n">1</i>装 TrollStore（巨魔）</h2>
  <div class="only-no">
    <p><b>你这台没有这条路。</b>iOS <b>17.0.1</b> 把巨魔依赖的签名校验漏洞补了，
    之后所有版本（17.x / 18.x / 26.x）都不会再有 —— 不是等更新能解决的。
    下面这些安装器点了也只会失败，别浪费时间。</p>
    <a class="btn" href="/api/app/webclip.mobileconfig">直接用 · 加到主屏幕（30 秒）</a>
    <a class="btn ghost" href="/ios">回上一页，看「自签」怎么装成真 App</a>
  </div>
  <div class="only-ok">
  <p>巨魔不是越狱，它是靠 CoreTrust 的漏洞做「永久签名」。装一次一直在，
  不用 7 天续签、不用登录 Apple ID。机型不确定就点<b>左边那个</b>先试 ——
  装错了安装器会自己报错，不会把系统弄坏。</p>
  <div class="pick" id="pick">
    <a href="#" data-b="new">iPhone XS 及以后<br><span class="tiny">A12 及以上</span></a>
    <a href="#" data-b="old">iPhone X 及更早<br><span class="tiny">A11 及以下</span></a>
  </div>

  <div class="branch" id="b-new">
    <a class="btn" href="itms-services://?action=download-manifest&amp;url=https://jailbreaks.app/cdn/plists/TrollHelper.plist">iOS 14 – 15.6.1：点这一下直接装</a>
    <p class="hint">点了会弹「想要安装」→ 点 <b>安装</b>。桌面会多一个叫
    <b>GTA Car Tracker</b> 的图标 —— 那是伪装的巨魔助手，不是游戏，别删。
    打开它点 <b>Install TrollStore</b> 就装好了。</p>
    <a class="btn ghost" href="https://jailbreaks.app/">版本更高 / 上面弹不出来？换签名源（TrollInstallerX）</a>
    <ol>
      <li>打开后找到 <b>TrollInstallerX</b>，点 <b>GET</b> → 弹出「想要安装」点 <b>安装</b>。</li>
      <li>装完去 <b>设置 → 通用 → VPN 与设备管理</b>，点那个企业证书 → <b>信任</b>。</li>
      <li>打开桌面上的 TrollInstallerX → 点 <b>Install TrollStore</b> →
          选一个你不用的系统 App（比如「提示 / Tips」）当持久化助手。</li>
      <li>打开那个 App，点 <b>Install TrollStore</b>，手机会注销一次，回桌面就有巨魔了。</li>
      <li>首次打开巨魔会自动装 ldid（要联网）；没弹就在 Settings 里点 <b>Install ldid</b>。</li>
    </ol>
    <p class="hint">企业证书被吊销是常态 —— 点了 GET 装不上，就换一天再试，
    或者直接用下面「必须电脑」那一条（TrollRestore 不依赖证书，最稳）。</p>
  </div>

  <div class="branch" id="b-old">
    <a class="btn" href="https://jailbreaks.app/troll">打开 OTA 安装页（TrollHelper）</a>
    <ol>
      <li>用 <b>Safari</b> 打开，点安装 → 允许。</li>
      <li>桌面出现 TrollHelper → 打开 → <b>Install TrollStore</b>。</li>
      <li>装完打开巨魔，等它自动装 ldid。</li>
    </ol>
    <p class="hint">这一档只在 iOS 15.0 – 15.4.1（arm64）或 14.0b2 – 15.6.1（arm64e）有效。</p>
  </div>

  <details><summary>iOS 17.0 / 企业证书用不了？走电脑（最稳，不依赖证书）</summary>
    <ol>
      <li>电脑装 <b>iTunes</b> + <b>Python3</b>，下载 <b>TrollRestore</b>（github.com/JJTech0130/TrollRestore/releases）。</li>
      <li>手机关掉「查找我的 iPhone」，用数据线连电脑。</li>
      <li>运行 TrollRestore，输入 <b>Tips</b> 回车，等它跑完，手机会自动重启。</li>
      <li>打开「提示」App，它已经变成安装器 → 点 <b>Install TrollStore</b>。</li>
    </ol>
    <p class="hint">TrollRestore 用的是备份恢复通道，不碰证书，所以比在线装稳得多 ——
    追求「稳定」就选这条。</p>
  </details>
  </div><!-- /.only-ok -->
</section>

<section class="step" id="step2">
  <h2><i class="n">2</i>装 YMusic</h2>
  <p>巨魔装好后回到这一页，点下面的按钮，会直接从浏览器跳进巨魔开始装，不用下载、不用找分享菜单。</p>
  ${installStep}
</section>

<section class="step" id="step3">
  <h2><i class="n">3</i>装完记得做的一件事</h2>
  <p>巨魔的 Settings 里点 <b>Install Persistence Helper</b>，选你刚才注入的那个系统 App。
  不做这一步，系统刷新图标缓存后巨魔和白图标一样打不开 —— 这是巨魔最常见的「装完第二天失效」。</p>
  <a class="btn ghost" href="/ios">不用巨魔，直接加到主屏幕</a>
</section>

<footer>iOS 17.0.1 及以上没有巨魔，也没有任何绕过的办法<br>
那一档请用上面的「加到主屏幕」，体验差不太多</footer>
</div>
<script>
(function(){
  var ua = navigator.userAgent || '';
  /* 第三段必须取：17.0.1 的 UA 里是「OS 17_0_1」，只取两段会当成 17.0（详见 /ios 页注释） */
  var m = /OS (\\d+)[._](\\d+)(?:[._](\\d+))?/.exec(ua);
  if (!m && /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1) {
    m = /Version\\/(\\d+)\\.(\\d+)(?:\\.(\\d+))?/.exec(ua);
  }
  var box = document.getElementById('verdict'), cls = 'warn', txt = '';
  if (!m) {
    txt = '认不出系统版本 —— 去「设置 → 通用 → 关于本机」看一下。';
  } else {
    var a = +m[1], b = +m[2], c = m[3] ? +m[3] : 0;
    if (a < 14) { txt = 'iOS ' + a + '.' + b + '：低于 14，装不了巨魔。'; cls = 'bad'; }
    else if (a > 17 || (a === 17 && (b > 0 || c > 0))) {
      /* 18 / 26 / 27 这些「17 之后」的世代：**别张口就说 17.0.1** ——
         一个 26.5 的人会以为「我这不是 17，你是在说别人」。直接讲他这一代。
         （26 起苹果把版本号改成按发布年份，26 = 原本该叫 19 的那一代，所以数字跳了；
           用户看到 26 会懵，页面就得把这件事讲明白。） */
      txt = 'iOS ' + a + '.' + b + (c ? '.' + c : '') + '：巨魔在你这一代早就没了'
        + (a >= 18
            ? '（苹果从 17.0.1 起就把它依赖的漏洞补了，18 / 26 / 27 一样没戏）'
            : '（17.0.1 把它依赖的漏洞补了）')
        + '，但 YMusic 照常能用 —— 点下面那个按钮加到主屏幕就行。';
      cls = 'bad';
    } else if (a === 17) {
      txt = 'iOS 17.0：最后一版能装的，只能用 TrollRestore（要电脑），见下面那条折叠项。';
    } else if (a === 16 && b === 7) {
      txt = 'iOS 16.7：只有 RC 版（20H18）能装，正式版不行。';
    } else {
      txt = 'iOS ' + a + '.' + b + '：在巨魔支持范围内。先点上面那个「14 – 15.6.1 直接装」，'
        + '弹不出来再用下面的签名源。';
      cls = 'good';
    }
  }
  box.className = 'banner ' + cls;
  box.textContent = txt;

  /* 不在支持范围 → 把第 1 步整块换成「别试了」，省得他去点那些安装器 */
  var trollOk = !!(m && (+m[1] === 14 || +m[1] === 15
    || (+m[1] === 16 && +m[2] < 7)
    || (+m[1] === 17 && +m[2] === 0 && (!m[3] || +m[3] === 0))));
  if (!trollOk) document.documentElement.className += ' no-troll';

  var pick = document.getElementById('pick');
  function show(b){
    var nodes = document.querySelectorAll('.branch');
    for (var i = 0; i < nodes.length; i++) nodes[i].className = 'branch';
    var el = document.getElementById('b-' + b);
    if (el) el.className = 'branch on';
    var links = pick.getElementsByTagName('a');
    for (var j = 0; j < links.length; j++) {
      links[j].className = (links[j].getAttribute('data-b') === b) ? 'on' : '';
    }
  }
  pick.addEventListener('click', function(e){
    var t = e.target;
    while (t && t !== pick && !t.getAttribute('data-b')) t = t.parentNode;
    if (!t || t === pick) return;
    e.preventDefault();
    show(t.getAttribute('data-b'));
  });
  /* 默认就把「A12 及以上」那一档展开。
     之前这里是空白 —— 用户打开页面只看到两个机型按钮，不点就什么都没有，
     于是直接滑到底去点「下载」，然后就掉进 iOS 的「数据」文件坑里。
     内容先摆出来，让不想读的人也能看见按钮。 */
  show('new');
})();
</script></body></html>`;

      return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    }

    /* ---- /ios：给 iPhone 打开的自助安装页 ----
     * 为什么单独一页、不塞进 /download：
     *   iOS 的安装路径跟安卓/桌面**完全不是一回事** —— 安卓点一下装 apk，
     *   桌面点一下跑 exe，iOS 要先看系统版本、再选「巨魔 / 自签 / 主屏幕」
     *   三条路里的一条。把这段塞进那张通用下载列表里，只会让 iPhone 用户
     *   点一个装不上的按钮，然后以为软件坏了。
     *
     * 三条硬约束（同 /download）：
     *   ① 自包含 —— 不引任何 CDN；
     *   ② 实读磁盘 —— 有没有 IPA 看 data/app-update，发新包只换文件；
     *   ③ 复用 /api/app/ipa，不新造第二套下载逻辑。
     *
     * ⚠️ 必须插在 WEB_ASSET_RE 静态分支之前。 */
    if (p === '/ios' || p === '/ios/' || p === '/ios.html') {
      let hasIpa = false, ipaSize = '';
      try {
        const f = fs.readdirSync(RELEASE_DIR).filter(n => /\.ipa$/i.test(n)).sort().pop();
        if (f) {
          const st = fs.statSync(path.join(RELEASE_DIR, f));
          hasIpa = true;
          /* 100MB 以内按 MB 一位小数；不到 1MB 换成 KB —— 否则显示「0.0 MB」，
             像是个空文件。 */
          ipaSize = st.size >= 1048576
            ? (st.size / 1048576).toFixed(1) + ' MB'
            : Math.max(1, Math.round(st.size / 1024)) + ' KB';
        }
      } catch { /* 没有就没有 */ }

      const base = currentBase();
      /* ⚠️ 这里**不再提供「下载 IPA」**。
       *
       * 真实用户反馈（2026-10-19）：在 iPhone 上点「下载 IPA」，Safari 把它
       * 存成了「YMusic-3.7.23-unsigned 2 · 131 KB · 数据」—— 没有扩展名、
       * 归类叫「数据」。「文件」App 里打不开，分享给 TrollStore 也认不出来。
       * 这不是我们的响应头写错了（Content-Disposition 带 .ipa、
       * Content-Type 是 octet-stream，都对），是 iOS 根本没有 .ipa 这个 UTI：
       * Safari 下载未知类型时一律存成「数据」并抹掉后缀。
       *
       * 所以对已经装好巨魔的人，唯一可行的是 apple-magnifier:// 深链 ——
       * 由巨魔自己去 URLSession 下载，完全不经过 Safari 的下载管理器。
       * 没装巨魔的人点它没反应，那是预期的（页面下面第 1 步就是装巨魔）。 */
      const ipaBtn = hasIpa
        ? '<a class="btn" href="apple-magnifier://install?url='
            + encodeURIComponent(base.replace(/\/+$/, '') + '/api/app/ipa') + '">'
            + '已装巨魔？一键装 App（' + ipaSize + '）</a>'
          + '<p class="hint">点下去没反应 = 巨魔还没装好，或者巨魔 Settings 里没开 <b>URL 安装</b>。'
            + '手机上不要找「下载 IPA」这个按钮 —— iOS 会把 .ipa 存成一个没有扩展名的'
            + '「数据」文件，那是装不上的，别在那上面浪费时间。</p>'
        : '<a class="btn ghost" href="/ios/trollstore">先去装巨魔（跟包无关，可以先做）</a>';

      const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>YMusic for iOS · 安装</title>
<meta name="theme-color" content="#0A120D">
<meta name="apple-mobile-web-app-title" content="YMusic">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<style>
:root{--bg:#050806;--card:#0f1712;--line:#1e2b23;--txt:#e8f2ea;--sub:#8fa396;--acc:#25d07a}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;padding:calc(env(safe-area-inset-top) + 18px) 16px calc(env(safe-area-inset-bottom) + 28px);
  background:var(--bg);color:var(--txt);font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
  min-height:100vh;min-height:100dvh;-webkit-text-size-adjust:100%}
.wrap{max-width:560px;margin:0 auto}
header{text-align:center;padding:6px 0 16px}
.logo{width:62px;height:62px;border-radius:15px;display:block;margin:0 auto 10px}
h1{margin:0;font-size:21px;letter-spacing:.3px}
.sub{margin:5px 0 0;color:var(--sub);font-size:13px}
.banner{border-radius:12px;padding:12px 14px;font-size:13px;line-height:1.6;margin-bottom:16px;border:1px solid}
.banner.good{background:#0d1f14;border-color:#1d4a2c;color:#9fe7b8}
.banner.warn{background:#201a0d;border-color:#4a3c1d;color:#e8cf9f}
.banner.bad{background:#200f10;border-color:#4a1d20;color:#f0b0b3}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin-bottom:12px}
.card h2{margin:0 0 6px;font-size:16px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.n{font-style:normal;width:22px;height:22px;border-radius:50%;background:#14261c;border:1px solid #21472f;
  color:var(--acc);font-size:12px;font-weight:700;display:inline-flex;align-items:center;
  justify-content:center;flex:none}
.card h2 em{font-style:normal;font-size:11px;font-weight:400;color:var(--acc);
  background:#122019;border:1px solid #1d3a2a;padding:2px 8px;border-radius:20px;margin-left:auto}
.card h2 em.warn2{color:#e8cf9f;background:#1f1a0d;border-color:#4a3c1d}
.card p{margin:0 0 12px;color:var(--sub);font-size:13px}
a.btn{display:block;text-align:center;text-decoration:none;background:var(--acc);color:#04120a;
  font-weight:700;border-radius:12px;padding:14px;font-size:15px;-webkit-user-select:none}
a.btn:active{transform:scale(.985)}
a.btn.ghost{background:transparent;color:var(--txt);border:1px solid var(--line);font-weight:500;margin-top:10px}
a.btn.off{background:#1a2a22;color:#7b9486;pointer-events:none}
ol{margin:0;padding-left:20px;font-size:14px;color:var(--txt)}
ol li{margin-bottom:8px}
b{color:#d8f2e2;font-weight:600}
.steps{margin-top:12px;border-top:1px solid var(--line);padding-top:10px;font-size:13px;color:var(--sub)}
.steps[open]{padding-bottom:2px}
.steps summary{cursor:pointer;color:var(--acc);font-size:13px;outline:none;padding:2px 0;-webkit-tap-highlight-color:transparent}
.steps ol{margin:10px 0 0;color:var(--txt);font-size:13px;padding-left:18px}
.steps ol li{margin-bottom:7px}
.hint{margin:10px 0 0;font-size:12px;color:#7d9186;line-height:1.6}
.kv{font-size:12px;color:#6f8579;word-break:break-all}
footer{text-align:center;color:#5d7267;font-size:12px;padding:14px 0 6px;line-height:1.9}
/* 系统版本决定哪一块该出现在这个人眼前。
   17.0.1 起巨魔永久无解，还摆一块「巨魔安装」只会让人反复试 —— 直接换成一句
   说清楚原因的话，把注意力推回「加到主屏幕」和「自签」这两条真能走的路。 */
.only-no{display:none}
html.no-troll .only-no{display:block}
html.no-troll .only-ok{display:none}
html.no-troll #card-troll{border-color:#3a3120;background:#141208}
</style></head><body><div class="wrap">
<header><img class="logo" src="/logo-mark.svg" alt="">
<h1>YMusic for iOS</h1>
<p class="sub">音乐搜索 · 试听 · 下载</p></header>

<div id="verdict" class="banner">正在认你的系统版本…</div>
<div id="act" style="margin:0 0 14px"></div>

<section class="card">
  <h2><i class="n">1</i>加到主屏幕<em>推荐 · 30 秒</em></h2>
  <p>不用装 App、不用 Apple ID、不占签名名额。主屏幕上多一个图标，点开就是全屏的 YMusic，
  服务器一更新它自动就是最新的。</p>
  <a class="btn" href="/api/app/webclip.mobileconfig">一键加到主屏幕</a>
  <details class="steps"><summary>点完之后的三步</summary><ol>
    <li>底部会弹出「此网站正尝试下载一个配置描述文件」→ 点 <b>允许</b>。</li>
    <li>打开「设置」，最上面出现 <b>已下载描述文件</b> → 点进去 → 右上角 <b>安装</b>（要输一次锁屏密码）。</li>
    <li>回到主屏幕，往后翻一页，图标已经在那儿了。</li>
  </ol>
  <p class="hint">系统提示「未签名」是正常的 —— 这个描述文件只是往桌面放一个快捷方式，
  里面没有任何可执行代码，随时可在「设置 → 通用 → VPN 与设备管理」里删掉。</p></details>
  <details class="steps"><summary>不想装描述文件？手动加也一样</summary><ol>
    <li>用 <b>Safari</b> 打开本站。<b>微信里打不开这个菜单</b> —— 点右上角「…」→「在 Safari 中打开」。</li>
    <li>点底部中间的 <b>分享</b> 按钮（方框 + 向上箭头）。</li>
    <li>往下滑，选 <b>添加到主屏幕</b> → 右上角「添加」。</li>
  </ol></details>
</section>

<section class="card" id="card-troll">
  <h2><i class="n">2</i>巨魔安装<em class="only-ok">永久签名</em><em class="warn2 only-no">你这台用不了</em></h2>
  <div class="only-ok">
    <p>TrollStore 借 CoreTrust 的漏洞给 App 做永久签名，装一次就一直在，不用 7 天续签、
    也不用登录 Apple ID。只支持 <b>iOS 14.0b2 – 16.6.1 / 16.7 RC / 17.0</b>。</p>
    ${ipaBtn}
    <a class="btn ghost" href="/ios/trollstore">还没装巨魔？看一步步的装法</a>
    <details class="steps"><summary>顺序不能反</summary><ol>
      <li><b>先有巨魔，这个按钮才有用。</b>巨魔装好后回到本页，点上面那个绿色按钮，
          浏览器会直接跳进巨魔开始装，全程不用下载任何文件。</li>
      <li>巨魔的 Settings 里把 <b>URL 安装</b> 那个开关打开，按钮才会生效。</li>
      <li>装完在巨魔里点 <b>Install Persistence Helper</b>，
          否则系统刷新图标缓存后 App 会打不开。</li>
    </ol></details>
  </div>
  <div class="only-no">
    <p><b>你这台不用看这一块了。</b>巨魔靠的是 iOS 签名校验里的一个漏洞，
    苹果在 <b>17.0.1</b> 把它补上了 —— 不是「还没做出来」，是<b>永远不会有</b>。
    17.0 是最后一版能装的，之后 17.x、18.x、26.x 全都不行。</p>
    <p class="hint">但它只影响「装成桌面上的真 App」这件事。<b>YMusic 本身照常能用</b> ——
    用上面第 1 块「加到主屏幕」，功能和装 App 完全一样（同一套页面、同一套播放器）。
    真想要桌面图标，看下面第 3 块自签。</p>
  </div>
</section>

<section class="card">
  <h2><i class="n">3</i>自签安装<em>7 天续一次</em></h2>
  <p>系统不在巨魔范围（17.0.1 以上），或者不想折腾巨魔，可以用 AltStore / Sideloadly
  拿自己的 Apple ID 签一次。免费账号 7 天过期，重签不丢数据。</p>
  ${hasIpa ? '<a class="btn ghost" href="/api/app/ipa">用电脑打开这个链接下载 IPA</a>'
    : '<a class="btn ghost" href="/ios/trollstore">看巨魔 / 自签的完整步骤</a>'}
  <details class="steps"><summary>自签要注意什么？</summary><ol>
    <li><b>这一步必须在电脑上做。</b>Sideloadly / AltStore 都是电脑软件，
        把上面那个链接在电脑浏览器里打开、存成 .ipa，再拖进 Sideloadly。
        手机上直接点它只会得到一份没扩展名的「数据」，用不上。</li>
    <li>免费 Apple ID 最多同时签 3 个 App，7 天要连回电脑续一次，否则打不开。</li>
    <li>续签不丢数据 —— 收藏、下载的歌都还在。</li>
  </ol></details>
</section>

<section class="card">
  <h2>常见问题</h2>
  <details class="steps" style="border-top:0;padding-top:0"><summary>下载的歌存到哪了？</summary><ol>
    <li>在 YMusic 里点「存到本机」，弹出系统分享表时选 <b>存储到文件</b>。</li>
    <li>位置：<b>文件 → 我的 iPhone → YMusic</b>（页面上那个是网页版的位置；装了我们壳的 App 会直接在 YMusic 文件夹里）。</li>
    <li>想用别的播放器打开，就在「文件」里长按那首歌 → 共享。</li>
  </ol></details>
  <details class="steps"><summary>下载列表里出现一个「131 KB · 数据」，装不上？</summary><ol>
    <li>那个文件<b>就是我们的 IPA，但它已经废了</b> —— iOS 不认 .ipa 这个类型，
        Safari 下载时把它当成未知二进制，存成了没有扩展名的「数据」。
        双击、分享、拖进巨魔，全都不会成功。可以长按删掉它。</li>
    <li><b>正确的做法</b>：本页第 2 块那个绿色按钮 —— 它走的是
        <b>apple-magnifier://</b> 深链，让巨魔自己去下载，完全不经过 Safari 的下载管理器。</li>
    <li>按钮点了没反应，说明巨魔还没装好（或没开 URL 安装）。
        那就先回本页第 2 步把巨魔装上 —— 顺序是「先巨魔，后装 App」，
        反过来一定卡在这个「数据」文件上。</li>
  </ol></details>
  <details class="steps"><summary>下载了 IPA，具体怎么装进去？</summary><ol>
    <li><b>已经装好巨魔</b>：回到本页第 2 块，点绿色按钮，从浏览器一步跳进巨魔。
        真的已经下载到「文件」里了，就在那儿点它 → 左下角分享 → 选 <b>TrollStore</b>。</li>
    <li><b>还没装巨魔</b>：先按上面第 2 步把巨魔装上（大概 15 分钟），再回来点按钮。</li>
    <li><b>系统在 17.0.1 以上</b>：巨魔用不了，改用 Sideloadly / AltStore
        在电脑上签一次，同样是这个 IPA。7 天到期重签一次，数据不丢。</li>
  </ol></details>
  <details class="steps"><summary>为什么 App Store 里搜不到？</summary><ol>
    <li>这类「搜歌 + 下载」的工具过不了 App Store 审核，全球都一样，不是我们不上架。</li>
    <li>所以只有三条路：巨魔（永久）、自签（7 天）、加到主屏幕（不用签名）—— 上面三块就是这三条。</li>
  </ol></details>
  <details class="steps"><summary>图标点开还是有地址栏 / 一片白？</summary><ol>
    <li>有一点地址栏是正常的：网页版永远是浏览器在渲染，只是把工具栏收起来了。</li>
    <li>一片白一般是服务没起。先回主屏幕，用 Safari 直接访 <span class="kv">${base}</span> 试试。</li>
    <li>还是不行就删掉图标重加一次 —— 旧图标可能记着已经换掉的地址。</li>
  </ol></details>
</section>

<footer>iPhone 上下载 → 系统分享表「存储到文件」<br>文件 App → 我的 iPhone → YMusic</footer>
</div>
<script>
(function(){
  var ua = navigator.userAgent || '';
  /* ⚠️ 必须取到第三段。iOS 17.0.1 的 UA 里写的是「OS 17_0_1」，
     老的 /OS (\d+)[._](\d+)/ 只吃到 17_0 就停 —— 于是 17.0.1 被当成 17.0，
     把「能装巨魔」的结论给了一个永远装不上的系统。17.0.1 正好是硬分界线，
     这个坑踩不得。 */
  var m = /OS (\\d+)[._](\\d+)(?:[._](\\d+))?/.exec(ua);
  /* iPadOS 13+ 默认发 Macintosh UA，里面只有 Version/17.0 这种 Safari 版本号。
     用 maxTouchPoints 确认是触屏 Mac（= iPad）之后才拿 Version 兜底，
     免得把真 Mac 也判成 iOS。 */
  if (!m && /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1) {
    m = /Version\\/(\\d+)\\.(\\d+)(?:\\.(\\d+))?/.exec(ua);
  }
  var box = document.getElementById('verdict'), txt = '', cls = 'warn';
  /* trollOk：这台机器的系统版本到底能不能装巨魔。
     14.0b2 – 16.6.1 / 16.7 RC（20H18）/ 17.0 —— 这里按主版本粗判，
     16.7 的 RC 与正式版在 UA 里完全一样，分不出来，所以 16.7 保守算「不行」，
     页面上另有说明让用户自己对括号里的版本号。 */
  var trollOk = false;
  if (!m) {
    txt = '认不出这是哪一代 iOS —— 去「设置 → 通用 → 关于本机」看版本号。';
  } else {
    var a = +m[1], b = +m[2], c = m[3] ? +m[3] : 0;
    trollOk = (a === 14) || (a === 15) || (a === 16 && b < 7) || (a === 17 && b === 0 && c === 0);
    if (a < 14) {
      txt = 'iOS ' + a + '.' + b + '：低于 14，装不了巨魔，走上面「加到主屏幕」最省事。';
    } else if (a > 17 || (a === 17 && (b > 0 || c > 0))) {
      /* 同上：对 18 / 26 / 27 别只说 17.0.1，直接讲「你这一代」 */
      txt = 'iOS ' + a + '.' + b + (c ? '.' + c : '') + '：巨魔在你这一代早就没了'
        + (a >= 18
            ? '（苹果从 17.0.1 起就把它依赖的漏洞补了，18 / 26 / 27 一样没戏）'
            : '（17.0.1 把它依赖的漏洞补了）')
        + '，但 YMusic 不受影响 —— 用下面第 1 块加到主屏幕就行。';
      cls = 'bad';
    } else if (a === 16 && b === 7) {
      txt = 'iOS 16.7：只有 RC 版（20H18）能装巨魔，正式版不行 —— 核对关于本机里括号中的版本号。';
    } else if (a === 17) {
      txt = 'iOS 17.0：这是最后一版能装巨魔的（17.0.1 起就不行了）。';
      cls = 'good';
    } else {
      txt = 'iOS ' + a + '.' + b + '：在巨魔支持范围内（14.0b2 – 16.6.1 / 16.7 RC / 17.0）。';
      cls = 'good';
    }
  }
  box.className = 'banner ' + cls;
  box.textContent = txt;

  /* 17.0.1 起巨魔永久无解 —— 把第 2 块整块换成「为什么没有」，别让人反复试。 */
  if (!trollOk) document.documentElement.className += ' no-troll';

  /* 认完版本直接把「下一步点哪个」摆出来 —— 大部分人（包括刚才那位）
     卡在「页面给了三条路，我该点哪条」，而不是卡在某一步不会做。 */
  var act = document.getElementById('act');
  if (act) {
    function mk(href, text, ghost, mt) {
      var el = document.createElement('a');
      el.className = 'btn' + (ghost ? ' ghost' : '');
      el.href = href;
      el.textContent = text;
      if (mt) el.style.marginTop = mt;
      return el;
    }
    var lead = document.createElement('p');
    lead.className = 'hint';
    lead.style.margin = '0 0 10px';
    lead.textContent = '按你的系统，现在最该做的是：';
    act.appendChild(lead);
    act.appendChild(mk('/api/app/webclip.mobileconfig', '① 现在就能用 · 加到主屏幕（30 秒）'));
    act.appendChild(mk('/ios/trollstore',
      trollOk ? '② 想要真 App · 去装巨魔（约 15 分钟）' : '② 想装真 App · 只能自签（要电脑）',
      true, '10px'));
  }
})();
</script></body></html>`;

      return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    }

    /* /get —— 给人念的短链接，跳到教程页 */
    if (p === '/get' || p === '/get/') {
      return send(res, 302, '', { Location: '/guide', 'Cache-Control': 'no-cache' });
    }

    /* ---- /guide：全端安装教程 ----
     * 为什么要有这一页：/download 只解决「把文件给你」，但一大半人卡在
     * 拿文件之后 —— 安卓的「未知来源」、Windows 的「已保护你的电脑」、
     * iPhone 的「添加到主屏幕」。这些步骤写在聊天里发一次就散一次，
     * 写成一页、发一个链接，谁问都指过来。
     *
     * 三条约束跟 /download 一致：自包含（不引 CDN）、实读磁盘（没有的端
     * 就不给按钮）、复用已有下发接口（不新造第二套）。
     */
    if (p === '/guide' || p === '/guide/' || p === '/help' || p === '/install') {
      const esc = s => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const base = currentBase();
      /* 有包才给按钮。灰按钮比死链好，比「点了 404」好得多。 */
      let hasApk = false, hasExe = false, hasHap = false, hasIpa = false;
      try { hasApk = !!readApkMeta(APK_META, '/api/app/apk'); } catch { /* ignore */ }
      try {
        const mf = readJSON(RELEASE_MANIFEST, null) || {};
        const ex = (mf && typeof mf.exe === 'object' && mf.exe) ? mf.exe : {};
        const rel = String(ex.file || 'YMusic.exe').replace(/\\/g, '/').replace(/^\/+/, '');
        hasExe = !rel.includes('..') && fs.existsSync(path.join(RELEASE_DIR, rel));
      } catch { /* ignore */ }
      try { hasHap = fs.readdirSync(RELEASE_DIR).some(n => /\.hap$/i.test(n)); } catch { /* ignore */ }
      try { hasIpa = fs.readdirSync(RELEASE_DIR).some(n => /\.ipa$/i.test(n)); } catch { /* ignore */ }

      const btn = (href, text, cls) => href
        ? '<a class="btn' + (cls ? ' ' + cls : '') + '" href="' + esc(href) + '">' + esc(text) + '</a>'
        : '<a class="btn off">' + esc(text) + '</a>';

      const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>YMusic · 安装教程</title>
<meta name="theme-color" content="#f5f6f8">
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;padding:calc(env(safe-area-inset-top) + 14px) 14px calc(env(safe-area-inset-bottom) + 28px);
  background:#f5f6f8;color:#1c1c1e;font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-text-size-adjust:100%}
.wrap{max-width:720px;margin:0 auto}
.hero{background:#0a120d;color:#e8f2ea;border-radius:16px;padding:20px 18px;margin-bottom:14px}
.hero h1{margin:0;font-size:20px;letter-spacing:.3px}
.hero p{margin:6px 0 0;color:#8fa396;font-size:13px}
.hero .addr{margin-top:12px;background:#0f1712;border:1px solid #1e2b23;border-radius:10px;
  padding:9px 11px;font-size:12px;color:#9fd8b6;word-break:break-all}
.nav{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
.nav a{font-size:13px;text-decoration:none;color:#1c1c1e;background:#fff;border:1px solid #e3e5e9;
  border-radius:20px;padding:6px 12px}
.sec{background:#fff;border:1px solid #e3e5e9;border-radius:14px;padding:16px;margin-bottom:12px}
.sec h2{font-size:16px;margin:0 0 2px;display:flex;align-items:center;gap:8px}
.sec h2 span{font-size:11px;font-weight:400;color:#1a7f4b;background:#eaf7f0;border:1px solid #cfeadd;
  border-radius:20px;padding:2px 8px;margin-left:auto}
.lead{font-size:13px;color:#6b7078;margin:6px 0 12px}
ol{margin:0;padding-left:20px;font-size:14px}
ol li{margin-bottom:9px}
b{font-weight:600}
.btn{display:block;text-align:center;background:#1a73e8;color:#fff;text-decoration:none;
  border-radius:10px;padding:12px;font-size:15px;font-weight:600;margin-top:4px}
.btn:active{background:#1663c7}
.btn.ghost{background:#fff;color:#1c1c1e;border:1px solid #d8dbe0;font-weight:500}
.btn.off{background:#eceef1;color:#9aa0a8;pointer-events:none;font-weight:500}
.btn+.btn{margin-top:8px}
.warn{background:#fff8e6;border:1px solid #ffe2a8;border-radius:10px;padding:10px 12px;
  font-size:12.5px;color:#7a5b12;line-height:1.65;margin:12px 0 0}
code{background:#f0f2f5;border:1px solid #e3e5e9;border-radius:5px;padding:1px 5px;font-size:12.5px}
.faq{margin-top:16px}
details{background:#fff;border:1px solid #e3e5e9;border-radius:12px;padding:12px 14px;margin-bottom:8px}
details summary{cursor:pointer;font-size:14px;font-weight:500;outline:none}
details p{margin:8px 0 0;font-size:13.5px;color:#55595f;line-height:1.75}
footer{text-align:center;color:#9aa0a8;font-size:12px;padding:14px 0 4px;line-height:1.8}
</style></head><body><div class="wrap">

<div class="hero">
  <h1>YMusic 安装教程</h1>
  <p>按你手上的设备，找到那一段，跟着点就行</p>
  <div class="addr">${esc(base)}</div>
</div>

<div class="nav">
  <a href="#ios">iPhone / iPad</a>
  <a href="#android">安卓</a>
  <a href="#harmony">鸿蒙</a>
  <a href="#win">Windows</a>
  <a href="#web">只在浏览器用</a>
</div>

<section class="sec" id="ios">
  <h2>iPhone / iPad<span>3 条安装路线</span></h2>
  <p class="lead">iOS 没法像安卓那样点一下装 APK，只有三条路。系统版本决定你能走哪条 ——
  打开那页会自动认你的版本，直接告诉你选哪个。</p>
  <ol>
    <li><b>加到主屏幕</b>（推荐）：不用装 App、不用 Apple ID，30 秒。桌面上多个图标，点开全屏。</li>
    <li><b>巨魔 TrollStore</b>：只有 iOS 14.0b2 – 16.6.1 / 16.7 RC / 17.0 能用，永久签名。</li>
    <li><b>自签</b>（AltStore / Sideloadly）：任何版本都能用，7 天要连电脑续一次。</li>
  </ol>
  ${btn('/api/app/webclip.mobileconfig', '一键加到主屏幕（30 秒，不用签名）')}
  ${btn('/ios', '想装成真 App？打开 iOS 安装页（自动识别版本）', 'ghost')}
</section>

<section class="sec" id="android">
  <h2>安卓手机 / 平板<span>点一下就能装</span></h2>
  <p class="lead">下载 APK，装上就能用。第一次装会提示「未知来源」，允许一次就好。</p>
  <ol>
    <li>点下面的按钮下载。下载完在通知栏或「文件管理 → 下载」里点它。</li>
    <li>系统提示「为了安全，你的手机不允许安装未知应用」→ 点 <b>设置</b> → 打开
        <b>允许来自此来源</b>（不同品牌叫法略有差别，有的写「允许安装未知应用」）。</li>
    <li>回到安装界面点 <b>安装</b>。如果弹出「Play 保护机制已阻止」，点 <b>仍要安装</b>。</li>
    <li>装完打开，登录同一个账号，收藏和下载记录会跟着账号走。</li>
  </ol>
  ${btn(hasApk ? '/api/app/apk' : '', hasApk ? '下载安卓版 APK' : '安卓包准备中')}
  <div class="warn">装完如果闪退：多半是系统把「自启动 / 后台活动」关了。
  去 设置 → 应用 → YMusic → 电池，选「不限制」，否则后台下载会被杀。</div>
</section>

<section class="sec" id="harmony">
  <h2>鸿蒙手机<span>暂时用网页版</span></h2>
  <p class="lead">鸿蒙原生安装包（HAP）还在做。现在有两条能用的路，都不影响你听歌和下载。</p>
  <ol>
    <li><b>装安卓版 APK</b>：HarmonyOS 4 及以下可以直接装（鸿蒙 NEXT 不行）。</li>
    <li><b>加到桌面</b>：用自带浏览器打开本站 → 菜单里选「添加到桌面」，
        图标和 App 一样，点开是全屏的。</li>
  </ol>
  ${btn('/', '用浏览器打开并加到桌面')}
  ${hasHap ? btn('/api/app/hap', '下载鸿蒙安装包（HAP）', 'ghost') : ''}
</section>

<section class="sec" id="win">
  <h2>Windows 电脑<span>一个 exe 搞定</span></h2>
  <p class="lead">免安装绿色包，双击就跑，不用装运行库。</p>
  <ol>
    <li>点下面的按钮下载 <code>.exe</code>（一百多 MB，慢是正常的）。</li>
    <li>第一次打开时 Windows 可能拦一下：点 <b>更多信息</b> → <b>仍要运行</b>。
        这是没有买代码签名的必然结果，不是文件损坏。</li>
    <li>想放到桌面就在 exe 上右键 → 发送到 → 桌面快捷方式。</li>
    <li>下载的歌默认在「下载」文件夹，可以在设置里换成别的目录。</li>
  </ol>
  ${btn(hasExe ? '/api/app/exe' : '', hasExe ? '下载 Windows 桌面版' : '桌面版准备中')}
</section>

<section class="sec" id="web">
  <h2>什么都不装<span>打开就能用</span></h2>
  <p class="lead">搜索、试听、收藏、下载全都在网页里。电脑上是完整界面，手机上是竖屏版。</p>
  ${btn('/', '直接打开 YMusic')}
  <p class="lead" style="margin:12px 0 0">想让它看起来像个 App：手机浏览器菜单里选「添加到主屏幕 / 添加到桌面」，
  电脑 Chrome / Edge 地址栏右边有个安装图标，点一下也是独立窗口。</p>
</section>

<div class="faq">
  <details><summary>下载的歌存在哪？</summary>
    <p>安卓：<b>文件管理 → 下载</b>（或设置里指定的目录）。<br>
    Windows：<b>下载</b> 文件夹，桌面版设置里能看到确切路径。<br>
    iPhone：下载时选「存储到文件」→ <b>文件 → 我的 iPhone</b>。</p></details>
  <details><summary>为什么提示「不安全 / 未签名 / 已阻止」？</summary>
    <p>这些都是同一件事：安装包没有花钱买商业代码签名证书。安卓的「未知来源」、
    Windows 的 SmartScreen、iOS 的「未签名」都是它。文件本身是完整的，
    按上面每段里的提示允许一次即可。</p></details>
  <details><summary>能多台设备一起用吗？</summary>
    <p>可以。同一个账号在手机、电脑、网页上登录，收藏和播放记录是同步的；
    下载记录按设备分开，各存各的。</p></details>
  <details><summary>打不开页面 / 一直转圈</summary>
    <p>先确认地址没抄错：<code>${esc(base)}</code>。还是不行就是服务没起，
    找管理员重启一次。别用公司内网或校园网，有些会拦非 80 端口的站点。</p></details>
</div>

<footer>YMusic · 一个地址，四端通用<br>把这一页存成书签，换设备时不用再问人</footer>
</div></body></html>`;

      return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    }

    /* ---- /download：给手机直接打开的自助下载页 ----
     * 为什么要它：3.6.13 救援包要发到用户手里，而原来承担分发任务的引导页
     * 发布通道已经死了，不能再指望它。这个页面由服务端自己提供，
     * 服务在，页面就在。
     *
     * 三条硬要求，都是为了「在一个可能连不上外网的手机上也能用」：
     *  ① 自包含 —— 不外链任何 CDN / CSS / JS，样式全部内联；
     *  ② 实读磁盘 —— 版本、大小、说明都从文件里读，发新包只换文件、不碰代码；
     *  ③ 复用已有下发路由 —— 不新造第二套下载逻辑，省得两边口径不一致。
     *
     * ⚠️ 必须插在 WEB_ASSET_RE 静态资源分支之前：那条分支按前缀匹配，
     *    放后面会被它吃掉（先 404 然后永远走不到这里）。 */
    if (p === '/download' || p === '/download/') {
      const mb = n => (Number(n) > 0 ? (Number(n) / 1048576).toFixed(1) + ' MB' : '');
      const esc = s => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      /* 时间戳可能带 'T' 和微秒，手机上不需要那么长，截到「年-月-日 时:分」 */
      const when = v => {
        const s = String(v || '');
        if (!s) return '';
        return s.slice(0, 16).replace('T', ' ');
      };
      /* exe / hap 没有元数据文件，只能拿文件的 mtime。
       * ⚠️ 不能用 toISOString()：那是 UTC，会比本地时间早 8 小时，
       *    和 APK 元数据里那个本地时间并排显示，看起来像「桌面版早半天发的」。 */
      const whenFile = d => {
        const p = n => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
          + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
      };
      const cards = [];

      const apk = readApkMeta(APK_META, '/api/app/apk');
      if (apk) cards.push({
        name: 'YMusic 安卓版', tag: 'Android · 手机 / 平板', href: apk.url,
        ver: apk.versionName, size: mb(apk.size), at: when(apk.at), note: apk.note,
        btn: '下载安卓版 APK', help: '/guide#android', helpText: '怎么装到安卓上？'
      });
      const adm = readApkMeta(ADMIN_APK_META, '/api/app/admin-apk');
      if (adm) cards.push({
        name: 'YMusic 管理台（安卓）', tag: 'Android · 仅管理员', href: adm.url,
        ver: adm.versionName, size: mb(adm.size), at: when(adm.at), note: adm.note,
        btn: '下载管理台 APK', help: '/guide#android', helpText: '安装步骤跟安卓版一样'
      });
      /* exe 不走 readExeMeta()：那个函数要读 89MB 算 md5，
       * 下载页不需要 md5，为它扛一次 90MB 的堆峰值不值得。 */
      try {
        const mf = readJSON(RELEASE_MANIFEST, null) || {};
        const ex = (mf && typeof mf.exe === 'object' && mf.exe) ? mf.exe : {};
        const rel = String(ex.file || 'YMusic.exe').replace(/\\/g, '/').replace(/^\/+/, '');
        const fp = path.join(RELEASE_DIR, rel);
        if (!rel.includes('..') && fs.existsSync(fp)) {
          const st = fs.statSync(fp);
          cards.push({
            name: 'YMusic 桌面版', tag: 'Windows · .exe', href: '/api/app/exe',
            ver: String(ex.version || mf.version || APP_VERSION),
            size: mb(st.size), at: whenFile(st.mtime),
            note: String(ex.note || mf.note || '修复已知问题，提升使用体验'),
            btn: '下载桌面版 .exe', help: '/guide#win', helpText: '被 Windows 拦了怎么办？'
          });
        }
      } catch { /* 读不到就不列这一块，别让整页挂掉 */ }
      /* 鸿蒙：data/app-update 下第一个 .hap。目前还没有这一端，没有就不显示。 */
      try {
        const hap = fs.readdirSync(RELEASE_DIR).filter(n => /\.hap$/i.test(n)).sort().pop();
        if (hap) {
          const st = fs.statSync(path.join(RELEASE_DIR, hap));
          cards.push({
            name: 'YMusic 鸿蒙版', tag: 'HarmonyOS · .hap', href: '/api/app/hap',
            ver: hap.replace(/\.hap$/i, ''), size: mb(st.size),
            at: whenFile(st.mtime), note: '鸿蒙端安装包',
            btn: '下载鸿蒙版 HAP', help: '/guide#harmony', helpText: '鸿蒙怎么装？'
          });
        }
      } catch { /* 同上 */ }
      /* iOS：跟别的端**不一样**，这里永远给一行 ——
         安卓/桌面点一下就是文件，iOS 点一下只是开始（要选巨魔 / 自签 / 主屏幕）。
         所以：
           · 用 iPhone 打开这一页 → 第一张卡就是「一键加到主屏幕」，
             这是全站唯一一个「在 iPhone 上点一下真能装出图标」的动作；
           · 用电脑打开 → 描述文件没用，只给教程入口；
           · 有 .ipa 时把版本堆进 note，让人知道有包。 */
      const uaStr = String(req.headers['user-agent'] || '');
      const uaIos = /iPhone|iPad|iPod/i.test(uaStr)
        || (/Macintosh/i.test(uaStr) && /Mobile/i.test(uaStr));
      try {
        const ipa = fs.readdirSync(RELEASE_DIR).filter(n => /\.ipa$/i.test(n)).sort().pop();
        let iosCard;
        if (ipa) {
          const st = fs.statSync(path.join(RELEASE_DIR, ipa));
          const abs = currentBase().replace(/\/+$/, '') + '/api/app/ipa';
          iosCard = {
            name: 'YMusic iOS 版', tag: 'iPhone / iPad · 30 秒，不用签名',
            href: '/api/app/webclip.mobileconfig',
            ver: ipa.replace(/\.ipa$/i, ''), size: mb(st.size),
            at: whenFile(st.mtime),
            /* ⚠️ 主按钮**不能**是「下载 IPA」。
               iOS 的 Safari 不认识 .ipa 这个类型，下载后只会把它存成一个
               没有扩展名的「数据」文件（下载列表里能看到 131 KB 的那个就是），
               「文件」App 里也打不开、分享给巨魔也认不出来 —— 用户走这条路
               100% 装不上，还白占一次下载。所以主按钮改成真正能成的描述文件，
               IPA 只留给「已经装好巨魔」的人走 apple-magnifier:// 深链。 */
            note: '点「一键加到主屏幕」→ 允许 → 设置里点安装，桌面就多一个图标。'
              + '已经装好巨魔的，点下面那行直接跳进巨魔装 App。',
            btn: '一键加到主屏幕',
            link2: {
              href: 'apple-magnifier://install?url=' + encodeURIComponent(abs),
              text: '已装巨魔？从浏览器直接装 App'
            },
            help: '/ios', helpText: '想装成真 App？看三条路线'
          };
        } else if (uaIos) {
          iosCard = {
            name: 'YMusic iOS 版', tag: 'iPhone / iPad · 不用签名', href: '/api/app/webclip.mobileconfig',
            note: '点按钮 → 允许下载描述文件 → 设置里点「安装」，桌面上就多一个图标，点开全屏用',
            btn: '一键加到主屏幕', plain: true,
            help: '/ios', helpText: '想装成真 App？看另外两条路'
          };
        } else {
          iosCard = {
            name: 'YMusic iOS 版', tag: 'iPhone / iPad · 免签名 / 巨魔 / 自签', href: '/ios',
            note: 'iOS 点一下装不了 —— 三条安装路线（含不用签名的「加到主屏幕」）都写在这一页里',
            btn: '打开 iOS 安装页', plain: true, help: '/guide#ios', helpText: '三条路线怎么选？'
          };
        }
        if (uaIos) cards.unshift(iosCard); else cards.push(iosCard);
      } catch { /* 同上 */ }

      const base = currentBase();
      const html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<title>YMusic 下载</title><style>'
        + '* { box-sizing: border-box; }'
        + 'body { margin: 0; padding: 16px 12px 32px; background: #f5f6f8; color: #1c1c1e;'
        + ' font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;'
        + ' -webkit-text-size-adjust: 100%; }'
        + '.wrap { max-width: 760px; margin: 0 auto; }'
        + 'h1 { font-size: 20px; margin: 4px 0 10px; }'
        + '.srv { background: #fff; border: 1px solid #e3e5e9; border-radius: 10px;'
        + ' padding: 12px 14px; margin-bottom: 14px; font-size: 13px; line-height: 1.6; }'
        + '.srv b { word-break: break-all; font-size: 14px; }'
        + '.srv small { color: #8a8f98; display: block; margin-top: 4px; }'
        + '.grid { display: grid; grid-template-columns: 1fr; gap: 12px; }'
        + '@media (min-width: 620px) { .grid { grid-template-columns: 1fr 1fr; } }'
        + '.card { background: #fff; border: 1px solid #e3e5e9; border-radius: 12px;'
        + ' padding: 14px; display: flex; flex-direction: column; }'
        + '.card h2 { font-size: 15px; margin: 0 0 2px; }'
        + '.tag { font-size: 12px; color: #8a8f98; margin-bottom: 10px; }'
        + '.row { font-size: 13px; color: #55595f; line-height: 1.7; }'
        + '.row span { color: #8a8f98; display: inline-block; width: 4.2em; }'
        + '.note { font-size: 12px; color: #6b7078; margin: 10px 0 12px;'
        + ' padding-top: 10px; border-top: 1px dashed #e3e5e9; line-height: 1.6; flex: 1; }'
        + '.btn { display: block; text-align: center; background: #1a73e8; color: #fff;'
        + ' text-decoration: none; border-radius: 8px; padding: 11px 0; font-size: 15px; }'
        + '.btn:active { background: #1663c7; }'
        + '.btn.plain { background: #0a7a45; }'
        + '.btn.plain:active { background: #086838; }'
        + '.help { display: block; text-align: center; margin-top: 8px; font-size: 13px;'
        + ' color: #1a73e8; text-decoration: none; }'
        + '.help:active { opacity: .6; }'
        + '.toplink { display: block; background: #eaf7f0; border: 1px solid #cfeadd; color: #12673c;'
        + ' text-decoration: none; border-radius: 10px; padding: 11px 14px; font-size: 13.5px;'
        + ' margin-bottom: 14px; line-height: 1.6; }'
        + '.toplink b { font-weight: 600; }'
        + '.tip { margin: 18px 0 0; font-size: 12px; color: #8a8f98;'
        + ' text-align: center; line-height: 1.6; }'
        + '</style></head><body><div class="wrap">'
        + '<h1>YMusic 下载</h1>'
        + '<a class="toplink" href="/guide">第一次装？<b>点这里看分步图文教程</b> —— '
        + '安卓、Windows、iPhone / iPad、鸿蒙各一段，照着点就行</a>'
        + '<div class="srv">当前服务地址<br><b>' + esc(base) + '</b>'
        + '<small>如果这个地址打不开，说明服务没起，联系管理员</small></div>'
        + '<div class="grid">'
        + cards.map(c => '<div class="card"><h2>' + esc(c.name) + '</h2>'
          + '<div class="tag">' + esc(c.tag) + '</div>'
          + '<div class="row">'
          + (c.ver ? '<div><span>版本</span>' + esc(c.ver) + '</div>' : '')
          + (c.size ? '<div><span>大小</span>' + esc(c.size) + '</div>' : '')
          + (c.at ? '<div><span>更新</span>' + esc(c.at) + '</div>' : '')
          + '</div>'
          + (c.note ? '<div class="note">' + esc(c.note) + '</div>' : '<div class="note"></div>')
          + '<a class="btn' + (c.plain ? ' plain' : '') + '" href="' + esc(c.href) + '">'
          + esc(c.btn || '下载') + '</a>'
          + (c.link2 ? '<a class="help" href="' + esc(c.link2.href) + '">' + esc(c.link2.text) + '</a>' : '')
          + (c.help ? '<a class="help" href="' + esc(c.help) + '">' + esc(c.helpText || '怎么装？') + '</a>' : '')
          + '</div>').join('')
        + '</div>'
        + '<p class="tip">每一行的「怎么装」都写了分步说明 · '
        + '安卓提示「未知来源」时，在系统设置里允许本浏览器安装应用</p>'
        + '</div></body></html>';
      /* no-cache 而不是长缓存：包会更新，页面缓存住了就永远看不到新版。 */
      return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    }
    if (WEB_ASSET_RE.test(p)) {
      const rel = p.slice(1);
      const body = readWeb(rel);
      if (body == null) return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      const headers = { 'Content-Type': MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream' };
      // Service Worker 与入口 HTML 绝不能长缓存，否则更新发不出去
      headers['Cache-Control'] = NO_CACHE_ASSET.has(rel) ? 'no-cache' : 'public, max-age=3600';
      return send(res, 200, body, headers);
    }

    /* ---- 下载任务（服务端跑，与浏览器播放解耦） ---- */
    if (p === '/api/task' && req.method === 'POST') {
      if (!userOf(req)) return denyGuest(res, '下载');
      const b = await readBody(req);
      if (!b.url) return sendJSON(res, { ok: false, error: '缺少 url' });
      /* 这个 url 是客户端给的，服务端会 fetch 它并落盘 —— 与 /api/proxy 同一条 SSRF 面 */
      const tg = await netGate(b.url);
      if (!tg.ok) { netDeny('/api/task', b.url, tg.why); return sendJSON(res, { ok: false, error: '这个地址不允许下载：' + tg.why }, 403); }
      const t = {
        id: 't' + (++TASK_SEQ) + '_' + Date.now().toString(36),
        name: b.name || '未命名', singer: b.singer || '', source: b.source || '',
        sourceName: b.sourceName || '', quality: b.quality || '', ext: b.ext || 'mp3',
        url: b.url, lyric: b.lyric || '',
        naming: b.naming || 'song-singer',
        force: !!b.force,          // 明确要「重下一份」时才拿掉去重
        dir: (b.dir || '').trim() || CFG.downloadDir,
        status: 'queued', received: 0, total: Number(b.size) || 0,
        path: '', error: '', startedAt: 0, endedAt: 0,
        controller: new AbortController()
      };
      TASKS.set(t.id, t);
      pumpTasks();
      return sendJSON(res, { ok: true, task: taskPublic(t) });
    }
    if (p === '/api/tasks') {
      return sendJSON(res, { ok: true, list: [...TASKS.values()].map(taskPublic), dir: CFG.downloadDir, concurrency: TASK_MAX_CONCURRENCY });
    }
    if (p === '/api/task' && req.method === 'DELETE') {
      const t = TASKS.get(Q('id'));
      if (!t) return sendJSON(res, { ok: false, error: '任务不存在' });
      if (t.status === 'running' || t.status === 'queued') { try { t.controller.abort(); } catch { /* ignore */ } t.status = 'canceled'; }
      else TASKS.delete(t.id);
      return sendJSON(res, { ok: true });
    }
    if (p === '/api/tasks/clear' && req.method === 'POST') {
      for (const [id, t] of [...TASKS]) if (t.status !== 'running' && t.status !== 'queued') TASKS.delete(id);
      return sendJSON(res, { ok: true, list: [...TASKS.values()].map(taskPublic) });
    }

    /* ---- 磁盘 / 目录浏览：下载路径任意化（硬盘、U 盘、移动硬盘） ---- */
    if (p === '/api/drives') return sendJSON(res, { ok: true, drives: listDrives(), current: CFG.downloadDir, exists: (() => { try { return fs.existsSync(CFG.downloadDir); } catch { return false; } })() });
    if (p === '/api/browse') {
      const dir = Q('dir');
      /* '@pc' 是「此电脑」这个虚拟节点，不是一条真路径，不能拿去查黑名单 */
      if (!fsApiGuard(req, res, dir === '@pc' ? null : (dir || CFG.downloadDir))) return;
      try { return sendJSON(res, { ok: true, ...browseDir(dir) }); }
      catch (e) { return sendJSON(res, { ok: false, error: humane(e, '这个目录打不开') }); }
    }
    if (p === '/api/mkdir' && req.method === 'POST') {
      const b = await readBody(req);
      const target = (b.dir || '').trim();
      if (!target) return sendJSON(res, { ok: false, error: '缺少 dir' });
      if (!fsApiGuard(req, res, target)) return;
      try { fs.mkdirSync(target, { recursive: true }); return sendJSON(res, { ok: true, dir: target }); }
      catch (e) { return sendJSON(res, { ok: false, error: humane(e, '这个文件夹建不出来') }); }
    }
    if (p === '/api/reveal' && req.method === 'POST') {
      const b = await readBody(req);
      const target = (b.path || '').trim();
      if (!target) return sendJSON(res, { ok: false, error: '缺少 path' });
      if (!fsApiGuard(req, res, target)) return;
      const isFile = (() => { try { return fs.existsSync(target) && fs.statSync(target).isFile(); } catch { return false; } })();
      const at = fs.existsSync(target) ? target : path.dirname(target);
      const opened = revealNative(isFile ? target : at, isFile);
      return sendJSON(res, { ok: true, opened });
    }

    /* ---- 搜索 ---- */
    if (p === '/api/search') {
      const kw = Q('kw').trim(); if (!kw) return sendJSON(res, { ok: false, error: '请输入关键词' });
      const page = int(Q('page'), 1, 1, 500), size = int(Q('size'), 30, 1, 50);
      const src = (Q('src') || 'all').toLowerCase();
      const safe = fn => fn().catch(() => null);

      if (src === 'kugou') {
        const r = await apiSongSearch(kw, page, size);
        /* 第 18 期：单源也过一道排序 —— 平台原始序会把「(Remix版)/(57秒片段)」
           这种顶到原唱前面；rankSearchList 的版本惩罚 + 精确匹配提升在单源
           同样有效（锚点那项要两平台共有才生效，单源自动跳过）。 */
        return sendJSON(res, { ok: true, ...r, list: rankSearchList(r.list || [], kw, r.list || []), singerHint: await kugouSingerHint(kw) });
      }
      if (src === 'netease') {
        const r = await apiNeteaseSearch(kw, page, size);
        return sendJSON(res, { ok: true, source: 'netease', ...r, list: rankSearchList(r.list || [], kw, r.list || []) });
      }
      if (src === 'qq') {
        const r = await apiQQSearch(kw, page, size);
        return sendJSON(res, { ok: true, source: 'qq', ...r, list: rankSearchList(r.list || [], kw, r.list || []) });
      }
      if (src === 'bili') return sendJSON(res, { ok: true, source: 'bili', ...(await apiBiliSearch(kw, page, size)) });
      /* 抖音：搜索接口要登录 + 签名，走不通；这里改成「粘贴分享链接」解析单条。
         所以 src=douyin 传进来的不是关键词，是链接/分享文案。 */
      if (src === 'douyin') {
        try {
          const r = await apiDouyinSearch(kw);
          return sendJSON(res, { ok: true, source: 'douyin', ...r, note: '抖音不支持匿名搜索，已按分享链接解析这一条' });
        } catch (e) {
          return sendJSON(res, { ok: false, noSource: !!e.isNoSource, error: humane(e, '这首暂时取不到音源') });
        }
      }
      /* ★ U-54：搜索页「上传」单源芯片（原「抖音」芯片的位置）。
         抖音匿名链路实测必失败且本就不支持关键词搜索，芯片换成「上传」后，
         前端会传 src=upload —— 不接这条分支的话会掉进下面的全平台并行聚合，
         白跑 4 个外部平台请求（酷狗/网易/QQ/B站），拿回来的还是混合结果，
         「上传」这个筛选等于没有。
         这里早退，只查站内上传池：searchUploads 内部已按
         `state === 'approved' && USERS[t.uid]` 过滤并投影成搜索行
         （source:'upload' / sourceName:'上传' / vip:false / 时长真值等），
         零外部请求、无网络等待。返回形状与上面四个单源分支对齐。 */
      if (src === 'upload') {
        const list = searchUploads(kw, size);
        return sendJSON(res, {
          ok: true, source: 'upload',
          total: list.length, list,
          /* 脚注：`找到 N 首（上传）`。sources 里必须有 upload 且为真值，
             否则 Object.keys(...).filter(v=>v) 会把这一项滤掉，脚注只出数字。 */
          sources: { upload: true }
        });
      }

      // 全平台并行聚合（任一源挂掉不影响其它源）
      /* ★ R13 / U-02：站内上传池并进全平台聚合。
         ⚠️ ups **必须放在最后**：mergePlatforms 第二轮是按 groups 顺序输出的，
         放最后 → 上传行排在所有外部结果之后（已知副作用，PRD §8 已接受）。
         ★ 例外（2026-10-12 U-54）：精确命中的上传行会被紧随其后的
         promoteUploads() 补位并提到最前 —— PRD §8 那条副作用已被本次口径覆盖。
         包一层 { list } 是为了和上面四个源的返回形状对齐。 */
      const [k, ne, qq, bi, ups, singerHint] = await Promise.all([
        safe(() => apiSongSearch(kw, page, size)),
        safe(() => apiNeteaseSearch(kw, page, size)),
        safe(() => apiQQSearch(kw, page, size)),
        safe(() => apiBiliSearch(kw, page, size)),
        /* ⚠️ 必须包成 Promise：上面的 safe 是 `fn => fn().catch(() => null)`，
           直接给普通对象会在 `.catch` 上抛 TypeError，整个 /api/search 变 500。 */
        safe(() => Promise.resolve({ list: searchUploads(kw, 50) })),
        safe(() => kugouSingerHint(kw))
      ]);
      let list = mergePlatforms([k, ne, qq, bi, ups], kw);
      /* ★ U-54 / R21：精确命中的上传行补位 + 提到最前（详见 promoteUploads 注释）。
         只作用于全平台聚合，src=upload 单源分支不走这里。 */
      list = promoteUploads(list, ups && ups.list, kw);

      // 兜底：原词无结果 → 拆词按第一段重搜
      if (!list.length) {
        const parts = kw.split(/[\s\-–—]+/).filter(Boolean);
        if (parts.length > 1) {
          const [k2, ne2, qq2, bi2, ups2] = await Promise.all([
            safe(() => apiSongSearch(parts[0], 1, size)),
            safe(() => apiNeteaseSearch(parts[0], 1, size)),
            safe(() => apiQQSearch(parts[0], 1, size)),
            safe(() => apiBiliSearch(parts[0], 1, size)),
            safe(() => Promise.resolve({ list: searchUploads(parts[0], 50) }))
          ]);
          list = mergePlatforms([k2, ne2, qq2, bi2, ups2], parts[0]);
          list = promoteUploads(list, ups2 && ups2.list, parts[0]);   // 同上，兜底重搜也要提权
          if (list.length) return sendJSON(res, { ok: true, total: list.length, list, singerHint, note: '原词无结果，已按「' + parts[0] + '」重搜' });
        }
      }
      return sendJSON(res, {
        ok: true,
        /* total 前端目前**根本不消费**（「找到 N 首」和翻页器都用 lastList.length），
           所以算错了也不会显示出错。把上传路并进来只是为了将来有人读这个字段时不踩坑。 */
        total: Math.max(k?.total || 0, ne?.total || 0, qq?.total || 0, bi?.total || 0,
                        (ups && ups.list ? ups.list.length : 0)) || list.length,
        list, singerHint,
        /* ★ upload 这一项**必须补**：前端搜索脚注会消费 sources（锚点 `kugou:'酷狗'`），
           不补的话脚注里不会出现「上传」这个来源。 */
        sources: { kugou: !!k, netease: !!ne, qq: !!qq, bili: !!bi,
                   upload: !!(ups && ups.list && ups.list.length) }
      });
    }
    if (p === '/api/search/singer') {
      const kw = Q('kw').trim(); if (!kw) return sendJSON(res, { ok: false, error: '请输入歌手名' });
      return sendJSON(res, { ok: true, ...(await apiSingerSearch(kw, 1, 20)) });
    }
    if (p === '/api/singer/hot') {   // 歌手页首屏：热门歌手宫格
      return sendJSON(res, { ok: true, ...(await apiSingerHot(int(Q('page'), 1, 1, 50), int(Q('size'), 24, 1, 60))) });
    }
    if (p === '/api/singer/songs') {
      const id = Q('singerid'); if (!id) return sendJSON(res, { ok: false, error: '缺少 singerid' });
      return sendJSON(res, { ok: true, ...(await apiSingerSongs(id, int(Q('page'), 1, 1, 500), int(Q('size'), 30, 1, 300), Q('sort') || 1)) });
    }
    if (p === '/api/singer/all') {   // 一次聚合该歌手全部歌曲（并发分页 + 去重）
      const id = Q('singerid'); if (!id) return sendJSON(res, { ok: false, error: '缺少 singerid' });
      return sendJSON(res, { ok: true, ...(await apiSingerAllSongs(id, Q('sort') || 1)) });
    }
    if (p === '/api/search/album') {
      const kw = Q('kw').trim(); if (!kw) return sendJSON(res, { ok: false, error: '请输入专辑名' });
      return sendJSON(res, { ok: true, ...(await apiAlbumSearch(kw, int(Q('page'), 1, 1, 200), int(Q('size'), 20, 1, 50))) });
    }
    if (p === '/api/album/songs') {
      const id = Q('albumid'); if (!id) return sendJSON(res, { ok: false, error: '缺少 albumid' });
      return sendJSON(res, { ok: true, ...(await apiAlbumSongs(id, int(Q('page'), 1, 1, 500), int(Q('size'), 50, 1, 100))) });
    }
    if (p === '/api/rank/list') return sendJSON(res, { ok: true, ...(await apiRankList()) });
    /* 每日推荐：各平台公开榜单，按「天」冻结（同一天永远是同一份） */
    if (p === '/api/daily') {
      try {
        return sendJSON(res, { ok: true, ...(await apiDaily((Q('src') || 'all').toLowerCase(), Q('size'), Q('page'))) });
      } catch (e) {
        return sendJSON(res, { ok: false, error: humane(e, '榜单没读出来，稍后再试') });
      }
    }
    if (p === '/api/rank/songs') {
      const id = Q('rankid'); if (!id) return sendJSON(res, { ok: false, error: '缺少 rankid' });
      /* ⚠️ size 上限 500：酷狗 /rank/song 的 pagesize 实测能一次给 500 首
       （TOP500 就是 500 首），而这里以前卡死在 50 —— 前端只能写
       「已载入前 50 首」，业主口径「排行榜歌并没有拿全」就是这里。 */
      return sendJSON(res, { ok: true, ...(await apiRankSongs(id, int(Q('page'), 1, 1, 500), int(Q('size'), 30, 1, 500))) });
    }
    /* ── 排行榜 · 三平台（第 9 期）────────────────────────────────
       业主口径「排行榜页要设计三个平台的榜单」。
       数据源不另找：QQ / 网易云 / B站的榜单取数在每日推荐那边**已经跑通**
       并且有当日缓存（dailyFetchOne 分 kind 走四条路），这里只是换一个
       「目录 + 单榜取歌」的入口，取数逻辑一个字没重写。
       ⚠️ 为什么不直接让前端调 /api/daily?src=qq：
          那是「按天冻结的日推池」，同一张榜永远是同一份、且不带榜名；
          排行榜要的是「此刻这个榜上有什么」，两件事不能混。
          这里直接调 dailyFetchOne，不读写 DAILY_MEM。 */
    /* ── MV：一首歌有没有 MV、能不能播（见 apiMvFind 的说明） ──
       不登录也能看（MV 是公开内容），但不给游客反复刷 —— 走跟搜索同一条
       游客闸门，避免有人拿这个接口当 B站搜索的中转。 */
    if (p === '/api/mv/find') {
      const name = String(Q('name') || '').trim();
      const singer = String(Q('singer') || '').trim();
      if (!name && !Q('mvhash')) return sendJSON(res, { ok: false, error: '缺歌名' });
      try {
        const r = await apiMvFind({
          name, singer,
          mvhash: String(Q('mvhash') || ''),
          duration: parseFloat(Q('duration') || '0')
        });
        return sendJSON(res, r);
      } catch (e) {
        return sendJSON(res, { ok: false, error: humane(e, 'MV 没取到') });
      }
    }
    /* ── 官方 MV 直链（第 14 期）：三平台官方源直出 mp4 地址（见 apiMvUrl）。
       取不到回 {ok:false,error:'notfound'}，前端自动退回 /api/mv/find 的 B 站兜底。
       与 mv/find 同一档：公开内容不强制登录。 ── */
    if (p === '/api/mv/url') {
      const src = String(Q('src') || '').toLowerCase();
      if (src !== 'kugou' && src !== 'netease' && src !== 'qq')
        return sendJSON(res, { ok: false, error: 'notfound' });
      try {
        const r = await apiMvUrl({
          src, id: String(Q('id') || ''),
          name: String(Q('name') || ''), singer: String(Q('singer') || '')
        });
        return sendJSON(res, r);
      } catch (e) {
        return sendJSON(res, { ok: false, error: humane(e, 'MV 没取到') });
      }
    }
    if (p === '/api/comment') {
      const name = String(Q('name') || '').trim();
      const singer = String(Q('singer') || '').trim();
      if (!name) return sendJSON(res, { ok: false, error: '缺歌名' });
      try {
        const r = await apiSongComment(name, singer, int(Q('page'), 1, 1, 50));
        return sendJSON(res, r);
      } catch (e) {
        return sendJSON(res, { ok: false, error: humane(e, '评论没取到') });
      }
    }
    if (p === '/api/charts') {
      /* 四家平台同一套卡：目录里连封面与前三首一起给（见 chartPreview 注释） */
      const plats = await Promise.all(RANK_PLATS.map(async x => ({
        key: x.key, name: x.name,
        items: await Promise.all(x.items.map(async i => {
          const pv = await chartPreview(i);
          return { key: i.key, name: i.name, sub: i.sub, cover: pv.cover, songs: pv.songs };
        }))
      })));
      return sendJSON(res, { ok: true, plats });
    }
    if (p === '/api/chart/songs') {
      const key = String(Q('key') || '').trim();
      const c = RANK_PLATS.reduce((a, x) => a || x.items.find(i => i.key === key), null);
      if (!c) return sendJSON(res, { ok: false, error: '没有这个榜' });
      try {
        const got = await dailyFetchOne(c, int(Q('size'), 50, 1, 500));   // QQ 300 / 网易云 200 / 酷狗 500 都能一次取全
        return sendJSON(res, {
          ok: true, key: c.key, name: c.name, sub: c.sub,
          total: (got.list || []).length, list: got.list || []
        });
      } catch (e) {
        return sendJSON(res, { ok: false, error: humane(e, '这个榜暂时打不开，换一个试试') });
      }
    }
    if (p === '/api/special/list') {   // 歌单页首屏：精选歌单目录
      /* 第 10 期加 plat：歌单页要能切三大平台，目录也得跟着换源。
         缺省 kugou（保持老行为，老客户端不受影响）。 */
      const plat = String(Q('plat') || 'kugou').toLowerCase();
      try {
        return sendJSON(res, { ok: true, plat,
          ...(await apiSpecialListPlat(plat, int(Q('page'), 1, 1, 40), int(Q('size'), 30, 1, 30))) });
      } catch (e) {
        return sendJSON(res, { ok: false, plat, error: humane(e, '歌单目录没取到，换个平台试试') });
      }
    }
    /* 按名字搜歌单。存在的意义：gcid 自建歌单在网页端只给 10 首（上游硬限，
       实测见 apiSpecialSearch 上面那段），而搜出来的公开歌单是数字 ID、能拿全量。
       所以「拿不全」时的正解是这条路，不是硬凑。 */
    if (p === '/api/special/search') {
      const kw = String(Q('kw') || '').trim();
      if (!kw) return sendJSON(res, { ok: false, error: '要个关键词' });
      try {
        return sendJSON(res, { ok: true, ...(await apiSpecialSearch(kw, int(Q('page'), 1, 1, 20), int(Q('size'), 20, 1, 30))) });
      } catch (e) {
        return sendJSON(res, { ok: false, error: humane(e, '搜歌单没成功，稍后再试') });
      }
    }
    if (p === '/api/special/songs') {
      const raw = (Q('id') || '').trim();
      /* ── 识别顺序救过一次真 bug（业主报「歌单导入有问题」）──
         ① gcid 必须先认：老正则 `\d{3,}` 会把 gcid_3zr0ubguz3z007 里的
            **"007"** 抠出来当歌单 ID，查一个不存在的歌单、回 total:0，
            前端就显示「导入后是空的」。业主给的测试链接正是这种格式。
         ② 其次认「纯数字 ID / 带 specialid= 的旧链接」。
            这里要求 4 位起（`\d{4,}`）：酷狗的 specialid 都是 5~7 位，
            3 位起会把上面那种 gcid 尾巴重新漏进来。 */
      const gc = raw.match(/gcid_[a-z0-9]+/i);
      if (gc) {
        try {
          return sendJSON(res, { ok: true, ...(await apiSpecialByGcid(gc[0].toLowerCase())) });
        } catch (e) {
          return sendJSON(res, { ok: false, error: humane(e, '这个歌单打不开，确认链接没贴错') });
        }
      }
      const id = (raw.match(/\d{4,}/) || [])[0];
      if (!id) return sendJSON(res, { ok: false, error: '请填歌单 ID 或歌单链接' });
      /* 第 10 期：带 plat 走对应平台。三家的 ID 都是纯数字且互不通用，
         所以必须显式带 plat —— 靠数字串猜平台就是「查到空歌单」那个坑。 */
      const plat2 = String(Q('plat') || 'kugou').toLowerCase();
      try {
        return sendJSON(res, { ok: true, plat: plat2,
          ...(await apiSpecialSongsPlat(plat2, id, int(Q('page'), 1, 1, 500), int(Q('size'), 30, 1, 500))) });  // 歌单一次能取 500 首，别再卡 50
      } catch (e) {
        return sendJSON(res, { ok: false, plat: plat2, error: humane(e, '这个歌单打不开，换个试试') });
      }
    }

    /* ---- 音源 ---- */
    if (p === '/api/probe') {
      const src = (Q('src') || 'kugou').toLowerCase();
      if (src === 'netease' || src === 'qq' || src === 'bili') {
        const levels = [];
        try {
          const dur = parseFloat(Q('duration') || '0');
          /* QQ 走全档位探测：登录态下无损/Hi-Res 才会亮，这正是用户要看的 */
          if (src === 'qq') return sendJSON(res, { ok: true, levels: await qqProbeLevels(Q('id'), Q('br')) });
          if (src === 'netease') return sendJSON(res, { ok: true, levels: await neProbeLevels(Q('id')) });
          const a = await apiBiliResolve(Q('id'), dur);
          levels.push({ q: 'auto', label: a.quality, ok: true, ext: a.ext, bitRate: a.bitRate, size: a.size, sizeText: a.sizeText, quality: a.quality });
        } catch (e) { levels.push({ q: 'auto', label: SRC_NAME[src] || src, ok: false, reason: humane(e, '取不到') }); }
        return sendJSON(res, { ok: true, levels });
      }
      const t = { hash: Q('hash'), sqhash: Q('sqhash'), h320hash: Q('h320hash'), reshash: Q('reshash') };
      if (!t.hash) return sendJSON(res, { ok: false, error: '缺少 hash' });
      return sendJSON(res, { ok: true, levels: await probeAll(t) });
    }
    if (p === '/api/resolve') {
      const src = (Q('src') || 'kugou').toLowerCase();
      /* ---- U-47 游客试听闸门 ----
         ⚠️ 位置：必须在 upload 分支**之前**算，但 upload 分支要跳过 —— 上传歌对
            游客本来就播不了（它内部 userOf 校验会直接回「请先登录」），游客在搜索
            结果里点到一首上传歌时，绝不该白白扣掉他一首额度。所以 upload 直接给
            guest:null（= 已登录语义，不计数、不带 guest 字段）。
         ⚠️ 支出口径：只有真的解析出可播 url、走 okGuest() 返回时才算「听了一首」；
            解析失败（会员 / 付费 / 下架）走 failGuest()，不扣额度 —— 用户一首都没
            听到却扣他额度，那不是限流。 */
      const gq = (src === 'upload')
        ? { ok: true, guest: null }
        : guestPlayGate(req, res, 'resolve', Q, u.searchParams.toString());
      if (!gq.ok) return;      // 额度用尽：响应已由 guestOut() 发出
      try {
        const dur = parseFloat(Q('duration') || '0');
        /* 首选源失败 → 服务端顺着次选源往下试 → 首个成功直接当成功体返回。
           为什么包在这里而不是每个分支各写一遍：四条外部源分支要的是同一套行为，
           分开写迟早有人改漏一条，漏的那条就是下一次「点一下没声」的出处。
           ⚠️ upload 走不到这里：它在下面自己 return 了（红线二：上传的歌绝不换源）。 */
        const withAlt = async (label, fn) => {
          try { return { ok: true, source: label, ...(await fn()) }; }
          catch (e) {
            const alt = await resolveFallback(label, Q);
            if (alt) return alt;
            throw e;      /* 次选源也没有：把**原始原因**抛回去，
                             外层 catch 会用它如实报错且有 noSource 标记 */
          }
        };
        if (src === 'netease') return okGuest(res, await withAlt('netease', () => apiNeteaseResolve(Q('id'), dur, Q('br'))), gq);
        if (src === 'qq') return okGuest(res, await withAlt('qq', () => apiQQResolve(Q('id'), dur, parseInt(Q('size') || '0', 10), Q('br'))), gq);
        /* mv=1 → 要走 B站音视频合并流（MP4，含画面），前端据此把 <audio> 换 <video>。
           不传 mv 时 opts.mv 为 false，apiBiliResolve 走原来的 dash.audio 那轨，行为不变。 */
        if (src === 'bili') return okGuest(res, await withAlt('bili', () => apiBiliResolve(Q('id'), dur, { mv: Q('mv') === '1' })), gq);
        if (src === 'douyin') {
          let dy = null;
          try { dy = await apiDouyinResolve(Q('id') || Q('url') || Q('hash')); }
          catch (eDy) {
            const alt = await resolveFallback('douyin', Q);
            if (alt) return okGuest(res, alt, gq);
            throw eDy;
          }
          return okGuest(res, { ok: true, source: 'douyin', douyin: { id: dy.id, songname: dy.songname, singer: dy.singer, dyDesc: dy.dyDesc, dyAuthor: dy.dyAuthor }, ...dy.audio }, gq);
        }
        /* ★ R13 / U-03：上传歌曲的解析。
           🔴 **位置硬约束**：必须在下面 `const t = { hash... }` 和 `if (!t.hash)` **之前**。
              插晚了请求会掉进最后的酷狗分支、被「缺少 hash」挡掉，表现是上传歌
              **恒报** `缺少 hash` —— 这个报错长得像参数没传对，极易被误判成前端 bug。
           🔴 **恒返回 ok:true**（连文件丢了也返回 true）：`loadAndPlay` 一旦 `!r.ok`
              就 throw → autoAlt 接管 → 用户听到别人的版本，是红线二明令禁止的。
              文件丢失交给 `<audio>` 的 error 事件兜底，文案已按 upload 分流。 */
        if (src === 'upload') {
          const sess = userOf(req);          // ★ /api/resolve 本身没有登录校验，upload 分支必须自己加
          const me = sess && sess.user;
          if (!me) return sendJSON(res, { ok: false, error: '请先登录' });
          const o = readUploads();
          const up = o.list.find(x => x.id === Q('id'));
          if (!up) return sendJSON(res, { ok: false, error: '这首歌找不到了' });
          /* 口径与 /api/music/file 逐字对齐：approved || 本人 || 管理员。
             ⚠️ 这里**不能**用 adminOf(req, res)：它拒绝时已经把响应发出去了，
             再 return 一个 JSON 就是同一请求重复发送。只借 isAdmin 判断，不让它发响应。 */
          if (up.state !== 'approved' && up.uid !== sess.uid && !isAdmin(me)) {
            return sendJSON(res, { ok: false, error: '这首歌还没通过审核' });
          }
          const tk = mintUploadTicket(up.id, sess.uid);
          /* ★ 必须是**绝对地址**：前端 proxyAudio() 会把 url 塞进 `/api/proxy?u=` ，
             那边是服务端 `fetch(u)`，给相对路径会直接抛 "Failed to parse URL"。
             用本进程自己监听的 127.0.0.1:PORT，不依赖公网隧道，最稳。 */
          const url = 'http://127.0.0.1:' + PORT + '/api/music/file'
                    + '?id='  + encodeURIComponent(up.id)
                    + '&uid=' + encodeURIComponent(sess.uid)
                    + '&exp=' + tk.exp
                    + '&sig=' + tk.sig;
          /* ★ quality 必须有值：前端渲染 song.sourceName + ' · ' + r.quality，
             空值会在播放页标题上打出 undefined（U-09）。 */
          return sendJSON(res, {
            ok: true, source: 'upload', url: url,
            ext: up.ext || 'mp3', quality: String(up.ext || 'mp3').toUpperCase()
          });
        }
        const t = { hash: Q('hash'), sqhash: Q('sqhash'), h320hash: Q('h320hash'), reshash: Q('reshash') };
        if (!t.hash) return failGuest(res, { ok: false, error: '缺少 hash' }, gq);
        return okGuest(res, await withAlt('kugou', () => resolveAudio(t, Q('br') || 'auto')), gq);
      } catch (e) {
        /* 解析失败（会员 / 付费 / 下架）**不扣额度** —— 记账只发生在 okGuest() 里。
           但仍然把当前剩余数带回去，免得前端的「还剩 N 首」因为这一首失败就断掉。 */
        return failGuest(res, { ok: false, noSource: !!e.isNoSource, error: humane(e, '这首暂时取不到音源') }, gq);
      }
    }
    if (p === '/api/lyric') {
      const t0 = Date.now();
      const src = (Q('src') || 'kugou').toLowerCase();
      const force = Q('force') === '1' || Q('force') === 'true';
      const name = Q('name'), singer = Q('singer');
      const hash = Q('hash') || '';
      /* duration 是酷狗的**召回**参数（不只是排序参数）：实测同一首歌传 223 能召回
         录音室版，传 0 则 20 条候选全是现场版。所以时长不可信的源，宁可传 0
         让它走通用候选集，也别把视频时长/假时长塞进去召回一堆不相关的东西。
         · bili：Q('duration') 是**视频**时长（3:43 的歌做成 8 分钟反应视频就差 5 分钟）
         · douyin：同上
         · upload：web/index.html 上传行不采集 duration，恒为 0（本来就是 0） */
      const UNTRUSTED_DUR_SRC = { bili: 1, douyin: 1, upload: 1 };
      const dur = UNTRUSTED_DUR_SRC[src] ? 0 : parseFloat(Q('duration') || '0');
      let l = null;
      const dbg = { src, force, ms: 0, durUsed: dur };

      /* ── 20s 总闸（LYRIC_GATE_MS）────────────────────────────────────────
         子步骤各自有 6s 超时（搜索 / 下载各一次 getJSON），但关键词降级链有 3 条、
         每条最多试 5 个候选 —— 最坏 3 × (6s + 5 × 6s) ≈ 108s；非 kugou 源失败后
         下面还会**整条再回落一遍**，最坏翻倍到 ~216s。前端就一直卡在「取歌词…」。
         20s 的依据：实测正常取词缓存命中 0ms、非缓存 ~500ms，留了约 40 倍余量；
         同时保证最坏情况快速失败，把「重新取词」那个入口还给用户，而不是让他干等。
         ⚠️ 总闸是**兜底上界**，不与子步骤的 6s 冲突：谁先到算谁的。
         ⚠️ 超时必须回 `timedOut: true` + 非 2xx：前端的 req() 不校验 HTTP 状态，
            只认响应体；而「这首没有歌词」和「取词失败（可重试）」是两种不同 UI，
            超时属于后者，不给标记就会被当成前者 —— 重试按钮直接消失。 */
      const LYRIC_GATE_MS = 20000;
      const runLyric = async () => {
        try {
          if (src === 'netease') l = await apiNeteaseLyric(Q('id'));
          else if (src === 'qq') l = await apiQQLyric(Q('id'));
          /* 抖音没有文本歌词（它的词是 KTV 动图），直接置空走下面的酷狗匹配；
             不能把抖音的 music id 当 hash 塞给 fetchLyric，那是两套编号。 */
          else if (src === 'douyin') l = null;
          else l = await fetchLyric(name, singer, dur, hash, { force, src });
        } catch (e) {
          /* 以前这里静默吞异常，线上出问题时一个字都看不到 */
          console.warn('[歌词] /api/lyric 取词异常 src=' + src + ' name=' + name +
            ' singer=' + singer + ' dur=' + dur + ' → ' + ((e && e.message) || e));
          l = null;
        }
        /* 所有源取不到都回落到酷狗的歌词搜索（按歌名 + 歌手）。
           ⚠️ 以前只有 bili / douyin 会回落，netease / qq 失败就直接「没找到歌词」了。 */
        /* ⚠️ bili 不回落：B站 hash 恒为空，主路径那次调用和这里的回落**参数完全一样**
           （name / singer / dur / hash 四个值一个不差），等于把同一件事做两遍 ——
           双倍耗时、双倍上游请求，还吃掉 20s 总闸一半的余量。
           而真正能救 B站的是「补真歌手」，那已经在 fetchLyric 里做掉了。
           douyin 不一样：它的主路径是 `l = null`（抖音没有文本歌词），
           这里这次调用是它**唯一**的取词机会，必须保留。 */
        if (!l && src !== 'kugou' && src !== 'bili') {
          try {
            const fb = await fetchLyric(name, singer, dur, '', { force, src });
            if (fb) { l = fb; dbg.fellBackToKugou = true; }
          } catch (e) {
            console.warn('[歌词] 回落酷狗失败 src=' + src + ' name=' + name + ' → ' + ((e && e.message) || e));
          }
        }
      };
      /* runLyric 内部已把所有异常都吞掉，所以 race 里唯一会 reject 的就是这个闸 */
      let gateTimer = null;
      const gate = new Promise(function (_, rej) {
        gateTimer = setTimeout(function () { rej(new Error('取词总闸 ' + LYRIC_GATE_MS + 'ms 超时')); }, LYRIC_GATE_MS);
        if (gateTimer.unref) gateTimer.unref();
      });
      try {
        await Promise.race([runLyric(), gate]);
      } catch (e) {
        dbg.timedOut = true;
        console.warn('[歌词] /api/lyric 触发 ' + LYRIC_GATE_MS + 'ms 总闸 src=' + src +
          ' name=' + name + ' singer=' + singer + ' dur=' + dur + '（已 ' + (Date.now() - t0) + 'ms）');
      } finally {
        if (gateTimer) clearTimeout(gateTimer);   // 正常返回时把闸拆掉，别留定时器
      }
      dbg.ms = Date.now() - t0;
      /* 超时是一条**独立**的出口：它跟「没找到歌词」不是一回事 ——
         后者是「这首没有词」（不可重试），前者是「这次没取到」（该让用户重试）。 */
      if (dbg.timedOut) {
        return sendJSON(res, {
          ok: false,
          timedOut: true,
          error: '取词超时，请重试',
          debug: dbg
        }, 504);
      }
      return l ? sendJSON(res, {
        ok: true, ...l,
        lyricSource: l.lyricSource || (dbg.fellBackToKugou ? 'kugou' : src),
        debug: Object.assign({}, dbg, l.lyricDiag || {})
      })
        : sendJSON(res, {
          ok: false,
          error: '没找到歌词',
          debug: dbg,
          /* 把「为什么没词」一并带回去：以前只有一句话，线上排障时根本没法判断
             是上游没搜到、下载失败，还是候选被判成另一首歌。 */
          reason: lyricMissOf(name, singer, dur, hash) || undefined
        });
    }

    /* ---- 跨平台换源：某平台取不到就换另一个平台的免费版本 ---- */
    if (p === '/api/alt') {
      /* ---- U-47：换源也要过同一道闸 ----
         它是 resolve 失败后的兜底路径，同时也是一个独立路由；不给它加闸，
         游客直接构造 /api/alt?name=..&singer=.. 就能无限听。
         不会重复扣：键是「歌手｜歌名」，换到另一个平台的同名版本键不变，
         会落进 guestPlayGate 的「这首歌已经听过」那一支。 */
      const ga = guestPlayGate(req, res, 'alt', Q, u.searchParams.toString());
      if (!ga.ok) return;
      try {
        const r = await apiAltSource(Q('name'), Q('singer'), parseFloat(Q('duration') || '0'), Q('exclude'));
        return okGuest(res, { ok: true, ...r }, ga);
      } catch (e) {
        return failGuest(res, { ok: false, noSource: !!e.isNoSource, error: humane(e, '这首暂时取不到音源') }, ga);
      }
    }

    /* ---- 播放/下载代理（含 Range） ---- */
    /* 下载进度查询 —— 配合 /api/proxy?dl=1&dlid=xxx 用（账本见 DL_TRACK 上方那段）。
       ⚠️ 必须让客户端带时间戳破缓存：同一个 dlid 会被轮询几百次，
          浏览器 / 中间层一旦缓存了第一次的 0% 响应，进度条就永远不动。
          这里也补一条 no-store，双保险。 */
    if (p === '/api/dl/progress') {
      const id = String(Q('dlid') || '').slice(0, 48);
      const st = id ? DL_TRACK.get(id) : null;
      if (!st) return sendJSON(res, { ok: false, error: '没有这个下载任务' }, 404);
      if (Date.now() - st.at > DL_TRACK_TTL) {
        DL_TRACK.delete(id);
        return sendJSON(res, { ok: false, error: '下载任务已过期' }, 410);
      }
      return send(res, 200, JSON.stringify({
        ok: true, id: id, done: st.done, total: st.total, finished: st.finished,
        /* pct = -1 表示上游没给总长，页面按「不确定」画 —— 不编假数 */
        pct: st.total > 0 ? Math.min(100, Math.round(st.done * 1000 / st.total) / 10) : -1
      }), { 'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate' });
    }

    if (p === '/api/proxy') {
      const target = Q('u'); if (!target) return sendJSON(res, { ok: false, error: '缺少 u 参数' }, 400);
      const dl = Q('dl') === '1';
      /* 下载进度账本：只有落盘请求才记（见 DL_TRACK 上方那段） */
      const dlid = dl ? String(Q('dlid') || '').slice(0, 48) : '';
      // 试听（dl=0）游客也能用；带 dl=1 是要落盘的，必须登录
      if (dl && !userOf(req)) return denyGuest(res, '下载');
      const h = { 'User-Agent': uaFor(target) };
      const ref = refererFor(target);
      if (ref) h.Referer = ref;
      if (req.headers.range) h.Range = req.headers.range;
      /* U-52：逐跳安检（安检放在拿到 h 之后，因为 netFetch 内部要带 UA/Referer 跟进） */
      const pg = await netFetch(target, { where: '/api/proxy', headers: h, timeoutMs: 30000 });
      if (!pg.ok) {
        if (pg.why) return sendJSON(res, { ok: false, error: '这个地址不允许代理：' + pg.why }, 403);
        return sendJSON(res, { ok: false, error: '音源拉取失败：' + humane(pg.err) }, 502);
      }
      const up = pg.res;
      if (!up.ok && up.status !== 206) return sendJSON(res, { ok: false, error: '音源拉取失败 HTTP ' + up.status }, 502);
      // 上游 CDN 常回 application/octet-stream，按 ext 回一个明确音频类型，播放器/小程序才好识别
      const extName = (Q('ext') || '').toLowerCase();
      const ctype = EXT_MIME[extName] || up.headers.get('content-type') || 'audio/mpeg';
      const out = { 'Content-Type': ctype, 'Accept-Ranges': 'bytes' };
      for (const k of ['content-length', 'content-range']) { const v = up.headers.get(k); if (v) out[k.replace(/(^|-)([a-z])/g, (m, a, b) => a + b.toUpperCase())] = v; }
      if (dl) {
        const fn = `${safeName(Q('name') || 'audio')}.${safeName(Q('ext') || 'mp3')}`;
        out['Content-Disposition'] = contentDisposition(fn);
      }
      res.writeHead(up.status === 206 ? 206 : 200, out);
      /* 账本开张：总长取上游的 content-length。
         拿不到（chunked / 上游不给）就记 0，页面那边按「不确定进度」显示 ——
         硬编一个假总数会让进度条走到 99% 再停住，比没有还糟。 */
      if (dlid) dlTrackBegin(dlid, Number(up.headers.get('content-length') || 0));
      /* ⚠️ 必须就地兜住，不能让它冒到最外层那个 catch。
         外层 catch 会先 console.error 再 sendJSON(500)，而这一条请求的
         响应头**已经发出去了** —— sendJSON 里的 writeHead 必然抛
         ERR_HTTP_HEADERS_SENT（虽然被外层的内层 try 吞了、不会崩进程），
         但那句 console.error 已经打出来了。

         实测：一次音频试听中断（用户拖动进度条、切歌、弱网）就刷一条
         `[500] /api/proxy TypeError: terminated` / `ERR_STREAM_PREMATURE_CLOSE`。
         上云之后这种中断是常态，日志会被它刷满，真正的 500 反而找不着。
         所以这里跟 /api/img 用同一套判断：
           · 响应头还没发 → 这说明是 fetch/建连阶段就失败了，还能回 502；
           · 已经发了 → 只能拆连接，没有第二种选择。 */
      /* ★ 客户端断开（拖进度条 / 切歌 / 关页面）时，必须主动把上游这条连接收掉，
         别让它「读到一半」就被还进 keep-alive 池 —— 紧随其后的 Range 请求复用
         这条脏连接就会 502，用户的观感是「拖一下进度条，歌没了」。

         为什么挂在 res 的 'close' 上、而不是只靠 pipeline 抛错：
           客户端掐断时 res 先 'close'，pipeline 不一定立刻抛（也可能压根不抛），
           只等 catch 就等于把收尾交给了不确定的时序。

         为什么 destroy 和 cancel 两个都做（实测过，不是想当然）：
           · 只 destroy Node 侧的 Readable → 底层那条 web 流**未必**被 cancel
             （Readable.fromWeb(...).destroy() 单独调用测出来 cancelled=false）
           · 只 cancel web 流 → 不保证 socket 层面被放掉
         两个一起做才是「这条连接一定没了」。幂等 + 只做一次。 */
      /* 注意：这里用 var 不用 let/const，catch 也一律带绑定（catch(e)）。
         本文件是 Node 侧的，写 const 一样能跑；但「不新增 let/const/可选 catch
         绑定」是这次改动的统一红线，跟不新增 async/await 同一条规矩 ——
         不给自己留「这里可以破例」的口子。 */
      var src = Readable.fromWeb(up.body);
      var upKilled = false;
      function killUpstream() {
        if (upKilled) return;
        upKilled = true;
        try { src.destroy(); } catch (e1) { /* 已经没了 */ }
        try {
          var b = up && up.body;
          if (b && typeof b.cancel === 'function') {
            var pr = b.cancel();
            if (pr && typeof pr.catch === 'function') pr.catch(function () { /* 已经没了 */ });
          }
        } catch (e2) { /* 已经没了 */ }
      }
      res.on('close', killUpstream);
      /* 进度计数塞在管道中间：pipeline(src, counter, res) 让每一块都过一遍这里，
         比额外挂一个 'data' 监听干净 —— 后者会和 pipeline 的消费方抢同一个流，
         在背压下行为不确定。counter 只累加、不改字节。 */
      var dlCounter = null;
      if (dlid) {
        var dlSt = DL_TRACK.get(dlid);
        if (dlSt) {
          dlCounter = new Transform({
            transform: function (chunk, enc, cb) {
              dlSt.done += chunk.length;
              dlSt.at = Date.now();
              cb(null, chunk);
            }
          });
        }
      }
      try {
        if (dlCounter) await pipeline(src, dlCounter, res);
        else await pipeline(src, res);
        /* 正常读完：把开关打上，后面 res 的 'close' 就不会再跑一遍。
           ⚠️ 不能改成在这里 destroy —— 下载走的是同一条路，正常读完就拆会误伤。 */
        upKilled = true;
        if (dlid) {
          var dlEnd = DL_TRACK.get(dlid);
          if (dlEnd) { dlEnd.finished = true; dlEnd.at = Date.now(); }
        }
      } catch (e) {
        killUpstream();
        if (!res.headersSent) {
          try { send(res, 502, 'upstream broken', { 'Content-Type': 'text/plain; charset=utf-8' }); } catch { /* 连接已经没了 */ }
        } else {
          try { res.destroy(); } catch { /* 连接已经没了，忽略 */ }
        }
      }
      return;
    }

    /* ---- 封面/头像图片代理（小程序端图片域名校验兜底） ---- */
    if (p === '/api/img') {
      const target = Q('u');
      if (!/^https?:\/\//i.test(target || '')) return send(res, 400, '');
      /* U-52：逐跳安检 + 体积上限 + Content-Type 校验，三件一起。
         ① 逐跳：netGate 只对原始 URL 判一次，白名单域名 302 跳内网就穿了；
         ② 体积：不设上限，「一个 2GB 的假图片」就能把内存吃干；
         ③ 类型：这一跳本来就是图片代理，非 image/* 一律不转发 —— 顺带把
            「拿 /api/img 当任意内容代理用」这条路堵死。 */
      const ig = await netFetch(target, {
        where: '/api/img', whitelist: false, timeoutMs: 15000,
        headers: { 'User-Agent': uaFor(target), Referer: refererFor(target) || undefined }
      });
      /* 失败统一走这里记一条：reason + 状态码 + URL，三样齐了才知道该查哪一层。
         X-Img-Reason 是**新增**的响应头，前端不读、不依赖，只为排查时能直接
         curl 出来看 —— 现有响应结构（状态码 + 空体）一个字节没动。 */
      const imgFail = function (status, reason, extra) {
        console.warn('[img] ' + status + ' reason=' + reason + (extra ? ' ' + extra : '') +
          ' | ' + String(target).slice(0, 160));
        return reason;
      };
      if (!ig.ok) {
        if (ig.why) {
          const r = imgFail(403, 'gate_denied', 'why=' + ig.why);
          return send(res, 403, '', { 'X-Img-Reason': r });
        }
        const r = imgFail(502, netFailReason(ig.err));
        if (!res.headersSent) send(res, 502, '', { 'X-Img-Reason': r });
        return;
      }
      try {
        const up = ig.res;
        if (!up.ok) {
          const r = imgFail(502, 'upstream_status', 'code=' + up.status);
          return send(res, 502, '', { 'X-Img-Reason': r + ',code=' + up.status });
        }
        const ctype = (up.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!/^image\//.test(ctype)) {
          try { if (up.body) await up.body.cancel(); } catch { /* ignore */ }
          const r = imgFail(415, 'not_image', 'ctype=' + (ctype || '(无 content-type)'));
          return send(res, 415, '', { 'X-Img-Reason': r });
        }
        const { buf, over } = await netReadCapped(up, IMG_MAX_BYTES);
        if (over) {
          const r = imgFail(413, 'too_large', '超过 ' + (IMG_MAX_BYTES / 1048576) + 'MB');
          return send(res, 413, '', { 'X-Img-Reason': r });
        }
        res.writeHead(200, { ...CORS, 'Content-Type': ctype || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
        res.end(buf);
      } catch (e) {
        /* ⚠️ 走到这里分两种情况，**不能**一律 send(502)：
           ① fetch 抛（上游连不上 / 超时）→ headers 还没发，send(502) 没问题；
           ② pipeline 半路断流（上游先回了 200，正文传一半死了）→ 上面 writeHead(200)
              已经执行过，再 send(502) 会抛 ERR_HTTP_HEADERS_SENT，这个异常再冒到
              最外层 catch，就把一次普通的图片加载失败打成了 500 刷日志。
              实测 _server.log 里被刷了 600+ 条，把 U18/U16 这些 grep 关键字全淹了。
              已发过 headers → 只能拆掉这条连接，没有第二种选择。 */
        if (!res.headersSent) {
          /*  headers 还没发 = fetch/读头阶段就失败了 → 归类成连接类原因  */
          const r = imgFail(502, netFailReason(e));
          send(res, 502, '', { 'X-Img-Reason': r });
        } else {
          /*  headers 已发（上游先回了 200）→ 正文传一半断了，是「读截断」不是连接失败。
              这种情况 send 不了（HEADERS_SENT），reason 只进日志，照样能排查。 */
          imgFail(502, 'read_truncated');
          try { res.destroy(); } catch { /* 连接已经没了，忽略 */ }
        }
      }
      return;
    }

    /* ---- 落盘 ---- */
    if (p === '/api/save' && req.method === 'POST') {
      if (!userOf(req)) return denyGuest(res, '下载');
      const b = await readBody(req);
      if (!b.url) return sendJSON(res, { ok: false, error: '缺少 url' });
      const sg = await netGate(b.url);
      if (!sg.ok) { netDeny('/api/save', b.url, sg.why); return sendJSON(res, { ok: false, error: '这个地址不允许保存：' + sg.why }, 403); }
      const dir = b.dir?.trim() || CFG.downloadDir;
      try { fs.mkdirSync(dir, { recursive: true }); }
      catch (e) {
        /* 建不出来基本就两种情况：盘不在（U 盘拔了 / 盘符变了），
           或者真的没写权限（系统目录）。**必须把路径一起报出去** ——
           以前只说「下载目录不可写」，用户根本不知道要去改哪里，
           于是就有了那句让人一头雾水的「没有权限读取这个位置」。 */
        const m = String((e && e.message) || e || '');
        const why = /EACCES|EPERM|EROFS/i.test(m)
          ? '这个文件夹不给写入权限'
          : '这个位置建不了文件夹（盘可能没插上，或路径已失效）';
        return sendJSON(res, { ok: false, error: why + '：' + dir, dir });
      }

      const ext = safeName(b.ext || 'mp3');
      const base = safeName(`${b.name || 'audio'} - ${b.singer || ''}`.replace(/ - $/, ''));
      let file = path.join(dir, `${base}.${ext}`), i = 1;
      while (fs.existsSync(file)) file = path.join(dir, `${base} (${i++}).${ext}`);

      // 磁盘余量检查
      try {
        const st = fs.statfsSync(dir);
        const free = st.bavail * st.bsize;
        if (b.size && free < b.size * 1.1) return sendJSON(res, { ok: false, error: `磁盘剩余空间不足（剩 ${fmtSize(free)}）` });
      } catch { /* 拿不到就跳过 */ }

      /* U-52：逐跳安检 —— 提交时 netGate 只看第一跳，真正 fetch 时要每一跳都判 */
      const sg2 = await netFetch(b.url, {
        where: '/api/save', timeoutMs: 180000,
        headers: { 'User-Agent': uaFor(b.url), Referer: refererFor(b.url) || undefined }
      });
      if (!sg2.ok) {
        if (sg2.why) return sendJSON(res, { ok: false, error: '这个地址不允许保存：' + sg2.why }, 403);
        return sendJSON(res, { ok: false, error: '音源拉取失败：' + humane(sg2.err) });
      }
      const up = sg2.res;
      if (!up.ok) return sendJSON(res, { ok: false, error: '音源拉取失败 HTTP ' + up.status });
      const tmp = file + '.part';
      await pipeline(Readable.fromWeb(up.body), fs.createWriteStream(tmp));
      const size = fs.statSync(tmp).size;
      if (b.size && size < b.size * 0.98) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } return sendJSON(res, { ok: false, error: `下载不完整（${fmtSize(size)}/${fmtSize(b.size)}）` }); }
      fs.renameSync(tmp, file);

      let lyricPath = null;
      if (b.lyric) { lyricPath = file.replace(/\.(mp3|flac|m4a|ape|wav|ogg)$/i, '') + '.lrc'; try { writeFileAtomic(lyricPath, b.lyric, 'utf8'); } catch { /* ignore */ } }
      return sendJSON(res, { ok: true, path: file, lyricPath, size, sizeText: fmtSize(size), dir });
    }

    if (p === '/api/saveLyric' && req.method === 'POST') {
      if (!userOf(req)) return denyGuest(res, '保存歌词');
      const b = await readBody(req);
      if (!b.lyric) return sendJSON(res, { ok: false, error: '缺少歌词内容' });
      const dir = b.dir?.trim() || CFG.downloadDir;
      fs.mkdirSync(dir, { recursive: true });
      const base = safeName(`${b.name || ''} - ${b.singer || ''}`.replace(/ - $/, ''));
      let file = path.join(dir, base + '.lrc'), i = 1;
      while (fs.existsSync(file)) file = path.join(dir, `${base} (${i++}).lrc`);
      /* 用户手动存的歌词落在下载目录，写坏了是永久性的，原子写 */
      writeFileAtomic(file, b.lyric, 'utf8');
      return sendJSON(res, { ok: true, path: file });
    }

    /* ═══ 账号体系 ═══
     * 三种身份：游客（不登录）/ 注册用户（密码或验证码登录）
     * 游客能搜、能试听、能看歌词；**下载一律要求登录**，而且是在服务端拦，
     * 不是只把按钮藏起来 —— 直接打接口同样会被 401 顶回去。
     * ═══════════════ */
    const isLoopback = (() => {
      const a = (req.socket && req.socket.remoteAddress) || '';
      return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
    })();

    if (p === '/api/auth/me' && req.method === 'GET') {
      const u = userOf(req);
      if (!u) {
        /* 带了 token 却查不到会话：只有两种可能 —— 过期，或者被别处登录踢掉了。
         * 这两种对端上的人做的事是一样的（都得退回游客态），但**要说清是哪一种**：
         * 「在别处登录」比「登录状态没了」更接近真相，也不会让人以为软件坏了。
         * 分辨靠 KICKED 回执（见 kickOthers 上方的注释），查不到就按过期算 ——
         * 宁可把"被踢"说成"过期"，也不能反过来：把过期说成被踢，等于凭空指控
         * 有人动了你的号。 */
        const raw = req.headers['authorization'] || '';
        const tk = (raw.startsWith('Bearer ') ? raw.slice(7) : '')
          || (new URL(req.url, 'http://x')).searchParams.get('token') || '';
        return sendJSON(res, {
          ok: true, logged: false, guest: true,
          expired: !!tk,
          kicked: !!kickedOf(tk)
        });
      }
      return sendJSON(res, { ok: true, logged: true, user: publicUser(u.user) });
    }

    /* 取一张图形验证码。不涉及任何账号信息，所以不需要登录。
       id 和 svg 一起给前端，答案留在服务端内存里，从头到尾不上网。 */
    if (p === '/api/auth/captcha' && req.method === 'GET') {
      /* 只认 socket 远端地址：XFF 是请求头，随手就能伪造，
         信了它这个限速等于没做（同一条教训见 /api/admin/claim）。 */
      const cip = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
      const rl = captchaRate(cip);
      if (!rl.ok) return sendJSON(res, { ok: false, error: rl.error }, 429);
      const c = newCaptcha();
      return sendJSON(res, { ok: true, id: c.id, svg: c.svg, ttl: c.ttl });
    }

    /* 注册：用户名 + 手机号 + 密码 + 性别（邮箱选填） */
    if (p === '/api/auth/register' && req.method === 'POST') {
      const b = await readBody(req);
      const username = cleanName(b.username);
      const phone = String(b.phone || '').trim();
      const pass = String(b.password || '');
      const gender = b.gender === 'female' ? 'female' : b.gender === 'male' ? 'male' : '';
      const email = normEmail(b.email);
      if (!username) return sendJSON(res, { ok: false, error: '用户名不能为空' });
      if (!isPhone(phone)) return sendJSON(res, { ok: false, error: '手机号格式不对（11 位，1 开头）' });
      if (pass.length < 6) return sendJSON(res, { ok: false, error: '密码至少 6 位' });
      const weak = weakPassReason(pass);
      if (weak) return sendJSON(res, { ok: false, error: weak });
      if (!gender) return sendJSON(res, { ok: false, error: '选一下性别' });
      if (email && !isEmail(email)) return sendJSON(res, { ok: false, error: '邮箱格式不对' });
      /* ⚠️ 图形验证码必须卡在这里 —— 格式校验之后、findUser({phone}) 查重之前。
         放到查重之后，验证码就是个摆设：攻击者照样能用「这个手机号已经注册过了」
         这句回显去枚举谁注册过（手机号注册没关，这条探测路径一直开着）。
         所以验不过就直接返回，下面一行查库都不许跑。
         captcha:true 只是给前端一个「该换图了」的信号，与手机号是否存在无关。 */
      const cap = checkCaptcha(b.captchaId, b.captcha);
      if (!cap.ok) return sendJSON(res, { ok: false, error: cap.error, captcha: true }, 400);
      if (findUser({ phone })) return sendJSON(res, { ok: false, error: '这个手机号已经注册过了' });
      if (email && findUser({ email })) return sendJSON(res, { ok: false, error: '这个邮箱已经被绑定了' });
      if (email && !isAllowed(email)) return sendJSON(res, { ok: false, error: '这个邮箱不在授权名单里' });
      /* 注册时选「管理员」要对授权码。码不对就当普通用户注册，不在这里泄露码是否正确之外的信息 */
      const wantAdmin = String(b.role || '') === 'admin';
      if (wantAdmin) {
        const got = String(b.code || '').trim();
        if (!got) return sendJSON(res, { ok: false, error: '注册管理员要填授权码' }, 400);
        if (got !== getAdminCode()) return sendJSON(res, { ok: false, error: '授权码不对' }, 403);
      }
      const nu = createUser({ username, phone, email, gender, passHash: hashPass(pass) });
      if (wantAdmin) nu.role = 'admin';
      const dev = deviceOf(req);
      stampDevice(nu, dev, true);
      writeJSON(USERS_FILE, USERS);
      syncPush(nu);                       // 配了 sync.json 就回传给主库，没配则静默
      const token = issueToken(nu.uid, dev);
      return sendJSON(res, { ok: true, token, user: publicUser(nu) });
    }

    /* 密码登录：账号可以是手机号，也可以是邮箱 */
    if (p === '/api/auth/login' && req.method === 'POST') {
      const b = await readBody(req);
      const account = String(b.account || b.email || b.phone || '').trim();
      /* U-41：登录档（key 带账号）。放在密码校验之前 —— 撞库也是要挡的 */
      if (rlLoginGate(req, res, p, account)) return;
      const pass = String(b.password || '');
      if (!account || !pass) return sendJSON(res, { ok: false, error: '账号和密码都要填' });
      const u = findByAccount(account);
      // 账号不存在和密码错误给同一句提示，避免被拿来探测哪个手机号注册过
      if (!u || !u.passHash || !checkPass(pass, u.passHash)) {
        return sendJSON(res, { ok: false, error: '账号或密码不对' });
      }
      const dev = deviceOf(req);
      stampDevice(u, dev, false);
      writeJSON(USERS_FILE, USERS);
      syncPush(u);
      const token = issueToken(u.uid, dev);
      const kicked = kickOthers(u.uid, token);   // 互斥登录：别处的这次登录失效
      return sendJSON(res, { ok: true, token, user: publicUser(u), kicked });
    }

    /* 发验证码：只发给已注册账号绑定的邮箱 */
    if (p === '/api/auth/reqcode' && req.method === 'POST') {
      const b = await readBody(req);
      const email = normEmail(b.email);
      if (!isEmail(email)) return sendJSON(res, { ok: false, error: '邮箱格式不对' });
      if (!isAllowed(email)) return sendJSON(res, { ok: false, error: '这个邮箱不在授权名单里' });
      const target = findUser({ email });
      if (!target) return sendJSON(res, { ok: false, error: '这个邮箱还没注册，先去注册一个账号', needRegister: true });
      const cfg = smtpCfg();
      if (!cfg.user || !cfg.pass) return sendJSON(res, { ok: false, error: '服务端还没配置发信邮箱' });
      const now = Date.now();
      const prev = CODES.get(email);
      const hourStart = prev && now - prev.hourStart < 3600000 ? prev.hourStart : now;
      const count = prev && now - prev.hourStart < 3600000 ? prev.count : 0;
      if (prev && prev.sentAt && now - prev.sentAt < 60000) {
        return sendJSON(res, { ok: false, error: '慢一点，' + Math.ceil((60000 - (now - prev.sentAt)) / 1000) + ' 秒后可以再发' });
      }
      if (count >= 8) return sendJSON(res, { ok: false, error: '这个邮箱一小时内发得太多了，过会儿再试' });
      const code = String(Math.floor(100000 + Math.random() * 900000));
      try {
        await smtpSend({
          to: email,
          subject: 'YMusic 登录验证码：' + code,
          text: '你的 YMusic 登录验证码是：' + code + '\n\n5 分钟内有效，请勿转发给他人。\n'
            + '如果不是你本人操作，忽略这封邮件即可，账号不会有任何变化。\n'
        }, cfg);
      } catch (e) {
        return sendJSON(res, { ok: false, error: humane(e, '验证码没发出去，检查一下邮箱设置') });
      }
      CODES.set(email, { code, exp: now + CODE_TTL, tries: 0, sentAt: now, count: count + 1, hourStart });
      return sendJSON(res, { ok: true, ttl: CODE_TTL / 1000, to: email.replace(/^(.{2}).*(@.*)$/, '$1***$2') });
    }

    /* 验证码登录 */
    if (p === '/api/auth/codelogin' && req.method === 'POST') {
      const b = await readBody(req);
      const email = normEmail(b.email), code = String(b.code || '').trim();
      /* U-41：验证码登录同属登录档，key 带邮箱 */
      if (rlLoginGate(req, res, p, email)) return;
      const rec = CODES.get(email);
      if (!rec || rec.exp < Date.now()) return sendJSON(res, { ok: false, error: '验证码过期了，重新发一次' });
      if (rec.tries >= 5) { CODES.delete(email); return sendJSON(res, { ok: false, error: '错误次数太多，请重新获取验证码' }); }
      if (rec.code !== code) { rec.tries++; return sendJSON(res, { ok: false, error: '验证码不对，还能试 ' + (5 - rec.tries) + ' 次' }); }
      CODES.delete(email);
      const u = findUser({ email });
      if (!u) return sendJSON(res, { ok: false, error: '这个邮箱还没注册' });
      const dev = deviceOf(req);
      stampDevice(u, dev, false);
      writeJSON(USERS_FILE, USERS);
      const tk = issueToken(u.uid, dev);
      const kicked = kickOthers(u.uid, tk);      // 互斥登录：别处的这次登录失效
      return sendJSON(res, { ok: true, token: tk, user: publicUser(u), kicked });
    }

    /* ══════════════════════════════════════════════════════
       密码：忘了怎么办 / 登录后怎么改 / 没邮箱怎么绑
       ──────────────────────────────────────────────────────
       一律走邮箱验证码。手机号找回要接短信服务商，成本高且容易被刷，
       邮箱这条链路我们自己完全可控。
       ══════════════════════════════════════════════════════ */

    /* 忘了密码：给已注册的邮箱发重置码 */
    if (p === '/api/auth/forgot/reqcode' && req.method === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const email = normEmail(b.email);
      if (!isEmail(email)) return sendJSON(res, { ok: false, error: '邮箱格式不对' });
      const target = findUser({ email });
      /* 不告诉对方「这个邮箱没注册」—— 否则就成了批量探测账号是否存在的接口 */
      if (!target) {
        return sendJSON(res, { ok: true, sent: true, hint: '如果这个邮箱注册过，验证码已经发出了' });
      }
      const r = await issueCode(email, 'reset',
        'YMusic 重置密码验证码：{code}',
        '你正在重置 YMusic 密码，验证码是：{code}\n\n5 分钟内有效。\n'
        + '如果这不是你本人操作，忽略这封邮件即可 —— 密码不会有任何变化。\n');
      if (!r.ok) return sendJSON(res, r, 400);
      return sendJSON(res, { ok: true, sent: true, to: r.to, ttl: r.ttl });
    }

    /* 忘了密码：验证码 + 新密码 → 重置 */
    if (p === '/api/auth/forgot/reset' && req.method === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const email = normEmail(b.email);
      const np = String(b.password || '');
      if (!isEmail(email)) return sendJSON(res, { ok: false, error: '邮箱格式不对' });
      if (np.length < 6) return sendJSON(res, { ok: false, error: '新密码至少 6 位' });
      const u = findUser({ email });
      if (!u) return sendJSON(res, { ok: false, error: '这个邮箱还没注册' });
      const c = checkCode(email, b.code, 'reset');
      if (!c.ok) return sendJSON(res, c, 400);
      CODES.delete(c.key);
      u.passHash = hashPass(np);
      writeJSON(USERS_FILE, USERS);
      /* 改完密码把所有会话踢掉：万一密码已经泄露，别人那边的登录立刻失效 */
      let killed = 0;
      for (const t of Object.keys(SESSIONS)) if (SESSIONS[t] && SESSIONS[t].uid === u.uid) { delete SESSIONS[t]; killed++; }
      writeJSON(SESSIONS_FILE, SESSIONS);
      return sendJSON(res, { ok: true, killed, relogin: true });
    }

    /* 已登录改密码：给已绑定的邮箱发码 */
    if (p === '/api/auth/pass/reqcode' && req.method === 'POST') {
      const sess = userOf(req);
      const me = sess && sess.user;
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      if (!me.email) return sendJSON(res, { ok: false, error: '这个账号还没绑邮箱，先绑一个才能用它改密码', needBind: true }, 400);
      const r = await issueCode(normEmail(me.email), 'chpass',
        'YMusic 修改密码验证码：{code}',
        '你正在修改 YMusic 密码，验证码是：{code}\n\n5 分钟内有效。\n'
        + '如果这不是你本人操作，请立刻检查账号安全。\n');
      if (!r.ok) return sendJSON(res, r, 400);
      return sendJSON(res, { ok: true, to: r.to, ttl: r.ttl });
    }

    /* 已登录改密码：验证码 + 新密码 */
    if (p === '/api/auth/pass' && req.method === 'POST') {
      const sess = userOf(req);
      const me = sess && sess.user;
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const np = String(b.password || '');
      if (np.length < 6) return sendJSON(res, { ok: false, error: '新密码至少 6 位' });
      if (!me.email) return sendJSON(res, { ok: false, error: '这个账号还没绑邮箱', needBind: true }, 400);
      const c = checkCode(normEmail(me.email), b.code, 'chpass');
      if (!c.ok) return sendJSON(res, c, 400);
      CODES.delete(c.key);
      me.passHash = hashPass(np);
      writeJSON(USERS_FILE, USERS);
      /* 保留当前这一次登录，别的设备全部踢下线 */
      let kept = 0, killed = 0;
      for (const t of Object.keys(SESSIONS)) {
        if (!SESSIONS[t] || SESSIONS[t].uid !== me.uid) continue;
        if (t === sess.token) { kept++; continue; }
        delete SESSIONS[t]; killed++;
      }
      writeJSON(SESSIONS_FILE, SESSIONS);
      return sendJSON(res, { ok: true, killed, kept });
    }

    /* 绑定邮箱：先发码（邮箱必须没被别人占用） */
    if (p === '/api/auth/bindemail/reqcode' && req.method === 'POST') {
      const sess = userOf(req);
      const me = sess && sess.user;
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const email = normEmail(b.email);
      if (!isEmail(email)) return sendJSON(res, { ok: false, error: '邮箱格式不对' });
      if (!isAllowed(email)) return sendJSON(res, { ok: false, error: '这个邮箱不在授权名单里' });
      const other = findUser({ email });
      if (other && other.uid !== me.uid) return sendJSON(res, { ok: false, error: '这个邮箱已经被别的账号用了' }, 400);
      const r = await issueCode(email, 'bind',
        'YMusic 绑定邮箱验证码：{code}',
        '你正在把 {to} 绑定到 YMusic 账号，验证码是：{code}\n\n5 分钟内有效。\n');
      if (!r.ok) return sendJSON(res, r, 400);
      return sendJSON(res, { ok: true, to: r.to, ttl: r.ttl });
    }

    /* 绑定邮箱：验证码确认 */
    if (p === '/api/auth/bindemail' && req.method === 'POST') {
      const sess = userOf(req);
      const me = sess && sess.user;
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      const b = await readBody(req).catch(() => ({}));
      const email = normEmail(b.email);
      if (!isEmail(email)) return sendJSON(res, { ok: false, error: '邮箱格式不对' });
      const c = checkCode(email, b.code, 'bind');
      if (!c.ok) return sendJSON(res, c, 400);
      CODES.delete(c.key);
      const other = findUser({ email });
      if (other && other.uid !== me.uid) return sendJSON(res, { ok: false, error: '这个邮箱已经被别的账号用了' }, 400);
      me.email = email;
      writeJSON(USERS_FILE, USERS);
      return sendJSON(res, { ok: true, user: publicUser(me) });
    }

    if (p === '/api/auth/logout' && req.method === 'POST') {
      const u = userOf(req);
      if (u) { delete SESSIONS[u.token]; writeJSON(SESSIONS_FILE, SESSIONS); }
      return sendJSON(res, { ok: true });
    }

    /* 自助注销：用户/管理员从 App 里把自己销掉。
     * 和管理台删号同一个口径——连根清，不留孤儿数据；
     *   ⚠️ 上传的歌是唯一例外（U-16）：文件与元数据保留、仍可播放，只在检索侧隐藏（U-17）。
     * 开发者账号例外，它是整套系统的根，不能自己把自己删了。 */
    if (p === '/api/me/delete' && req.method === 'POST') {
      /* 同样注意：userOf 给的是 { uid, user, token }，role 在 .user 上 */
      const sess = userOf(req);
      const me = sess && sess.user;
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      if (me.role === 'superadmin') {
        return sendJSON(res, { ok: false, error: '开发者账号不能注销（可在管理台转让后再注销）' }, 403);
      }
      const b = await readBody(req).catch(() => ({}));
      const uid = me.uid;
      /* 留一份快照，万一用户反悔或误操作，管理台「备份·日志」里还能捞回来 */
      let backup = '';
      try {
        const dir = path.join(DATA_DIR, 'deleted-users');
        fs.mkdirSync(dir, { recursive: true });
        backup = path.join(dir, uid + '_' + Date.now() + '.json');
        writeFileAtomic(backup, JSON.stringify(me, null, 2), 'utf8');
      } catch { backup = ''; }

      const cleaned = purgeUser(uid, me.username);

      delete USERS[uid];
      writeJSON(USERS_FILE, USERS);
      for (const t of Object.keys(SESSIONS)) {
        if (SESSIONS[t] && SESSIONS[t].uid === uid) delete SESSIONS[t];
      }
      writeJSON(SESSIONS_FILE, SESSIONS);
      console.log('[me/delete]', uid, JSON.stringify(cleaned));
      return sendJSON(res, { ok: true, cleaned, backup: !!backup });
    }

    /* ══════════════════════════════════════════════════════════════
       管理 API（并入主服务，凭管理员 token 鉴权）
       主 App 的管理面板、网页管理台、EXE、APK 三端共用这一套。
       ══════════════════════════════════════════════════════════════ */
    if (p === '/api/admin/state') {
      const me = adminOf(req, res); if (!me) return;
      const list = Object.values(USERS), now = Date.now();
      const pres = readJSON(PRESENCE_FILE, {});
      let online = 0, hidden = 0;
      for (const [uid, x] of Object.entries(pres)) {
        if (!x || !x.at || now - x.at > ONLINE_WINDOW) continue;
        if (!USERS[uid]) continue;
        online++; if (x.state === 'invisible') hidden++;
      }
      const ups = readUploads().list;
      const nt = readJSON(NOTICE_FILE, { list: [] });
      const rel = readJSON(RELEASE_MANIFEST, null) || {};
      const apkMeta = (() => { try { return JSON.parse(fs.readFileSync(APK_META, 'utf8')); } catch { return null; } })();
      /* 今日新增：注册数与活跃数的差值，首页 KPI 用得上 */
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
      return sendJSON(res, {
        ok: true,
        me: { uid: me.uid, username: me.username, role: roleOf(me) },
        service: {
          app: APP_VERSION,
          web: rel.version || APP_VERSION,
          publicBase: publicUrl() || '',
          port: PORT,
          dir: APP_DIR,
          sea: IS_SEA,
          since: BOOT_AT,
          now: now,
          host: os.hostname(),
          platform: process.platform + ' ' + process.arch,
          node: process.version,
          memMb: Math.round(process.memoryUsage().rss / 1048576),
          uptimeMin: Math.round((now - BOOT_AT) / 60000)
        },
        release: {
          webAt: rel.at || 0,
          webNote: rel.note || '',
          webFiles: (rel.files || []).map(f => f.rel),
          apk: apkMeta ? { versionName: apkMeta.versionName, versionCode: apkMeta.versionCode, size: apkMeta.size, at: apkMeta.at } : null
        },
        counts: {
          todayNew: list.filter(u => (u.createdAt || 0) >= dayStart.getTime()).length,
          users: list.length,
          admins: list.filter(isAdmin).length,
          online, hidden,
          pending: ups.filter(t => t.state === 'pending').length,
          approved: ups.filter(t => t.state === 'approved').length,
          rejected: ups.filter(t => t.state === 'rejected').length,
          /* 头像待审角标单独一个：跟"音频待审"是两条队列，别混在一个数字里 */
          avatarPending: readAvatars().list.filter(t => t.state === 'pending').length,
          notices: (nt.list || []).length,
          sessions: Object.values(SESSIONS).filter(x => x && x.exp > now).length
        },
        top: topActive(3, 'today').map(x => ({ uid: x.uid, username: x.username, ms: x.ms }))
      });
    }

    if (p === '/api/admin/users') {
      const me = adminOf(req, res); if (!me) return;
      const q = String(Q('q') || '').trim().toLowerCase();
      const pres = readJSON(PRESENCE_FILE, {});
      let rows = Object.values(USERS).map(u => {
        const pv = presView(pres, u.uid);
        return {
          uid: u.uid, username: u.username || '听众', role: roleOf(u),
          phone: u.phone || '', email: u.email || '', gender: u.gender || '',
          hasPass: !!u.passHash, createdAt: u.createdAt || 0, lastLogin: u.lastLogin || 0,
          favCount: (u.favs || []).length, historyCount: (u.history || []).length,
          /* 管理端用户列表也显示真头像（没有就回退前端的字母块） */
          avatar: avatarUrlOf(u), avatarPending: !!u.avatarPending,
          lastDevice: u.lastDevice || '', lastIp: u.lastIp || '',
          /* 真实在线：隐身的人在这里照样是在线，只是多一个 hidden 标记 */
          online: pv.online, hidden: pv.hidden, lastSeen: pv.lastSeen, song: pv.song,
          todayMs: pv.today, totalMs: pv.total, device: pv.device
        };
      });
      if (q) rows = rows.filter(r =>
        (r.username || '').toLowerCase().includes(q) || (r.phone || '').includes(q) ||
        (r.email || '').toLowerCase().includes(q) || (r.uid || '').toLowerCase().includes(q));
      rows.sort((a, b) => (b.lastLogin || 0) - (a.lastLogin || 0));
      return sendJSON(res, { ok: true, rows, total: rows.length });
    }

    if (p === '/api/admin/user') {
      const me = adminOf(req, res); if (!me) return;
      const u = USERS[String(Q('uid') || '').trim()];
      if (!u) return sendJSON(res, { ok: false, error: '账号不存在' }, 404);
      const pv = presView(readJSON(PRESENCE_FILE, {}), u.uid);
      const pick = it => ({
        name: it.name || it.songname || it.title || '(未命名)',
        artist: it.artist || it.singer || '', at: it.at || 0
      });
      return sendJSON(res, {
        ok: true,
        user: {
          uid: u.uid, username: u.username || '听众', role: roleOf(u),
          phone: u.phone || '', email: u.email || '', gender: u.gender || '',
          hasPass: !!u.passHash, createdAt: u.createdAt || 0, lastLogin: u.lastLogin || 0,
          avatar: avatarUrlOf(u), avatarPending: !!u.avatarPending,
          online: pv.online, hidden: pv.hidden, lastSeen: pv.lastSeen, song: pv.song,
          todayMs: pv.today, totalMs: pv.total, device: pv.device,
          lastDevice: u.lastDevice || '', lastIp: u.lastIp || ''
        },
        favs: (u.favs || []).map(pick),
        history: (u.history || []).map(pick),
        uploads: readUploads().list.filter(t => t.uid === u.uid).map(pubTrack),
        sessions: Object.entries(SESSIONS).filter(([, v]) => v && v.uid === u.uid)
          .map(([t, v]) => ({ token: t.slice(0, 10) + '…', alive: v.exp > Date.now() }))
      });
    }

    /* ---------------- 酷狗会员守护（2026-10-18）----------------
       高码率整条链路对 token 是「全或无」的门槛 —— 实测把 token 换空/伪造，
       连免费曲的 songinfo 都回 status=0。凭证一失效，全站会员曲当场哑火，
       而症状和「会员到期」完全一样，用户在页面上分不出来。
       所以这里提供：查状态 / 登记到期日 / 扫码换证。 */
    if (p === '/api/admin/kg/health') {
      const me = adminOf(req, res); if (!me) return;
      const h = readJSON(path.join(DATA_DIR, 'kg-health.json'), null) ||
        { level: 'unknown', ok: false, message: '尚未体检（巡检每 30 分钟跑一次，也可点「立即体检」）' };
      const v = readJSON(path.join(DATA_DIR, 'kg-vip.json'), {}) || {};
      const k = (typeof SECRETS === 'object' && SECRETS && SECRETS.kugou) || {};
      const tk = String(k.token || '');
      return sendJSON(res, {
        ok: true, health: h, vip: v,
        userid: String(k.userid || ''), nickname: String(k.nickname || ''),
        savedAt: String(k.savedAt || ''),
        tokenMask: tk ? (tk.slice(0, 6) + '…' + tk.slice(-4)) : ''
      });
    }

    if (p === '/api/admin/kg/expire' && req.method === 'POST') {
      const me = adminOf(req, res, true); if (!me) return;   /* 只有开发者能改 */
      const b = await readBody(req).catch(() => ({}));
      const d = String(b.expireAt || '').trim();
      if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        return sendJSON(res, { ok: false, error: '到期日要 YYYY-MM-DD 格式' }, 400);
      }
      const f = path.join(DATA_DIR, 'kg-vip.json');
      const v = readJSON(f, {}) || {};
      v.expireAt = d;
      v.notifyDays = Math.max(1, Math.min(60, parseInt(b.notifyDays, 10) || 7));
      v.updatedAt = Date.now();
      v.updatedBy = me.uid;
      writeJSON(f, v);
      return sendJSON(res, { ok: true, vip: v });
    }

    if (p === '/api/admin/kg/qr') {
      const me = adminOf(req, res, true); if (!me) return;
      const j = await kgLoginGet('/v2/qrcode', {
        appid: '1014', type: '1', plat: '4', qrcode_txt: KG_QR_TXT
      }).catch(() => null);
      if (!j || j.status !== 1) {
        return sendJSON(res, {
          ok: false,
          error: '酷狗没给二维码（error_code=' + ((j && j.error_code) || '?') + '）'
        }, 502);
      }
      const d = j.data || {};
      return sendJSON(res, {
        ok: true,
        qrcode: String(d.qrcode || ''),
        img: String(d.qrcode_img || ''),
        txt: KG_QR_TXT + 'qrcode=' + String(d.qrcode || '')
      });
    }

    if (p === '/api/admin/kg/qr/poll') {
      const me = adminOf(req, res, true); if (!me) return;
      const qc = Q('qrcode');
      if (!qc) return sendJSON(res, { ok: false, error: '缺少 qrcode' }, 400);
      const j = await kgLoginGet('/v2/get_userinfo_qrcode', {
        appid: '1014', plat: '4', qrcode: qc
      }).catch(() => null);
      if (!j) return sendJSON(res, { ok: false, error: '轮询失败' }, 502);
      const st = Number((j.data || {}).status || 0);   /* 1待扫 / 2已扫 / 4成功 / 0失效 */
      if (st !== 4) {
        return sendJSON(res, {
          ok: true, state: st,
          msg: st === 1 ? '等待扫码' : st === 2 ? '已扫码，请在手机上点确认' : '二维码已失效，请刷新'
        });
      }
      const d = j.data || {};
      const uid = String(d.userid || ''), tk = String(d.token || '');
      if (!uid || !tk) return sendJSON(res, { ok: false, error: '扫码成功但没拿到凭证' }, 502);
      const old = (typeof SECRETS === 'object' && SECRETS && SECRETS.kugou) || {};
      SECRETS.kugou = {
        userid: uid, token: tk,
        mid: String(old.mid || d.mid || ''),
        dfid: String(old.dfid || d.dfid || ''),
        nickname: String(d.nickname || d.username || old.nickname || ''),
        savedAt: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
      };
      writeJSON(SECRETS_FILE, SECRETS);
      /* 把响应里的字段名打出来，万一以后酷狗开始给会员到期日，这里能第一时间看到 */
      console.log('[kg] 扫码换证成功 userid=' + uid + '，字段: ' + Object.keys(d).join(','));
      return sendJSON(res, {
        ok: true, state: 4, msg: '已接通',
        userid: uid, nickname: SECRETS.kugou.nickname
      });
    }

    /* 立即体检：和 cron 里的 kg-guard.py 同一判据（见 kgProbe 注释），
       结果写进同一个 kg-health.json，页面刷新就能看到。 */
    if (p === '/api/admin/kg/probe') {
      const me = adminOf(req, res); if (!me) return;
      const r = await kgProbe();
      const f = path.join(DATA_DIR, 'kg-health.json');
      const old = readJSON(f, {}) || {};
      const v = readJSON(path.join(DATA_DIR, 'kg-vip.json'), {}) || {};
      const k = (typeof SECRETS === 'object' && SECRETS && SECRETS.kugou) || {};
      const expireAt = String(v.expireAt || old.expireAt || '');
      writeJSON(f, {
        ok: r.ok, level: r.level, message: r.message,
        checkedAt: Date.now(),
        checkedAtText: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' '),
        levels: r.levels || [],
        expireAt,
        daysLeft: neDaysLeft(expireAt),
        notifyDays: v.notifyDays || old.notifyDays || 7,
        probe: { hash: KG_PROBE_HASH, name: KG_PROBE_NAME },
        account: {
          userid: String(k.userid || ''), nickname: String(k.nickname || ''),
          savedAt: String(k.savedAt || '')
        },
        by: 'manual'
      });
      return sendJSON(res, { ok: true, result: r });
    }

    /* ---------------- QQ音乐凭证守护（2026-10-18） ----------------
       和酷狗那段一一对应：查状态 / 立即体检 / 登记到期日 / 粘贴凭证 / 扫码换证。
       QQ 的高码率对 cookie 同样是「全或无」：没 qqmusic_key 就一律 104003。 */
    if (p === '/api/admin/qq/health') {
      const me = adminOf(req, res); if (!me) return;
      const c = qqCred();
      const h = readJSON(path.join(DATA_DIR, 'qq-health.json'), null) ||
        { level: 'unknown', ok: false, message: '尚未体检（巡检每 30 分钟跑一次，也可点「立即体检」）' };
      const v = readJSON(path.join(DATA_DIR, 'qq-vip.json'), {}) || {};
      const k = (typeof SECRETS === 'object' && SECRETS && SECRETS.qq) || {};
      const ck = String(k.cookie || '');
      const key = (/(?:qqmusic_key|qm_keyst)=([^;]+)/.exec(ck) || [])[1] || '';
      return sendJSON(res, {
        ok: true, health: h, vip: v,
        logged: !!c, hasKey: qqHasKey(ck),
        uin: String(k.uin || ''), nickname: String(k.nickname || ''),
        savedAt: String(k.savedAt || ''),
        keyMask: key ? (key.slice(0, 6) + '…' + key.slice(-4)) : '',
        cookieLen: ck.length
      });
    }

    if (p === '/api/admin/qq/probe') {
      const me = adminOf(req, res); if (!me) return;
      const r = await qqProbe();
      const f = path.join(DATA_DIR, 'qq-health.json');
      const old = readJSON(f, {}) || {};
      const c = qqCred();
      writeJSON(f, {
        ok: r.ok, level: r.level, message: r.message,
        checkedAt: Date.now(),
        checkedAtText: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' '),
        levels: r.levels,
        expireAt: String(old.expireAt || ''),
        daysLeft: old.daysLeft == null ? null : old.daysLeft,
        notifyDays: old.notifyDays || 7,
        probe: { mid: QQ_PROBE_MID, name: QQ_PROBE_NAME },
        account: { uin: c ? c.uin : '', nickname: c ? c.nickname : '', savedAt: (SECRETS.qq || {}).savedAt || '' },
        by: 'manual'
      });
      return sendJSON(res, { ok: true, result: r });
    }

    if (p === '/api/admin/qq/cred' && req.method === 'POST') {
      const me = adminOf(req, res, true); if (!me) return;
      const b = await readBody(req).catch(() => ({}));
      let ck = String(b.cookie || '').trim();
      /* 允许用户只粘「qqmusic_key=xxx; uin=o123」，也允许粘整段 document.cookie */
      ck = ck.replace(/^cookie:\s*/i, '').replace(/[\r\n]+/g, ' ').trim();
      if (!ck) return sendJSON(res, { ok: false, error: '先把 cookie 粘进来' }, 400);
      /* QQ 号登录给 uin=o0123…；微信登录只有 wxuin=1152921504…（19 位）。
         必须先抓 wxuin，否则 /uin=o?(\d+)/ 会从 "wxuin=" 尾巴上截到错的前几位。 */
      const wx = (/wxuin=(\d{5,20})/.exec(ck) || [])[1] || '';
      const uin = wx || (/[^a-z]uin=o?(\d{5,20})/.exec(ck) || [])[1]
        || String(b.uin || '').replace(/^o/i, '');
      if (!/^\d{5,20}$/.test(uin)) {
        return sendJSON(res, { ok: false, error: 'cookie 里没有 uin / wxuin，请把 Cookie 整行复制全' }, 400);
      }
      if (!qqHasKey(ck)) {
        return sendJSON(res, {
          ok: false,
          error: 'cookie 里没有 qqmusic_key / qm_keyst —— 多半是没登录 y.qq.com，或复制时漏了这一段'
        }, 400);
      }
      const old = (typeof SECRETS === 'object' && SECRETS && SECRETS.qq) || {};
      SECRETS.qq = {
        uin, cookie: ck,
        nickname: String(b.nickname || old.nickname || ''),
        savedAt: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
      };
      writeJSON(SECRETS_FILE, SECRETS);
      QQ_DETAIL_CACHE.clear();
      const r = await qqProbe();
      console.log('[qq] 凭证已更新 uin=' + uin + '，体检 level=' + r.level);
      return sendJSON(res, { ok: true, nickname: SECRETS.qq.nickname, result: r });
    }

    if (p === '/api/admin/qq/expire' && req.method === 'POST') {
      const me = adminOf(req, res, true); if (!me) return;
      const b = await readBody(req).catch(() => ({}));
      const d = String(b.expireAt || '').trim();
      if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        return sendJSON(res, { ok: false, error: '到期日要 YYYY-MM-DD 格式' }, 400);
      }
      const f = path.join(DATA_DIR, 'qq-vip.json');
      const v = readJSON(f, {}) || {};
      v.expireAt = d;
      v.notifyDays = Math.max(1, Math.min(60, parseInt(b.notifyDays, 10) || 7));
      v.updatedAt = Date.now();
      v.updatedBy = me.uid;
      writeJSON(f, v);
      return sendJSON(res, { ok: true, vip: v });
    }

    if (p === '/api/admin/qq/qr') {
      const me = adminOf(req, res, true); if (!me) return;
      qqQrClean();
      const ua = UA_PC;
      let r;
      try {
        r = await fetch('https://ssl.ptlogin2.qq.com/ptqrshow?' + QQ_QR_APP + '&t=' + Date.now(), {
          headers: { 'User-Agent': ua, Referer: 'https://y.qq.com/' }
        });
      } catch (e) {
        return sendJSON(res, { ok: false, error: '申请二维码失败：' + String(e).slice(0, 80) }, 502);
      }
      const buf = Buffer.from(await r.arrayBuffer());
      let list = [];
      try { list = r.headers.getSetCookie ? r.headers.getSetCookie() : []; } catch { list = []; }
      const qrsig = ((list.join(';').match(/qrsig=([^;]+)/) || [])[1]) || '';
      if (!buf.length || !qrsig) {
        return sendJSON(res, { ok: false, error: 'QQ 没给二维码（qrsig 缺失）' }, 502);
      }
      const id = md5(qrsig + '|' + Date.now());
      QQ_QR.set(id, { qrsig, ua, at: Date.now() });
      return sendJSON(res, {
        ok: true, qrcode: id,
        img: 'data:image/png;base64,' + buf.toString('base64')
      });
    }

    if (p === '/api/admin/qq/qr/poll') {
      const me = adminOf(req, res, true); if (!me) return;
      const id = Q('qrcode');
      const s = QQ_QR.get(id);
      if (!s) return sendJSON(res, { ok: true, state: 0, msg: '二维码已失效，请重新生成' });
      const token = qqHash33(s.qrsig);
      const url = 'https://ssl.ptlogin2.qq.com/ptqrlogin?u1=' + encodeURIComponent('https://graph.qq.com/oauth2.0/login_jump') +
        '&ptqrtoken=' + token + '&ptredirect=1&h=1&t=1&g=1&from_ui=1&ptlang=2052&action=0-0-' + Date.now() +
        '&js_ver=20102616&js_type=1&login_sig=&pt_uistyle=40&aid=716027609&daid=383&pt_3rd_aid=100497308&has_onekey=1';
      let txt = '';
      try {
        const r = await fetch(url, { headers: { 'User-Agent': s.ua, Referer: 'https://ssl.ptlogin2.qq.com/', Cookie: 'qrsig=' + s.qrsig } });
        txt = await r.text();
      } catch (e) {
        return sendJSON(res, { ok: false, error: '轮询失败：' + String(e).slice(0, 80) }, 502);
      }
      /* ptuiCB('0','0','<跳转url>','0','登录成功','') —— 状态码 0 成功 / 66 待扫 / 67 已扫待确认 / 65 失效 */
      const m = /ptuiCB\('(\d+)','(\d+)','([^']*)','(\d+)','([^']*)'/.exec(txt);
      const code = m ? m[1] : '';
      if (code === '66') return sendJSON(res, { ok: true, state: 1, msg: '等待扫码' });
      if (code === '67') return sendJSON(res, { ok: true, state: 2, msg: '已扫码，请在手机上点确认' });
      if (code !== '0') {
        QQ_QR.delete(id);
        return sendJSON(res, { ok: true, state: 0, msg: m ? ('登录未完成：' + m[5]) : '二维码已失效，请刷新' });
      }
      const jump = m[3];
      QQ_QR.delete(id);
      const got = await qqTakeover(jump, s.ua);
      if (!got.cookie) {
        console.log('[qq] 扫码跟进失败：一个 cookie 都没收回来');
        return sendJSON(res, {
          ok: false,
          error: '扫码已通过，但跟进跳转时一个 cookie 都没拿到（QQ 这步常要人工过安全校验）。改用「粘贴 cookie」更稳。'
        }, 502);
      }
      /* ★ 不再因为「没拿到 qqmusic_key」就直接判失败（2026-10-29）。
         旧逻辑：没有 key → 立刻报错，用户辛苦扫完一趟白扫。
         实际是：跳转被安全校验拦下时，手里仍可能有 uin / p_skey / skey，
         而 c.y.qq.com 认的是 uin + qm_keyst 那一套 —— 能不能用，**体检说了算**，
         不该由我们替用户判死刑。所以：先落盘 → 体检 → 过了就算接通，
         没过再把原因如实说出来。 */
      const old = (typeof SECRETS === 'object' && SECRETS && SECRETS.qq) || {};
      SECRETS.qq = {
        uin: got.uin, cookie: got.cookie,
        nickname: got.nickname || old.nickname || '',
        savedAt: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
      };
      writeJSON(SECRETS_FILE, SECRETS);
      try { fs.chmodSync(SECRETS_FILE, 0o600); } catch { /* 改不动也不拦业务 */ }
      QQ_DETAIL_CACHE.clear();
      const pr = await qqProbe();
      console.log('[qq] 扫码跟进：key=' + (got.key ? 'yes' : 'no') + ' uin=' + (got.uin || '-')
        + ' 体检 level=' + pr.level + '（cookie ' + got.cookie.length + ' B）');
      if (!got.key && pr.level !== 'ok') {
        SECRETS.qq = old;                       /* 体检没过就别把坏的凭证盖上去 */
        writeJSON(SECRETS_FILE, SECRETS);
        return sendJSON(res, {
          ok: false,
          error: '扫码通过了，但没拿到 qqmusic_key（QQ 这一步常要人工过安全校验），体检也没过。改用「粘贴 cookie」更稳。'
        }, 502);
      }
      return sendJSON(res, {
        ok: true, state: 4,
        msg: got.key ? '已接通' : '已接通（没拿到 qqmusic_key，但体检通过了）',
        uin: got.uin, nickname: SECRETS.qq.nickname, result: pr
      });
    }

    /* ---------------- 网易云凭证守护（2026-10-18，2026-10-29 补扫码） ----------------
       和酷狗 / QQ 那段一一对应：查状态 / 立即体检 / 登记到期日 / 粘贴凭证。
       2026-10-29：扫码这条也铺上了（网易云 App 扫一下就拿 cookie，流程和酷狗一致），
       粘贴那条留着当兜底 —— 个别账号扫码拿不到 MUSIC_U 时它还是唯一出路。 */
    if (p === '/api/admin/ne/health') {
      const me = adminOf(req, res); if (!me) return;
      const c = neCred();
      const h = readJSON(path.join(DATA_DIR, 'ne-health.json'), null) ||
        { level: 'unknown', ok: false, message: '尚未体检（巡检每 30 分钟跑一次，也可点「立即体检」）' };
      const v = readJSON(path.join(DATA_DIR, 'ne-vip.json'), {}) || {};
      const k = (typeof SECRETS === 'object' && SECRETS && SECRETS.netease) || {};
      const ck = String(k.cookie || '');
      const mu = (/(?:^|;\s*)MUSIC_U=([^;\s]+)/.exec(ck) || [])[1] || '';
      return sendJSON(res, {
        ok: true, health: h, vip: v,
        logged: !!c, hasKey: neHasKey(ck),
        uid: String(k.uid || ''), nickname: String(k.nickname || ''),
        savedAt: String(k.savedAt || ''),
        keyMask: mu ? (mu.slice(0, 6) + '…' + mu.slice(-4)) : '',
        cookieLen: ck.length
      });
    }

    if (p === '/api/admin/ne/probe') {
      const me = adminOf(req, res); if (!me) return;
      const r = await neProbe();
      const vp = await neVipInfo();
      const h = neSaveHealth(r, 'manual', vp);
      return sendJSON(res, { ok: true, result: r, health: h, vip: vp });
    }

    if (p === '/api/admin/ne/cred' && req.method === 'POST') {
      const me = adminOf(req, res, true); if (!me) return;
      const b = await readBody(req).catch(() => ({}));
      let ck = String(b.cookie || '').trim();
      ck = ck.replace(/^cookie:\s*/i, '').replace(/[\r\n]+/g, ' ').trim();
      if (!ck) return sendJSON(res, { ok: false, error: '先把 cookie 粘进来' }, 400);
      /* 只粘了 MUSIC_U 的值（一长串 base64）也认，帮他补上键名 */
      if (!neHasKey(ck) && /^[A-Za-z0-9+/=_\-]{40,}$/.test(ck)) ck = 'MUSIC_U=' + ck;
      if (!neHasKey(ck)) {
        return sendJSON(res, {
          ok: false,
          error: '这段里没有 MUSIC_U=… —— 确认是在 music.163.com 登录后复制的 Cookie 整行'
        }, 400);
      }
      /* 顺手向网易云问一下这是谁：失败不影响凭证本身 */
      let uid = String(b.uid || ''), nickname = String(b.nickname || '');
      try {
        const j = await getJSON('https://music.163.com/api/nuser/account/get', {
          headers: { ...NE_H, Cookie: 'os=pc; appver=8.9.70; ' + ck }, tries: 1, timeout: 8000
        });
        const p = j && j.profile;
        if (p) { uid = String(p.userId || uid); nickname = String(p.nickname || nickname); }
      } catch { /* 拿不到昵称也照存，体检才是硬指标 */ }
      const old = (typeof SECRETS === 'object' && SECRETS && SECRETS.netease) || {};
      SECRETS.netease = {
        uid, cookie: ck,
        nickname: nickname || String(old.nickname || ''),
        savedAt: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
      };
      writeJSON(SECRETS_FILE, SECRETS);
      /* writeJSON 走的是 0644，凭证文件必须收回来 —— 以前每次粘贴都会被重新放开 */
      try { fs.chmodSync(SECRETS_FILE, 0o600); } catch (e) { /* 改不动也不拦业务 */ }
      const r = await neProbe();
      /* ★ 只带 MUSIC_U 会「登录成功但只给试听」：实测同一张号，整行 cookie 给
         Hi-Res 53,648,976 B，砍到只有 MUSIC_U + __csrf 就掉成 720,813 B 试听 ——
         网易云把登录态绑在设备 cookie（NMTID / _ntes_nuid / sDeviceId）上。 */
      const thin = !/(?:^|;\s*)(?:NMTID|_ntes_nuid)=/.test(ck);
      if (thin && r.level !== 'ok') {
        r.level = 'warn';
        r.message += '（这次只粘了 MUSIC_U：网易云会把它当新设备，会员曲只给 30 秒试听。'
          + '请在 music.163.com 按 F12 → Network → 点任意一条请求 → 复制 Cookie 整行）';
      }
      const vp = await neVipInfo();
      const h = neSaveHealth(r, 'manual', vp);
      console.log('[ne] 凭证已更新 uid=' + (uid || '-') + '，体检 level=' + r.level
        + (vp.expireAt ? '，会员到 ' + vp.expireAt : ''));
      return sendJSON(res, { ok: true, uid, nickname: SECRETS.netease.nickname, result: r, health: h, vip: vp, thin });
    }

    /* ── 网易云「手机 App 扫码」登录（2026-10-29，业主点名要的）────────────
       和酷狗那条一个手感：点一下出图 → 手机网易云 App 扫 → 点确认 → cookie 落盘。
       状态机沿用酷狗那套（前端 kg.html 是三平台共用的）：
         state 1 等待扫码 / 2 已扫待确认 / 0 已失效 / 4 已接通 */
    if (p === '/api/admin/ne/qr') {
      const me = adminOf(req, res, true); if (!me) return;
      neQrClean();
      let lastErr = '';
      for (const arg of [{ type: 1 }, { type: '1' }]) {
        try {
          const dev = await neDeviceCookie();
          const r = await neWeapiCall('/weapi/login/qrcode/unikey', arg, dev);
          const key = String((r.json && r.json.unikey) || '');
          if (key) {
            const id = md5(key + '|' + Date.now());
            NE_QR.set(id, { key, dev, at: Date.now() });
            const url = 'https://music.163.com/login?codekey=' + key;
            console.log('[ne] 二维码已生成 unikey=' + key.slice(0, 8) + '…（设备 cookie ' + dev.length + ' B）');
            return sendJSON(res, {
              ok: true, qrcode: id, url,
              img: 'data:image/svg+xml;base64,' + Buffer.from(qrSvg(url, 3, 6)).toString('base64')
            });
          }
          lastErr = '网易云没给 unikey：' + JSON.stringify(r.json).slice(0, 120);
        } catch (e) { lastErr = String(e).slice(0, 120); }
      }
      return sendJSON(res, { ok: false, error: '申请二维码失败：' + (lastErr || '未知') }, 502);
    }

    if (p === '/api/admin/ne/qr/poll') {
      const me = adminOf(req, res, true); if (!me) return;
      const id = Q('qrcode');
      const s = NE_QR.get(id);
      if (!s) return sendJSON(res, { ok: true, state: 0, msg: '二维码已失效，请重新生成' });
      let r;
      try {
        r = await neWeapiCall('/weapi/login/qrcode/client/login', { key: s.key, type: 1 }, s.dev);
      } catch (e) {
        return sendJSON(res, { ok: true, state: 1, msg: '轮询失败，正在重试…' });
      }
      const code = Number((r.json && r.json.code) || 0);
      if (code === 801) return sendJSON(res, { ok: true, state: 1, msg: '等待扫码（用网易云 App 扫）' });
      if (code === 802) return sendJSON(res, { ok: true, state: 2, msg: '已扫描，请在手机上点「确认登录」' });
      if (code === 800) {
        NE_QR.delete(id);
        return sendJSON(res, { ok: true, state: 0, msg: '二维码已过期，请重新生成' });
      }
      if (code !== 803) {
        return sendJSON(res, { ok: true, state: 1, msg: String((r.json && r.json.message) || ('状态 ' + code)) });
      }
      NE_QR.delete(id);
      /* 803 = 登录成功，凭证就在这一拍的 Set-Cookie 里（MUSIC_U / __csrf …） */
      const ck = neCookieMerge(s.dev, r.cookies);
      if (!neHasKey(ck)) {
        console.log('[ne] 扫码通过但没收到 MUSIC_U，响应头 cookie 数=' + (r.cookies || []).length);
        return sendJSON(res, {
          ok: false,
          error: '扫码通过了，但没收到 MUSIC_U（网易云这步偶尔不给）。改用下面的「粘贴 cookie」。'
        }, 502);
      }
      let uid = '', nickname = '';
      try {
        const j = await getJSON('https://music.163.com/api/nuser/account/get', {
          headers: { ...NE_H, Cookie: ck }, tries: 1, timeout: 8000
        });
        const pf = j && j.profile;
        if (pf) { uid = String(pf.userId || ''); nickname = String(pf.nickname || ''); }
      } catch { /* 昵称只是展示用，体检才是硬指标 */ }
      SECRETS.netease = {
        uid, cookie: ck, nickname,
        savedAt: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
      };
      writeJSON(SECRETS_FILE, SECRETS);
      try { fs.chmodSync(SECRETS_FILE, 0o600); } catch { /* 改不动也不拦业务 */ }
      const pr = await neProbe();
      const vp = await neVipInfo();
      const h = neSaveHealth(pr, 'manual', vp);
      console.log('[ne] 扫码换证成功 uid=' + (uid || '-') + '，体检 level=' + pr.level
        + '（cookie ' + ck.length + ' B）');
      return sendJSON(res, { ok: true, state: 4, msg: '已接通', uid, nickname, result: pr, health: h, vip: vp });
    }

    if (p === '/api/admin/ne/expire' && req.method === 'POST') {
      const me = adminOf(req, res, true); if (!me) return;
      const b = await readBody(req).catch(() => ({}));
      const d = String(b.expireAt || '').trim();
      if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        return sendJSON(res, { ok: false, error: '到期日要 YYYY-MM-DD 格式' }, 400);
      }
      const f = path.join(DATA_DIR, 'ne-vip.json');
      const v = readJSON(f, {}) || {};
      v.expireAt = d;
      v.manual = !!d;          /* 填了就以手工为准；清空则交回自动读取 */
      v.auto = false;
      v.notifyDays = Math.max(1, Math.min(60, parseInt(b.notifyDays, 10) || 7));
      v.updatedAt = Date.now();
      v.updatedBy = me.uid;
      writeJSON(f, v);
      return sendJSON(res, { ok: true, vip: v });
    }

    if (p === '/api/admin/user/role' && req.method === 'POST') {
      const me = adminOf(req, res); if (!me) return;
      const b = await readBody(req).catch(() => ({}));
      const u = USERS[String(b.uid || '').trim()];
      if (!u) return sendJSON(res, { ok: false, error: '账号不存在' }, 404);
      if (u.role === 'superadmin') return sendJSON(res, { ok: false, error: '开发者账号不能改动' }, 403);
      u.role = (String(b.role || '') === 'admin') ? 'admin' : '';
      writeJSON(USERS_FILE, USERS);
      return sendJSON(res, { ok: true, role: roleOf(u) });
    }

    if (p === '/api/admin/user/del' && req.method === 'POST') {
      const me = adminOf(req, res); if (!me) return;
      const b = await readBody(req).catch(() => ({}));
      const uid = String(b.uid || '').trim();
      const u = USERS[uid];
      if (!u) return sendJSON(res, { ok: false, error: '账号不存在' }, 404);
      if (u.role === 'superadmin') return sendJSON(res, { ok: false, error: '这是开发者账号，不能注销' }, 403);
      if (uid === me.uid) return sendJSON(res, { ok: false, error: '别在这儿注销自己，去「我 → 注销账号」' }, 400);
      const cleaned = purgeUser(uid, me.username);
      delete USERS[uid];
      writeJSON(USERS_FILE, USERS);
      let killed = 0;
      for (const t of Object.keys(SESSIONS)) if (SESSIONS[t] && SESSIONS[t].uid === uid) { delete SESSIONS[t]; killed++; }
      writeJSON(SESSIONS_FILE, SESSIONS);
      return sendJSON(res, { ok: true, cleaned, killed });
    }

    if (p === '/api/admin/transfer' && req.method === 'POST') {
      const me = adminOf(req, res, true); if (!me) return;
      const b = await readBody(req).catch(() => ({}));
      const to = USERS[String(b.uid || '').trim()];
      if (!to) return sendJSON(res, { ok: false, error: '目标账号不存在' }, 404);
      if (to.uid === me.uid) return sendJSON(res, { ok: false, error: '已经是开发者了' }, 400);
      me.role = 'admin'; to.role = 'superadmin';
      writeJSON(USERS_FILE, USERS);
      return sendJSON(res, {
        ok: true,
        from: { uid: me.uid, username: me.username, role: 'admin' },
        to: { uid: to.uid, username: to.username, role: 'superadmin' }
      });
    }

    /* ── 上传审核 ── */
    if (p === '/api/admin/uploads') {
      const me = adminOf(req, res); if (!me) return;
      const st = String(Q('state') || '').trim();
      let list = readUploads().list.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
      if (st) list = list.filter(t => t.state === st);
      return sendJSON(res, {
        ok: true,
        list: list.map(t => Object.assign(pubTrack(t), {
          uploader: (USERS[t.uid] && USERS[t.uid].username) || '（已注销）'
        }))
      });
    }
    if (p === '/api/admin/uploads/file') {
      const me = adminOf(req, res); if (!me) return;
      const t = readUploads().list.find(x => x.id === String(Q('id') || '').trim());
      if (!t || !t.file) return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      const fp = path.join(UPLOAD_DIR, String(t.file).replace(/[\\/]/g, ''));
      if (!fs.existsSync(fp)) return send(res, 404, '文件没了', { 'Content-Type': 'text/plain; charset=utf-8' });
      const ct = ({ mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', aac: 'audio/aac' })[t.ext] || 'audio/mpeg';
      /* ★ U-27：和 /api/music/file 同一套 Range 逻辑，复用模块级 parseRange()。
         管理端审核预览用的就是 <audio controls>（web/admin.html:1112，以及
         web/index.html:11540 里内嵌的审核面板），之前同样声明了 Accept-Ranges
         却不认 Range，走 send() 的 chunked 下发没有 Content-Length —— 管理员
         点播放，时长一样是 Infinity、进度条一样拖不动。
         ⚠️ 审核预览不计 plays：原来这里就没有累加播放数，保持原样。 */
      const st = fs.statSync(fp);
      const total = st.size;
      let rg = parseRange(req.headers.range, total);
      const base = {
        'Content-Type': ct,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
        ETag: '"' + total + '-' + Math.floor(st.mtimeMs) + '"',
        'Last-Modified': st.mtime.toUTCString()
      };
      const isHEAD = req.method === 'HEAD';

      /* If-Range 对不上 → 忽略 Range 回 200 整段，避免拿新文件的字节拼旧数据。
         RFC 7233 §3.2。 */
      const ifRange = String(req.headers['if-range'] || '').trim();
      if (ifRange && ifRange !== base.ETag && !rg.full && !rg.bad) rg = { full: true };

      if (rg.bad) {
        res.writeHead(416, {
          ...CORS, 'Content-Type': 'text/plain; charset=utf-8',
          'Content-Range': 'bytes */' + total, 'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store', 'Content-Length': '0'
        });
        return res.end(isHEAD ? undefined : '');
      }
      /* 整段也走流，不 readFileSync —— 40MB 的文件不会一次性压进内存 */
      const from = rg.full ? 0 : rg.start;
      const to = rg.full ? total - 1 : rg.end;
      if (rg.full) {
        res.writeHead(200, { ...CORS, ...base, 'Content-Length': String(total) });
      } else {
        res.writeHead(206, {
          ...CORS, ...base,
          'Content-Range': 'bytes ' + from + '-' + to + '/' + total,
          'Content-Length': String(to - from + 1)
        });
      }
      if (isHEAD) return res.end();
      try {
        return await pipeline(fs.createReadStream(fp, { start: from, end: to }), res);
      } catch (e) {
        /* 管理端点了「通过」之后会立刻切走，连接中断是常态，就地兜住 */
        if (!res.headersSent) {
          try { send(res, 500, '读取失败：' + humane(e), { 'Content-Type': 'text/plain; charset=utf-8' }); } catch { /* 连接已经没了 */ }
        } else {
          try { res.destroy(); } catch { /* 连接已经没了 */ }
        }
      }
      return;
    }
    if (p === '/api/admin/uploads/review' && req.method === 'POST') {
      const me = adminOf(req, res); if (!me) return;
      const b = await readBody(req).catch(() => ({}));
      const o = readUploads();
      const t = o.list.find(x => x.id === String(b.id || '').trim());
      if (!t) return sendJSON(res, { ok: false, error: '找不到这首' }, 404);
      const pass = (String(b.pass) === '1') || b.pass === true;
      t.state = pass ? 'approved' : 'rejected';
      t.reason = pass ? '' : String(b.reason || '').slice(0, 200);
      t.reviewAt = Date.now(); t.reviewBy = me.uid;
      writeUploads(o);
      return sendJSON(res, { ok: true, state: t.state });
    }
    /* ── 头像审核 ──
       跟音频审核同一套手势：列表 → 看 → 通过 / 驳回（带理由）。
       差别只在"通过"时要顺手把这张设成该账号对外生效的头像。 */
    if (p === '/api/admin/avatars') {
      const me = adminOf(req, res); if (!me) return;
      const st = String(Q('state') || '').trim();
      let list = readAvatars().list.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
      if (st) list = list.filter(t => t.state === st);
      return sendJSON(res, {
        ok: true,
        list: list.slice(0, 300).map(t => ({
          id: t.id, uid: t.uid, ext: t.ext, size: t.size || 0, at: t.at || 0,
          state: t.state, reason: t.reason || '', reviewAt: t.reviewAt || 0,
          /* 谁通过的：管理员审的是 uid，开发者自己换的是 'self'。
             翻旧账时要能分清这两种，所以这个字段必须带出来。 */
          reviewBy: t.reviewBy || '',
          /* 队列里存了上传那一刻的昵称：账号后来改名 / 注销了，审核员
             看到的仍然是"这图是谁传的"，不会变成一片空白。 */
          uploader: t.username || ((USERS[t.uid] && USERS[t.uid].username) || '（已注销）'),
          current: avatarUrlOf(USERS[t.uid] || {})      // 该账号当前生效的头像（旧图）
        }))
      });
    }
    if (p === '/api/admin/avatars/file') {
      const me = adminOf(req, res); if (!me) return;
      /* 审核要看的是待审的图，所以这里不看 state —— 能进管理台的才拿得到 */
      const t = readAvatars().list.find(x => x.id === String(Q('id') || '').trim());
      if (!t || !t.file) return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      const fp = path.join(AVATAR_DIR, String(t.file).replace(/[\\/]/g, ''));
      if (!fs.existsSync(fp)) return send(res, 404, '文件没了', { 'Content-Type': 'text/plain; charset=utf-8' });
      return send(res, 200, fs.readFileSync(fp), {
        'Content-Type': AVATAR_MIME[t.ext] || 'image/jpeg',
        'Cache-Control': 'private, max-age=3600'
      });
    }
    if (p === '/api/admin/avatars/review' && req.method === 'POST') {
      const me = adminOf(req, res); if (!me) return;
      const b = await readBody(req).catch(() => ({}));
      const o = readAvatars();
      const t = o.list.find(x => x.id === String(b.id || '').trim());
      if (!t) return sendJSON(res, { ok: false, error: '找不到这张头像' }, 404);
      const pass = (String(b.pass) === '1') || b.pass === true;
      t.state = pass ? 'approved' : 'rejected';
      t.reason = pass ? '' : String(b.reason || '').slice(0, 200);
      t.reviewAt = Date.now(); t.reviewBy = me.uid;
      const u = USERS[t.uid];
      if (u) {
        if (pass) {
          /* 通过：这一刻才"上车" —— 对外生效的头像换成这张，旧图文件回收。 */
          const old = u.avatar;
          u.avatar = { id: t.id, file: t.file, ext: t.ext, at: t.at };
          u.avatarPending = ''; u.avatarReason = '';
          if (old && old.file && old.file !== t.file) {
            try { fs.rmSync(path.join(AVATAR_DIR, String(old.file).replace(/[\\/]/g, '')), { force: true, maxRetries: 2, retryDelay: 150 }); } catch { }
          }
        } else {
          /* 驳回：u.avatar 一个字都不动，对外还是旧头像 / 字母块；
             理由写到账号上，本人下次进「我」页能看到。 */
          u.avatarPending = '';
          u.avatarReason = t.reason;
        }
      }
      writeAvatars(o);
      writeJSON(USERS_FILE, USERS);
      return sendJSON(res, { ok: true, state: t.state });
    }
    if (p === '/api/admin/uploads/delete' && req.method === 'POST') {
      const me = adminOf(req, res); if (!me) return;
      const b = await readBody(req).catch(() => ({}));
      const o = readUploads();
      const i = o.list.findIndex(x => x.id === String(b.id || '').trim());
      if (i < 0) return sendJSON(res, { ok: false, error: '找不到这首' }, 404);
      const t = o.list[i];
      o.list.splice(i, 1);
      writeUploads(o);
      let removed = false;
      if (t.file) {
        try { fs.rmSync(path.join(UPLOAD_DIR, t.file), { force: true, maxRetries: 2, retryDelay: 150 }); removed = true; } catch { /* ignore */ }
      }
      return sendJSON(res, { ok: true, fileRemoved: removed });
    }

    /* ── 公告 ── */
    if (p === '/api/admin/notice') {
      const me = adminOf(req, res); if (!me) return;
      const all = readJSON(NOTICE_FILE, { list: [] });
      const list = (Array.isArray(all.list) ? all.list.slice() : []).sort((a, b) => (b.at || 0) - (a.at || 0));
      return sendJSON(res, { ok: true, list });
    }
    if (p === '/api/admin/notice/post' && req.method === 'POST') {
      const me = adminOf(req, res); if (!me) return;
      const b = await readBody(req).catch(() => ({}));
      const title = String(b.title || '').trim().slice(0, 80);
      if (!title) return sendJSON(res, { ok: false, error: '标题不能为空' }, 400);
      const all = readJSON(NOTICE_FILE, { list: [] });
      if (!Array.isArray(all.list)) all.list = [];
      let points = [];
      if (Array.isArray(b.points)) points = b.points.map(x => String(x).slice(0, 200));
      else points = String(b.points || '').split('\n').map(x => x.trim()).filter(Boolean);
      const item = {
        id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type: 'notice', title,
        body: String(b.body || '').slice(0, 2000),
        points: points.slice(0, 12),
        top: !!b.top, at: Date.now(), by: me.uid, byName: me.username || ''
      };
      all.list.unshift(item);
      all.list = all.list.slice(0, 200);
      writeJSON(NOTICE_FILE, all);
      return sendJSON(res, { ok: true, id: item.id });
    }
    if (p === '/api/admin/notice/delete' && req.method === 'POST') {
      const me = adminOf(req, res); if (!me) return;
      const b = await readBody(req).catch(() => ({}));
      const all = readJSON(NOTICE_FILE, { list: [] });
      const n = (all.list || []).length;
      all.list = (all.list || []).filter(x => x.id !== String(b.id || '').trim());
      writeJSON(NOTICE_FILE, all);
      return sendJSON(res, { ok: true, removed: n - all.list.length });
    }

    /* ── 邮箱白名单：留空=不限制（跟手机号注册口径一致） ── */
    /* ⚠️ 必须排除 POST：下面那个写接口路径一模一样，
       不判方法的话 POST 会被这个 GET 分支先截胡，永远写不进去。 */
    if (p === '/api/admin/whitelist' && req.method !== 'POST') {
      const me = adminOf(req, res); if (!me) return;
      return sendJSON(res, { ok: true, allow: allowList() });
    }
    if (p === '/api/admin/whitelist' && req.method === 'POST') {
      const me = adminOf(req, res); if (!me) return;
      const b = await readBody(req).catch(() => ({}));
      /* 一行一个，也接受逗号分隔；空 = 不限制任何人 */
      const raw = Array.isArray(b.allow) ? b.allow.join('\n') : String(b.allow || '');
      const list = raw.split(/[\n,，;；\s]+/).map(x => normEmail(x)).filter(x => isEmail(x));
      try {
        const f = path.join(DATA_DIR, 'secrets.json');
        const sec = readJSON(f, {});
        sec.auth = sec.auth || {};
        sec.auth.allow = list;
        writeJSON(f, sec);
        /* 让内存里的副本立刻跟上，不然要等下一次文件变更检测 */
        try { SECRETS.auth = Object.assign({}, SECRETS.auth || {}, { allow: list }); } catch { /* ignore */ }
      } catch (e) {
        return sendJSON(res, { ok: false, error: humane(e, '保存失败了，重试一下') }, 500);
      }
      return sendJSON(res, { ok: true, allow: list });
    }

    /* ── 授权码：只有开发者能看能改 ── */
    /* 同上：不判方法的话，改授权码的 POST 会被这个读分支吃掉 */
    if (p === '/api/admin/code' && req.method !== 'POST') {
      const me = adminOf(req, res, true); if (!me) return;
      const c = getAdminCode();
      const masked = c.length <= 4 ? '••••' : (c.slice(0, 2) + '•'.repeat(Math.min(8, c.length - 4)) + c.slice(-2));
      /* 默认只给掩码。带 reveal=1 才给明文 —— 反正这个接口本来就只放开发者进来，
         而开发者本来就需要知道自己的授权码去发给别人。 */
      const out = { ok: true, hint: masked, len: c.length };
      if (Q('reveal') === '1') out.code = c;
      return sendJSON(res, out);
    }
    if (p === '/api/admin/code' && req.method === 'POST') {
      const me = adminOf(req, res, true); if (!me) return;
      const b = await readBody(req).catch(() => ({}));
      const c = String(b.code || '').trim();
      if (c.length < 4) return sendJSON(res, { ok: false, error: '授权码至少 4 位' }, 400);
      setAdminCode(c);
      return sendJSON(res, { ok: true, len: c.length });
    }

    /* 已经注册的普通用户，凭授权码把自己升成管理员 */
    /* 防爆破：授权码是唯一闸门，不限速的话公网上可以一秒几百次地试。
       键 = IP + uid，10 分钟窗口最多 5 次错码，超了就锁到窗口结束。 */
    if (p === '/api/admin/claim' && req.method === 'POST') {
      const sess = userOf(req);
      const me = sess && sess.user;
      if (!me) return sendJSON(res, { ok: false, error: '未登录' }, 401);
      /* ⚠ 限速键只认 socket 远端地址，**不看** X-Forwarded-For。
         云上是端口直连、前面没有反向代理解这个头，于是 XFF 是纯客户端输入：
         以前 `XFF || socket` 的写法意味着攻击者每试一次就换一个 XFF，
         ck 就永远是个全新的键、计数永远是 1 —— 这道「10 分钟 5 次」的闸门
         等于没装，公网可以无限试管理员授权码。

         也不能写成「XFF 非空就用 XFF」那种回落式：只要请求里带了一个假的
         XFF，就永远走不到 socket 分支，改了等于没改。在没有可信反向代理的
         部署形态下，唯一不能伪造的就是 TCP 连接对端的地址。 */
      const _ip = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
      const ck = _ip + '|' + me.uid;
      const now0 = Date.now();
      let cl = CLAIM_TRIES.get(ck);
      if (!cl || now0 - cl.t0 > 600000) { cl = { t0: now0, n: 0 }; CLAIM_TRIES.set(ck, cl); }
      const waitMin = Math.ceil((600000 - (now0 - cl.t0)) / 60000);
      /* 锁了就是锁了：以前只在**错码**的分支里喊一句「错得太多」，
         码对了照样放行 —— 计数只影响文案，不限速，注释里那句
         「超了就锁到窗口结束」其实从没兑现过。
         先把这道闸放在校验之前，窗口内剩下的时间码对也不给过。 */
      if (cl.n >= 5) {
        return sendJSON(res, { ok: false, error: '错得太多，' + waitMin + ' 分钟后再试' }, 403);
      }
      const b = await readBody(req).catch(() => ({}));
      if (String(b.code || '').trim() !== getAdminCode()) {
        cl.n++;
        /* 第 5 次错码这里就把话说满（下一次请求会被上面那道闸挡住，
           轮不到再错一次才知道自己被锁了） */
        return sendJSON(res, {
          ok: false,
          error: cl.n >= 5 ? '错得太多，' + waitMin + ' 分钟后再试' : '授权码不对'
        }, 403);
      }
      CLAIM_TRIES.delete(ck);
      if (isAdmin(me)) return sendJSON(res, { ok: true, role: roleOf(me), tip: '已经是管理员了' });
      me.role = 'admin';
      writeJSON(USERS_FILE, USERS);
      return sendJSON(res, { ok: true, role: 'admin' });
    }

    /* 账号回收入口：PC 端 exe 把账号推回主库（详见 mergeRemoteUser 注释）
     * 公网隧道上谁都能调，所以要么带 syncKey，要么只允许本机。 */
    if (p === '/api/sync/push' && req.method === 'POST') {
      const need = String((SECRETS.sync && SECRETS.sync.key) || '');
      const got = String(req.headers['x-sync-key'] || '');
      if (!isLoopback && (!need || got !== need)) {
        return sendJSON(res, { ok: false, error: '同步密钥不对（或没在主服务配置 sync.key）' }, 403);
      }
      const b = await readBody(req);
      const incoming = b.user ? [b.user] : Object.values(b.users || {});
      if (!incoming.length) return sendJSON(res, { ok: false, error: '没有账号数据' }, 400);
      let added = 0, merged = 0;
      for (const u of incoming) {
        if (!u || typeof u !== 'object') continue;
        const r = mergeRemoteUser(u, b.clientId || '');
        if (!r) continue;
        r.isNew ? added++ : merged++;
      }
      writeJSON(USERS_FILE, USERS);
      return sendJSON(res, { ok: true, added, merged, total: Object.keys(USERS).length });
    }

    /* SMTP 配置：只读接口永不返回授权码；写接口仅限本机（公网隧道上不能改） */
    if (p === '/api/auth/smtp' && req.method === 'GET') {
      const c = smtpCfg();
      return sendJSON(res, {
        ok: true, configured: !!(c.user && c.pass),
        host: c.host, port: c.port, user: c.user, from: c.from, allow: allowList()
      });
    }
    if (p === '/api/auth/smtp' && req.method === 'POST') {
      if (!isLoopback) return sendJSON(res, { ok: false, error: '为了安全，只有本机可以改发信配置' });
      const b = await readBody(req);
      const s = SECRETS.smtp || (SECRETS.smtp = {});
      if (b.host != null) s.host = String(b.host).trim() || 'smtp.qq.com';
      if (b.port != null) s.port = Number(b.port) || 465;
      if (b.user != null) s.user = String(b.user).trim();
      if (b.pass) s.pass = String(b.pass).trim();          // 留空表示不改，避免误清
      if (b.from != null) s.from = String(b.from).trim() || s.user;
      if (Array.isArray(b.allow)) SECRETS.auth = { allow: b.allow.map(normEmail).filter(Boolean) };
      writeJSON(SECRETS_FILE, SECRETS);
      return sendJSON(res, { ok: true, configured: !!(s.user && s.pass), user: s.user, allow: allowList() });
    }

    /* ---- 播放记录（登录后按账号存服务端） ---- */
    if (p === '/api/history') {
      const au = userOf(req);
      if (!au) return sendJSON(res, { ok: false, logged: false, error: '未登录' });
      const rec = au.user;
      const keyOf = x => String(x.key || (x.source || '') + ':' + (x.id || x.hash || x.songname || ''));
      if (req.method === 'GET') return sendJSON(res, { ok: true, list: rec.history || [] });
      if (req.method === 'DELETE') {
        /* 带 ?key= 就删这一条（列表里长按/右键删单首），不带才是清空。
           早先是「DELETE 一律清空」，界面上想删一首就只能清全表。 */
        const k = Q('key');
        const list = rec.history || [];
        rec.history = k ? list.filter(x => keyOf(x) !== k) : [];
        writeJSON(USERS_FILE, USERS);
        return sendJSON(res, { ok: true, list: rec.history });
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        const item = b.item;
        if (!item || typeof item !== 'object') return sendJSON(res, { ok: false, error: '缺少 item' });
        const key = keyOf(item);
        const list = rec.history || (rec.history = []);
        const i = list.findIndex(x => keyOf(x) === key);
        const merged = { ...(i >= 0 ? list[i] : {}), ...item, key, at: Date.now() };
        if (i >= 0) list.splice(i, 1);
        list.unshift(merged);
        rec.history = list.slice(0, 500);      // 上限 500 条，避免文件无限膨胀
        writeJSON(USERS_FILE, USERS);
        return sendJSON(res, { ok: true, list: rec.history });
      }
    }

    /* ---- 收藏（登录后按账号存服务端，换设备同步） ---- */
    if (p === '/api/fav') {
      const au = userOf(req);
      if (!au) return sendJSON(res, { ok: false, logged: false, error: '未登录' });
      const rec = au.user;
      const keyOf = it => String(it.key || (it.source || '') + ':' + (it.id || it.hash || it.songname || ''));
      if (req.method === 'GET') return sendJSON(res, { ok: true, list: rec.favs || [] });
      if (req.method === 'DELETE') {
        const k = Q('key');
        const list = rec.favs || [];
        rec.favs = k ? list.filter(x => keyOf(x) !== k) : [];
        writeJSON(USERS_FILE, USERS);
        return sendJSON(res, { ok: true, list: rec.favs });
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        const item = b.item;
        if (!item || typeof item !== 'object') return sendJSON(res, { ok: false, error: '缺少 item' });
        const key = keyOf(item);
        const list = rec.favs || (rec.favs = []);
        const i = list.findIndex(x => keyOf(x) === key);
        let liked;
        if (i >= 0 && b.toggle) {                    // 再点一次＝取消收藏
          list.splice(i, 1); liked = false;
        } else {
          const merged = { ...(i >= 0 ? list[i] : {}), ...item, key, at: Date.now() };
          if (i >= 0) list.splice(i, 1);
          list.unshift(merged); liked = true;
        }
        rec.favs = list.slice(0, 1000);
        writeJSON(USERS_FILE, USERS);
        return sendJSON(res, { ok: true, list: rec.favs, liked });
      }
    }

    /* ---- 配置 / 目录 ---- */
    /* GET 也要跑一次体检（不只是启动那一次）。
       背景（能力矩阵 §3.1 第 1、2 条）：healDir() 只在模块启动时跑过一次，
       用户运行时设了个坏目录，要等下次重启才被纠正 —— 中间这段时间的下载
       直接失败；而且体检结果只进 console.log，界面上一个字都没有，
       于是「歌被静默存到了另一个地方」这种事用户永远不知道。
       现在改成每次请求顺手体检一次，代价是一次 canWriteIn()（写一个临时文件
       再删），跟一次 stat 差不多，可以忽略。 */
    if (p === '/api/config' && req.method === 'GET') {
      const healed = healDir();          // 目录坏了就地改存
      if (healed) {
        DIR_HEAL = healed;               // 启动日志那句也随之更新
        PENDING_HEAL = healed;
      }
      const h = healed ? { exists: true, creatable: true, reason: '' } : dirHealth(CFG.downloadDir);
      /* dirHeal 一次只报一次：用户看过了、点了「知道了」，这事就该翻篇。
         reason 一并带上很重要 —— 「U 盘拔了」和「权限不够」在界面上是两种说法，
         而 healDir() 落地之后 creatable 已经变回 true，这里那个 reason
         是唯一还能说清「原来是哪种病」的地方。 */
      const dirHeal = PENDING_HEAL
        ? { from: PENDING_HEAL.from, to: PENDING_HEAL.to, reason: PENDING_HEAL.reason || '' }
        : null;
      PENDING_HEAL = null;
      let free = 0; try { const st = fs.statfsSync(h.exists ? CFG.downloadDir : APP_DIR); free = st.bavail * st.bsize; } catch { /* ignore */ }
      return sendJSON(res, {
        ok: true, downloadDir: CFG.downloadDir, exists: h.exists, creatable: h.creatable,
        reason: h.reason || '', dirHeal, freeText: free ? fmtSize(free) : '',
        concurrency: TASK_MAX_CONCURRENCY, version: APP_VERSION, sea: IS_SEA, platform: process.platform,
        /* 网页端「改用安全连接」用。空串 = 本站没有 https 入口，前端不显示那颗按钮。 */
        httpsUrl: HTTPS_URL
      });
    }
    if (p === '/api/config' && req.method === 'POST') {
      /* 🔴 downloadDir 和 concurrency 都是**服务端全局**的：改一下，所有人的下载
         落点都跟着变。以前这个口子裸奔，谁都能 POST 一条把下载位置改到别处去。
         规矩跟 /api/auth/smtp 一致（「只有本机可以改发信配置」）：
           本机自用（桌面端 / 本地脚本）→ 登录即可；
           公网 / 局域网部署（HOST=0.0.0.0）→ 还得是管理员。
         原因很直接：桌面上改的是自己的机器，云上改的是所有人的机器。 */
      const _sess = userOf(req);
      if (!_sess || !_sess.user)
        return sendJSON(res, { ok: false, needLogin: true, error: '改下载目录需要先登录账号' }, 401);
      if (!isLocalReq(req) && !isAdmin(_sess.user))
        return sendJSON(res, { ok: false, error: '下载目录是服务端全局配置，只有管理员能改' }, 403);
      const b = await readBody(req);
      /* 🔴 downloadDir 必须过一遍与 browse/mkdir/reveal 同一套 allow/deny 判据。
         背景（D1 的绕过口子，P0）：computeAllowedFsRoots() 把「当前下载目录」
         算作允许根之一，而 sysPathDeny() 那张黑名单只点名系统目录。以前这里
         不校验，于是：
             POST /api/config {downloadDir:"/home/别人的目录"} → 设成功
             → 它进了允许根 → browse 它 → 白名单放行、黑名单没写它 → 200 能列
         也就是说黑名单挡得住系统目录、挡不住「别人的目录」。设 C:/Windows 时
         没出事只是因为它恰好落在 SYS_DENY_WIN 里 —— 那是运气，不是设计。
         所以这里走 fsApiGuard()（白名单 fsPathReachable → 黑名单 sysPathDeny，
         与那三个磁盘接口同一个门禁）：被拒时它自己已经把 403 发回去了，
         这里只负责 return。以后门禁再加层，这条自动跟上。
         ⚠️ 校验放在**任何赋值之前**，downloadDir 被拒时 concurrency 也不落盘
         —— 一条请求要么整体生效要么整体不生效，别留下「目录没改成但并发改了」
         这种半截状态。 */
      if (b.downloadDir?.trim()) {
        const wantDir = b.downloadDir.trim();
        if (!fsApiGuard(req, res, wantDir)) return;
        /* 🔴 光过黑白名单不够，还得**真的能写**。
           踩过的坑：设置页那排盘符按钮点一下就 setDir('D:\\')，而盘根在
           Windows 上 mkdirSync 直接 EPERM —— 黑白名单都不拦（D 盘不是系统目录），
           于是这个不可写的路径被存进 config。之后每一次「打开下载文件夹」
           /api/opendir 都在 mkdirSync 上抛异常回 500，下载任务也建不了目录。
           更糟的是前端 setDir 无条件 toast「下载位置已切到 D:\\」，
           用户看到的是"成功了"，实际整个下载链路已经废了。
           所以用同一种方式做一次真实探测，不通过就整条请求拒掉。 */
        if (!pathWritable(wantDir)) {
          return sendJSON(res, {
            ok: false,
            error: '这个位置不能写入：' + wantDir + '。换一个文件夹（比如「下载」或「音乐」下面的子目录）',
          }, 400);
        }
        CFG.downloadDir = wantDir; saveConfig();
      }
      if (b.concurrency != null) {
        const n = Math.min(4, Math.max(1, parseInt(b.concurrency, 10) || 2));
        TASK_MAX_CONCURRENCY = n; CFG.concurrency = n; saveConfig();
        pumpTasks();     // 调大并发后立刻把排队的跑起来
      }
      return sendJSON(res, { ok: true, downloadDir: CFG.downloadDir, concurrency: TASK_MAX_CONCURRENCY, exists: fs.existsSync(CFG.downloadDir) });
    }
    if (p === '/api/opendir' && req.method === 'POST') {
      /* ★ 这里不能无脑 mkdirSync：config 里完全可能留着一条「盘根 / 无权限目录」
         （旧版本允许把 D:\ 直接存进 downloadDir）。那种路径 mkdir 会 EPERM，
         被外层 catch 兜成 500「没有权限读写这个位置」—— 用户看到的只是
         "服务器坏了"，既不知道坏在哪，也不知道怎么救。
         先探一次可写性（顺带把还不存在的目录建出来），不成回 400 并指路。 */
      if (!pathWritable(CFG.downloadDir)) {
        return sendJSON(res, {
          ok: false,
          error: '下载目录不能写入：' + CFG.downloadDir + '。请到「设置 → 下载位置」换一个可写的文件夹（例如 ' +
            (process.platform === 'win32' ? 'D:\YMusic' : '~/Music/YMusic') + '）',
        }, 400);
      }
      // 服务器上没有桌面，revealNative 会自己返回 opened:false，不会报错
      const opened = revealNative(CFG.downloadDir, false);
      return sendJSON(res, { ok: true, dir: CFG.downloadDir, opened });
    }

    send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  } catch (e) {
    /* 请求体超限：readBody 会在 req 上留 _bodyTooBig 标记。
     * 这里必须先认它 —— 不认的话会按 500 回出去，客户端只知道「服务器
     * 出问题了」，还是看不到「请求体太大」这个真正的原因。 */
    if (req._bodyTooBig) {
      try { sendJSON(res, { ok: false, error: '请求体太大了' }, 413); } catch { /* ignore */ }
      return;
    }
    console.error('[500]', p, e && e.stack ? e.stack : e);
    try { sendJSON(res, { ok: false, error: humane(e, '服务器出了点问题，稍后再试') }, 500); } catch { /* ignore */ }
  }
});

let PORT = int(process.env.PORT, 8788, 1024, 65000);
// 监听地址：默认只绑本机。要让手机/局域网访问（或部署到云），设 HOST=0.0.0.0。
const BIND_HOST = process.env.HOST || '127.0.0.1';
/* ---- U-41：三条连接层上限 ----
 * headersTimeout：收完请求头的时限。慢速攻击（一点点吐头）靠它掐，15 秒足够
 *   任何正常客户端发完头。
 * requestTimeout：收完整个请求的时限。⚠️ 是 300000 不是 60000 —— /api/upload
 *   非分片通道还能整文件传 40MB（MAX_UPLOAD），弱网上行 100KB/s 就要 400 秒；
 *   分片通道单片 2MB 在 20KB/s 上行也要 102 秒。写 60000 不是加固，是把 Node
 *   默认的 300 秒砍成 60 秒，等于掐掉弱网上传。
 * maxConnections：并发连接上限。默认无限制，2000 是留足余量的天花板。 */
server.headersTimeout = 15000;
server.requestTimeout = 300000;
server.maxConnections = 2000;
server.on('error', e => {
  if (e.code === 'EADDRINUSE' && PORT < 8818) { PORT += 1; server.listen(PORT, BIND_HOST); }
  else { console.error('启动失败:', e.message); process.exit(1); }
});
/* ★ U-25：开监听之前先跑一遍音乐圈老评论的主键迁移（只写一次盘，见函数上的注释） */
migrateMomentCids();
server.listen(PORT, BIND_HOST, () => {
  console.log('\n  YMusic 音乐下载器 已启动');
  console.log('  ────────────────────────────────');
  console.log(`  本机地址：http://127.0.0.1:${PORT}`);
  if (BIND_HOST === '0.0.0.0') {
    for (const ip of lanAddrs()) console.log(`  局域网：  http://${ip}:${PORT}   ← 手机同一 WiFi 可用（http 只能加网页快捷方式）`);
  }
  const pu = publicUrl();
  if (pu) console.log(`  公网 https：${pu}   ← 手机用这个能真正「安装成 App」`);
  console.log(`  音源平台：酷狗 · 网易云 · QQ音乐 · B站 · 抖音`);
  console.log(`  保存目录：${CFG.downloadDir}`);
  if (DIR_HEAL) {
    console.log(`  ⚠ 原来设的目录不能用了：${DIR_HEAL.from}`);
    console.log(`    已自动改存到：${DIR_HEAL.to}`);
    console.log('    （想存别处，去「设置 → 下载」里改）');
  }
  /* U-40：这个黑框现在是 SEA 版**唯一**的反馈面。
   * 原来只写「关闭本窗口即退出程序」——用户双击后看到一闪而过的控制台，
   * 既不知道成没成，也不知道接下来该干嘛，于是判定「安装失败 / 打开失败」。
   * 这行不动业务，只补两句「接下来做什么」，把黑框从「像报错」改成「像说明」。 */
  console.log('');
  console.log('  ✅ 服务已经跑起来了，上面这个地址在浏览器里打开就能用。');
  console.log('  ⚠ 这个黑窗口就是程序本体，别关它 —— 关掉服务就停了。');
  console.log('     想关的时候：在这个窗口按 Ctrl+C，或直接关掉它。\n');
  try { writeFileAtomic(path.join(APP_DIR, 'runtime.json'), JSON.stringify({ port: PORT, pid: process.pid, dir: CFG.downloadDir, sea: IS_SEA }, null, 2), 'utf8'); } catch { /* ignore */ }
  /* OTA 自检：启动 3 秒后查一次，之后每 30 分钟。全程静默失败，绝不影响正常使用。 */
  if (IS_SEA) {
    const tick = () => {
      checkAppUpdate().then(r => {
        if (r && r.changed && r.changed.length) {
          console.log(`  已更新到前端 v${r.version}（${r.changed.join('、')}），刷新页面即可生效`);
        }
      }).catch(() => { });
    };
    setTimeout(tick, 3000);
    const timer = setInterval(tick, UPDATE_CHECK_MS);
    if (timer.unref) timer.unref();
  }
  // 双击 exe 启动时自动开浏览器；脚本方式仍由 OPEN=1 控制
  if (process.env.OPEN === '1' || (IS_SEA && process.env.OPEN !== '0')) {
    const cmd = process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', `http://127.0.0.1:${PORT}`] : [`http://127.0.0.1:${PORT}`];
    try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
  }
});
