# pi-refresh-deepinfra

Pi 扩展:`/refresh-deepinfra` 用 DeepInfra 线上 catalog 刷新
`~/.pi/agent/models.json` 中 `providers.deepinfra.models` 数组。

## 使用

```
/refresh-deepinfra
```

成功后 TUI 通知写入的模型数,`/reload` 后生效。任何异常(catalog 为空、
解析失败、self-test 未通过、写入失败)都会拒绝写盘并给出原因,
`models.json` 永远不会被写坏。

## 安全机制

- JSON 解析/定位/编辑/验证全部使用 vendored 的
  [jsonc-parser](https://github.com/microsoft/node-jsonc-parser)(Microsoft,MIT,
  见 `jsonc/LICENSE.md`),不手写任何 JSON 逻辑
- 编辑是 tree-aware 的:只替换 models 数组的字节范围,文件其余部分
  (注释/缩进/其它 provider/其它字段)原样保留
- 写盘前 selfTest:候选零解析错误、模型数量与 catalog 一致、deepinfra
  其它字段逐值保留、providers 集合不变;任一失败不写
- 首次写盘前把当前文件备份到 `~/.pi/agent/models.json.corrupted`
- 原子写:写同目录临时文件 + rename,中途崩溃不会产生半截文件
- 写后回读盘上内容再跑一遍 selfTest

## 安装

```bash
git clone <repo-url> ~/refresh-deepinfra
ln -s ~/refresh-deepinfra ~/.pi/agent/extensions/refresh-deepinfra
```

然后在 pi 里 `/reload`。

## 测试

```bash
npm install --ignore-scripts
npm test
```

22 项回归:对真实 `~/.pi/agent/models.json` 与真实 DeepInfra catalog 做
dry-run(只验证,不写盘),覆盖标准/损坏/JSONC/BOM/多 provider/压力等
17 种文件形态 + 原子写/回读/负例。测试直接用 jiti 加载 `index.ts`
真实实现,不用副本。

## 已知限制:pi -p(print 模式)下不要用扩展命令

pi v0.84.4 的 `pi -p "/refresh-deepinfra"` 存在两个问题(任何扩展命令均如此,
非本插件独有):

1. **无输出**:print 模式给扩展绑定的 UI 是 noOp(`notify: () => {}`),
   且扩展命令不触发 LLM 回合(执行完 handler 直接返回),所以零输出;
2. **进程挂起**:handler 正常执行完(副作用生效)后,pi 进程不退出,
   只能靠外部 timeout 杀掉。

TUI 内使用完全不受影响。若确需脚本化刷新,直接用 jiti 调纯函数,
绕开 pi 进程:

```bash
cd ~/refresh-deepinfra && node --import jiti/register -e "
const { spliceModelsArray, selfTest } = await import('./index.ts');
// 拉 catalog、读 models.json、splice、selfTest、原子写的完整示例见 test/run-tests.cjs
"
```

## 设计说明

- **`thinkingLevelMap: { off: \"none\" }`**(`reasoning: true` 的模型):
  经实测必要——DeepInfra 的 reasoning 模型在不发 `reasoning_effort` 时
  **默认开启思考**;发送 `\"none\"` 才能真正关闭。其余档位(minimal/low/
  medium/high)DeepInfra 全部接受。
- **vendored `jsonc/` 不能加 `"type": "module"`**:仓库根 `package.json`
  一旦声明 `type: module`,Node 会把 UMD 格式的 `jsonc/main.js` 当 ESM
  解析,`module.exports` 被忽略,parseTree 等导出全部丢失。

## 注意

- 仓库本身不含任何密钥;`models.json` 含 apiKey,**不要**提交它
- `jsonc/` 是 vendored 第三方代码,随仓库提交以保证克隆即可用
