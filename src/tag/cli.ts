#!/usr/bin/env node
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DsAuthError, DsClient } from '../client/ds-client.ts';
import { describeTokenExpiry, loadConfig } from '../config.ts';
import { TaskNormalizer } from '../normalize/normalize-task.ts';
import { renderTranscript } from '../render/transcript.ts';
import { TagValidationError, costOf, tagTask } from './tag-task.ts';

const USAGE = `
Fetch a task, normalize it, and tag it with a general and a specific tag.

Usage
  pnpm tag <taskId> [<taskId> ...]
  pnpm tag --from-file ./out/<taskId>.txt        tag an already-normalized transcript

Options
  --from-file <path>    skip the fetch; tag this transcript. Repeatable. No DS token needed.
  --out-dir <dir>       also save each fetched transcript as <dir>/<taskId>.txt — the exact text
                        the model read. Off unless given. Ignored for --from-file inputs, which
                        are already files.
  --effort <level>      none | low | medium | high | xhigh | max. Default low.
  --model <id>          default gpt-5.6-luna
  --help

Env
  DS_ACCESS_TOKEN   required unless every input is --from-file
  OPENAI_API_KEY    always required

Output
  stdout  one JSON object per input: {"taskId":"…","general":"…","specific":"…"|null}
          --from-file inputs carry {"source":"<path>"} in place of "taskId"
  stderr  a per-task usage line, and a cache/cost summary at the end
  files   with --out-dir, <dir>/<taskId>.txt per fetched task
`;

interface Args {
	taskIds: string[];
	files: string[];
	/** Null means "do not write transcripts". There is no default directory — writing files is opt-in. */
	outDir: string | null;
	effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
	model: string;
	help: boolean;
}

const parseArgs = (argv: string[]): Args => {
	const args: Args = { taskIds: [], files: [], outDir: null, effort: 'low', model: 'gpt-5.6-luna', help: false };

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		const readValue = () => {
			const value = argv[index + 1];
			if (!value || value.startsWith('--')) throw new Error(`${token} needs a value.`);
			index += 1;
			return value;
		};

		if (token === '-h') {
			args.help = true;
			continue;
		}

		if (!token.startsWith('--')) {
			args.taskIds.push(token);
			continue;
		}

		switch (token) {
			case '--help':
			case '-h':
				args.help = true;
				break;
			case '--from-file':
				args.files.push(readValue());
				break;
			case '--out-dir':
				args.outDir = readValue();
				break;
			case '--effort': {
				const value = readValue();
				if (!['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) {
					throw new Error(`--effort must be none|low|medium|high|xhigh|max, received "${value}".`);
				}
				args.effort = value as Args['effort'];
				break;
			}
			case '--model':
				args.model = readValue();
				break;
			default:
				throw new Error(`Unknown option ${token}. Run with --help.`);
		}
	}

	return args;
};

const fetchTranscript = async (client: DsClient, taskId: string) => {
	const normalizer = new TaskNormalizer(taskId);
	const task = await client.getTask(taskId);
	for await (const page of client.streamHistory(taskId)) {
		normalizer.addPage(page);
	}
	return renderTranscript(normalizer.build(task));
};

/**
 * Saves the transcript the model is about to read, so a tag can be shown next to its evidence.
 *
 * Written before the tagging call, not after: rebuilding a transcript costs a full history fetch,
 * so a model failure should not also throw away the ~11 MB of transfer that produced it.
 *
 * Task ids arrive on the command line and become filenames here, so an id that is not a plain slug
 * is refused rather than allowed to write outside `--out-dir`. Same rule as `pnpm normalize`.
 */
const saveTranscript = (outDir: string, taskId: string, text: string): string => {
	if (!/^[A-Za-z0-9._-]+$/.test(taskId) || taskId.startsWith('.')) {
		throw new Error(`"${taskId}" cannot be a filename; ids may contain only letters, digits, '.', '_' and '-'.`);
	}

	const outPath = join(outDir, `${taskId}.txt`);
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, text);
	return outPath;
};

const main = async () => {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		process.stdout.write(`${USAGE}\n`);
		return;
	}

	// Usage goes to stderr and exits non-zero when it is a mistake rather than a request: stdout is
	// the JSON-lines channel, and a caller piping into `jq` must not receive the help text on it.
	if (args.taskIds.length === 0 && args.files.length === 0) {
		process.stderr.write(`${USAGE}\n`);
		process.exitCode = 1;
		return;
	}

	if (!process.env.OPENAI_API_KEY) {
		throw new Error('No OPENAI_API_KEY. Set it in .env — the AI SDK reads it directly.');
	}

	// Only build a DS client when something actually needs fetching, so --from-file works with an
	// expired or absent DS token.
	let client: DsClient | null = null;
	if (args.taskIds.length > 0) {
		const config = loadConfig();
		const expiry = describeTokenExpiry(config.accessToken);
		if (expiry) {
			if (expiry.minutesLeft <= 0) {
				throw new DsAuthError(`DS token already expired at ${expiry.expiresAt.toISOString()}. Fetch a fresh JWT.`);
			}
			process.stderr.write(`DS token expires ${expiry.expiresAt.toISOString()} (${expiry.minutesLeft} min left)\n`);
		}
		client = new DsClient(config);
	}

	const inputs: Array<{
		label: string;
		key: 'taskId' | 'source';
		load: () => Promise<{ text: string; messages: number; savedTo?: string }>;
	}> = [
		...args.taskIds.map((taskId) => ({
			label: taskId,
			key: 'taskId' as const,
			load: async () => {
				const rendered = await fetchTranscript(client as DsClient, taskId);
				const savedTo = args.outDir ? saveTranscript(args.outDir, taskId, rendered.text) : undefined;
				return { text: rendered.text, messages: rendered.commentsRendered, savedTo };
			},
		})),
		...args.files.map((file) => ({
			label: file,
			key: 'source' as const,
			load: async () => {
				const text = readFileSync(file, 'utf8');
				// Undated comments render as `[unknown]`, so anchoring on a year counted them as zero.
				return { text, messages: (text.match(/^\[(?:\d{4}-|unknown\])/gm) ?? []).length };
			},
		})),
	];

	let spend = 0;
	let reads = 0;
	let writes = 0;
	let failures = 0;
	let attempted = 0;
	let costsKnown = true;

	for (const input of inputs) {
		attempted += 1;
		try {
			const { text, messages, savedTo } = await input.load();
			const { tags, usage } = await tagTask(text, { model: args.model, reasoningEffort: args.effort });

			const cost = costOf(usage, args.model);
			costsKnown &&= cost !== null;
			spend += cost ?? 0;
			reads += usage.cacheReadTokens;
			writes += usage.cacheWriteTokens;

			process.stdout.write(`${JSON.stringify({ [input.key]: input.label, ...tags })}\n`);
			process.stderr.write(
				`  ${tags.general} / ${tags.specific ?? 'null'}`
					+ `  ·  ${messages} msgs, ${usage.inputTokens} in`
					+ `  ·  cache read ${usage.cacheReadTokens} write ${usage.cacheWriteTokens}`
					+ `  ·  reasoning ${usage.reasoningTokens}`
					+ `  ·  ${cost === null ? `no rates for ${args.model}` : `$${cost.toFixed(6)}`}\n`,
			);
			if (savedTo) process.stderr.write(`  transcript → ${savedTo}\n`);
		} catch (error) {
			failures += 1;
			if (error instanceof TagValidationError) {
				process.stderr.write(`  ${input.label}: model returned an invalid pair — ${error.message}\n`);
			} else if (error instanceof DsAuthError) {
				// The token is dead; every later task fails the same way. Stop, but still report what
				// was spent and tagged before it died.
				process.stderr.write(`  ${input.label}: ${error.message}\nStopping: the token will not work for the remaining tasks.\n`);
				break;
			} else {
				process.stderr.write(`  ${input.label}: ${error instanceof Error ? error.message : String(error)}\n`);
			}
		}
	}

	const tagged = attempted - failures;
	const skipped = inputs.length - attempted;
	process.stderr.write(
		`\n${tagged}/${inputs.length} tagged`
			+ (skipped > 0 ? ` (${skipped} never attempted)` : '')
			+ `  ·  cache read ${reads} write ${writes}`
			+ (costsKnown ? `  ·  $${spend.toFixed(6)} total${tagged > 0 ? `  ·  $${(spend / tagged).toFixed(6)} per task` : ''}` : '  ·  cost unavailable')
			+ '\n',
	);
	if (failures > 0) process.exitCode = 1;
};

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
