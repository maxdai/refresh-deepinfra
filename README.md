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

读写策略(2026-09-04 拍板):**整文件读写,不拼接**。

- 读 = vendored jsonc-parser 宽容解析:容忍注释/尾逗号,语法错误直接拒写
- 改 = 只对 `providers.deepinfra.models` 赋值,其余字段原对象保留
- 写 = `JSON.stringify` 整文件一次写入(2 空格标准 JSON,注释不保留)
- 写盘前 selfTest:候选是合法 JSON、models 数量与 catalog 一致、
  除 deepinfra.models 外整棵树逐值相等;任一失败不写
- 首次写盘前把当前文件备份到 `~/.pi/agent/models.json.corrupted`
- 原子写:写同目录临时文件 + rename,中途崩溃不会产生半截文件
- 写后回读盘上内容再跑一遍 selfTest

## 安装

```bash
git clone https://github.com/maxdai/refresh-deepinfra.git
./refresh-deepinfra/install.sh
```

然后在 pi 里 `/reload`。

install.sh 默认把仓库**软链**进 `~/.pi/agent/extensions/refresh-deepinfra`
(单一事实源,仓库更新即生效),支持:

```
./install.sh              # 软链安装(幂等,重复执行无害)
./install.sh --copy       # 复制安装(不随仓库更新)
./install.sh --force      # 替换指向别处的已有软链
./install.sh --uninstall  # 卸载(真目录需加 --force)
```

安装过程尊重 `PI_CODING_AGENT_DIR`,检查 node >= 18,并对 vendored
jsonc-parser 做冒烟自检;已有真目录会被移动到 `<目标>.bak-时间戳` 备份。

## 测试

```bash
npm install --ignore-scripts
npm test
```

22 项回归:对真实 `~/.pi/agent/models.json` 与真实 DeepInfra catalog 做
dry-run(只验证,不写盘)。覆盖:注释/尾逗号读容忍写剥离、BOM、键序
保留、多 provider、1000 模型压力、损坏拒写(`[[` 是合法嵌套数组整体接管,
stray `]]` 拒绝)、原子写/回读/幂等/截断/数量不符负例。测试直接用 jiti
加载 `index.ts` 真实实现,不用副本。

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
const { rebuildModelsConfig, selfTest } = await import('./index.ts');
// 拉 catalog、读 models.json、重写、selfTest、原子写的完整示例见 test/run-tests.cjs
"
```

## 设计说明

- **整文件重写而非原位拼接**(2026-09-04 用户拍板):models.json 就是一个
  JSON,读宽容写纯 JSON——读容忍注释/尾逗号,写整体序列化,注释不保留。
  原位替换 models 数组字节范围的 splice 方案已废弃。
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
