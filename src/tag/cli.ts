#!/usr/bin/env node
import 'dotenv/config';
import { readFileSync } from 'node:fs';
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
  --effort <level>      none | low | medium | high | xhigh | max. Default low.
  --model <id>          default gpt-5.6-luna
  --help

Env
  DS_ACCESS_TOKEN   required unless every input is --from-file
  OPENAI_API_KEY    always required

Output
  stdout  one JSON object per task: {"taskId":"…","general":"…","specific":"…"|null}
  stderr  a per-task usage line, and a cache/cost summary at the end
`;

interface Args {
	taskIds: string[];
	files: string[];
	effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
	model: string;
	help: boolean;
}

const parseArgs = (argv: string[]): Args => {
	const args: Args = { taskIds: [], files: [], effort: 'low', model: 'gpt-5.6-luna', help: false };

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		const readValue = () => {
			const value = argv[index + 1];
			if (!value || value.startsWith('--')) throw new Error(`${token} needs a value.`);
			index += 1;
			return value;
		};

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

const main = async () => {
	const args = parseArgs(process.argv.slice(2));

	if (args.help || (args.taskIds.length === 0 && args.files.length === 0)) {
		process.stdout.write(`${USAGE}\n`);
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
			process.stderr.write(`DS token expires ${expiry.expiresAt.toISOString()} (${expiry.minutesLeft} min left)\n`);
		}
		client = new DsClient(config);
	}

	const inputs: Array<{ label: string; load: () => Promise<{ text: string; messages: number }> }> = [
		...args.taskIds.map((taskId) => ({
			label: taskId,
			load: async () => {
				const rendered = await fetchTranscript(client as DsClient, taskId);
				return { text: rendered.text, messages: rendered.commentsRendered };
			},
		})),
		...args.files.map((file) => ({
			label: file,
			load: async () => {
				const text = readFileSync(file, 'utf8');
				return { text, messages: (text.match(/^\[\d{4}-/gm) ?? []).length };
			},
		})),
	];

	let spend = 0;
	let reads = 0;
	let writes = 0;
	let failures = 0;

	for (const input of inputs) {
		try {
			const { text, messages } = await input.load();
			const { tags, usage } = await tagTask(text, { model: args.model, reasoningEffort: args.effort });

			const cost = costOf(usage);
			spend += cost;
			reads += usage.cacheReadTokens;
			writes += usage.cacheWriteTokens;

			process.stdout.write(`${JSON.stringify({ taskId: input.label, ...tags })}\n`);
			process.stderr.write(
				`  ${tags.general} / ${tags.specific ?? 'null'}`
					+ `  ·  ${messages} msgs, ${usage.inputTokens} in`
					+ `  ·  cache read ${usage.cacheReadTokens} write ${usage.cacheWriteTokens}`
					+ `  ·  reasoning ${usage.reasoningTokens}`
					+ `  ·  $${cost.toFixed(6)}\n`,
			);
		} catch (error) {
			failures += 1;
			if (error instanceof TagValidationError) {
				process.stderr.write(`  ${input.label}: model returned an invalid pair — ${error.message}\n`);
			} else if (error instanceof DsAuthError) {
				throw error; // the token is dead; every later task fails the same way
			} else {
				process.stderr.write(`  ${input.label}: ${error instanceof Error ? error.message : String(error)}\n`);
			}
		}
	}

	const tagged = inputs.length - failures;
	process.stderr.write(
		`\n${tagged}/${inputs.length} tagged  ·  cache read ${reads} write ${writes}  ·  $${spend.toFixed(6)} total`
			+ (tagged > 0 ? `  ·  $${(spend / tagged).toFixed(6)} per task\n` : '\n'),
	);
	if (failures > 0) process.exitCode = 1;
};

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
