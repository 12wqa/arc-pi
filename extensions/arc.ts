import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const EXTENSION_TYPE = "pi-arc";
const STATE_TYPE = "pi-arc-state";
const INTERNAL_ROLLOVER_COMMAND = "arc-rollover";

const DEFAULTS = {
	mode: "practical" as ArcMode,
	threshold: 0.35,
	practicalWindowTokens: 200_000,
	maxRecentMessages: 20,
	auto: true,
	cooldownTurns: 2,
};

type ArcMode = "off" | "practical" | "full";

type ArcState = {
	mode: ArcMode;
	threshold: number;
	practicalWindowTokens: number;
	maxRecentMessages: number;
	auto: boolean;
	cooldownTurns: number;
	cooldownRemaining: number;
	manualPending: boolean;
	thresholdPending: boolean;
	lastObservedTokens: number | null;
	lastPacketPath?: string;
	lastRolloverAt?: string;
	contextId?: string;
};

type RestartPacketInput = {
	contextId: string;
	oldSessionId: string;
	oldSessionFile?: string;
	newSessionId: string;
	cwd: string;
	platform: string;
	threshold: number;
	reason: string;
	createdAt: string;
	recentMessages: CleanMessage[];
};

type CleanMessage = {
	role: string;
	label?: string;
	content: string;
};

type ContextUsageLike = { tokens: number | null; contextWindow: number; percent: number | null };

type ModelRecommendation = {
	family: string;
	practicalWindowTokens: number;
	threshold: number;
	refreshTokens: number;
	confidence: "observed-pattern" | "metadata-derived" | "fallback";
	rationale: string;
};

const SECRET_PATTERNS = [
	/\bsk-[A-Za-z0-9_-]{12,}\b/g,
	/\b(?:api[_-]?key|token|secret)\s*[:=]\s*['"]?[^\s'"]+/gi,
	/\b(?:authorization)\s*:\s*bearer\s+[^\s'"]+/gi,
];

function freshState(): ArcState {
	return {
		...DEFAULTS,
		cooldownRemaining: 0,
		manualPending: false,
		thresholdPending: false,
		lastObservedTokens: null,
	};
}

function sanitizeState(input: unknown): ArcState | null {
	if (!input || typeof input !== "object") return null;
	const raw = input as Partial<ArcState>;
	const state = freshState();
	if (raw.mode === "off" || raw.mode === "practical" || raw.mode === "full") state.mode = raw.mode;
	if (typeof raw.threshold === "number" && raw.threshold > 0 && raw.threshold <= 1) state.threshold = raw.threshold;
	if (typeof raw.practicalWindowTokens === "number" && raw.practicalWindowTokens > 0) {
		state.practicalWindowTokens = Math.floor(raw.practicalWindowTokens);
	}
	if (typeof raw.maxRecentMessages === "number" && raw.maxRecentMessages >= 1) {
		state.maxRecentMessages = Math.floor(raw.maxRecentMessages);
	}
	if (typeof raw.auto === "boolean") state.auto = raw.auto;
	if (typeof raw.cooldownTurns === "number" && raw.cooldownTurns >= 0) state.cooldownTurns = Math.floor(raw.cooldownTurns);
	if (typeof raw.cooldownRemaining === "number" && raw.cooldownRemaining >= 0) {
		state.cooldownRemaining = Math.floor(raw.cooldownRemaining);
	}
	if (typeof raw.manualPending === "boolean") state.manualPending = raw.manualPending;
	if (typeof raw.thresholdPending === "boolean") state.thresholdPending = raw.thresholdPending;
	if (typeof raw.lastObservedTokens === "number" || raw.lastObservedTokens === null) {
		state.lastObservedTokens = raw.lastObservedTokens;
	}
	if (typeof raw.lastPacketPath === "string") state.lastPacketPath = raw.lastPacketPath;
	if (typeof raw.lastRolloverAt === "string") state.lastRolloverAt = raw.lastRolloverAt;
	if (typeof raw.contextId === "string") state.contextId = raw.contextId;
	return state;
}

function redact(text: string): string {
	let redacted = text;
	for (const pattern of SECRET_PATTERNS) {
		redacted = redacted.replace(pattern, "[REDACTED]");
	}
	return redacted;
}

function pct(value: number): string {
	return `${Math.round(value * 100)}%`;
}

function parseThreshold(value: string): number | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (trimmed.endsWith("%")) {
		const n = Number.parseFloat(trimmed.slice(0, -1));
		return Number.isFinite(n) && n > 0 && n <= 100 ? n / 100 : undefined;
	}
	const n = Number.parseFloat(trimmed);
	if (!Number.isFinite(n) || n <= 0) return undefined;
	return n > 1 && n <= 100 ? n / 100 : n <= 1 ? n : undefined;
}

function effectiveWindow(state: ArcState, modelContextWindow?: number): number | null {
	if (state.mode === "off") return null;
	const full = modelContextWindow && modelContextWindow > 0 ? modelContextWindow : null;
	if (state.mode === "full") return full;
	if (full) return Math.min(full, state.practicalWindowTokens);
	return state.practicalWindowTokens;
}

function modelField(model: unknown, field: string): unknown {
	return model && typeof model === "object" ? (model as Record<string, unknown>)[field] : undefined;
}

function currentModelLabel(model: unknown): string {
	const provider = modelField(model, "provider");
	const id = modelField(model, "id");
	const name = modelField(model, "name");
	if (typeof provider === "string" && typeof id === "string") return `${provider}/${id}`;
	if (typeof id === "string") return id;
	if (typeof name === "string") return name;
	return "unknown model";
}

function contextWindowFor(model: unknown, usage?: ContextUsageLike): number | undefined {
	const candidates = [
		usage?.contextWindow,
		modelField(model, "contextWindow"),
		modelField(model, "context_length"),
		modelField(model, "contextLength"),
	];
	for (const candidate of candidates) {
		if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) return candidate;
	}
	return undefined;
}

function capWindow(target: number, contextWindow?: number): number {
	if (!contextWindow || contextWindow <= 0) return target;
	return Math.max(4_000, Math.min(target, contextWindow));
}

function buildRecommendation(model: unknown, usage?: ContextUsageLike): ModelRecommendation {
	const label = currentModelLabel(model).toLowerCase();
	const contextWindow = contextWindowFor(model, usage);
	const rec = (family: string, window: number, threshold: number, confidence: ModelRecommendation["confidence"], rationale: string): ModelRecommendation => {
		const practicalWindowTokens = capWindow(window, contextWindow);
		return {
			family,
			practicalWindowTokens,
			threshold,
			refreshTokens: Math.floor(practicalWindowTokens * threshold),
			confidence,
			rationale,
		};
	};

	if (label.includes("claude") || label.includes("anthropic")) {
		if ((contextWindow ?? 0) >= 500_000) {
			return rec("Claude very-long-context", 160_000, 0.35, "metadata-derived", "large advertised windows are useful, but ARC keeps the working set well below the noisy middle");
		}
		return rec("Claude", 100_000, 0.40, "observed-pattern", "Claude usually stays sharp when tool-heavy sessions refresh before the 50k-token zone");
	}
	if (label.includes("gemini") || label.includes("google/")) {
		return rec("Gemini", 200_000, 0.35, "metadata-derived", "Gemini long-context models tolerate larger windows, but conservative refresh keeps retrieval pressure low");
	}
	if (label.includes("gpt") || label.includes("openai") || /\bo[134]\b/.test(label)) {
		return rec("OpenAI GPT/o-series", 80_000, 0.45, "metadata-derived", "OpenAI long-context models are strong but benefit from avoiding late-context tool clutter");
	}
	if (label.includes("qwen") || label.includes("deepseek") || label.includes("kimi") || label.includes("moonshot")) {
		return rec("Open-weight long-context", 64_000, 0.45, "fallback", "open-weight long-context behavior varies widely, so start conservative and tune upward");
	}
	if (label.includes("llama") || label.includes("mistral") || label.includes("mixtral") || label.includes("local")) {
		return rec("local/open model", 32_000, 0.55, "fallback", "smaller or local models typically degrade earlier under agent/tool transcripts");
	}
	if (contextWindow && contextWindow <= 32_768) {
		return rec("small-context model", 20_000, 0.60, "metadata-derived", "small windows need a higher threshold but a small practical window");
	}
	if (contextWindow && contextWindow <= 65_536) {
		return rec("medium-context model", 32_000, 0.55, "metadata-derived", "medium windows should refresh before tool output dominates the middle of context");
	}
	if (contextWindow && contextWindow >= 200_000) {
		return rec("generic long-context model", 100_000, 0.40, "fallback", "generic long-context recommendation prioritizes premium-state behavior over maximum capacity");
	}
	return rec("generic model", 64_000, 0.45, "fallback", "no specific model profile matched; use this as a safe starting point");
}

function formatRecommendation(model: unknown, usage?: ContextUsageLike): string {
	const recommendation = buildRecommendation(model, usage);
	return [
		`Recommendation for ${currentModelLabel(model)} (${recommendation.family}, ${recommendation.confidence}):`,
		`  /arc practical`,
		`  /arc window ${recommendation.practicalWindowTokens}`,
		`  /arc ${pct(recommendation.threshold)}`,
		`Refresh target: ~${recommendation.refreshTokens.toLocaleString()} tokens.`,
		`Why: ${recommendation.rationale}.`,
	].join("\n");
}

function contentToText(content: unknown): string {
	if (content === undefined || content === null) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const block = part as Record<string, unknown>;
			if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
			else if (block.type === "thinking") continue;
			else if (block.type === "image") parts.push("[image omitted]");
			else if (block.type === "toolCall") {
				const name = typeof block.name === "string" ? block.name : "tool";
				parts.push(`[tool call: ${name} ${safeJson(block.arguments)}]`);
			}
		}
		return parts.join("\n");
	}
	return safeJson(content);
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function cleanEntry(entry: any): CleanMessage | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	if (entry.type === "message" && entry.message) {
		const msg = entry.message as Record<string, unknown>;
		const role = typeof msg.role === "string" ? msg.role : "message";
		if (role === "system") return undefined;
		if (role === "assistant") {
			const text = contentToText(msg.content);
			return text.trim() ? { role, content: redact(text) } : undefined;
		}
		if (role === "toolResult") {
			const toolName = typeof msg.toolName === "string" ? msg.toolName : undefined;
			const text = contentToText(msg.content);
			return text.trim() ? { role, label: toolName, content: redact(text) } : undefined;
		}
		const text = contentToText(msg.content);
		return text.trim() ? { role, content: redact(text) } : undefined;
	}
	if (entry.type === "custom_message") {
		if (entry.customType === EXTENSION_TYPE || entry.customType === STATE_TYPE) return undefined;
		const text = contentToText(entry.content);
		return text.trim() ? { role: "custom", label: entry.customType, content: redact(text) } : undefined;
	}
	if (entry.type === "compaction") {
		return { role: "compactionSummary", content: redact(String(entry.summary ?? "")) };
	}
	if (entry.type === "branch_summary") {
		return { role: "branchSummary", content: redact(String(entry.summary ?? "")) };
	}
	return undefined;
}

function getRecentCleanMessages(branch: readonly any[], maxRecentMessages: number): CleanMessage[] {
	const clean = branch.map(cleanEntry).filter((m): m is CleanMessage => Boolean(m));
	return maxRecentMessages > 0 ? clean.slice(-maxRecentMessages) : clean;
}

function renderPacket(input: RestartPacketInput): string {
	const lines = [
		"[ARC REFRESH PACKET]",
		"method: ARC (Adaptive Refresh Cycle)",
		`context_id: ${input.contextId}`,
		`previous_session_id: ${input.oldSessionId}`,
		`new_session_id: ${input.newSessionId}`,
	];
	if (input.oldSessionFile) lines.push(`previous_session_file: ${input.oldSessionFile}`);
	lines.push(
		`cwd: ${input.cwd}`,
		`platform: ${input.platform}`,
		`arc_threshold: ${pct(input.threshold)}`,
		`reason: ${input.reason}`,
		`created_at: ${input.createdAt}`,
		"",
		"Continuation rules:",
		"- Continue from this packet as the authoritative handoff state.",
		"- Do not repeat completed tool calls unless the user asks or verification is required.",
		"- Preserve active goals, decisions, file paths, failing/passing tests, and next steps.",
		"- Treat this as a fresh physical session within the same logical ARC context.",
		"",
		"Recent clean transcript:",
	);
	for (const msg of input.recentMessages) {
		const label = msg.label ? `${msg.role}:${msg.label}` : msg.role;
		lines.push(`\n--- ${label} ---`, msg.content);
	}
	lines.push("\n[END ARC REFRESH PACKET]");
	return lines.join("\n");
}

function packetPathFor(newSessionId: string): string {
	return join(homedir(), ".pi", "agent", "arc", "packets", `${newSessionId}.md`);
}

function getLatestStateFromBranch(branch: readonly any[]): ArcState | null {
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i];
		if (entry?.type === "custom" && entry.customType === STATE_TYPE) {
			return sanitizeState(entry.data);
		}
	}
	return null;
}

function statusText(state: ArcState, usage?: ContextUsageLike, model?: unknown): string {
	const window = effectiveWindow(state, usage?.contextWindow);
	const thresholdTokens = window ? Math.floor(window * state.threshold) : null;
	const usageLine = usage?.tokens == null
		? "Current usage: unknown"
		: `Current usage: ${usage.tokens.toLocaleString()} tokens${window ? ` / ${window.toLocaleString()} ARC window` : ""}`;
	return [
		`ARC: ${state.mode === "off" ? "disabled" : state.auto ? "enabled" : "manual-only"}`,
		`Status line: ${formatStatusLine(state, usage) ?? "hidden"}`,
		`Mode: ${state.mode}`,
		`Threshold: ${pct(state.threshold)}${thresholdTokens ? ` (~${thresholdTokens.toLocaleString()} tokens)` : ""}`,
		`Practical window: ${state.practicalWindowTokens.toLocaleString()} tokens`,
		`Max recent messages in packet: ${state.maxRecentMessages}`,
		`Pending: ${state.manualPending ? "manual" : state.thresholdPending ? "threshold" : "none"}`,
		`Cooldown: ${state.cooldownRemaining}/${state.cooldownTurns} turns`,
		usageLine,
		model ? "" : undefined,
		model ? formatRecommendation(model, usage) : undefined,
		state.lastPacketPath ? `Last packet: ${state.lastPacketPath}` : undefined,
	].filter((line) => line !== undefined).join("\n");
}

function compactTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${Number.parseFloat((tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1))}M`;
	if (tokens >= 1_000) return `${Number.parseFloat((tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1))}k`;
	return `${tokens}`;
}

function formatStatusLine(state: ArcState, usage?: ContextUsageLike): string | undefined {
	if (state.mode === "off") return undefined;
	const mode = state.auto ? "A" : "M";
	const window = effectiveWindow(state, usage?.contextWindow);
	const thresholdTokens = window ? Math.floor(window * state.threshold) : null;
	const tokens = usage?.tokens ?? state.lastObservedTokens;
	if (!thresholdTokens || tokens == null) return `ARC ${mode} ${state.mode} ${pct(state.threshold)}`;

	const ratio = Math.max(0, tokens / thresholdTokens);
	const width = 8;
	const filled = Math.min(width, Math.max(0, Math.round(ratio * width)));
	const bar = `${"▰".repeat(filled)}${"▱".repeat(width - filled)}`;
	const suffix = ratio >= 1 ? " !" : state.cooldownRemaining > 0 ? ` ↻${state.cooldownRemaining}` : "";
	return `ARC ${mode} ${bar} ${compactTokens(tokens)}/${compactTokens(thresholdTokens)}${suffix}`;
}

function parseArcCommand(args: string): { action: string; threshold?: number; value?: string } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0 || parts[0] === "status") return { action: "status" };
	const head = parts[0].toLowerCase();
	if (["off", "disable", "disabled"].includes(head)) return { action: "disable" };
	if (["on", "enable", "enabled"].includes(head)) return { action: "enable" };
	if (head === "practical" || head === "full") return { action: "mode", value: head };
	if (head === "manual") return { action: "manual" };
	if (head === "auto") return { action: "auto" };
	if (head === "now") return { action: "rollover", value: "manual" };
	if (head === "recommend" || head === "recommended") return { action: "recommend" };
	if ((head === "limit" || head === "threshold") && parts[1]) {
		const threshold = parseThreshold(parts[1]);
		return threshold ? { action: "threshold", threshold } : { action: "unknown" };
	}
	if (head === "window" && parts[1]) return { action: "window", value: parts[1] };
	if (head === "recent" && parts[1]) return { action: "recent", value: parts[1] };
	const threshold = parseThreshold(head);
	if (threshold) return { action: "threshold", threshold };
	return { action: "unknown" };
}

export default function arcExtension(pi: ExtensionAPI) {
	let state = freshState();
	let rolloverQueued = false;

	function persistState() {
		pi.appendEntry(STATE_TYPE, state);
	}

	function show(content: string) {
		pi.sendMessage({ customType: EXTENSION_TYPE, content, display: true });
	}

	function updateStatus(ctx: Pick<ExtensionContext, "hasUI" | "ui" | "getContextUsage">) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(EXTENSION_TYPE, formatStatusLine(state, ctx.getContextUsage()));
	}

	function queueThresholdRollover(ctx: Pick<ExtensionContext, "ui">, usage: ContextUsageLike, reason = "threshold") {
		if (rolloverQueued || state.mode === "off" || !state.auto || usage.tokens == null) return false;
		rolloverQueued = true;
		state = { ...state, thresholdPending: true, lastObservedTokens: usage.tokens };
		persistState();
		ctx.ui.notify(`ARC threshold is already crossed at ${usage.tokens.toLocaleString()} tokens; queuing safe-boundary refresh.`, "info");
		pi.sendUserMessage(`/${INTERNAL_ROLLOVER_COMMAND} ${reason}`, { deliverAs: "followUp" });
		return true;
	}

	async function performRollover(ctx: ExtensionCommandContext, reason: string) {
		try {
			await ctx.waitForIdle();
			if (state.mode === "off" && reason !== "manual") {
				rolloverQueued = false;
				return;
			}

			const branch = ctx.sessionManager.getBranch() as readonly any[];
			const oldSessionFile = ctx.sessionManager.getSessionFile();
			const oldSessionId = ctx.sessionManager.getSessionId?.() ?? oldSessionFile ?? "unknown-session";
			const contextId = state.contextId ?? `arc_${randomUUID()}`;
			const recentMessages = getRecentCleanMessages(branch, state.maxRecentMessages);
			const parentSession = oldSessionFile;
			const createdAt = new Date().toISOString();
			let packetPath: string | undefined;

			if (recentMessages.length === 0) {
				show("ARC rollover skipped: no conversation messages found to hydrate the new session.");
				rolloverQueued = false;
				return;
			}

			state = {
				...state,
				contextId,
				manualPending: reason === "manual",
				thresholdPending: reason !== "manual",
			};
			persistState();

			const result = await ctx.newSession({
				parentSession,
				setup: async (sessionManager: any) => {
					const newSessionId = sessionManager.getSessionId?.() ?? `arc_${randomUUID()}`;
					const packet = renderPacket({
						contextId,
						oldSessionId,
						oldSessionFile,
						newSessionId,
						cwd: ctx.cwd,
						platform: "pi",
						threshold: state.threshold,
						reason,
						createdAt,
						recentMessages,
					});
					packetPath = packetPathFor(newSessionId);
					await mkdir(join(homedir(), ".pi", "agent", "arc", "packets"), { recursive: true });
					await writeFile(packetPath, packet, "utf8");
					sessionManager.appendMessage({
						role: "user",
						content: [{ type: "text", text: packet }],
						timestamp: Date.now(),
					});
					sessionManager.appendCustomEntry?.(STATE_TYPE, {
						...state,
						manualPending: false,
						thresholdPending: false,
						lastObservedTokens: null,
						cooldownRemaining: state.cooldownTurns,
						lastPacketPath: packetPath,
						lastRolloverAt: createdAt,
						contextId,
					});
				},
				withSession: async (replacementCtx) => {
					// Keep this deliberately UI-only. Injecting another custom message from
					// the replacement callback can race some interactive session-rebind paths.
					replacementCtx.ui.notify(`ARC refreshed into a new session${packetPath ? ` (${packetPath})` : ""}.`, "info");
				},
			});

			rolloverQueued = false;
			if (result.cancelled) {
				show("ARC rollover cancelled by session switch guard.");
				return;
			}
		} catch (error) {
			rolloverQueued = false;
			const message = error instanceof Error ? error.message : String(error);
			show(`ARC rollover failed safely: ${message}`);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		state = getLatestStateFromBranch(ctx.sessionManager.getBranch() as readonly any[]) ?? freshState();
		updateStatus(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		if (state.cooldownRemaining > 0) {
			state = { ...state, cooldownRemaining: state.cooldownRemaining - 1 };
			persistState();
			updateStatus(ctx);
			return;
		}
		if (!state.auto || state.mode === "off" || rolloverQueued) {
			updateStatus(ctx);
			return;
		}
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens == null) {
			updateStatus(ctx);
			return;
		}
		const window = effectiveWindow(state, usage.contextWindow);
		if (!window) {
			updateStatus(ctx);
			return;
		}
		const thresholdTokens = Math.floor(window * state.threshold);
		const wasAbove = state.lastObservedTokens != null && state.lastObservedTokens >= thresholdTokens;
		const isAbove = usage.tokens >= thresholdTokens;
		state = { ...state, lastObservedTokens: usage.tokens, thresholdPending: isAbove };
		persistState();
		updateStatus(ctx);
		if (!isAbove || wasAbove) return;
		queueThresholdRollover(ctx, usage, "threshold");
	});

	pi.registerCommand("arc", {
		description: "ARC safe-boundary session refresh: status, now, recommend, 35%, on, off, practical, full",
		handler: async (args, ctx) => {
			const parsed = parseArcCommand(args);
			if (parsed.action === "status") {
				show(statusText(state, ctx.getContextUsage(), ctx.model));
				return;
			}
			if (parsed.action === "recommend") {
				show(formatRecommendation(ctx.model, ctx.getContextUsage()));
				return;
			}
			if (parsed.action === "disable") {
				state = { ...state, mode: "off", manualPending: false, thresholdPending: false };
				persistState();
				updateStatus(ctx);
				show("ARC disabled. Pi default compaction remains available.");
				return;
			}
			if (parsed.action === "enable") {
				state = { ...state, mode: state.mode === "off" ? "practical" : state.mode, auto: true };
				persistState();
				updateStatus(ctx);
				show("ARC enabled.");
				return;
			}
			if (parsed.action === "mode" && (parsed.value === "practical" || parsed.value === "full")) {
				state = { ...state, mode: parsed.value };
				persistState();
				updateStatus(ctx);
				show(`ARC mode set to ${parsed.value}.`);
				return;
			}
			if (parsed.action === "manual") {
				state = { ...state, auto: false };
				persistState();
				updateStatus(ctx);
				show("ARC automatic refresh disabled; /arc now still works.");
				return;
			}
			if (parsed.action === "auto") {
				state = { ...state, auto: true };
				persistState();
				updateStatus(ctx);
				show("ARC automatic refresh enabled.");
				return;
			}
			if (parsed.action === "threshold" && parsed.threshold) {
				state = { ...state, threshold: parsed.threshold, thresholdPending: false };
				persistState();
				const usage = ctx.getContextUsage();
				const window = effectiveWindow(state, usage?.contextWindow);
				const thresholdTokens = window ? Math.floor(window * state.threshold) : null;
				const alreadyOverThreshold = Boolean(usage?.tokens != null && thresholdTokens && usage.tokens >= thresholdTokens);
				if (alreadyOverThreshold && usage) {
					queueThresholdRollover(ctx, usage, "threshold");
				}
				updateStatus(ctx);
				show([
					alreadyOverThreshold
						? `ARC threshold set to ${pct(parsed.threshold)}. Current context is already over that threshold, so refresh has been queued for a safe boundary.`
						: `ARC threshold set to ${pct(parsed.threshold)}. Refresh will wait for a safe boundary.`,
					"",
					formatRecommendation(ctx.model, usage),
				].join("\n"));
				return;
			}
			if (parsed.action === "window" && parsed.value) {
				const n = Number.parseInt(parsed.value.replace(/,/g, ""), 10);
				if (!Number.isFinite(n) || n <= 0) {
					show("Usage: /arc window <tokens>");
					return;
				}
				state = { ...state, practicalWindowTokens: n, thresholdPending: false };
				persistState();
				updateStatus(ctx);
				show(`ARC practical window set to ${n.toLocaleString()} tokens.`);
				return;
			}
			if (parsed.action === "recent" && parsed.value) {
				const n = Number.parseInt(parsed.value, 10);
				if (!Number.isFinite(n) || n <= 0) {
					show("Usage: /arc recent <message-count>");
					return;
				}
				state = { ...state, maxRecentMessages: n };
				persistState();
				updateStatus(ctx);
				show(`ARC packets will include the last ${n} clean messages.`);
				return;
			}
			if (parsed.action === "rollover") {
				await performRollover(ctx, "manual");
				return;
			}
			show("Usage: /arc [status|recommend|now|35%|threshold 35%|on|off|auto|manual|practical|full|window <tokens>|recent <count>]");
		},
	});

	pi.registerCommand(INTERNAL_ROLLOVER_COMMAND, {
		description: "Internal ARC safe-boundary rollover command",
		handler: async (args, ctx) => {
			const reason = args.trim() || "threshold";
			await performRollover(ctx, reason);
		},
	});
}
