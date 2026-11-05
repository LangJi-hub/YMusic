/* YMusic 账号管理台 —— 独立运维进程
 *
 * 设计前提（很重要）：
 *   1. 这是**独立于主服务**的进程，端口 8803，只监听 127.0.0.1。
 *      它不启动/停止/重启任何正在运行的 YMusic 服务，也不碰 cloudflared 隧道。
 *   2. 它直接读写各发行版的 data/users.json（和主服务同一份文件），
 *      因此"改完"的可见性取决于主服务是否还在内存里持有旧副本 —— 见下方 sync 说明。
 *   3. 任何写操作都先备份（admin/backups/）再落盘，并记一条操作日志。
 *      删除账号这种不可逆操作，界面上强制二次确认。
 *   4. 零依赖：不装任何 npm 包，node 直接跑，便于随手拷到别的机器上用。
 *
 * 启动：node admin/server.mjs [--port 8803]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* 打包成 exe 后（Node SEA）没有磁盘上的 admin/ 目录：
 *  · 界面 index.html 是内嵌资源，得从 sea.getAsset 取；
 *  · 配置/备份/日志要落到 exe 同目录（可写）下的 admin-data/，不能写回内嵌区；
 *  · 默认的"源"路径也来自打包时内嵌的 sources-default.json。
 * 用 createRequire 探测而不是顶层 import：非 SEA 环境 import 'node:sea' 会直接抛错。 */
let SEA = null;
try { SEA = createRequire(import.meta.url)('node:sea'); } catch { SEA = null; }
const IS_SEA = (() => { try { return !!(SEA && typeof SEA.isSea === 'function' && SEA.isSea()); } catch { return false; } })();

/* OTA / 发布地址兜底：优先用 public-url.txt 的实时值；
 * 只有读不到（比如 exe 被拷到另一台机器上跑）才用它。
 * 打包前由 一键打包.py 自动改写成当时的在线地址。 */
const DEFAULT_ADMIN_BASE = 'http://127.0.0.1:8788';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);                       // 工程根（脚本态）
const EXE_DIR = IS_SEA ? path.dirname(process.execPath) : '';
// 脚本态：东西都放 admin/ 下；exe 态：放 exe 同目录的 admin-data/
const HOME_DIR = IS_SEA ? path.join(EXE_DIR, 'admin-data') : HERE;
const SOURCES_FILE = path.join(HOME_DIR, 'sources.json');
const LOG_FILE = path.join(HOME_DIR, 'admin-log.jsonl');
const BACKUP_DIR = path.join(HOME_DIR, 'backups');

/* 端口可分配：命令行 > 环境变量 > 上次保存的 > 8803。
 * 保存下来的端口落在 admin-data/admin-port.json，exe 版和脚本版各存各的。 */
const PORT_FILE = path.join(HOME_DIR, 'admin-port.json');
function savedPort() {
  try {
    const v = JSON.parse(fs.readFileSync(PORT_FILE, 'utf8'));
    const n = Number(v && v.port);
    return n >= 1024 && n <= 65535 ? n : 0;
  } catch { return 0; }
}
const PORT_ARG = Number((process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || 0);
const PORT_BASE = PORT_ARG || Number(process.env.YM_ADMIN_PORT) || savedPort() || 8803;
let PORT = PORT_BASE;                                  // 实际端口（被占顺延后会变，接口里要回报真实值）
const HOST = '127.0.0.1';                              // 只本机，绝不暴露到公网隧道

/* ---------------- 数据源 ----------------
 * 一个"源" = 某个发行版的数据目录。同一份账号体系可能被多份拷贝割裂
 * （脚本版 / exe 版 / 桌面版 / Electron 用户数据），管理台把它们并列出来，
 * 既能分别查看，也能一键把其它源归集到主源。 */
function expand(p) {
  return String(p || '').replace(/%APPDATA%/gi, process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    .replace(/%LOCALAPPDATA%/gi, process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    .replace(/%USERPROFILE%/gi, os.homedir());
}
function defaultSources() {
  // exe 态没有工程目录可推，默认源是打包时内嵌进去的（含开发机上的真实路径）
  if (IS_SEA) {
    try {
      const j = JSON.parse(SEA.getAsset('sources-default.json', 'utf8'));
      if (Array.isArray(j) && j.length) return j;
    } catch { /* 内嵌配置缺失就退回下面这套相对路径 */ }
  }
  return [
    { id: 'script', name: '脚本版（8802 正在用这个）', dir: path.join(ROOT, 'data'), main: true },
    { id: 'desktop', name: '桌面版 dist\\YMusic-桌面版', dir: path.join(ROOT, 'dist', 'YMusic-桌面版', 'data') },
    { id: 'desktop35', name: '桌面版 v3.5.0 分发目录', dir: path.join(ROOT, 'dist', 'YMusic-桌面版-v3.5.0', 'data') },
    { id: 'exe', name: '单文件 exe 版 dist\\data', dir: path.join(ROOT, 'dist', 'data') },
    { id: 'electron', name: 'Electron 用户数据 %APPDATA%\\YMusic', dir: '%APPDATA%\\YMusic\\data' }
    // 历史备份目录不列进来：里面的账号是旧快照，算进统计只会让数字虚高。
    // 真要回滚旧数据，用下面的「备份 · 日志」页，或点「添加数据源」手动指过去。
  ];
}
function loadSources() {
  let list = null;
  try { list = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8')); } catch { /* 没有就用默认 */ }
  if (!Array.isArray(list) || !list.length) {
    list = defaultSources();
    try { fs.writeFileSync(SOURCES_FILE, JSON.stringify(list, null, 2), 'utf8'); } catch { /* ignore */ }
  }
  const arr = list.map(s => ({ ...s, dir: expand(s.dir) }));
  /* 目录联接（junction）会让好几个源指向同一份真实数据。
   * 不去重的话，同一批账号会被数好几遍（13 个变 65 个），归集时还会自己合并自己。
   * 所以这里按 realpath 判重：后出现的标上 linked = 第一个源的 id。 */
  const seen = new Map();
  for (const s of arr) {
    let real = s.dir;
    try { real = fs.realpathSync(s.dir); } catch { /* 目录还没建，就用字面路径 */ }
    s.real = real;
    if (seen.has(real)) s.linked = seen.get(real);
    else seen.set(real, s.id);
  }
  return arr;
}
try { fs.mkdirSync(HOME_DIR, { recursive: true }); } catch { /* ignore */ }
let SOURCES = loadSources();

/* ---------------- 读写小工具 ---------------- */
function readJSON(file, dflt) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : dflt;
  } catch { return dflt; }
}
/* ⚠️ 原子写：先写同目录的 .tmp，写完整了再 rename 盖上去。
 * 和管理台同进程写的是同一份 data/（users.json / notices.json / manifest.json …），
 * 进程被 kill 时留下半个 JSON，主服务那边 readJSON 就整体失效了。
 * 原理与做法和主服务 server.mjs 里的 writeFileAtomic 一致，这里不重复注释。 */
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
function writeJSON(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2), 'utf8');
}
function srcPath(src, name) { return path.join(src.dir, name); }
function log(op, detail) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify({ at: Date.now(), op, ...detail }) + '\n', 'utf8');
  } catch { /* ignore */ }
}
function readLog(n = 200) {
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch { return []; }
}
/* 写之前一定先备份 —— 管理台是给人"敢下手"用的，出事能一键回滚 */
function backup(src, tag) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const target = path.join(BACKUP_DIR, `${src.id}_${tag}_${ts}.json`);
    const cur = srcPath(src, 'users.json');
    if (fs.existsSync(cur)) fs.copyFileSync(cur, target);
    return path.basename(target);
  } catch { return ''; }
}

/* ---------------- 账号视图 ---------------- */
const maskPhone = p => String(p || '').replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');

/* 真实在线状态。
 * 「隐身」只是对**其它普通用户**隐藏自己，心跳照打、数据照写。
 * 管理台读的是原始心跳，所以隐身的人在这里依然显示「在线（隐身）」——
 * 这正是开发者该看到的东西，不能被用户的隐私设置蒙住。 */
const PRESENCE_WINDOW = 90000;
function presView(pres, uid) {
  const p = (pres || {})[uid];
  if (!p || !p.at) return { online: false, hidden: false, lastSeen: 0, song: null, today: 0, total: 0, device: '' };
  const fresh = Date.now() - Number(p.at) <= PRESENCE_WINDOW;
  return {
    online: fresh,
    hidden: fresh && p.state === 'invisible',
    lastSeen: Number(p.at) || 0,
    song: (fresh && p.song && p.song.name) ? { name: p.song.name, artist: p.song.artist || '' } : null,
    today: Number(p.today) || 0,
    total: Number(p.total) || 0,
    device: p.device || ''
  };
}
function viewUser(u, src, showFull, pres) {
  const pv = presView(pres, u.uid);
  return {
    uid: u.uid,
    username: u.username || '听众',
    /* 角色：superadmin 开发者（不可降级/注销）· admin 管理员 · 其余是普通用户 */
    role: u.role === 'superadmin' ? 'superadmin' : (u.role === 'admin' ? 'admin' : 'user'),
    phone: showFull ? (u.phone || '') : maskPhone(u.phone),
    phoneRaw: u.phone || '',
    email: u.email || '',
    gender: u.gender || '',
    hasPass: !!u.passHash,
    createdAt: u.createdAt || 0,
    lastLogin: u.lastLogin || 0,
    favCount: (u.favs || []).length,
    historyCount: (u.history || []).length,
    /* 注册来源 / 最后登录设备。
     * 老账号和 exe 版注册的账号没有这些字段（exe 内嵌的是打包时的旧代码，
     * 不重打包就记不了），统一标成 unknown，前端显示「未标记·本地客户端」。 */
    regSrc: u.regSrc || 'unknown',
    regDevice: u.regDevice || '',
    lastSrc: u.lastSrc || 'unknown',
    lastDevice: u.lastDevice || '',
    lastIp: u.lastIp || '',
    /* 在线状态（真实值，隐身也在线） */
    online: pv.online,
    hidden: pv.hidden,
    lastSeen: pv.lastSeen,
    song: pv.song,
    todayMs: pv.today,
    totalMs: pv.total,
    device: pv.device,
    src: src.id,
    srcName: src.name
  };
}
function statFile(f) {
  try { const st = fs.statSync(f); return { size: st.size, mtime: st.mtimeMs }; } catch { return null; }
}
function probePort(p) {
  return new Promise(res => {
    const done = up => res({ port: p, up });
    const req = http.request({ host: '127.0.0.1', port: p, path: '/api/ping', method: 'GET', timeout: 700 }, r => {
      let b = '';
      r.on('data', c => { b += c; if (b.length > 8192) r.destroy(); });
      r.on('end', () => {
        /* 光看状态码不够：管理台自己（默认 8803）也会回一个 200 的
         * {"ok":false,"error":"not found"}，只认 200 会把自己当成主服务。
         * 端口扫的范围比原来宽，这个校验就必须做 —— 认响应体里的身份标记。 */
        try {
          const j = JSON.parse(b);
          done(!!(j && j.ok === true && j.service === 'kugou-downloader'));
        } catch { done(false); }
      });
      r.on('error', () => done(false));
    });
    req.on('error', () => done(false));
    req.on('timeout', () => { req.destroy(); done(false); });
    req.end();
  });
}
function pidAlive(pid) {
  /* signal 0 只做存在性检查，不会真的发信号；进程不存在时抛 ESRCH */
  try { process.kill(pid, 0); return true; } catch { return false; }
}
/* 主服务自己写的 runtime.json 在 APP_DIR（脚本态就是工程根），格式 { port, pid, dir, sea }。
 * 必须校验 pid 还活着：这文件是启动时写的，服务停了文件还在，
 * 只看文件会一直误报"运行中" —— 那是从一个坑跳到另一个坑。 */
function mainRuntime() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime.json'), 'utf8'));
    const port = Number(j && j.port), pid = Number(j && j.pid);
    if (port >= 1024 && port <= 65535 && pid > 0 && pidAlive(pid)) return { port, pid };
  } catch { /* 文件不存在 / 坏了 / 进程已死，走下面的兜底 */ }
  return null;
}
/* 兜底：扫一段端口。主服务有三条取值路径 —— 默认 8788、PORT 环境变量任意值、
 * 端口被占时自增（源码里上限 8818），所以不能只探几个写死的值。
 * 8788~8820 覆盖默认值与自增区间（多留 2 个余量）。 */
function fallbackPorts() {
  const list = [];
  const envP = Number(process.env.PORT);
  if (envP >= 1024 && envP <= 65535) list.push(envP);
  for (let p = 8788; p <= 8820; p++) list.push(p);
  return [...new Set(list)];
}
/* 主服务是否在运行：决定了"改完什么时候生效"的提示文案 */
async function probeMain() {
  const rt = mainRuntime();
  if (rt) {
    const hit = await probePort(rt.port);
    if (hit.up) return [hit];          /* 命中就只探一个，省掉整段扫描 */
  }
  return Promise.all(fallbackPorts().map(probePort));
}

/* ---------------- HTTP ---------------- */
function sendJSON(res, obj, code = 200) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}
function readBody(req) {
  return new Promise(resolve => {
    let s = '';
    /* 放宽到 40MB：上传 APK 时走的是 base64，体积会膨胀约 1/3 */
    req.on('data', c => { s += c; if (s.length > 4e7) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function srcById(id) { return SOURCES.find(s => s.id === id); }

/* OTA 发布路径：以主数据源为锚点，exe 版与脚本版都能指到同一处 */
function releasePaths() {
  const main = SOURCES.find(s => s.main) || SOURCES[0];
  const dataDir = main ? expand(main.dir) : path.join(ROOT, 'data');
  const projRoot = path.dirname(dataDir);
  let base = '';
  try { base = fs.readFileSync(path.join(projRoot, 'public-url.txt'), 'utf8').trim(); } catch { }
  if (!base) { try { base = fs.readFileSync(path.join(ROOT, 'public-url.txt'), 'utf8').trim(); } catch { } }
  if (!base || !/^https?:\/\//.test(base)) base = DEFAULT_ADMIN_BASE;
  return {
    dir: path.join(dataDir, 'app-update'),
    manifest: path.join(dataDir, 'app-update', 'manifest.json'),
    webDir: path.join(projRoot, 'web'), base
  };
}
/* 扫描当前工程前端文件，算 md5 —— 客户端靠 md5 判断是否需要重下 */
function releaseScan(webDir) {
  const out = [];
  /* ⚠️ 这三个必须齐全，漏一个就静默少发一个覆盖层。
     manifest.webmanifest 已经因为「某份硬编码名单漏了它」吃过三次亏：
       · 服务端 WEB_ASSET_RE 漏过 → iOS 加到主屏幕只能得到个普通书签；
       · 这里漏过 → 管理台发一次版 files[] 就从 3 个掉成 2 个，
         而 /api/app/file 是严格文件名白名单，掉了的那个直接 404，
         PWA 的 manifest 从此不再更新。
     真源是 data/app-update/manifest.json 的 files[].rel（当前正好这三个），
     两边要一起动，别再各写一份。 */
  for (const f of ['index.html', 'sw.js', 'manifest.webmanifest']) {
    try {
      const b = fs.readFileSync(path.join(webDir, f));
      out.push({ rel: f, size: b.length, md5: crypto.createHash('md5').update(b).digest('hex') });
    } catch { /* 文件不存在就跳过 */ }
  }
  return out;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    // exe 态界面是内嵌资源；脚本态直接读磁盘，改完刷新就见效
    const b = IS_SEA ? Buffer.from(SEA.getAsset('index.html', 'utf8'), 'utf8')
      : fs.readFileSync(path.join(HERE, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
    return res.end(b);
  }

  /* 概览：源列表 + 每源账号数 + 主服务在线情况 */
  /* 端口分配：改完自己重启到自己指定的端口上，不用去翻命令行。 */
  if (p === '/api/port') {
    return sendJSON(res, { ok: true, port: PORT, base: PORT_BASE, saved: savedPort(), isExe: IS_SEA });
  }
  if (p === '/api/port' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    const n = Number(b && b.port);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      return sendJSON(res, { ok: false, error: '端口要填 1024–65535 之间的整数' }, 400);
    }
    writeJSON(PORT_FILE, { port: n, at: Date.now() });
    log('port', { from: PORT, to: n });
    if (n === PORT) return sendJSON(res, { ok: true, port: n, restarted: false });
    /* 立刻按新端口重启自己。先把新进程拉起来再退出，
     * 拉不起来就当作没改，继续用老端口活着——绝不能把自己弄没了。 */
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, port: n, restarted: true }));
    setTimeout(() => {
      try {
        const args = process.argv.slice(1).filter(a => !a.startsWith('--port='));
        const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', cwd: path.dirname(process.execPath) });
        child.unref();
        setTimeout(() => process.exit(0), 400);
      } catch (e) {
        console.error('[admin] 重启失败，继续用 ' + PORT + '：' + e.message);
      }
    }, 200);
    return;
  }

  if (p === '/api/state') {
    const mains = await probeMain();
    const srcs = SOURCES.map(s => {
      const uf = srcPath(s, 'users.json');
      const st = statFile(uf);
      const users = readJSON(uf, {});
      const sessions = readJSON(srcPath(s, 'sessions.json'), {});
      const secrets = readJSON(srcPath(s, 'secrets.json'), {});
      const list = Object.values(users);
      const now = Date.now();
      return {
        id: s.id, name: s.name, dir: s.dir, main: !!s.main,
        linked: s.linked || '',          /* 非空 = 和别的源是同一份数据（目录联接），统计时不重复计入 */
        exists: !!st, size: st ? st.size : 0, mtime: st ? st.mtime : 0,
        count: list.length,
        withPass: list.filter(u => u.passHash).length,
        favTotal: list.reduce((a, u) => a + (u.favs || []).length, 0),
        historyTotal: list.reduce((a, u) => a + (u.history || []).length, 0),
        activeSessions: Object.values(sessions).filter(x => x && x.exp > now).length,
        whitelist: (secrets.auth && Array.isArray(secrets.auth.allow)) ? secrets.auth.allow : []
      };
    });
    return sendJSON(res, { ok: true, port: PORT, sources: srcs, mains, log: readLog(30) });
  }

  /* 账号列表：支持跨源合并视图 */
  if (p === '/api/users') {
    const srcId = url.searchParams.get('src') || 'all';
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const sort = url.searchParams.get('sort') || 'lastLogin';
    const showFull = url.searchParams.get('full') === '1';
    /* all 视图跳过「目录联接」重复源，否则同一批账号会列出 5 遍 */
    const targets = srcId === 'all' ? SOURCES.filter(s => !s.linked) : SOURCES.filter(s => s.id === srcId);
    let rows = [];
    for (const s of targets) {
      const users = readJSON(srcPath(s, 'users.json'), {});
      const pres = readJSON(srcPath(s, 'presence.json'), {});
      for (const u of Object.values(users)) rows.push(viewUser(u, s, showFull, pres));
    }
    if (q) rows = rows.filter(r =>
      (r.username || '').toLowerCase().includes(q) ||
      (r.phoneRaw || '').includes(q) ||
      (r.email || '').toLowerCase().includes(q) ||
      (r.uid || '').toLowerCase().includes(q));
    const dir = url.searchParams.get('dir') === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const k = sort === 'createdAt' ? 'createdAt' : sort === 'fav' ? 'favCount' : sort === 'history' ? 'historyCount' : sort === 'name' ? 'username' : 'lastLogin';
      const va = typeof a[k] === 'string' ? a[k] : (a[k] || 0);
      const vb = typeof b[k] === 'string' ? b[k] : (b[k] || 0);
      return va < vb ? -dir : va > vb ? dir : 0;
    });
    return sendJSON(res, { ok: true, rows, total: rows.length });
  }

  /* 任命 / 撤销管理员。开发者账号动不了，避免把自己锁在门外。 */
  if (p === '/api/user/role' && req.method === 'POST') {
    const b = await readBody(req);
    const s = srcById(b.src);
    if (!s) return sendJSON(res, { ok: false, error: '源不存在' }, 400);
    const f = srcPath(s, 'users.json');
    const users = readJSON(f, {});
    const u = users[b.uid];
    if (!u) return sendJSON(res, { ok: false, error: '账号不存在' }, 404);
    if (u.role === 'superadmin') {
      return sendJSON(res, { ok: false, error: '开发者账号不能改动' }, 403);
    }
    const want = String(b.role || '');
    u.role = (want === 'admin') ? 'admin' : '';
    writeJSON(f, users);
    log('role', { src: s.id, uid: b.uid, username: u.username, role: u.role || 'user' });
    return sendJSON(res, { ok: true, role: u.role || 'user' });
  }

  /* 转让开发者身份。
   * 开发者账号既不能降级也不能注销——那会把整套系统变成没主人的孤儿。
   * 真想把主账号换掉，走这里：先把它交给别人，自己自动降成管理员，
   * 之后想注销就能注销了。全程一个事务，不会中途出现「两个最高」或「零个最高」。 */
  if (p === '/api/user/transfer' && req.method === 'POST') {
    const b = await readBody(req);
    const s = srcById(b.src);
    if (!s) return sendJSON(res, { ok: false, error: '源不存在' }, 400);
    const f = srcPath(s, 'users.json');
    const users = readJSON(f, {});
    const from = Object.values(users).find(u => u.role === 'superadmin');
    const to = users[b.uid];
    if (!from) return sendJSON(res, { ok: false, error: '这个数据源里没有开发者账号' }, 404);
    if (!to) return sendJSON(res, { ok: false, error: '目标账号不存在' }, 404);
    if (to.uid === from.uid) return sendJSON(res, { ok: false, error: '已经是开发者了' }, 400);
    const bak = backup(s, 'transfer');
    from.role = 'admin';
    to.role = 'superadmin';
    writeJSON(f, users);
    log('transfer', { src: s.id, from: from.uid, fromName: from.username, to: to.uid, toName: to.username });
    return sendJSON(res, {
      ok: true, backup: bak,
      from: { uid: from.uid, username: from.username, role: 'admin' },
      to: { uid: to.uid, username: to.username, role: 'superadmin' }
    });
  }

  /* 账号详情：带收藏/历史明细 */
  if (p === '/api/user') {
    const s = srcById(url.searchParams.get('src'));
    if (!s) return sendJSON(res, { ok: false, error: '源不存在' }, 400);
    const users = readJSON(srcPath(s, 'users.json'), {});
    const u = users[url.searchParams.get('uid')];
    if (!u) return sendJSON(res, { ok: false, error: '账号不存在' }, 404);
    const pick = it => ({
      key: it.key || '', name: it.name || it.songname || it.title || it.song || '(未命名)',
      artist: it.artist || it.singer || it.singerName || '', album: it.album || it.albumName || '',
      at: it.at || 0, source: it.source || '', id: it.id || it.hash || ''
    });
    return sendJSON(res, {
      ok: true,
      user: viewUser(u, s, true, readJSON(srcPath(s, 'presence.json'), {})),
      favs: (u.favs || []).map(pick),
      history: (u.history || []).map(pick),
      sessions: Object.entries(readJSON(srcPath(s, 'sessions.json'), {}))
        .filter(([, v]) => v && v.uid === u.uid)
        .map(([t, v]) => ({ token: t.slice(0, 10) + '…', exp: v.exp, alive: v.exp > Date.now() }))
    });
  }

  /* 编辑资料 */
  if (p === '/api/user/edit' && req.method === 'POST') {
    const b = await readBody(req);
    const s = srcById(b.src); if (!s) return sendJSON(res, { ok: false, error: '源不存在' }, 400);
    const f = srcPath(s, 'users.json');
    const users = readJSON(f, {});
    const u = users[b.uid]; if (!u) return sendJSON(res, { ok: false, error: '账号不存在' }, 404);
    const bak = backup(s, 'edit');
    const before = { username: u.username, phone: u.phone, email: u.email, gender: u.gender };
    if (b.username !== undefined) u.username = String(b.username).trim().slice(0, 20) || '听众';
    if (b.phone !== undefined) u.phone = String(b.phone).trim();
    if (b.email !== undefined) u.email = String(b.email).trim().toLowerCase();
    if (b.gender !== undefined) u.gender = ['male', 'female', ''].includes(b.gender) ? b.gender : u.gender;
    writeJSON(f, users);
    log('edit', { src: s.id, uid: b.uid, before, after: { username: u.username, phone: u.phone, email: u.email, gender: u.gender }, backup: bak });
    return sendJSON(res, { ok: true, user: viewUser(u, s, true, readJSON(srcPath(s, 'presence.json'), {})), backup: bak });
  }

  /* 重置密码：和主服务同一套 scrypt$盐$摘要 格式，改完主服务能直接校验 */
  if (p === '/api/user/pass' && req.method === 'POST') {
    const b = await readBody(req);
    const s = srcById(b.src); if (!s) return sendJSON(res, { ok: false, error: '源不存在' }, 400);
    const f = srcPath(s, 'users.json');
    const users = readJSON(f, {});
    const u = users[b.uid]; if (!u) return sendJSON(res, { ok: false, error: '账号不存在' }, 404);
    const bak = backup(s, 'pass');
    if (b.clear) {
      u.passHash = '';
    } else {
      const pw = String(b.pass || '');
      if (pw.length < 6) return sendJSON(res, { ok: false, error: '密码至少 6 位' }, 400);
      const salt = crypto.randomBytes(16);
      u.passHash = 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(pw, salt, 64).toString('hex');
    }
    writeJSON(f, users);
    log('pass', { src: s.id, uid: b.uid, action: b.clear ? 'clear' : 'reset', backup: bak });
    return sendJSON(res, { ok: true, backup: bak });
  }

  /* 删除账号（不可逆，调用方必须弹过确认） */
  if (p === '/api/user/del' && req.method === 'POST') {
    const b = await readBody(req);
    const s = srcById(b.src); if (!s) return sendJSON(res, { ok: false, error: '源不存在' }, 400);
    const f = srcPath(s, 'users.json');
    const users = readJSON(f, {});
    if (!users[b.uid]) return sendJSON(res, { ok: false, error: '账号不存在' }, 404);
    /* 开发者账号不能被注销——不然整个管理端就没主人了 */
    if (users[b.uid].role === 'superadmin') {
      return sendJSON(res, { ok: false, error: '这是开发者账号，不能注销' }, 403);
    }
    const bak = backup(s, 'delete');
    const gone = users[b.uid];
    delete users[b.uid];
    // 顺带清掉该账号的会话，避免残token指向已删除用户
    const sf = srcPath(s, 'sessions.json');
    const sess = readJSON(sf, {});
    let killed = 0;
    for (const [t, v] of Object.entries(sess)) if (v && v.uid === b.uid) { delete sess[t]; killed++; }
    if (killed) writeJSON(sf, sess);
    writeJSON(f, users);

    /* 注销要连根拔：好友关系、分享、动态、一起听、在线状态、上传的歌，
     * 不然好友列表里会留下一堆打不开的「幽灵」。删不掉也不影响注销本身。 */
    const cleaned = { friends: 0, requests: 0, shares: 0, moments: 0, rooms: 0, uploads: 0 };
    try {
      const sp = srcPath(s, 'social.json');
      const so = readJSON(sp, { friends: {}, requests: [], shares: [] });
      delete so.friends[b.uid];
      for (const k of Object.keys(so.friends || {})) {
        so.friends[k] = (so.friends[k] || []).filter(x => x !== b.uid);
        if (!so.friends[k].length) { delete so.friends[k]; cleaned.friends++; }
      }
      const rq = (so.requests || []).filter(x => x.from === b.uid || x.to === b.uid);
      cleaned.requests = rq.length;
      so.requests = (so.requests || []).filter(x => x.from !== b.uid && x.to !== b.uid);
      const sh = (so.shares || []).filter(x => x.from === b.uid || x.to === b.uid);
      cleaned.shares = sh.length;
      so.shares = (so.shares || []).filter(x => x.from !== b.uid && x.to !== b.uid);
      writeJSON(sp, so);
    } catch { }
    try {
      const mp = srcPath(s, 'moments.json');
      const mo = readJSON(mp, { list: [] });
      const n = (mo.list || []).filter(x => x.uid === b.uid).length;
      mo.list = (mo.list || []).filter(x => x.uid !== b.uid);
      cleaned.moments = n; writeJSON(mp, mo);
    } catch { }
    try {
      const lp = srcPath(s, 'listen.json');
      const lo = readJSON(lp, { rooms: [] });
      const n = (lo.rooms || []).filter(x => x.host === b.uid || x.guest === b.uid).length;
      lo.rooms = (lo.rooms || []).filter(x => x.host !== b.uid && x.guest !== b.uid);
      cleaned.rooms = n; writeJSON(lp, lo);
    } catch { }
    try {
      const pp = srcPath(s, 'presence.json');
      const po = readJSON(pp, {});
      delete po[b.uid]; writeJSON(pp, po);
    } catch { }
    try {
      const nrp = srcPath(s, 'notice-read.json');
      const nr = readJSON(nrp, {});
      delete nr[b.uid]; writeJSON(nrp, nr);
    } catch { }
    try {
      const up = srcPath(s, 'uploads.json');
      const uo = readJSON(up, { list: [] });
      const mine = (uo.list || []).filter(x => x.uid === b.uid);
      cleaned.uploads = mine.length;
      uo.list = (uo.list || []).filter(x => x.uid !== b.uid);
      writeJSON(up, uo);
      const ud = srcPath(s, 'uploads');
      for (const t of mine) {
        const fp = path.join(ud, String(t.file || '').replace(/[\\/]/g, ''));
        for (let i = 0; i < 3 && fs.existsSync(fp); i++) {
          try { fs.unlinkSync(fp); } catch { }
        }
      }
    } catch { }

    log('delete', { src: s.id, uid: b.uid, username: gone.username, phone: gone.phone,
      email: gone.email, backup: bak, killed, cleaned });
    return sendJSON(res, { ok: true, backup: bak, killed, cleaned });
  }

  /* 一键归集 / 同号整理
   *
   * 规则（按用户口径实现，别改）：
   *   · 同手机号 = 同一个人（其次是同邮箱、再次是同 uid）。
   *   · 登录凭证（passHash / phone / email）**永远以"保留方"为准**，不被另一方覆盖。
   *     保留方 = keep 策略：lastLogin（默认，最近登录的那条）| created（最早注册）| src（目标源优先，跨源归集时用）。
   *     跨源归集时保留方恒为目标源（也就是手机端正在用的那份），符合"保留手机用户登录信息"。
   *   · 不冲突的字段就补：昵称/性别只在保留方为空时才从对方补。
   *   · 收藏、历史做并集：同 key 保留 at 更新的那条，不丢数据。
   *   · preview=1 时只出报告不落盘，界面先给预览再让人点确认。
   */
  if (p === '/api/merge' && req.method === 'POST') {
    const b = await readBody(req);
    return sendJSON(res, runMerge({
      toId: b.to, fromIds: Array.isArray(b.from) ? b.from : [],
      keep: b.keep || 'src', dedupeSrc: !!b.dedupeSrc, preview: !!b.preview
    }));
  }

  /* 源内同号整理：只整理一个源自己内部的重复手机号，不动其它源 */
  if (p === '/api/dedupe' && req.method === 'POST') {
    const b = await readBody(req);
    return sendJSON(res, runMerge({
      toId: b.src, fromIds: [], keep: b.keep || 'lastLogin', dedupeSrc: true, preview: !!b.preview
    }));
  }

  function runMerge({ toId, fromIds, keep, dedupeSrc, preview }) {
    const to = srcById(toId); if (!to) return { ok: false, error: '目标源不存在' };
    // 源内整理不能用"目标源优先"（那样等于永远留第一条），退化成"最近登录优先"
    if (dedupeSrc && keep === 'src') keep = 'lastLogin';
    const tf = srcPath(to, 'users.json');
    const target = readJSON(tf, {});
    const detail = [];
    let added = 0, merged = 0, same = 0;

    /* 谁当保留方：跨源恒目标源；源内整理时按 keep 策略比大小 */
    const rank = u => (keep === 'created' ? -(u.createdAt || 0) : (u.lastLogin || u.createdAt || 0));
    const winner = (a, c) => (keep === 'src' ? a : (rank(c) > rank(a) ? c : a));
    const loser = (a, c) => (winner(a, c) === a ? c : a);

    const absorb = (keepRec, dropRec, tag) => {
      // 只补空字段，登录凭证不动 —— 这是"保留手机用户登录信息"的硬保证
      if (!keepRec.username || keepRec.username === '听众') keepRec.username = dropRec.username || keepRec.username;
      if (!keepRec.gender && dropRec.gender) keepRec.gender = dropRec.gender;
      if (!keepRec.phone && dropRec.phone) keepRec.phone = dropRec.phone;
      if (!keepRec.email && dropRec.email) keepRec.email = dropRec.email;
      if (!keepRec.passHash && dropRec.passHash) keepRec.passHash = dropRec.passHash;
      const f0 = (keepRec.favs || []).length, h0 = (keepRec.history || []).length;
      keepRec.favs = mergeList(keepRec.favs || [], dropRec.favs || []);
      keepRec.history = mergeList(keepRec.history || [], dropRec.history || []);
      keepRec.createdAt = Math.min(keepRec.createdAt || Date.now(), dropRec.createdAt || Date.now());
      keepRec.mergedFrom = [...new Set([...(keepRec.mergedFrom || []), dropRec.uid, tag].filter(Boolean))].slice(0, 20);
      keepRec.mergedAt = Date.now();
      return { favAdd: (keepRec.favs || []).length - f0, hisAdd: (keepRec.history || []).length - h0 };
    };

    /* 先做目标源内部的同号整理 */
    if (dedupeSrc) {
      const byPhone = new Map(), byEmail = new Map(), drop = new Set();
      for (const [uid, u] of Object.entries(target)) {
        if (u.phone) {
          if (byPhone.has(u.phone)) {
            const a = target[byPhone.get(u.phone)];
            const w = winner(a, u), l = loser(a, u);
            const d = absorb(w, l, 'src:' + to.id);
            drop.add(l.uid); merged++;
            detail.push({ action: '同号合并', key: u.phone, keepUid: w.uid, dropUid: l.uid, nick: w.username, ...d, where: to.name });
            byPhone.set(u.phone, w.uid);
          } else byPhone.set(u.phone, uid);
        }
        if (u.email) {
          if (byEmail.has(u.email)) {
            const a = target[byEmail.get(u.email)];
            if (a && !drop.has(a.uid) && !drop.has(uid)) {
              const w = winner(a, u), l = loser(a, u);
              const d = absorb(w, l, 'src:' + to.id);
              drop.add(l.uid); merged++;
              detail.push({ action: '同邮箱合并', key: u.email, keepUid: w.uid, dropUid: l.uid, nick: w.username, ...d, where: to.name });
              byEmail.set(u.email, w.uid);
            }
          } else byEmail.set(u.email, uid);
        }
      }
      for (const uid of drop) delete target[uid];
    }

    /* 再把其它源的账号归集进来 */
    for (const fid of fromIds) {
      if (fid === to.id) continue;
      const fs2 = srcById(fid); if (!fs2) continue;
      const others = readJSON(srcPath(fs2, 'users.json'), {});
      for (const [uid, u] of Object.entries(others)) {
        if (target[uid]) {                                   // uid 撞了：目标源（手机端）当保留方
          const d = absorb(target[uid], u, 'src:' + fid); merged++;
          detail.push({ action: '同 uid 合并', key: uid, keepUid: uid, dropUid: uid, nick: target[uid].username, ...d, where: fs2.name });
          continue;
        }
        const dup = Object.values(target).find(x =>
          (u.phone && x.phone === u.phone) || (u.email && x.email && x.email === u.email));
        if (dup) {                                           // 同一个人：登录信息留目标源，只并数据
          const d = absorb(dup, u, 'src:' + fid); merged++;
          detail.push({
            action: u.phone && dup.phone === u.phone ? '同手机号合并' : '同邮箱合并',
            key: u.phone || u.email, keepUid: dup.uid, dropUid: uid, nick: dup.username, ...d, where: fs2.name
          });
          continue;
        }
        target[uid] = { ...u, mergedFrom: ['src:' + fid], mergedAt: Date.now() };
        added++;
        detail.push({ action: '新增', key: u.phone || u.email || uid, keepUid: uid, dropUid: '', nick: u.username, favAdd: (u.favs || []).length, hisAdd: (u.history || []).length, where: fs2.name });
      }
    }

    if (preview) return { ok: true, preview: true, added, merged, same, detail: detail.slice(0, 400), total: Object.keys(target).length };

    const bak = backup(to, 'merge');
    writeJSON(tf, target);
    log('merge', { to: to.id, from: fromIds, keep, added, merged, backup: bak });
    return { ok: true, added, merged, same, backup: bak, detail: detail.slice(0, 400), total: Object.keys(target).length };
  }

  function mergeList(a, b) {
    const keyOf = it => String(it.key || (it.source || '') + ':' + (it.id || it.hash || it.songname || ''));
    const map = new Map();
    for (const it of b) map.set(keyOf(it), it);
    for (const it of a) {                                    // a（保留方）后写 → 同 key 以其为准
      const k = keyOf(it), old = map.get(k);
      map.set(k, (!old || (it.at || 0) >= (old.at || 0)) ? it : old);
    }
    // 按时间倒序，最近收藏/听过的排前面，和 App 里的顺序一致
    return [...map.values()].sort((x, y) => (y.at || 0) - (x.at || 0)).slice(0, 1000);
  }

  /* 白名单（secrets.json 的 auth.allow）：空 = 不限制 */
  if (p === '/api/whitelist') {
    const s = srcById(url.searchParams.get('src')) || SOURCES[0];
    if (!s) return sendJSON(res, { ok: false, error: '源不存在' }, 400);
    const f = srcPath(s, 'secrets.json');
    if (req.method === 'GET') {
      const sec = readJSON(f, {});
      return sendJSON(res, { ok: true, list: (sec.auth && sec.auth.allow) || [] });
    }
    const b = await readBody(req);
    const sec = readJSON(f, {});
    sec.auth = sec.auth || {};
    sec.auth.allow = (Array.isArray(b.list) ? b.list : [])
      .map(x => String(x).trim().toLowerCase()).filter(Boolean);
    /* 邮箱白名单写在各数据源的 secrets.json 里，是主服务读的那个文件 —— 必须原子写 */
    writeFileAtomic(f, JSON.stringify(sec, null, 2), 'utf8');
    log('whitelist', { src: s.id, list: sec.auth.allow });
    return sendJSON(res, { ok: true, list: sec.auth.allow });
  }

  /* 会话：查看 / 踢下线 */
  if (p === '/api/sessions') {
    const s = srcById(url.searchParams.get('src')) || SOURCES[0];
    if (!s) return sendJSON(res, { ok: false, error: '源不存在' }, 400);
    const f = srcPath(s, 'sessions.json');
    if (req.method === 'GET') {
      const sess = readJSON(f, {});
      const users = readJSON(srcPath(s, 'users.json'), {});
      const now = Date.now();
      const rows = Object.entries(sess).map(([t, v]) => ({
        token: t.slice(0, 12) + '…', full: t, exp: v.exp, alive: v.exp > now,
        uid: v.uid, username: (users[v.uid] && users[v.uid].username) || '(已删除)'
      }));
      rows.sort((a, b) => b.exp - a.exp);
      return sendJSON(res, { ok: true, rows });
    }
    const b = await readBody(req);
    const sess = readJSON(f, {});
    let n = 0;
    if (b.token) { if (sess[b.token]) { delete sess[b.token]; n = 1; } }
    else if (b.uid) { for (const [t, v] of Object.entries(sess)) if (v && v.uid === b.uid) { delete sess[t]; n++; } }
    else if (b.all) {
      const now = Date.now();
      for (const [t, v] of Object.entries(sess)) if (v.exp > now) { delete sess[t]; n++; }
    }
    writeJSON(f, sess);
    log('kick', { src: s.id, n, uid: b.uid || '' });
    return sendJSON(res, { ok: true, kicked: n });
  }

  /* 导出 CSV / JSON */
  if (p === '/api/export') {
    const srcId = url.searchParams.get('src') || 'all';
    const fmt = url.searchParams.get('fmt') || 'csv';
    const targets = srcId === 'all' ? SOURCES : SOURCES.filter(s => s.id === srcId);
    let rows = [];
    for (const s of targets) {
      const users = readJSON(srcPath(s, 'users.json'), {});
      const pres = readJSON(srcPath(s, 'presence.json'), {});
      for (const u of Object.values(users)) rows.push({ ...viewUser(u, s, true, pres), srcName: s.name });
    }
    const d = n => { const t = new Date(n); return n ? t.toLocaleString('zh-CN', { hour12: false }) : ''; };
    if (fmt === 'json') {
      const b = Buffer.from(JSON.stringify(rows, null, 2), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="ymusic-users.json"' });
      return res.end(b);
    }
    const head = ['来源', 'UID', '昵称', '手机', '邮箱', '性别', '有密码', '收藏', '历史', '注册时间', '最后登录'];
    const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = [head.map(esc).join(',')].concat(rows.map(r => [
      r.srcName, r.uid, r.username, r.phoneRaw, r.email,
      r.gender === 'female' ? '女' : r.gender === 'male' ? '男' : '', r.hasPass ? '是' : '否',
      r.favCount, r.historyCount, d(r.createdAt), d(r.lastLogin)
    ].map(esc).join(',')));
    const b = Buffer.from('\uFEFF' + lines.join('\r\n'), 'utf8');   // BOM：Excel 直接双击不乱码
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="ymusic-users.csv"' });
    return res.end(b);
  }

  /* 数据源增删 */
  if (p === '/api/sources') {
    if (req.method === 'GET') return sendJSON(res, { ok: true, sources: SOURCES });
    const b = await readBody(req);
    if (b.op === 'add') {
      const id = 's' + crypto.randomBytes(4).toString('hex');
      SOURCES.push({ id, name: String(b.name || '自定义源').slice(0, 60), dir: expand(b.dir) });
    } else if (b.op === 'del') {
      SOURCES = SOURCES.filter(s => s.id !== b.id || s.main);
    } else if (b.op === 'main') {
      SOURCES.forEach(s => { s.main = s.id === b.id; });
    }
    try { fs.writeFileSync(SOURCES_FILE, JSON.stringify(SOURCES, null, 2), 'utf8'); } catch { /* ignore */ }
    log('sources', { op: b.op, id: b.id || '' });
    return sendJSON(res, { ok: true, sources: SOURCES });
  }

  /* 备份回滚：把某次备份覆盖回当前 users.json */
  if (p === '/api/restore' && req.method === 'POST') {
    const b = await readBody(req);
    const s = srcById(b.src); if (!s) return sendJSON(res, { ok: false, error: '源不存在' }, 400);
    const file = path.join(BACKUP_DIR, String(b.file || ''));
    if (!file.startsWith(BACKUP_DIR) || !fs.existsSync(file)) return sendJSON(res, { ok: false, error: '备份不存在' }, 404);
    backup(s, 'pre-restore');
    fs.copyFileSync(file, srcPath(s, 'users.json'));
    log('restore', { src: s.id, file: b.file });
    return sendJSON(res, { ok: true });
  }

  /* 统一数据目录：生成一个启动器，让 PC 端（exe / 桌面版）用 YM_APP_DIR 指向手机端这份数据。
   * 这是"以后不再分裂"的根本办法 —— 两边读写同一个 users.json，压根不需要再合并。 */
  if (p === '/api/unify' && req.method === 'POST') {
    const b = await readBody(req);
    const s = srcById(b.src) || SOURCES.find(x => x.main) || SOURCES[0];
    if (!s) return sendJSON(res, { ok: false, error: '源不存在' }, 400);
    const dir = s.dir;
    const bat = [
      '@echo off',
      'chcp 65001 >nul',
      'rem YMusic 统一数据目录启动器 —— 让 PC 端和手机端共用同一份账号数据',
      'rem 由账号管理台生成于 ' + new Date().toLocaleString('zh-CN'),
      'set "YM_APP_DIR=' + dir + '"',
      'echo YM_APP_DIR=%YM_APP_DIR%',
      'if exist "' + path.join(ROOT, 'dist', 'YMusic.exe') + '" (',
      '  start "" "' + path.join(ROOT, 'dist', 'YMusic.exe') + '"',
      ') else (',
      '  echo 没找到 dist\\YMusic.exe，请把本文件放到 exe 同目录再运行',
      '  pause',
      ')'
    ].join('\r\n');
    const out = path.join(HERE, '统一数据目录启动器.bat');
    fs.writeFileSync(out, Buffer.from('\uFEFF' + bat, 'utf8'));   // BOM：中文不乱码
    log('unify', { src: s.id, dir });
    return sendJSON(res, { ok: true, file: '统一数据目录启动器.bat', dir });
  }

  if (p === '/api/backups') {
    try {
      const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).map(f => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { file: f, size: st.size, mtime: st.mtimeMs };
      }).sort((a, b) => b.mtime - a.mtime).slice(0, 60);
      return sendJSON(res, { ok: true, files });
    } catch { return sendJSON(res, { ok: true, files: [] }); }
  }

  /* ---- OTA 发布：把当前工程里的前端打成一个版本，供已分发出去的 exe 回来拉 ----
   * 路径以「主数据源」为锚点（不是 ROOT）—— exe 版管理台的 ROOT 与脚本版不同，
   * 用 ROOT 会指到 exe 自己那个目录，发布出去的版本主服务根本读不到。 */
  if (p === '/api/release') {
    const rel = releasePaths();
    const pub = readJSON(rel.manifest, null);
    const cur = releaseScan(rel.webDir);
    let apk = null;
    try { apk = JSON.parse(fs.readFileSync(path.join(path.dirname(rel.dir), 'apk-release.json'), 'utf8')); } catch { }
    return sendJSON(res, {
      ok: true, published: pub, current: cur, base: rel.base, apk,
      dirty: !pub || JSON.stringify(pub.files || []) !== JSON.stringify(cur)
    });
  }
  /* ---- 安卓 APK 发布：手机端自检更新后从主服务 /api/app/apk 拉包 ---- */
  if (p === '/api/release/apk' && req.method === 'POST') {
    const b = await readBody(req);
    const rel = releasePaths();
    let buf = null;
    try { buf = Buffer.from(String(b.data || ''), 'base64'); } catch { buf = null; }
    if (!buf || buf.length < 1024) return sendJSON(res, { ok: false, error: '没收到 APK 文件内容' }, 400);
    if (buf.slice(0, 2).toString('latin1') !== 'PK') return sendJSON(res, { ok: false, error: '这不像一个 APK 文件（APK 本质是 zip）' }, 400);

    const versionName = String(b.versionName || '').trim() || ('1.0.' + Date.now().toString().slice(-4));
    const versionCode = Number(b.versionCode) || 1;
    const file = 'YMusic-' + versionName + '.apk';
    try { fs.mkdirSync(rel.dir, { recursive: true }); } catch { }
    /* 留一份上一版，方便回滚 */
    const prevMeta = (() => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(rel.dir), 'apk-release.json'), 'utf8')); } catch { return null; } })();
    if (prevMeta && prevMeta.file) {
      try { fs.mkdirSync(path.join(rel.dir, 'prev'), { recursive: true });
            fs.copyFileSync(path.join(rel.dir, prevMeta.file), path.join(rel.dir, 'prev', prevMeta.file)); } catch { }
    }
    /* APK 是别人要装的安装包，写一半就是装不上的坏包 —— 原子写 */
    writeFileAtomic(path.join(rel.dir, file), buf);
    const meta = {
      versionCode, versionName, file, size: buf.length,
      md5: crypto.createHash('md5').update(buf).digest('hex'),
      note: String(b.note || '').trim() || '优化体验，修复已知问题',
      force: !!b.force,
      at: new Date().toISOString()
    };
    writeJSON(path.join(path.dirname(rel.dir), 'apk-release.json'), meta);
    log('release-apk', { version: versionName, code: versionCode, size: buf.length });
    return sendJSON(res, { ok: true, apk: meta });
  }
  if (p === '/api/release/publish' && req.method === 'POST') {
    const b = await readBody(req);
    const rel = releasePaths();
    const cur = releaseScan(rel.webDir);
    if (!cur.length) return sendJSON(res, { ok: false, error: 'web/ 下没找到可发布的前端文件' }, 400);
    const pub = readJSON(rel.manifest, null);
    const seq = (Number(pub && pub.seq) || 0) + 1;
    try { fs.mkdirSync(rel.dir, { recursive: true }); } catch { }
    /* 发布前把上一版的「文件」也备份进 prev/。
     * 只存清单是不够的 —— 新文件会覆盖旧的，回滚时清单说 md5 是 A、
     * 磁盘上却是 B，客户端校验不过就会静默拿不到更新。 */
    if (pub) {
      try {
        const prevDir = path.join(rel.dir, 'prev');
        fs.mkdirSync(prevDir, { recursive: true });
        for (const f of (pub.files || [])) {
          const s0 = path.join(rel.dir, f.rel);
          if (fs.existsSync(s0)) fs.copyFileSync(s0, path.join(prevDir, f.rel));
        }
        /* 备份正在进行时的那份清单，里头的 apk/exe 一起留下来，回滚才有完整信息 */
        writeFileAtomic(path.join(prevDir, 'manifest.json'), JSON.stringify(pub, null, 2), 'utf8');
      } catch { /* 备份失败不阻断发布 */ }
    }
    for (const f of cur) {
      try {
        fs.mkdirSync(path.dirname(path.join(rel.dir, f.rel)), { recursive: true });
        fs.copyFileSync(path.join(rel.webDir, f.rel), path.join(rel.dir, f.rel));
      } catch (e) { return sendJSON(res, { ok: false, error: '写入失败：' + e.message }, 500); }
    }
    /* changelog：管理台里逐条填的更新说明，客户端弹窗会分条列出来。
     * 兼容两种输入：数组，或者一行一条的字符串。 */
    let cl = [];
    if (Array.isArray(b.changelog)) cl = b.changelog.map(s => String(s || '').trim()).filter(Boolean);
    else if (typeof b.changelog === 'string') cl = b.changelog.split('\n').map(s => s.trim()).filter(Boolean);
    if (!cl.length && String(b.note || '').trim()) cl = [String(b.note).trim()];

    const ver = String(b.version || ('3.5.' + seq)).trim();
    const mf = {
      version: ver, seq, at: Date.now(),
      base: String(b.base || rel.base || '').trim(),
      note: String(b.note || '').trim(),
      changelog: cl,
      force: !!b.force,
      files: cur,
      /* apk / exe 两块只能人工写进清单，或者由专门的上传接口维护，
       * 发版表单里并没有这两个输入框。
       * 以前这里是**整体重建对象**，publish 一次就把它们静默抹掉 ——
       * 于是 /api/app/version 再也返回不了 exe，桌面端更新按钮点了也是空的。
       * 所以：请求体显式带过来就用新的，否则原样继承上一版。 */
      apk: (b.apk && typeof b.apk === 'object') ? b.apk : (pub && pub.apk),
      exe: (b.exe && typeof b.exe === 'object') ? b.exe : (pub && pub.exe)
    };
    /* undefined 的键会被 JSON.stringify 直接丢掉，这里想表达的是"就是没有"，用 null 更直白 */
    if (!mf.apk) delete mf.apk;
    if (!mf.exe) delete mf.exe;
    writeJSON(rel.manifest, mf);
    /* 同步一条 update 消息进消息中心，用户打开 App 就能看到这次改了什么 */
    try {
      const nf = path.join(path.dirname(rel.manifest), '..', 'notices.json');
      const obj = readJSON(nf, { list: [] });
      const list = Array.isArray(obj.list) ? obj.list : [];
      list.unshift({
        id: 'u_' + ver.replace(/[^0-9a-zA-Z]/g, '_') + '_' + Date.now(),
        type: 'update', title: '新版本 ' + ver + ' 已发布', version: ver,
        body: String(b.note || '').trim() || '本次更新带来新的改进',
        points: cl, at: Date.now(), top: false
      });
      writeJSON(nf, { list: list.slice(0, 80) });
    } catch { }
    log('release', { version: mf.version, base: mf.base, files: cur.map(f => f.rel) });
    return sendJSON(res, { ok: true, published: mf });
  }

  /* ── 消息中心：公告的查看 / 发布 / 删除 ──────────────────────── */
  function noticeFile() {
    const rel = releasePaths();
    return path.join(path.dirname(rel.manifest), '..', 'notices.json');
  }
  if (p === '/api/notice' ) {
    const obj = readJSON(noticeFile(), { list: [] });
    const list = Array.isArray(obj.list) ? obj.list.slice() : [];
    list.sort((a, b) => ((b.at || 0) - (a.at || 0)));
    return sendJSON(res, { ok: true, list });
  }
  if (p === '/api/notice/post' && req.method === 'POST') {
    const b = await readBody(req);
    const title = String(b.title || '').trim();
    const body = String(b.body || '').trim();
    if (!title && !body) return sendJSON(res, { ok: false, error: '标题和正文不能都为空' }, 400);
    let pts = [];
    if (Array.isArray(b.points)) pts = b.points.map(s => String(s || '').trim()).filter(Boolean);
    else if (typeof b.points === 'string') pts = b.points.split('\n').map(s => s.trim()).filter(Boolean);
    const nf = noticeFile();
    const obj = readJSON(nf, { list: [] });
    const list = Array.isArray(obj.list) ? obj.list : [];
    const item = {
      id: 'n_' + Date.now().toString(36),
      type: 'notice', title: title || '系统通知', body, points: pts,
      at: Date.now(), top: !!b.top
    };
    list.unshift(item);
    writeJSON(nf, { list: list.slice(0, 80) });
    log('notice', { title: item.title });
    return sendJSON(res, { ok: true, item });
  }
  if (p === '/api/notice/delete' && req.method === 'POST') {
    const b = await readBody(req);
    const id = String((b && b.id) || '');
    const nf = noticeFile();
    const obj = readJSON(nf, { list: [] });
    const list = (Array.isArray(obj.list) ? obj.list : []).filter(n => String(n.id) !== id);
    writeJSON(nf, { list });
    log('notice-delete', { id });
    return sendJSON(res, { ok: true });
  }

  /* ── 音频审核：管理端开发者，能看全部、能试听、能通过或驳回 ── */
  function uploadPaths() {
    const rel = releasePaths();
    const dataDir = path.dirname(rel.manifest.replace(/[\\/]app-update[\\/]?/, ''));
    return {
      meta: path.join(path.dirname(rel.manifest), '..', 'uploads.json'),
      dir: path.join(path.dirname(rel.manifest), '..', 'uploads')
    };
  }
  if (p === '/api/uploads') {
    const up = uploadPaths();
    const o = readJSON(up.meta, { list: [] });
    const state = String(url.searchParams.get('state') || '').trim();
    let list = Array.isArray(o.list) ? o.list.slice() : [];
    if (state) list = list.filter(x => x.state === state);
    const users = {};
    try {
      const uf = path.join(path.dirname(up.meta), 'users.json');
      const us = readJSON(uf, {});
      for (const k of Object.keys(us)) users[k] = us[k].username || '用户';
    } catch { }
    const out = list.map(t => ({
      id: t.id, name: t.name, artist: t.artist, album: t.album,
      size: t.size, ext: t.ext, at: t.at, state: t.state,
      reason: t.reason || '', plays: t.plays || 0, uid: t.uid,
      uploader: users[t.uid] || '（已注销）',
      exists: fs.existsSync(path.join(up.dir, String(t.file || '')))
    }));
    return sendJSON(res, { ok: true, list: out, dir: up.dir });
  }
  /* 试听：管理端不受「未审核」限制，待审的也能放 */
  if (p === '/api/uploads/file') {
    const up = uploadPaths();
    const id = String(url.searchParams.get('id') || '').trim();
    const o = readJSON(up.meta, { list: [] });
    const t = (o.list || []).find(x => x.id === id);
    /* 管理台没有主服务那个 send()，二进制得自己写响应头 */
    const raw = (code, body, ct) => {
      res.writeHead(code, { 'Content-Type': ct, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
      res.end(body);
    };
    if (!t) return raw(404, 'not found', 'text/plain; charset=utf-8');
    const fp = path.join(up.dir, String(t.file || '').replace(/[\\/]/g, ''));
    if (!fs.existsSync(fp)) return raw(404, '文件不在了', 'text/plain; charset=utf-8');
    const ct = ({ mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', aac: 'audio/aac' })[t.ext] || 'audio/mpeg';
    return raw(200, fs.readFileSync(fp), ct);
  }
  if (p === '/api/uploads/review' && req.method === 'POST') {
    const b = await readBody(req);
    const id = String((b && b.id) || '').trim();
    const ok2 = !!(b && b.approve);
    const reason = String((b && b.reason) || '').slice(0, 200).trim();
    const up = uploadPaths();
    const o = readJSON(up.meta, { list: [] });
    const t = (o.list || []).find(x => x.id === id);
    if (!t) return sendJSON(res, { ok: false, error: '找不到这条' }, 404);
    t.state = ok2 ? 'approved' : 'rejected';
    t.reason = ok2 ? '' : reason;
    t.reviewedAt = Date.now();
    writeJSON(up.meta, o);
    log('upload-review', { id, name: t.name, state: t.state, reason: t.reason });
    return sendJSON(res, { ok: true, state: t.state });
  }
  if (p === '/api/uploads/delete' && req.method === 'POST') {
    const b = await readBody(req);
    const id = String((b && b.id) || '').trim();
    const up = uploadPaths();
    const o = readJSON(up.meta, { list: [] });
    const t = (o.list || []).find(x => x.id === id);
    let removed = false;
    if (t) {
      o.list = o.list.filter(x => x.id !== id);
      writeJSON(up.meta, o);
      const fp = path.join(up.dir, String(t.file || '').replace(/[\\/]/g, ''));
      /* Windows 上偶尔会因为文件刚被读过而删不掉（播放器还握着句柄），
       * 重试几次基本都能成；实在不行也别让整条删除失败——记录已经清了。 */
      for (let i = 0; i < 4 && !removed; i++) {
        try {
          if (fs.existsSync(fp)) fs.unlinkSync(fp);
          removed = !fs.existsSync(fp);
        } catch { }
        if (!removed) {
          try { fs.rmSync(fp, { force: true, maxRetries: 3, retryDelay: 200 }); } catch { }
          removed = !fs.existsSync(fp);
        }
      }
    }
    log('upload-delete', { id, name: t ? t.name : '', removed });
    return sendJSON(res, { ok: true, fileRemoved: removed });
  }
  if (p === '/api/release/rollback' && req.method === 'POST') {
    const rel = releasePaths();
    const prevDir = path.join(rel.dir, 'prev');
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(path.join(prevDir, 'manifest.json'), 'utf8')); } catch { }
    if (!prev) return sendJSON(res, { ok: false, error: '没有可回滚的上一版' }, 400);
    /* 先把文件还原，再改清单 —— 顺序反了会出现「清单回退了、文件还是新的」 */
    for (const f of (prev.files || [])) {
      try {
        const s0 = path.join(prevDir, f.rel);
        if (fs.existsSync(s0)) fs.copyFileSync(s0, path.join(rel.dir, f.rel));
      } catch { /* ignore */ }
    }
    writeJSON(rel.manifest, prev);
    log('release-rollback', { to: prev.version });
    return sendJSON(res, { ok: true, published: prev });
  }

  if (p === '/api/log') return sendJSON(res, { ok: true, rows: readLog(Number(url.searchParams.get('n')) || 200) });

  sendJSON(res, { ok: false, error: 'not found' }, 404);
});

/* 端口被占就顺延：脚本版和 exe 版可能同时开着，各自用一个端口，互不打扰。
 * exe 态默认自动开浏览器（脚本态保持安静，不抢焦点）。 */
function start(port, tries = 0) {
  server.removeAllListeners('error');
  server.once('error', e => {
    if (e.code === 'EADDRINUSE' && tries < 12) {
      console.log('[admin] ' + port + ' 已被占用，改试 ' + (port + 1));
      setTimeout(() => start(port + 1, tries + 1), 60);
      return;
    }
    console.error('[admin] 启动失败：' + e.message);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    PORT = port;
    const url = 'http://' + HOST + ':' + port;
    console.log('[admin] YMusic 账号管理台  ' + url);
    console.log('[admin] 数据目录  ' + HOME_DIR);
    console.log('[admin] 只监听本机，不影响 8802 主服务与隧道');
    // 覆盖写：exe 每次启动端口可能不同，追加会让这个文件变成一坨历史
    try { fs.writeFileSync(path.join(HOME_DIR, 'current-url.txt'), url + '\r\n', 'utf8'); } catch { /* ignore */ }
    if (IS_SEA && process.env.OPEN !== '0') {
      try { spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
    }
  });
}
start(PORT_BASE);
