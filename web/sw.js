/* YMusic Service Worker
 * 策略：
 *   · /api/* 一律走网络 —— 音频、封面、搜索、下载任务都是实时的，绝不缓存
 *     （尤其 /api/proxy 是分片音频流，缓存它会直接毁掉播放）
 *   · 静态外壳 network-first + 缓存兜底 —— 手机离线也能打开界面
 */
/* ⚠️ 改了 web/ 下任何静态文件都要 +1：老 CACHE 不失效，
   手机端拿到的还是上一个版本的外壳，表现为「代码改了但页面没变」。 */
const CACHE = 'ymusic-v51';
const SHELL = [
  '/', '/index.html', '/logo-mark.svg', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/favicon-64.png'
];

/* ⚠️ 禁止改回 Promise.all —— 请求挂死时 waitUntil 永不 settle
 * ⚠️ 只改成串行 await 也无效 —— 串行不改「单个等多久」
 *
 *   两句都是实测结论，不是风格偏好。删掉任何一句都会让这个 bug 以更隐蔽的形式复发。
 *
 *   SHELL 里只要有一个请求既不返回也不报错（弱网、后端半死、代理抽风），
 *   waitUntil() 就永远不 settle，SW 永久停在 installing：
 *   controller 一直为 null，离线壳和 network-first 全部变成死代码，
 *   而且不会自愈 —— 用户不手动清站点数据就一直坏着。
 *
 *   串行 await 只改变「同时发几个」，不改变「单个等多久」：
 *   挂死的那个排第 1 个还是第 7 个，await 都会停在它那儿。
 *   实测（有头 Chromium，绕过代理，黑洞路由已确认生效）：
 *     Promise.all + 1 挂死 → installing 满 25s 无进展
 *     串行 await + 1 挂死 → installing 满 25s 无进展（一样卡）
 *     串行 + 每请求 5s 上限 → 约 5s 后跳过并激活
 *
 *   所以救命的是「每请求超时竞速」，串行只是顺带降低弱网下的瞬时并发。
 *   代价：超时那个资源这次不进缓存，下次 fetch 走网络补齐 ——
 *   宁可少缓存一个，也不能让整个 SW 永不激活。
 */
const INSTALL_TIMEOUT_MS = 5000;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    for (const u of SHELL) {
      /* 超时后那个请求并不会被取消，只是不等它了 —— 可接受。 */
      await Promise.race([
        c.add(u).catch(() => null),
        new Promise((r) => setTimeout(r, INSTALL_TIMEOUT_MS))
      ]);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;          // 跨域资源不接管
  if (url.pathname.startsWith('/api/')) return;             // 实时接口：一律网络直通

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html')))
  );
});
