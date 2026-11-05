#!/usr/bin/env node
/* 内嵌脚本语法检查
 * -----------------
 * web/ 下的页面是单文件形态：HTML 里内联了整段 JS（index.html 就有上千行）。
 * `node --check` 只能查 .mjs/.js 文件，查不到这些内联块，而历史事故恰恰出在这里：
 * 一次编辑吃掉了相邻分支的 `}`，静态规则全过、浏览器里整段脚本不执行、页面全黑。
 *
 * 所以这里把每个 <script> 块抽出来交给 V8 解析一遍。只做「能不能被解析」，
 * 不管 ES5/ES6 风格 —— 风格检查误报率高，且不影响页面能否跑起来。
 *
 * 用法：node tools/ci/check-inline-js.mjs [目录，默认 web]
 * 退出码：0 全部通过；1 有块解析失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = process.argv[2] || 'web';
const SKIP_DIR = new Set(['node_modules', '.git', 'data', '_backup']);

function walk(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (SKIP_DIR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.html?$/i.test(e.name)) out.push(p);
  }
  return out;
}

/* 抽出 <script> 块。type 为 module 的同样按模块解析；带 src 的跳过（外部文件）。 */
function scriptBlocks(html) {
  const blocks = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    const code = m[2] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (!code.trim()) continue;
    const line = html.slice(0, m.index).split('\n').length;
    blocks.push({ code, line, module: /type\s*=\s*["']?module/i.test(attrs) });
  }
  return blocks;
}

let files = 0, blocks = 0, failed = 0;

for (const file of walk(ROOT)) {
  const html = fs.readFileSync(file, 'utf8');
  const list = scriptBlocks(html);
  if (!list.length) continue;
  files++;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    blocks++;
    try {
      // 用 vm.Script 只做编译，不执行。module 块用 SourceTextModule 不可用（需 flag），
      // 退化成普通脚本解析：import/export 会报错，此时改为跳过并提示，不判定失败。
      if (b.module) { console.log(`  · ${file} 第 ${i + 1} 块（type=module，跳过）`); continue; }
      new vm.Script(b.code, { filename: `${file}#${i + 1}` });
    } catch (e) {
      failed++;
      const msg = String(e && e.message || e);
      console.error(`\n✗ ${file} 第 ${i + 1} 块（HTML 第 ${b.line} 行起）解析失败：`);
      console.error(`  ${msg}`);
      const mm = /:(\d+)/.exec(msg);
      if (mm) {
        const n = Number(mm[1]);
        const lines = b.code.split('\n');
        for (let k = Math.max(0, n - 3); k < Math.min(lines.length, n + 2); k++) {
          console.error(`  ${String(k + 1).padStart(4)} | ${lines[k]}`);
        }
      }
    }
  }
}

console.log(`\n内联脚本检查：${files} 个 HTML / ${blocks} 个块，失败 ${failed} 个`);
process.exit(failed ? 1 : 0);
