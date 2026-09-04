/**
 * run-tests.cjs — /refresh-deepinfra 的回归测试。
 *
 * 用 jiti 直接加载真实 index.ts,调用其导出的 rebuildModelsConfig / selfTest
 * (测的是真实代码,不是副本)。不写真实 models.json;网络 case 拉真实 catalog。
 *
 * 语义(2026-09-04 用户拍板):读宽容(jsonc,容忍注释/尾逗号),
 * 写 = 整文件重写为标准 JSON(2 空格,注释不保留)。
 *
 * 运行:node ~/.pi/agent/extensions/refresh-deepinfra/test/run-tests.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createJiti } = require("jiti");

const EXT_DIR = path.resolve(__dirname, "..");

// stub:@earendil-works/pi-coding-agent(测试只用到纯函数,不需要扩展运行时)
const STUB = path.join(os.tmpdir(), "pi-refresh-deepinfra-stub.cjs");
fs.writeFileSync(STUB, "module.exports = { getAgentDir: () => '/root/.pi/agent' };\n");

const jiti = createJiti(__filename, {
	alias: { "@earendil-works/pi-coding-agent": STUB },
});

async function main() {
	const mod = await jiti.import(path.join(EXT_DIR, "index.ts"));
	const { rebuildModelsConfig, selfTest } = mod;
	if (typeof rebuildModelsConfig !== "function" || typeof selfTest !== "function") {
		console.error("FATAL: 真实 index.ts 导出缺失:", Object.keys(mod));
		process.exit(1);
	}
	console.log("✓ 已加载真实 index.ts,使用其 rebuildModelsConfig / selfTest");

	const res = await fetch("https://api.deepinfra.com/v1/openai/models");
	if (!res.ok) { console.error("catalog HTTP", res.status); process.exit(1); }
	const j = await res.json();
	const mapped = (j.data ?? [])
		.filter((m) => (m.metadata?.tags ?? []).includes("chat"))
		.map((m) => {
			const meta = m.metadata ?? {};
			const tags = meta.tags ?? [];
			const pricing = meta.pricing ?? {};
			const r4 = (n) => Math.round((n ?? 0) * 10000) / 10000;
			const reasoning = tags.includes("reasoning");
			const vision = tags.includes("vision") || tags.includes("vlm");
			return {
				id: m.id,
				name: (m.id.split("/").pop() ?? m.id).replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
				reasoning,
				thinkingLevelMap: reasoning ? { off: "none" } : undefined,
				input: vision ? ["text", "image"] : ["text"],
				cost: { input: r4(pricing.input_tokens), output: r4(pricing.output_tokens), cacheRead: r4(pricing.cache_read_tokens ?? pricing.input_tokens), cacheWrite: 0 },
				contextWindow: meta.context_length ?? 128000,
				maxTokens: meta.max_tokens ?? 4096,
			};
		});
	console.log(`catalog: ${mapped.length} chat models`);
	const orig = fs.readFileSync("/root/.pi/agent/models.json", "utf-8");

	const big = Array.from({ length: 1000 }, (_, i) => ({ id: `m/${i}`, name: `M ${i}`, reasoning: i % 2 === 0, input: ["text"], cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 1000 }));

	// throws:true = 必须抛错(损坏/结构性缺失,拒写);pretty = 输出必须是多行标准 JSON
	const cases = [
		{ label: "真实文件", input: orig, pretty: true },
		{ label: "标准(紧凑单行)", input: '{"providers":{"deepinfra":{"apiKey":"k","models":[{"id":"a"}]}}}', pretty: true },
		{ label: "models 在最前(键序保留)", input: '{"providers":{"deepinfra":{"models":[{"id":"a"}],"apiKey":"k","baseUrl":"u","api":"a"}}}', pretty: true, firstKey: "models" },
		{ label: "models 在最后(键序保留)", input: '{"providers":{"deepinfra":{"apiKey":"k","baseUrl":"u","api":"a","models":[{"id":"a"}]}}}', pretty: true, lastKey: "models" },
		{ label: "JSONC 行注释(读容忍,写剥离)", input: '{\n  // 配置\n  "providers": {\n    "deepinfra": { // 尾注释\n      "apiKey": "k",\n      "models": [{"id": "a"}]\n    }\n  }\n}', noComments: true },
		{ label: "trailing comma(读容忍,写剥离)", input: '{"providers":{"deepinfra":{"apiKey":"k","models":[{"id":"a"}],}}}', pretty: true },
		{ label: "多 provider 保留", input: '{"providers":{"anthropic":{"apiKey":"k1"},"deepinfra":{"apiKey":"k2","models":[{"id":"a"}]},"openai":{"apiKey":"k3"}}}', pretty: true },
		{ label: "headers + modelOverrides 保留", input: '{"providers":{"deepinfra":{"apiKey":"k","headers":{"X-A":"1"},"modelOverrides":{"a":{"contextWindow":5}},"models":[{"id":"a"}]}}}', pretty: true },
		{ label: "UTF-8 BOM(剥离)", input: "﻿" + '{"providers":{"deepinfra":{"apiKey":"k","models":[{"id":"a"}]}}}', pretty: true },
		{ label: "1000 模型压力", input: `{"providers":{"deepinfra":{"apiKey":"k","models":${JSON.stringify(big)}}}}`, pretty: true },
		{ label: "models 是字符串(整体接管,换成真数组)", input: '{"providers":{"deepinfra":{"apiKey":"k","models":"foo"}}}', pretty: true },
		{ label: "models 是 null(整体接管,换成真数组)", input: '{"providers":{"deepinfra":{"apiKey":"k","models":null}}}', pretty: true },
		{ label: "双层 [[...]](合法嵌套数组,整体接管)", input: '{"providers":{"deepinfra":{"apiKey":"k","models":[[{"id":"a"},{"id":"b"}]]}}}', pretty: true },
		{ label: "stray ]] 损坏(应抛错)", input: '{"providers":{"deepinfra":{"apiKey":"k","models":[{"id":"a"}]]}}}', throws: true },
		{ label: "无 providers(应抛错)", input: '{"foo":1}', throws: true },
		{ label: "无 deepinfra(应抛错)", input: '{"providers":{"anthropic":{}}}', throws: true },
	];

	let total = 0, passed = 0;
	for (const c of cases) {
		total++;
		let out, err;
		try { out = rebuildModelsConfig(c.input, mapped); } catch (e) { err = e; }
		if (c.throws) {
			if (err) { passed++; console.log(`  ✓ ${c.label}`); }
			else console.log(`  ✗ ${c.label} 应抛错却成功`);
			continue;
		}
		if (err) { console.log(`  ✗ ${c.label} 意外抛错: ${err.message}`); continue; }
		const failure = selfTest(c.input, out, mapped.length);
		if (failure) { console.log(`  ✗ ${c.label} selfTest: ${failure}`); continue; }
		let parsed;
		try { parsed = JSON.parse(out); } catch (e) { console.log(`  ✗ ${c.label} 输出不是标准 JSON: ${e.message}`); continue; }
		const arr = parsed?.providers?.deepinfra?.models;
		if (!Array.isArray(arr) || arr[0]?.id !== mapped[0].id) { console.log(`  ✗ ${c.label} models[0] 与 catalog 不符`); continue; }
		const keys = Object.keys(parsed.providers.deepinfra);
		if (c.firstKey && keys[0] !== c.firstKey) { console.log(`  ✗ ${c.label} 首键不是 ${c.firstKey}`); continue; }
		if (c.lastKey && keys[keys.length - 1] !== c.lastKey) { console.log(`  ✗ ${c.label} 末键不是 ${c.lastKey}`); continue; }
		if (c.noComments && out.includes("//")) { console.log(`  ✗ ${c.label} 输出残留注释`); continue; }
		if (c.pretty && out.split("\n").length < 5) { console.log(`  ✗ ${c.label} 输出不是多行格式`); continue; }
		passed++;
		console.log(`  ✓ ${c.label}`);
	}

	// 原子写 + 回读验证模拟(不动真实文件)
	console.log("\n--- 原子写 + 回读验证模拟 ---");
	const cand = rebuildModelsConfig(orig, mapped);
	let failure = selfTest(orig, cand, mapped.length);
	if (failure) { console.log(`  ✗ rebuild/selfTest: ${failure}`); process.exit(1); }
	const tmp = `/tmp/models.json.sim-${process.pid}`;
	fs.writeFileSync(tmp, cand, "utf-8");
	fs.renameSync(tmp, tmp + "-final");
	const readback = fs.readFileSync(tmp + "-final", "utf-8");
	failure = selfTest(orig, readback, mapped.length);
	if (failure) { console.log(`  ✗ 回读 selfTest: ${failure}`); process.exit(1); }
	total++; passed++;
	console.log("  ✓ 原子写(tmp+rename)+ 回读 selfTest 通过");
	fs.rmSync(tmp + "-final", { force: true });

	// 幂等:对已重写的输出再跑一次,逐字节不变
	total++;
	const again = rebuildModelsConfig(cand, mapped);
	if (again === cand) { passed++; console.log("  ✓ 幂等:二次刷新输出逐字节不变"); }
	else console.log("  ✗ 幂等失败:二次输出与首次不同");

	// 负例 1:截断的损坏候选必须被 selfTest 拦截
	total++;
	const truncated = cand.slice(0, Math.floor(cand.length * 0.9));
	const tErr = selfTest(orig, truncated, mapped.length);
	if (tErr) { passed++; console.log(`  ✓ 截断 90% 的损坏文件被 selfTest 拦截`); }
	else console.log("  ✗ 截断文件未被拦截!");

	// 负例 2:selfTest 必须拒绝 models 数量不对的候选
	total++;
	const tErr2 = selfTest(orig, cand, mapped.length + 1);
	if (tErr2) { passed++; console.log(`  ✓ models 数量不符被拦截: ${tErr2.slice(0, 40)}...`); }
	else console.log("  ✗ 数量不符未被拦截!");

	// 正例:provider 只有 models 一个键也是合法的,selfTest 不能误拒
	total++;
	const modelsOnly = '{"providers":{"deepinfra":{"models":[{"id":"a"}]}}}';
	const moOut = rebuildModelsConfig(modelsOnly, mapped);
	const moErr = selfTest(modelsOnly, moOut, mapped.length);
	if (!moErr) { passed++; console.log("  ✓ 只有 models 键的 provider 不被误拒"); }
	else console.log(`  ✗ models-only 被误拒: ${moErr}`);

	// 负例 3:deepinfra 节点真的缺失时仍要拒绝
	total++;
	const noProvider = '{"providers":{"other":{"apiKey":"k"}}}';
	let spliced = false;
	try { rebuildModelsConfig(noProvider, mapped); spliced = true; } catch { /* 预期抛错 */ }
	if (!spliced) { passed++; console.log("  ✓ deepinfra 缺失仍正确抛错"); }
	else console.log("  ✗ deepinfra 缺失未抛错!");

	console.log(`\n${passed}/${total} 通过`);
	fs.rmSync(STUB, { force: true });
	process.exit(passed < total ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
