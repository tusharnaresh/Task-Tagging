#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DsAuthError, DsClient } from './client/ds-client.ts';
import { describeTokenExpiry, loadConfig } from './config.ts';
import { TaskNormalizer } from './normalize/normalize-task.ts';
import { renderTranscript } from './render/transcript.ts';
import type { NormalizedTask } from './types.ts';

const USAGE = `
Fetch DistributedSource tasks by id and emit a prompt-ready conversation transcript.
Stops at the transcript — no LLM, no analysis.

Usage
  pnpm normalize <taskId> [<taskId> ...] [options]
  pnpm normalize --ids-file ./task-ids.txt --out-dir ./out

Options
  --ids-file <path>   newline-separated task ids ('#' starts a comment)
  --out-dir <dir>     one file per task, default ./out
  --format <f>        transcript (default) | json — see below
  --keep-noise        transcript only: keep envelope headers, routing chatter and duplicates
  --stdout            write to stdout instead of files
  --token <jwt>       FullAuth JWT; defaults to DS_ACCESS_TOKEN
  --apikey <id>       parent DS account id, default SEN42
  --sub-type <name>   server-side filter, e.g. inboundemail. Off by default — see below
  --page-size <n>     history page size, default 50
  --help

Formats
  transcript  <taskId>.txt — what you feed an LLM. Drops per-comment scaffolding (UUIDs, derived
              ids, provenance flags), repeated email envelope headers, internal routing shorthand
              and duplicate messages; resolves the task-type UUID to its name. Measured on a
              189-comment task: 142KB -> 39.6KB, ~36.4k tokens -> ~10.1k, every substantive turn
              intact.
  json        <taskId>.json — lossless. Every comment with provenance, so a labelling decision can
              be traced back to its source entry. Use for debugging and audit.

Sub-type filtering
  The history API honours a server-side 'subType' filter, but the useful selection is "every
  comment sub-type", which is a set — one request per sub-type against an endpoint already
  returning ~90KB per comment. The default is a single unfiltered sweep with local partitioning,
  which is both cheaper and complete. Use --sub-type only to isolate one channel.

Token
  One FullAuth JWT authenticates both the task API and the history API. It lives ~2h; a mid-run
  expiry surfaces as an auth error naming the task it died on.
`;

type OutputFormat = 'transcript' | 'json';

interface Args {
	taskIds: string[];
	idsFile: string | null;
	outDir: string;
	format: OutputFormat;
	keepNoise: boolean;
	toStdout: boolean;
	token: string | null;
	apikey: string | null;
	subType: string | null;
	pageSize: number | null;
	help: boolean;
}

const parseArgs = (argv: string[]): Args => {
	const args: Args = {
		taskIds: [],
		idsFile: null,
		outDir: './out',
		format: 'transcript',
		keepNoise: false,
		toStdout: false,
		token: null,
		apikey: null,
		subType: null,
		pageSize: null,
		help: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];

		if (!token.startsWith('--')) {
			args.taskIds.push(token);
			continue;
		}

		const readValue = () => {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith('--')) {
				throw new Error(`${token} requires a value.`);
			}
			index += 1;
			return value;
		};

		switch (token) {
			case '--help':
			case '-h':
				args.help = true;
				break;
			case '--ids-file':
				args.idsFile = readValue();
				break;
			case '--out-dir':
				args.outDir = readValue();
				break;
			case '--format': {
				const value = readValue();
				if (value !== 'transcript' && value !== 'json') {
					throw new Error(`--format must be transcript or json, received "${value}".`);
				}
				args.format = value;
				break;
			}
			case '--keep-noise':
				args.keepNoise = true;
				break;
			case '--stdout':
				args.toStdout = true;
				break;
			case '--token':
				args.token = readValue();
				break;
			case '--apikey':
				args.apikey = readValue();
				break;
			case '--sub-type':
				args.subType = readValue();
				break;
			case '--page-size':
				args.pageSize = Number.parseInt(readValue(), 10);
				break;
			default:
				throw new Error(`Unknown option ${token}. Run with --help.`);
		}
	}

	return args;
};

const readIdsFile = (path: string) =>
	readFileSync(path, 'utf8')
		.split('\n')
		.map((line) => line.replace(/#.*$/, '').trim())
		.filter(Boolean);

const normalizeOneTask = async (client: DsClient, taskId: string): Promise<NormalizedTask> => {
	const normalizer = new TaskNormalizer(taskId);
	const task = await client.getTask(taskId);

	for await (const page of client.streamHistory(taskId)) {
		normalizer.addPage(page);
	}

	return normalizer.build(task);
};

const main = async () => {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		process.stdout.write(USAGE);
		return;
	}

	const taskIds = Array.from(new Set([...args.taskIds, ...(args.idsFile ? readIdsFile(args.idsFile) : [])]));

	if (taskIds.length === 0) {
		process.stderr.write(USAGE);
		process.exitCode = 1;
		return;
	}

	const config = loadConfig({
		...(args.token ? { accessToken: args.token } : {}),
		...(args.apikey ? { apikey: args.apikey } : {}),
		...(args.subType ? { subType: args.subType } : {}),
		...(args.pageSize ? { pageSize: args.pageSize } : {}),
	});

	const expiry = describeTokenExpiry(config.accessToken);
	if (expiry) {
		if (expiry.minutesLeft <= 0) {
			throw new DsAuthError(`Token already expired at ${expiry.expiresAt.toISOString()}. Fetch a fresh JWT.`);
		}
		process.stderr.write(`Token valid for ${expiry.minutesLeft} more minutes (until ${expiry.expiresAt.toISOString()}).\n`);
	}

	const client = new DsClient(config);
	const jsonResults: NormalizedTask[] = [];
	const transcripts: string[] = [];
	let failures = 0;

	// `--keep-noise` turns every cleanup off at once, which is the useful shape: it answers "what
	// did the renderer remove?" in one run rather than making the caller toggle three flags.
	const transcriptOptions = args.keepNoise
		? { stripEnvelopeHeaders: false, stripRoutingChatter: false, dedupe: false }
		: {};

	for (const [index, taskId] of taskIds.entries()) {
		const label = `[${index + 1}/${taskIds.length}] ${taskId}`;

		try {
			const normalized = await normalizeOneTask(client, taskId);
			const { commentsEmitted, historyEntries, roleCounts } = normalized.meta;
			const roles = `client ${roleCounts.client}, agent ${roleCounts.agent}, system ${roleCounts.system}, unknown ${roleCounts.unknown}`;

			if (args.format === 'json') {
				if (args.toStdout) {
					jsonResults.push(normalized);
				} else {
					const outPath = join(args.outDir, `${taskId}.json`);
					mkdirSync(dirname(outPath), { recursive: true });
					writeFileSync(outPath, JSON.stringify(normalized, null, 2));
				}

				process.stderr.write(`${label}: ${commentsEmitted} comments from ${historyEntries} entries (${roles})\n`);
			} else {
				const transcript = renderTranscript(normalized, transcriptOptions);

				if (args.toStdout) {
					transcripts.push(transcript.text);
				} else {
					const outPath = join(args.outDir, `${taskId}.txt`);
					mkdirSync(dirname(outPath), { recursive: true });
					writeFileSync(outPath, transcript.text);
				}

				process.stderr.write(
					`${label}: ${transcript.commentsRendered} messages ` +
						`(${transcript.commentsDropped} dropped as noise, ${historyEntries} history entries, ${roles}) ` +
						`— ${(transcript.text.length / 1024).toFixed(1)}KB, ~${Math.round(transcript.text.length / 4)} tokens\n`
				);
			}
		} catch (error) {
			failures += 1;

			// An auth failure will hit every remaining task the same way — a 2h token that expired
			// mid-run does not recover. Stop rather than emit a page of identical errors.
			if (error instanceof DsAuthError) {
				process.stderr.write(`${label}: ${error.message}\nStopping: the token will not work for the remaining tasks.\n`);
				break;
			}

			process.stderr.write(`${label}: FAILED — ${error instanceof Error ? error.message : String(error)}\n`);
		}
	}

	if (args.toStdout) {
		// Transcripts are separated by a rule so a multi-task dump stays readable as one document.
		process.stdout.write(args.format === 'json' ? JSON.stringify(jsonResults, null, 2) : transcripts.join('\n\n---\n\n'));
	}

	if (failures > 0) {
		process.exitCode = 1;
	}
};

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
