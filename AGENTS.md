# refresh-deepinfra 项目上下文

本仓库是 pi 扩展 `/refresh-deepinfra`:用 DeepInfra 线上 catalog 刷新
`~/.pi/agent/models.json` 中 `providers.deepinfra.models` 数组。
新会话先读这份文件,不要重复排查已知结论。

## 仓库与安装

- GitHub: `maxdai/refresh-deepinfra`(main 分支);仓库局部 git 身份
  `maxdai <maxdai@gmail.com>`;全局 git 身份也是这个(2026-09-04 按用户
  指示恢复,曾误设为 scturtle 并覆盖过用户原值——不要再动全局配置)。
- 安装方式:软链 `~/.pi/agent/extensions/refresh-deepinfra -> /root/refresh-deepinfra`
  (由 `./install.sh` 创建;支持 --copy/--force/--uninstall,尊重
  `PI_CODING_AGENT_DIR`)。改仓库代码即生效,TUI 里 `/reload`。
- 提交历史:`81a8908` 初始扩展 → `3dcc7de` README(pi -p 限制+设计说明)
  → `da059f3` install.sh → `c87e118` AGENTS.md → `aa30fb5` 整文件重写架构
  (废弃 tree-aware splice)→ `c2d79ce` apiKey 迁至 auth.json(文档同步)。

## deepinfra provider 配置(用户机器现状)

- `~/.pi/agent/models.json` 的 `providers.deepinfra`:baseUrl
  `https://api.deepinfra.com/v1/openai`,api `openai-completions`,
  **无 apiKey 字段**,compat:
  `{maxTokensField:"max_tokens", supportsStore:false, supportsDeveloperRole:false, supportsReasoningEffort:true}`。
- apiKey 存放在 `~/.pi/agent/auth.json` 的 `deepinfra` 条目(0600 权限;
  2026-09-04 从 models.json 迁入,实测 `pi auth check --provider deepinfra`
  ready + 真实请求通过)。pi 解析顺序:auth.json stored credential →
  models.json apiKey 字段 → 内建环境变量约定。旧记录"models.json 的
  apiKey 不读 auth.json"是误判,已纠正。
- pi-deepinfra npm 插件已从 settings.json packages 移除,完全由纯配置接管
  (node_modules 里残留副本未被引用)。
- models 数组:104 个 chat 模型(catalog 总 189,按 tags 含 "chat" 过滤),
  2026-09-04 与线上 catalog 同步(add 0 / remove 0)。
- `~/.pi/agent/models.json.corrupted` 是首次刷新前的备份(只建一次,不覆盖)。
- 用户常用模型:`zai-org/GLM-5.3-Flash`、`deepseek-ai/DeepSeek-V4-Flash-0731`
  (均经 deepinfra,实测可用;用户环境 PI_PROVIDER=deepinfra)。

## 扩展安全机制(不要弱化)

按顺序:fetch catalog(**故意在读文件之前**,缩小竞态窗口)→ 读 models.json
→ jsonc-parser 宽容解析整文件(容忍注释/尾逗号;语法错误拒写)→ 只对
providers.deepinfra.models 赋值 → JSON.stringify 整文件(2 空格 + 末尾换行)
→ selfTest(候选是合法 JSON、models 数量与 catalog 一致、除 deepinfra.models
外整棵树逐值相等;任一失败不写盘)→ 首次备份 → 同目录临时文件 + rename
原子写(临时文件名带 process.pid + 自增序号,防同进程连发互踩)→ 写后回读
再 selfTest。

## 已定设计决策(不要推翻)

- **整文件读写,不拼接**(2026-09-04 用户拍板):models.json 就是一个 JSON,
  读宽容(vendored jsonc-parser,容忍注释/尾逗号),写纯 JSON(JSON.stringify
  整文件一次写入,2 空格缩进,注释不保留)。tree-aware 原位 splice 已删除,
  不要加回。
- JSON 解析只允许两种工具:vendored jsonc-parser(宽容读)与标准
  JSON.parse/stringify;比较用 assert.deepStrictEqual。**禁止手拼 JSON 文本**
  (含调试/夹具);工具不合适就找合适工具,找不到合规路径必须停下报告由
  用户选择,不得私自变通(2026-09-04 用户立规)。
- `package.json` **不能加 `"type":"module"`**:会把 UMD 的 `jsonc/main.js`
  当 ESM 解析,`module.exports` 丢失,扩展直接失效(踩过的坑)。
- `thinkingLevelMap: { off: "none" }`(reasoning 模型)是必要设计:实测
  DeepInfra 不发 `reasoning_effort` 时 reasoning **默认开启**,"none" 才能关;
  minimal/low/medium/high/max 全部被接受(GLM-5.3-Flash 和
  DeepSeek-V4-Flash-0731 双模型实测)。
- 写盘前重读比对的"竞态防线"被用户否决(无必要且关不死窗口),不要加回。

## 已知问题(pi 本体,非本插件)

pi v0.84.4 的 `-p`/print 模式下**任何**扩展命令(含空命令、其它扩展如
magic-context 的 `/ctx-status`):handler 完整执行、副作用生效,但进程挂起
不退出(只能 timeout 杀),且零输出(print 模式扩展 UI 是 noOpUIContext,
notify 被吞;扩展命令不触发 LLM 回合)。TUI 完全正常。已写入 README,
未向上游报告。**因此脚本化刷新不要走 `pi -p`**;如需要,用 jiti 直接加载
`index.ts` 的 `rebuildModelsConfig`/`selfTest` 纯函数(`test/run-tests.cjs`
就是范例),或未来加独立 CLI 入口(用户暂缓,留作可能性)。

## 测试

`npm test` = `test/run-tests.cjs`,22 项回归。先 `npm install --ignore-scripts`
(devDep 仅 jiti 2.7.0)。测试用 jiti 加载**真实 index.ts**(非副本),拉真实
catalog,对真实 `~/.pi/agent/models.json` 做 dry-run,**从不写盘**。覆盖:
注释/尾逗号读容忍写剥离、BOM、键序保留、多 provider、1000 模型压力、
损坏拒写(`[[` 是合法嵌套数组整体接管;stray `]]` 拒绝)、原子写+回读模拟、
幂等、截断损坏拦截、数量不符拦截、models-only provider 不误拒。
修改代码后必须跑。

## 历史教训(本仓库诞生过程中踩过的)

不要手写 JSON 解析/编辑逻辑(手写 splice 连环产生损坏文件;2026-09-04 进一步
裁定:绕开工具的周边手写逻辑也不接受——工具不合适就换工具,无合规路径
先停下报告由用户选择);不要没测完就让用户运行(用户明确说过"不要让我
一次一次去碰壁");测试要加载真实代码并核对称谓("应抛错"因错误原因通过
是假绿);e2e 要捕获退出码(管道 head 会掩盖挂起);不擅自改用户全局配置;
先给最小可行改动让用户看真实输出,不要预判用户不满意而自行升级方案。
