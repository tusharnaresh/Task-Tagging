import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { openai, type OpenAILanguageModelResponsesOptions } from '@ai-sdk/openai';
import { Output, generateText } from 'ai';
import { z } from 'zod';

/**
 * Tags one normalized task with a general and a specific tag.
 *
 * The vocabulary lives in prompts/tag-task.md and is parsed out of it at load time, so the Zod
 * enums and the prompt can never disagree. Duplicating 101 slugs here would drift silently: the
 * prompt would offer a tag the schema rejects, and a strict enum would make it unpickable.
 */

const PROMPT_PATH = path.join(import.meta.dirname, '..', '..', 'prompts', 'tag-task.md');
const TRANSCRIPT_MARKER = '{{TRANSCRIPT}}';

/** Everything before the marker. Must be byte-identical on every call or the cache never hits. */
const PROMPT = (() => {
	const file = readFileSync(PROMPT_PATH, 'utf8');
	const marker = file.indexOf(TRANSCRIPT_MARKER);
	if (marker === -1) throw new Error(`prompts/tag-task.md is missing ${TRANSCRIPT_MARKER}`);
	return file.slice(0, marker).trimEnd();
})();

/* ── vocabulary, read out of the prompt ─────────────────────────────────── */

const GENERALS: string[] = [];
const SPECIFICS_BY_GENERAL: Record<string, string[]> = {};

{
	let current: string | null = null;
	for (const line of PROMPT.split('\n')) {
		const general = line.match(/^## `([a-z][a-z0-9-]*)`/);
		if (general) {
			current = general[1];
			GENERALS.push(current);
			SPECIFICS_BY_GENERAL[current] = [];
			continue;
		}
		if (!current) continue;
		// named specific: "- **`slug`** — …"   fallback: "- `general-other`"
		const specific = line.match(/^- \*\*`([a-z][a-z0-9-]*)`\*\*/) ?? line.match(/^- `([a-z][a-z0-9-]*)`\s*$/);
		if (specific) SPECIFICS_BY_GENERAL[current].push(specific[1]);
	}
}

/** Sorted, so the enum order — and therefore the cached schema — is identical across processes. */
const ALL_SPECIFICS = Object.values(SPECIFICS_BY_GENERAL).flat().sort();

// Fail at load rather than at request time: a bad parse would otherwise surface as a model that
// cannot emit half the vocabulary.
if (GENERALS.length !== 14 || ALL_SPECIFICS.length !== 87) {
	throw new Error(
		`Parsed ${GENERALS.length} generals and ${ALL_SPECIFICS.length} specifics from prompts/tag-task.md, expected 14 and 87. Did the prompt's heading or bullet format change?`,
	);
}

/* ── schema ─────────────────────────────────────────────────────────────── */

/**
 * `.nullable()` and not `.optional()`: OpenAI strict structured outputs reject optional properties.
 * Null is also the contract — it means "no specific is established", which is a real answer.
 */
export const TagSchema = z.object({
	general: z.enum(GENERALS as [string, ...string[]]),
	specific: z.enum(ALL_SPECIFICS as [string, ...string[]]).nullable(),
});

export type TaskTags = z.infer<typeof TagSchema>;

/**
 * The cache key is derived from the prompt itself, so editing the prompt starts a new cache rather
 * than half-matching a stale prefix. Bumping a hand-written version number is the same idea, minus
 * the step everyone forgets.
 */
const PROMPT_FINGERPRINT = createHash('sha256').update(PROMPT).digest('hex').slice(0, 12);

export interface TagUsage {
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	outputTokens: number;
}

export interface TagResult {
	tags: TaskTags;
	usage: TagUsage;
}

export class TagValidationError extends Error {
	constructor(readonly tags: TaskTags, message: string) {
		super(message);
		this.name = 'TagValidationError';
	}
}

export interface TagOptions {
	model?: string;
	/**
	 * Defaults to 'low'. Output bills at 6x the input rate and reasoning tokens are output tokens,
	 * so this dominates cost long before prompt size does. Raise it only if abstention degrades.
	 */
	reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
	/**
	 * OpenAI holds each cache key to roughly 15 requests per minute before hits start dropping.
	 * Above that, spread work over a few stable shards: shard: taskIndex % 4.
	 */
	shard?: number;
	/** Warn when the cache is not behaving. Off for one-shot use. */
	diagnostics?: boolean;
}

let callCount = 0;

export const tagTask = async (transcript: string, options: TagOptions = {}): Promise<TagResult> => {
	const {
		model = 'gpt-5.6-luna',
		reasoningEffort = 'low',
		shard,
		diagnostics = true,
	} = options;

	const promptCacheKey = shard === undefined
		? `ds-tag:${PROMPT_FINGERPRINT}`
		: `ds-tag:${PROMPT_FINGERPRINT}:s${shard}`;

	const { output, usage } = await generateText({
		model: openai(model),
		providerOptions: {
			openai: {
				promptCacheKey,
				// Explicit-only. In the default implicit mode OpenAI also puts a breakpoint on the
				// latest message, which would write every transcript to the cache at 1.25x the input
				// rate — and no two tasks ever share a transcript.
				promptCacheOptions: { mode: 'explicit', ttl: '30m' },
				reasoningEffort,
				// Defaults to true in the Responses API. These transcripts are real client
				// conversations; out/ and scratch/ are git-ignored for the same reason.
				store: false,
			} satisfies OpenAILanguageModelResponsesOptions,
		},
		messages: [
			{
				// The prompt is a message, not the `system` parameter: OpenAI cannot attach a cache
				// breakpoint to top-level instructions, and the SDK's system content is a plain
				// string with nowhere to hang one. A user content block takes providerOptions.
				role: 'user',
				content: [
					{
						type: 'text',
						text: PROMPT,
						providerOptions: { openai: { promptCacheBreakpoint: { mode: 'explicit' } } },
					},
				],
			},
			{ role: 'user', content: [{ type: 'text', text: transcript }] },
		],
		output: Output.object({ schema: TagSchema, name: 'task_tags' }),
	});

	const tagUsage: TagUsage = {
		inputTokens: usage.inputTokens ?? 0,
		cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
		cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
		reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
		outputTokens: usage.outputTokens ?? 0,
	};

	callCount += 1;
	if (diagnostics) assertCacheIsWorking(tagUsage, callCount);

	// JSON Schema cannot express "the specific must belong to the chosen general" across 14
	// branches, so a cross-general pair is schema-valid and wrong. Caller should retry.
	const allowed = SPECIFICS_BY_GENERAL[output.general] ?? [];
	if (output.specific !== null && !allowed.includes(output.specific)) {
		throw new TagValidationError(
			output,
			`"${output.specific}" does not belong to "${output.general}". Allowed: ${allowed.join(', ') || '(none)'}.`,
		);
	}
	if (output.general === 'unclassified' && output.specific !== null) {
		throw new TagValidationError(output, 'unclassified has no specifics; specific must be null.');
	}

	return { tags: output, usage: tagUsage };
};

/**
 * Two failures that cost money silently rather than throwing.
 *
 * Reads of zero after the first call mean the breakpoint is not taking — usually the prefix moved,
 * or it fell under the 1,024-token minimum. Repeated writes mean something request-specific sits
 * above the breakpoint, and writes bill at 1.25x, so that is worse than no caching at all.
 *
 * This is not belt-and-braces. `providerOptions` on a request is type-checked against
 * OpenAILanguageModelResponsesOptions, but `providerOptions` on a CONTENT PART is typed loosely
 * enough that a misspelled `promptCacheBreakpoint` compiles and is then ignored by the API.
 * Verified by deliberately typo-ing both: the request-level one errors, the content-part one does
 * not. So these two numbers are the only thing standing between a silent typo and a 10x input bill.
 */
const assertCacheIsWorking = (usage: TagUsage, call: number): void => {
	if (call === 1) return; // the first call legitimately writes the prefix and reads nothing

	if (usage.cacheReadTokens === 0) {
		console.warn(
			`[tag-task] call ${call}: cacheReadTokens=0 — the prompt prefix is not being reused. Check that nothing dynamic precedes the breakpoint and that the prefix exceeds 1,024 tokens.`,
		);
	}
	if (usage.cacheWriteTokens > 0) {
		console.warn(
			`[tag-task] call ${call}: cacheWriteTokens=${usage.cacheWriteTokens} — paying the 1.25x write rate again. Something request-specific is above the breakpoint, or mode is not 'explicit'.`,
		);
	}
};

/** Per-token rates, by model. A model absent here has no rates, not default ones. */
const RATES: Record<string, { input: number; cached: number; write: number; output: number }> = {
	'gpt-5.6-luna': { input: 0.2e-6, cached: 0.02e-6, write: 0.25e-6, output: 1.2e-6 },
};

/**
 * Above this many input tokens OpenAI bills the WHOLE request at the long-context rate: 2x input,
 * 1.5x output. Without the branch the reported cost understates a large transcript by roughly half.
 */
const LONG_CONTEXT_THRESHOLD = 272_000;
const LONG_CONTEXT_INPUT_MULTIPLIER = 2;
const LONG_CONTEXT_OUTPUT_MULTIPLIER = 1.5;

/**
 * Dollar cost of one request, or null when the model's rates are unknown.
 *
 * Null rather than a number computed from the default model's rates: a wrong figure that looks like
 * a right one is worse than an absent one, and `--model` is user-overridable.
 */
export const costOf = (usage: TagUsage, model: string): number | null => {
	const rate = RATES[model];
	if (!rate) {
		return null;
	}

	const longContext = usage.inputTokens > LONG_CONTEXT_THRESHOLD;
	const inputMultiplier = longContext ? LONG_CONTEXT_INPUT_MULTIPLIER : 1;
	const outputMultiplier = longContext ? LONG_CONTEXT_OUTPUT_MULTIPLIER : 1;
	const uncachedInput = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);

	return (
		(usage.cacheReadTokens * rate.cached + usage.cacheWriteTokens * rate.write + uncachedInput * rate.input) * inputMultiplier +
		usage.outputTokens * rate.output * outputMultiplier
	);
};
