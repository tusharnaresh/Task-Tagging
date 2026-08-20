import type { Config } from '../config.ts';
import type { DsTask, InteractionEntry, InteractionPage } from '../types.ts';

/**
 * Application-scoped constants for the history API. These identify DistributedSource itself, not an
 * account or a task, and are the same values the DS app sends
 * (`HistoryService.constructCommonUrlParams`).
 */
const HISTORY_APPLICATION_ID = '3c76774e-1464-4bdf-987e-c2d8d48d4d9f';
const HISTORY_COMPONENT_ID = 'c9bcf9a4-dceb-4619-b95e-4d37660db665';
const HISTORY_BRAND_ID = '801e4cdf-9fb6-4038-8de2-61719023c125';

/** A runaway-cursor backstop. The largest task observed runs to 4 pages at the default page size. */
const MAX_HISTORY_PAGES = 200;

/**
 * A history page is ~4.5 MB, so the ceiling is generous — but there has to be one. Without it a
 * hung connection stalls a whole batch indefinitely with nothing to show for the tasks it already
 * fetched.
 */
const REQUEST_TIMEOUT_MS = 120_000;

/** Transient failures worth one more try. A 401 or a 4xx is not transient and is not retried. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request, retried on a transient failure with exponential backoff.
 *
 * Without this, a 502 on page 3 of 4 throws away the two pages already fetched and normalized —
 * ~9 MB of transfer — and the batch records the task as failed.
 */
const fetchWithRetry = async (input: string | URL, init: RequestInit, context: string): Promise<Response> => {
	let lastError: unknown;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
		try {
			const response = await fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
			if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_ATTEMPTS) {
				return response;
			}
			lastError = new Error(`${context}: HTTP ${response.status}`);
		} catch (error) {
			if (attempt === MAX_ATTEMPTS) {
				throw error;
			}
			lastError = error;
		}

		await delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
	}

	throw lastError instanceof Error ? lastError : new Error(`${context}: request failed`);
};

export class DsAuthError extends Error {}

/**
 * Turns a response into JSON, or into an error that says what actually happened.
 *
 * Three DS failure modes look nothing like a normal JSON error and all three are silent if you
 * only check `response.ok`:
 *
 * - An expired or missing token returns the **login HTML page**, not JSON.
 * - `my.distributedsource.com` endpoints that are session-scoped return `200 {"success": false}` —
 *   a successful HTTP status carrying a total failure.
 * - A wrong `apikey` returns `401` with the same login HTML.
 */
const readJson = async (response: Response, context: string): Promise<unknown> => {
	const text = await response.text();

	// Both branches lowercased: `<HTML><body>login</body></HTML>` with no doctype matched neither,
	// so a dead token surfaced as a generic Error and the CLI kept going, one failure per task.
	const leading = text.trimStart().toLowerCase();
	if (response.status === 401 || leading.startsWith('<!doctype html') || leading.startsWith('<html')) {
		throw new DsAuthError(
			`${context}: DS returned its login page (HTTP ${response.status}). The JWT is missing, expired, or the apikey is not one this token may access.`
		);
	}

	if (!response.ok) {
		throw new Error(`${context}: HTTP ${response.status} — ${text.slice(0, 240)}`);
	}

	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(`${context}: response was not JSON — ${text.slice(0, 240)}`);
	}
};

export class DsClient {
	constructor(private readonly config: Config) {}

	private get headers() {
		return {
			Authorization: `Bearer ${this.config.accessToken}`,
			Accept: 'application/json',
		};
	}

	/**
	 * `POST` despite being a read — that is the DS contract, and a `GET` returns 405.
	 *
	 * Bearer auth works here because the handler is annotated `@ApiAuth({SESSION, FULLAUTH})` and
	 * takes its account from the `apikey` query param rather than the servlet session.
	 */
	async getTask(taskId: string): Promise<DsTask> {
		const url = new URL(`${this.config.baseUrl}/getATask_v2`);
		url.searchParams.set('apikey', this.config.apikey);
		url.searchParams.set('taskid', taskId);

		const response = await fetchWithRetry(
			url,
			{
				method: 'POST',
				headers: { ...this.headers, 'Content-Type': 'application/json' },
				body: JSON.stringify({ customField: true }),
			},
			`getATask_v2 ${taskId}`,
		);
		console.log(JSON.stringify(response));
		const payload = (await readJson(response, `getATask_v2 ${taskId}`)) as {
			status?: boolean;
			success?: boolean;
			error?: string;
			errorMessage?: string;
			task?: DsTask;
		};

		// This endpoint's root key is `status`; `/getTasksUnderAccount` uses `success`. Both report
		// failure in the body while returning HTTP 200, and DS is not consistent about which key a
		// given handler answers with, so neither one alone is a sufficient check.
		if (payload.status === false || payload.success === false) {
			throw new Error(payload.errorMessage ?? payload.error ?? `getATask_v2 ${taskId}: DS reported failure`);
		}

		// No `task` on a response that claims no failure means the id resolved to nothing. Returning
		// null here would emit a header-only transcript and exit 0 — a missing task must be loud.
		if (!payload.task) {
			throw new Error(`getATask_v2 ${taskId}: response carried no task. The id may not exist under apikey ${this.config.apikey}.`);
		}

		return payload.task;
	}

	private buildHistoryQuery(taskId: string) {
		const query = new URLSearchParams({
			applicationId: HISTORY_APPLICATION_ID,
			componentId: HISTORY_COMPONENT_ID,
			brandId: HISTORY_BRAND_ID,
			linkedTask: taskId,
			sort: 'createdDate',
			order: 'DESC',
			size: String(this.config.pageSize),
			isDeleted: 'false',
			accountId: this.config.apikey,
		});

		if (this.config.subType) {
			query.set('subType', this.config.subType);
		}

		return query.toString();
	}

	/**
	 * Yields history one page at a time.
	 *
	 * A page is ~4.5 MB and a single task can run to 190 entries across 4 pages, because every
	 * comment carries ~90 KB of styled HTML. Accumulating raw pages across a batch of task ids is
	 * what turns this from a script into an OOM, so the caller normalizes and discards per page.
	 */
	async *streamHistory(taskId: string): AsyncGenerator<InteractionEntry[]> {
		let queryString = this.buildHistoryQuery(taskId);
		let pagesFetched = 0;
		const seenQueries = new Set<string>();

		while (queryString) {
			// Termination otherwise depends entirely on DS omitting `links.next.parameters`. A cursor
			// that repeats, or a server that always returns one, would loop forever against a paid API.
			if (seenQueries.has(queryString)) {
				throw new Error(`history for ${taskId}: DS returned a next-page cursor it had already served (page ${pagesFetched + 1}).`);
			}
			if (pagesFetched >= MAX_HISTORY_PAGES) {
				throw new Error(`history for ${taskId}: stopped after ${MAX_HISTORY_PAGES} pages. DS is not signalling the end of the history.`);
			}
			seenQueries.add(queryString);

			const context = `history page ${pagesFetched + 1} for ${taskId}`;
			const response = await fetchWithRetry(`${this.config.historyBaseUrl}/v1/Interaction?${queryString}`, { headers: this.headers }, context);
			const page = (await readJson(response, context)) as InteractionPage;
			pagesFetched += 1;

			// `success: false` under HTTP 200 is a total failure that carries neither `data` nor a
			// `next` link, so an unchecked loop terminates cleanly and emits an empty conversation.
			if (page.success === false) {
				throw new Error(page.errorMessage ?? page.error ?? `history page ${pagesFetched} for ${taskId}: DS reported failure`);
			}

			yield page.data ?? [];

			// `links.next.parameters` is the COMPLETE next-page query string, substituted wholesale.
			// An empty object or a missing `next` marks the last page.
			queryString = page.links?.next?.parameters ?? '';
		}
	}
}
