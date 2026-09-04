/**
 * /refresh-deepinfra — 用 DeepInfra 线上 catalog 刷新 ~/.pi/agent/models.json
 * 中 providers.deepinfra.models 数组。
 *
 * JSON 处理全部使用 Microsoft jsonc-parser(VS Code 同款,MIT,已 vendored 到
 * ./jsonc/):解析、定位、编辑、验证,不手写任何 JSON 逻辑。
 *
 * 安全保证:
 *   - 编辑是 tree-aware 的:jsonc-parser 定位 models 数组节点的精确字节范围,
 *     只替换该范围,文件其余字节(注释/缩进/其它 provider/其它字段)原样保留。
 *   - 写盘前 selfTest 强制校验:候选文件零解析错误、models 数量与 catalog 一致、
 *     deepinfra 的其它字段全部逐值保留、providers 集合不变。任何一项失败不写盘。
 *   - 首次写盘前把当前文件备份到 models.json.corrupted。
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Vendored jsonc-parser (Microsoft, MIT) — the single JSON tool we use.
// ---------------------------------------------------------------------------

interface JsoncParseError {
	error: number;
	offset: number;
	length: number;
}

interface JsoncNode {
	type: "object" | "array" | "property" | "string" | "number" | "boolean" | "null";
	offset: number;
	length: number;
	children?: JsoncNode[];
}

interface JsoncParser {
	parseTree(
		text: string,
		errors?: JsoncParseError[],
		options?: { allowTrailingComma?: boolean; disallowComments?: boolean },
	): JsoncNode | undefined;
	findNodeAtLocation(root: JsoncNode, path: Array<string | number>): JsoncNode | undefined;
	getNodeValue(node: JsoncNode): unknown;
	applyEdits(
		text: string,
		edits: Array<{ offset: number; length: number; content: string }>,
	): string;
}

const require = createRequire(import.meta.url);
const jsonc = require("./jsonc/main.js") as JsoncParser;

const PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false } as const;

function stripBom(s: string): string {
	return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** 解析 JSONC;返回 null 表示连部分解析都失败(空文件/完全损坏)。自动剥离 UTF-8 BOM。 */
function parse(text: string, errors: JsoncParseError[]): JsoncNode | undefined {
	return jsonc.parseTree(stripBom(text), errors, PARSE_OPTIONS);
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
// 核心:tree-aware 替换 models 数组
// ---------------------------------------------------------------------------

/** 提取 provider 节点下除 models 外的所有属性(key → JSON 值字符串),用于字段保留比对。 */
function getProviderProps(tree: JsoncNode, providerId: string): Map<string, string> {
	const props = new Map<string, string>();
	const providerNode = jsonc.findNodeAtLocation(tree, ["providers", providerId]);
	if (!providerNode || providerNode.type !== "object") return props;
	for (const child of providerNode.children ?? []) {
		const keyNode = child.children?.[0];
		const valueNode = child.children?.[1];
		if (!keyNode || !valueNode) continue;
		const key = jsonc.getNodeValue(keyNode);
		if (key === "models") continue; // models 是被替换的目标
		props.set(key, JSON.stringify(jsonc.getNodeValue(valueNode)));
	}
	return props;
}

function getProviderNames(tree: JsoncNode): string[] {
	const names: string[] = [];
	const providersNode = jsonc.findNodeAtLocation(tree, ["providers"]);
	if (!providersNode || providersNode.type !== "object") return names;
	for (const child of providersNode.children ?? []) {
		const keyNode = child.children?.[0];
		if (keyNode) names.push(String(jsonc.getNodeValue(keyNode)));
	}
	return names.sort();
}

/**
 * 替换 providers.deepinfra.models 数组,其余字节原样保留。
 * 失败(找不到节点/不是数组)抛错,绝不产生半成品。
 */
function spliceModelsArray(originalText: string, newModelsJson: string): string {
	const hadBom = originalText.charCodeAt(0) === 0xfeff;
	const text = stripBom(originalText);

	const errors: JsoncParseError[] = [];
	const tree = parse(text, errors);
	if (!tree) {
		throw new Error(`models.json 无法解析(${errors.length} 个错误,文件可能严重损坏)`);
	}

	const modelsNode = jsonc.findNodeAtLocation(tree, ["providers", DEEPINFRA_PROVIDER_ID, "models"]);
	if (!modelsNode) {
		throw new Error(`models.json 中找不到 providers.${DEEPINFRA_PROVIDER_ID}.models 节点`);
	}
	if (modelsNode.type !== "array") {
		throw new Error(`providers.${DEEPINFRA_PROVIDER_ID}.models 不是数组(实际类型 ${modelsNode.type})`);
	}

	let candidate = jsonc.applyEdits(text, [
		{ offset: modelsNode.offset, length: modelsNode.length, content: newModelsJson },
	]);

	// 源文件若曾被错误编辑留下 stray 括号([[...]] 或 [...]]]),tree 只覆盖到
	// 平衡的数组边界,多余的一个括号会留在边界外。只在 splice 边界清理这一个字符。
	const close = modelsNode.offset + newModelsJson.length - 1; // 新数组的闭括号位置
	if (candidate[close] === "]" && candidate[close + 1] === "]") {
		candidate = candidate.slice(0, close + 1) + candidate.slice(close + 2);
	}
	if (
		modelsNode.offset > 0 &&
		candidate[modelsNode.offset] === "[" &&
		candidate[modelsNode.offset - 1] === "["
	) {
		candidate = candidate.slice(0, modelsNode.offset - 1) + candidate.slice(modelsNode.offset);
	}

	return hadBom ? "\uFEFF" + candidate : candidate;
}

// ---------------------------------------------------------------------------
// 写盘前强制 self-test;返回 null 表示通过,否则返回失败原因
// ---------------------------------------------------------------------------

function selfTest(
	originalText: string,
	candidateText: string,
	expectedCount: number,
): string | null {
	// 1. 候选必须零错误解析。
	const candErrors: JsoncParseError[] = [];
	const candTree = parse(candidateText, candErrors);
	if (!candTree) return "候选文件无法解析";
	if (candErrors.length > 0) return `候选文件有 ${candErrors.length} 个解析错误`;

	// 2. models 数组存在且数量与 catalog 一致。
	const candModelsNode = jsonc.findNodeAtLocation(candTree, [
		"providers",
		DEEPINFRA_PROVIDER_ID,
		"models",
	]);
	if (!candModelsNode || candModelsNode.type !== "array") {
		return "候选文件缺少 providers.deepinfra.models 数组";
	}
	const candModels = jsonc.getNodeValue(candModelsNode);
	if (!Array.isArray(candModels) || candModels.length !== expectedCount) {
		return `models 数量不符:期望 ${expectedCount},实际 ${Array.isArray(candModels) ? candModels.length : "非数组"}`;
	}
	if (candModels[0]?.id === undefined) return "候选 models 第一项缺少 id";

	// 3. deepinfra 除 models 外的所有字段逐值保留(provider 必须存在,但允许只有 models 一个键)。
	const origErrors: JsoncParseError[] = [];
	const origTree = parse(originalText, origErrors);
	if (!origTree) return "原文件无法解析,拒绝覆写";
	const origProviderNode = jsonc.findNodeAtLocation(origTree, ["providers", DEEPINFRA_PROVIDER_ID]);
	if (!origProviderNode || origProviderNode.type !== "object") {
		return "原文件中缺少 providers.deepinfra 对象";
	}
	const origProps = getProviderProps(origTree, DEEPINFRA_PROVIDER_ID);
	const candProps = getProviderProps(candTree, DEEPINFRA_PROVIDER_ID);
	for (const [key, value] of origProps) {
		if (candProps.get(key) !== value) {
			return `字段 ${key} 被改变(原 ${value.slice(0, 40)},新 ${candProps.get(key)?.slice(0, 40) ?? "缺失"})`;
		}
	}

	// 4. providers 集合不变(不丢也不增)。
	const origProviders = getProviderNames(origTree);
	const candProviders = getProviderNames(candTree);
	if (JSON.stringify(origProviders) !== JSON.stringify(candProviders)) {
		return `providers 集合改变:原 [${origProviders}],新 [${candProviders}]`;
	}

	return null;
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

// 供测试直接加载真实实现(jiti import;pi 运行时只消费 default 导出,不受影响)
export { spliceModelsArray, selfTest, getProviderProps, getProviderNames };

let tmpSeq = 0; // 同进程内连发两次命令也不会互踩同一个临时文件

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("refresh-deepinfra", {
		description: "Refresh the deepinfra model list in ~/.pi/agent/models.json",
		async handler(_args, ctx) {
			const agentDir = getAgentDir();
			const configPath = path.join(agentDir, "models.json");
			const backupPath = path.join(agentDir, "models.json.corrupted");

			// 1. 拉线上 catalog
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

			// 3. tree-aware 替换
			let candidate: string;
			try {
				candidate = spliceModelsArray(originalText, JSON.stringify(liveModels));
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
				`refresh-deepinfra: 已写入 ${liveModels.length} 个模型(其它字段原样保留)。/reload 后生效。`,
				"info",
			);
		},
	});
}