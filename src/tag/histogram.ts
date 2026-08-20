#!/usr/bin/env node
/**
 * Aggregates a `pnpm tag` run into the three numbers that turn prompt arguments into measurements:
 * the null rate, the `-other` rate, and the distribution of generals.
 *
 * Reads the JSON-lines `pnpm tag` writes to stdout — one object per input — and ignores anything
 * that is not a tag object, so a run whose stderr was merged in still aggregates.
 *
 *   pnpm tag --ids-file ./task-ids.txt > tagged.jsonl
 *   pnpm histogram < tagged.jsonl
 *
 * The point of comparison is the proposal's own distribution table (`script-change` 16.1% of all
 * tasks, top 5 specifics 48.0%, top 10 60.4%). A general histogram that does not resemble it, or a
 * null rate above ~15%, is the evidence P2/P3/P8 need.
 */

interface TagLine {
	general?: unknown;
	specific?: unknown;
}

const readStdin = async () => {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf8');
};

const parseLine = (line: string): { general: string; specific: string | null } | null => {
	if (!line.trim().startsWith('{')) {
		return null;
	}

	try {
		const parsed = JSON.parse(line) as TagLine;
		if (typeof parsed.general !== 'string') {
			return null;
		}

		return { general: parsed.general, specific: typeof parsed.specific === 'string' ? parsed.specific : null };
	} catch {
		return null;
	}
};

const pad = (value: string, width: number) => value.padEnd(width);
const percent = (count: number, total: number) => `${((count / total) * 100).toFixed(1)}%`;

const main = async () => {
	const tags = (await readStdin()).split('\n').map(parseLine).filter((tag): tag is { general: string; specific: string | null } => tag !== null);

	if (tags.length === 0) {
		process.stderr.write('No tag objects on stdin. Pipe the stdout of `pnpm tag`.\n');
		process.exitCode = 1;
		return;
	}

	const nulls = tags.filter((tag) => tag.specific === null).length;
	const others = tags.filter((tag) => tag.specific?.endsWith('-other')).length;

	const generalCounts = new Map<string, number>();
	const specificCounts = new Map<string, number>();
	for (const tag of tags) {
		generalCounts.set(tag.general, (generalCounts.get(tag.general) ?? 0) + 1);
		if (tag.specific) {
			specificCounts.set(tag.specific, (specificCounts.get(tag.specific) ?? 0) + 1);
		}
	}

	const byCount = (entries: Map<string, number>) => [...entries].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	const width = Math.max(...[...generalCounts.keys(), ...specificCounts.keys()].map((slug) => slug.length));

	process.stdout.write(`${tags.length} tagged\n`);
	process.stdout.write(`null specific   ${nulls} (${percent(nulls, tags.length)})\n`);
	process.stdout.write(`-other fallback ${others} (${percent(others, tags.length)})\n`);
	process.stdout.write(`named specific  ${tags.length - nulls - others} (${percent(tags.length - nulls - others, tags.length)})\n`);

	process.stdout.write('\nGenerals\n');
	for (const [general, count] of byCount(generalCounts)) {
		process.stdout.write(`  ${pad(general, width)}  ${String(count).padStart(4)}  ${percent(count, tags.length).padStart(6)}\n`);
	}

	const specifics = byCount(specificCounts);
	const top5 = specifics.slice(0, 5).reduce((sum, [, count]) => sum + count, 0);
	const top10 = specifics.slice(0, 10).reduce((sum, [, count]) => sum + count, 0);

	process.stdout.write(`\nSpecifics — ${specifics.length} distinct, top 5 ${percent(top5, tags.length)}, top 10 ${percent(top10, tags.length)}\n`);
	process.stdout.write('(proposal: top 5 48.0%, top 10 60.4%, script-change alone 16.1%)\n');
	for (const [specific, count] of specifics) {
		process.stdout.write(`  ${pad(specific, width)}  ${String(count).padStart(4)}  ${percent(count, tags.length).padStart(6)}\n`);
	}
};

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
