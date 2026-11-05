/**
 * 账号管理台 · SEA 引导（CommonJS）—— exe 的真正入口
 *
 * Node 的 SEA 只认 CommonJS 主脚本，而管理台源码是 ESM。
 * 所以把 admin/server.mjs 当**内嵌资源**打包进来，运行时取出、落到临时文件、再 import()。
 * 与主服务的 sea-main.cjs 是同一套思路，只是主资源名不同。
 */
'use strict';
const sea = require('node:sea');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MAIN_ASSET = 'admin-server.mjs';

function fail(msg) {
  console.error('\n  ✗ 启动失败：' + msg + '\n');
  process.exit(1);
}

if (!sea.isSea || !sea.isSea()) {
  fail('这个 exe 没有内嵌资源，可能是打包时漏了 inject 步骤');
}

let code;
try {
  code = sea.getAsset(MAIN_ASSET, 'utf8');
} catch (e) {
  fail('取不到内嵌管理台代码（' + MAIN_ASSET + '）：' + e.message);
}

// 落到临时文件再 import()。优先系统临时目录，拿不到就退回 exe 同目录。
const suffix = '.ymusic-admin-' + process.pid + '.mjs';
let tmp = path.join(os.tmpdir(), suffix);
try {
  fs.writeFileSync(tmp, code, 'utf8');
} catch (e) {
  tmp = path.join(path.dirname(process.execPath), suffix);
  try { fs.writeFileSync(tmp, code, 'utf8'); }
  catch (e2) { fail('无法写出运行时文件：' + e2.message); }
}

load(tmp);

function load(file) {
  const cleanup = () => { try { fs.unlinkSync(file); } catch (_) { /* ignore */ } };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  import(pathToFileURL(file).href).catch((err) => {
    console.error('\n  ✗ 管理台启动失败：');
    console.error(err && err.stack ? err.stack : err);
    cleanup();
    process.exit(1);
  });
}
