/**
 * /refresh-deepinfra — 用 DeepInfra 线上 catalog 刷新 ~/.pi/agent/models.json
 * 中 providers.deepinfra.models。
 *
 * 架构(2026-09-04 用户拍板):整文件读写,不拼接。
 *   - 读:vendored jsonc-parser 宽容解析(容忍注释/尾逗号);语法错误拒写。
 *   - 改:只赋值 providers.deepinfra.models 一个字段,其余字段原对象保留。
 *   - 写:JSON.stringify 整文件一次写入(2 空格缩进,标准 JSON,注释不保留)。
 *
 * 安全机制(任一失败不写盘):
 *   - selfTest:候选是合法 JSON、models 数量与 catalog 一致、除
 *     deepinfra.models 外整棵树逐值相等(其它配置不丢)。
 *   - 首次写盘前备份到 models.json.corrupted(只建一次)。
 *   - 同目录临时文件 + rename 原子写;写后回读再 selfTest。
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { deepStrictEqual } from "node:assert";
import { createRequire } from "node:module";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Vendored jsonc-parser(Microsoft,MIT)— 读侧宽容解析
// ---------------------------------------------------------------------------

interface JsoncParseError {
	error: number;
	offset: number;
	length: number;
}

interface JsoncParser {
	parse(
		text: string,
		errors?: JsoncParseError[],
		options?: { allowTrailingComma?: boolean; disallowComments?: boolean },
	): unknown;
}

const require = createRequire(import.meta.url);
const jsonc = require("./jsonc/main.js") as JsoncParser;

const READ_OPTIONS = { allowTrailingComma: true } as const;

/** 宽容读:剥 BOM,容忍注释/尾逗号;任何语法错误抛错,绝不返回残缺对象。 */
export function parseConfig(text: string): Record<string, any> {
	const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const errors: JsoncParseError[] = [];
	const value = jsonc.parse(body, errors, READ_OPTIONS);
	if (errors.length > 0 || value === undefined || typeof value !== "object" || value === null) {
		throw new Error(`models.json 解析失败(${errors.length} 个语法错误)`);
	}
	return value as Record<string, any>;
}

// ---------------------------------------------------------------------------
// DeepInfra catalog → pi models.json 映射
// ---------------------------------------------------------------------------

const DEEPINFRA_MODELS_URL = "https://api.deepinfra.com/v1/openai/models";
const DEEPINFRA_PROVIDER_ID = "deepinfra";

interface DeepInfraCatalogModel {
	id: string;
	metadata?: {
		context_length?: number;
		max_tokens?: number;
		pricing?: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number };
		tags?: string[];
	};
}

interface ModelsJsonModel {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string>;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

function round4(n: number | undefined): number {
	return Math.round((n ?? 0) * 10000) / 10000;
}

function displayName(id: string): string {
	const last = id.split("/").pop() ?? id;
	return last.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function mapCatalogModel(raw: DeepInfraCatalogModel): ModelsJsonModel {
	const metadata = raw.metadata ?? {};
	const tags = metadata.tags ?? [];
	const pricing = metadata.pricing ?? {};
	const reasoning = tags.includes("reasoning");
	const hasVision = tags.includes("vision") || tags.includes("vlm");
	return {
		id: raw.id,
		name: displayName(raw.id),
		reasoning,
		thinkingLevelMap: reasoning ? { off: "none" } : undefined,
		input: hasVision ? ["text", "image"] : ["text"],
		cost: {
			input: round4(pricing.input_tokens),
			output: round4(pricing.output_tokens),
			cacheRead: round4(pricing.cache_read_tokens ?? pricing.input_tokens),
			cacheWrite: 0,
		},
		contextWindow: metadata.context_length ?? 128000,
		maxTokens: metadata.max_tokens ?? 4096,
	};
}

async function fetchCatalog(signal?: AbortSignal): Promise<ModelsJsonModel[]> {
	const res = await fetch(DEEPINFRA_MODELS_URL, { signal });
	if (!res.ok) throw new Error(`catalog 拉取失败: HTTP ${res.status}`);
	const json = (await res.json()) as { data?: DeepInfraCatalogModel[] };
	return (json.data ?? [])
		.filter((m) => (m.metadata?.tags ?? []).includes("chat"))
		.map(mapCatalogModel);
}

// ---------------------------------------------------------------------------
// 整文件重写:只换 providers.deepinfra.models,其余字段原对象保留
// ---------------------------------------------------------------------------

export function rebuildModelsConfig(originalText: string, liveModels: ModelsJsonModel[]): string {
	const config = parseConfig(originalText);
	const deepinfra = (config.providers as any)?.[DEEPINFRA_PROVIDER_ID];
	if (!deepinfra || typeof deepinfra !== "object" || Array.isArray(deepinfra)) {
		throw new Error(`models.json 中找不到 providers.${DEEPINFRA_PROVIDER_ID} 对象`);
	}
	deepinfra.models = liveModels;
	return JSON.stringify(config, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// 写盘前强制 self-test;返回 null 表示通过,否则返回失败原因
// ---------------------------------------------------------------------------

function eq(a: unknown, b: unknown): boolean {
	try {
		deepStrictEqual(a, b);
		return true;
	} catch {
		return false;
	}
}

export function selfTest(originalText: string, candidateText: string, expectedCount: number): string | null {
	// 1. 候选必须是零瑕疵的标准 JSON(写出去的就是纯 JSON)
	let cand: Record<string, any>;
	try {
		cand = JSON.parse(candidateText);
	} catch {
		return "候选文件不是合法 JSON";
	}

	// 2. models 数组存在、数量与 catalog 一致
	const models = cand?.providers?.deepinfra?.models;
	if (!Array.isArray(models)) return "候选缺少 providers.deepinfra.models 数组";
	if (models.length !== expectedCount) {
		return `models 数量不符:期望 ${expectedCount},实际 ${models.length}`;
	}
	if (models[0]?.id === undefined) return "候选 models 第一项缺少 id";

	// 3. 原文件必须可解析(否则拒绝覆写)
	let orig: Record<string, any>;
	try {
		orig = parseConfig(originalText);
	} catch {
		return "原文件无法解析,拒绝覆写";
	}

	// 4. 除 deepinfra.models 外整棵树逐值相等(其它配置不丢)
	const origTop = { ...orig };
	const candTop = { ...cand };
	const origProviders = origTop.providers;
	const candProviders = candTop.providers;
	delete origTop.providers;
	delete candTop.providers;
	if (!eq(origTop, candTop)) return "providers 之外的顶层字段被改变";
	if (!origProviders || typeof origProviders !== "object") return "原文件缺 providers";
	const keySet = (o: object) => Object.keys(o).sort().join(",");
	if (keySet(candProviders) !== keySet(origProviders)) {
		return `providers 集合改变:原 [${keySet(origProviders)}],新 [${keySet(candProviders)}]`;
	}
	for (const name of Object.keys(origProviders)) {
		if (name === DEEPINFRA_PROVIDER_ID) continue;
		if (!eq(candProviders?.[name], origProviders[name])) return `provider ${name} 被改变`;
	}
	if (!origProviders[DEEPINFRA_PROVIDER_ID] || typeof origProviders[DEEPINFRA_PROVIDER_ID] !== "object") {
		return "原文件缺 providers.deepinfra 对象";
	}
	const { models: _om, ...origDeep } = origProviders[DEEPINFRA_PROVIDER_ID];
	const { models: _cm, ...candDeep } = candProviders?.[DEEPINFRA_PROVIDER_ID] ?? {};
	if (!eq(candDeep, origDeep)) return "deepinfra 除 models 外的字段被改变";

	return null;
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

// 供测试直接加载真实实现(jiti import;pi 运行时只消费 default 导出,不受影响)
export { rebuildModelsConfig, selfTest, parseConfig };

let tmpSeq = 0; // 同进程内连发两次命令也不会互踩同一个临时文件

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("refresh-deepinfra", {
		description: "Refresh the deepinfra model list in ~/.pi/agent/models.json",
		async handler(_args, ctx) {
			const agentDir = getAgentDir();
			const configPath = path.join(agentDir, "models.json");
			const backupPath = path.join(agentDir, "models.json.corrupted");

			// 1. 拉线上 catalog(故意在读文件之前,缩小竞态窗口)
			let liveModels: ModelsJsonModel[];
			try {
				liveModels = await fetchCatalog(ctx.signal);
			} catch (err) {
				ctx.ui.notify(
					`refresh-deepinfra: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
				return;
			}
			if (liveModels.length === 0) {
				ctx.ui.notify("refresh-deepinfra: catalog 为空,拒绝写入", "error");
				return;
			}

			// 2. 读当前配置
			let originalText: string;
			try {
				originalText = await fs.readFile(configPath, "utf-8");
			} catch (err) {
				ctx.ui.notify(
					`refresh-deepinfra: 读取 ${configPath} 失败: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
				return;
			}

			// 3. 整文件重写(只换 deepinfra.models)
			let candidate: string;
			try {
				candidate = rebuildModelsConfig(originalText, liveModels);
			} catch (err) {
				ctx.ui.notify(
					`refresh-deepinfra: ${err instanceof Error ? err.message : String(err)}。文件未修改。`,
					"error",
				);
				return;
			}

			// 4. 写盘前 self-test
			const failure = selfTest(originalText, candidate, liveModels.length);
			if (failure) {
				ctx.ui.notify(`refresh-deepinfra: self-test 未通过,文件未写入: ${failure}`, "error");
				return;
			}

			// 5. 首次备份
			try {
				if (!(await fs.stat(backupPath).catch(() => undefined))) {
					await fs.copyFile(configPath, backupPath);
				}
			} catch {
				// 备份失败不阻塞主流程(自测已通过,风险极低)
			}

			// 6. 原子写盘:先写同目录临时文件,再 rename 覆盖(rename 是原子操作,
			//    中途崩溃只会留下临时文件或保持旧文件完整,不会产生半截 models.json)
			const tmpPath = `${configPath}.tmp-${process.pid}-${++tmpSeq}`;
			try {
				await fs.writeFile(tmpPath, candidate, "utf-8");
				await fs.rename(tmpPath, configPath);
			} catch (err) {
				await fs.rm(tmpPath, { force: true }).catch(() => undefined);
				ctx.ui.notify(
					`refresh-deepinfra: 写入 ${configPath} 失败: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
				return;
			}

			// 7. 回读盘上内容并再次 self-test(确认盘上就是验证过的内容;若异常,
			//    备份仍在,用户可恢复)
			try {
				const written = await fs.readFile(configPath, "utf-8");
				const readbackFailure = selfTest(originalText, written, liveModels.length);
				if (readbackFailure) {
					ctx.ui.notify(
						`refresh-deepinfra: 写入后回读验证失败: ${readbackFailure}。备份在 ${backupPath}`,
						"error",
					);
					return;
				}
			} catch (err) {
				ctx.ui.notify(
					`refresh-deepinfra: 回读验证失败: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
				return;
			}

			ctx.ui.notify(
				`refresh-deepinfra: 已写入 ${liveModels.length} 个模型,models.json 已重写为标准 JSON。/reload 后生效。`,
				"info",
			);
		},
	});
}
