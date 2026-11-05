# 贡献指南

感谢你想改进 YMusic。这个项目有几点和常见前端项目不同，动手前请先看完。

## 环境

```bash
git clone https://github.com/LangJi-hub/YMusic.git
cd YMusic
node server.mjs          # 需要 Node.js ≥ 22
```

无需 `npm install`。如果你发现某处需要装依赖才能跑，那大概率是改动引入了不该有的依赖。

## 提交前自检

改完代码，按顺序过一遍：

1. **服务端语法**
   ```bash
   node --check server.mjs
   node --check admin/server.mjs
   ```

2. **前端语法**（单文件体量大，最容易在这里出事）
   ```bash
   node tools/ci/check-inline-js.mjs
   ```
   把每个 `<script>` 块交给 V8 解析一遍。整页白屏的典型原因就是某次编辑吃掉了相邻分支的 `}`，
   代码风格规则查不出来，但浏览器里整段脚本会直接不执行。

3. **没有引入第三方依赖**
   ```bash
   grep -n "^import" server.mjs | grep -v "node:"
   ```
   应当**没有任何输出**。

4. **没有提交运行时数据**
   ```bash
   git status --short | grep -E "data/|Downloads/|runtime.json"
   node tools/ci/guard-sensitive.mjs
   ```
   应当**没有任何输出**，且敏感信息检查通过。

以上四项在 GitHub Actions 里也会跑（见 `.github/workflows/ci.yml`），
其中还包括一次干净克隆的冷启动冒烟：`node server.mjs` 起来后用 `/api/ping` 探活。

## 代码风格

### 服务端 `server.mjs`

- 只用 `node:` 内置模块
- 可写路径一律经 `APP_DIR`，不要用 `__dirname`
- 写 JSON 必须走 `writeJSON()`（原子写），不要直接 `fs.writeFileSync`
- 注释写「为什么」，不写「做什么」——代码本身已经说明在做什么

### 前端 `web/index.html`

**必须守 ES5**：

| 禁用 | 改用 |
|---|---|
| `let` / `const` | `var` |
| 箭头函数 | `function` |
| 模板字符串 | 字符串拼接 |
| 解构 / 展开 | 逐项取值 |
| `class` | 构造函数 + 原型 |
| 可选链 `?.` | `&&` 逐层判断 |

原因见 [架构说明](docs/ARCHITECTURE.md#es5-约束的真实原因)。这不是风格偏好，是目标设备决定的下限。

### 提交信息

用中文，说清「改了什么、为什么」。

```
修复：搜索翻到末页时不再重复请求同一批

末页判定用的是本地数组长度，但多平台去重后长度会小于请求总量，
导致「还有下一页」永远成立。改成按实际返回条数判断。
```

## 改动影响面

以下几处改动需要额外注意，改之前建议先开 issue 讨论：

| 改动 | 风险 |
|---|---|
| 新增可播放列表 | 需同时改容器选择器、上下文映射白名单、数据源指向，漏一处静默播错歌 |
| 改 `userOf()` 签名 | 所有消费点都要跟着改 |
| 合并两个管理台 | **不要做**，会破坏权限边界 |
| 引入第三方依赖 | **不要做**，SEA 打包会崩 |
| 改 `data/` 结构 | 需要写迁移逻辑，且更新 CHANGELOG 的主版本号 |

## 提交 Pull Request

1. 从 `main` 切分支：`git checkout -b fix/搜索末页重复请求`
2. 按上面的自检清单过一遍
3. PR 描述里写清：**现象、原因、改法、验证方式**
4. 涉及界面的改动请附截图

## 报告问题

提交 issue 时请包含：

- 复现步骤（越具体越好）
- 期望行为与实际行为
- Node 版本、操作系统、服务端版本（`/api/ping` 可查）
- 相关日志或控制台报错

**不要**在 issue 里贴真实账号、Cookie、`secrets.json` 内容。

## 许可证

提交的代码默认以 [MIT](LICENSE) 授权。
