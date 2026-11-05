#!/usr/bin/env node
/* 敏感信息闸门
 * ------------
 * 这个仓库是对外公开的：任何人 fork/clone 都能拿到全部分支历史。
 * 一旦把服务器 IP、面板密码、平台 Cookie 或访问令牌提交上去，等于当众发出去，
 * 事后 delete 也删不掉 git 历史，只能整仓重建。
 *
 * 所以每次 push / PR 都跑一遍。只扫 git 已跟踪的文件（data/、runtime.json
 * 这些本来就在 .gitignore 里）。命中即失败，并打印打码后的上下文便于定位。
 *
 * 用法：node tools/ci/guard-sensitive.mjs
 * 退出码：0 干净；1 有命中。
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

/* 规则里的字面量故意拆开拼接，否则本文件自己会被自己命中 */
const RULES = [
  { name: '服务器公网 IP',      re: /\b113\.47\.1[0-9]\.\d{1,3}\b/ },
  { name: '服务器登录口令',      re: new RegExp('he' + 'Yue' + '723', 'i') },
  { name: '管理员默认授权码',    re: new RegExp('YMusic' + '2026', 'i') },
  { name: 'GitHub 访问令牌',     re: new RegExp('gh' + 'p_[A-Za-z0-9]{30,}') },
  { name: 'GitHub 细粒度令牌',   re: /github_pat_[A-Za-z0-9_]{40,}/ },
  { name: '私钥文件内容',        re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: '酷狗登录态 Cookie',   re: /MUSIC_U\s*[=:]\s*["']?[A-Za-z0-9%+/=_-]{24,}/ },
  { name: 'QQ音乐登录态 Cookie', re: /qm_keyst\s*[=:]\s*["']?[A-Za-z0-9%+/=_-]{24,}/ },
  { name: '网易云登录态 Cookie', re: /MUSIC_A\s*[=:]\s*["']?[A-Za-z0-9%+/=_-]{24,}/ },
  { name: 'B站登录态 Cookie',    re: /SESSDATA\s*[=:]\s*["']?[A-Za-z0-9%+/=_-]{24,}/ },
];

const TEXT_EXT = /\.(mjs|cjs|js|jsx|ts|tsx|json|html?|css|md|yml|yaml|sh|py|txt|gitignore|gitattributes|example)$/i;
const SKIP_PATH = /(^|\/)(node_modules|\.git|data|geo)\//;

function listFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
      .split('\0').filter(Boolean);
  } catch {
    // 没有 git（比如解压的源码包）：降级为遍历当前目录
    const out = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (/(node_modules|\.git|data)$/.test(e.name)) continue;
        const p = d === '.' ? e.name : `${d}/${e.name}`;
        if (e.isDirectory()) walk(p); else out.push(p);
      }
    })('.');
    return out;
  }
}

function mask(s) {
  if (s.length <= 8) return s[0] + '***';
  return s.slice(0, 3) + '*'.repeat(Math.min(12, s.length - 6)) + s.slice(-3);
}

const hits = [];
let scanned = 0;

for (const f of listFiles()) {
  if (SKIP_PATH.test(f)) continue;
  if (!TEXT_EXT.test(f) && !/^\.(gitignore|gitattributes)$/.test(f)) continue;
  let text;
  try {
    const st = fs.statSync(f);
    if (st.size > 4 * 1024 * 1024) continue;
    text = fs.readFileSync(f, 'utf8');
  } catch { continue; }
  if (text.includes('\0')) continue;   // 二进制
  scanned++;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const r of RULES) {
      const m = r.re.exec(lines[i]);
      if (!m) continue;
      hits.push({ file: f, line: i + 1, rule: r.name, sample: mask(m[0]) });
    }
  }
}

if (hits.length) {
  console.error(`\n✗ 发现 ${hits.length} 处敏感信息，已阻止提交：\n`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  [${h.rule}]  ${h.sample}`);
  console.error('\n处理方式：删掉真实值，改用占位符（如 127.0.0.1 / <YOUR_TOKEN> / config.example.json）。');
  console.error('如果已经 push 过，光删文件没用 —— 必须吊销那枚凭证。\n');
  process.exit(1);
}

console.log(`敏感信息检查：扫描 ${scanned} 个受控文本文件，未发现真实凭证 ✓`);
