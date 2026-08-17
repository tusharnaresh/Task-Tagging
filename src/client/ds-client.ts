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

	if (response.status === 401 || text.trimStart().toLowerCase().startsWith('<!doctype html') || text.trimStart().startsWith('<html')) {
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
	async getTask(taskId: string): Promise<DsTask | null> {
		const url = new URL(`${this.config.baseUrl}/getATask_v2`);
		url.searchParams.set('apikey', this.config.apikey);
		url.searchParams.set('taskid', taskId);

		const response = await fetch(url, {
			method: 'POST',
			headers: { ...this.headers, 'Content-Type': 'application/json' },
			body: JSON.stringify({ customField: true }),
		});

		const payload = (await readJson(response, `getATask_v2 ${taskId}`)) as {
			status?: boolean;
			error?: string;
			errorMessage?: string;
			task?: DsTask;
		};

		// This endpoint's root key is `status`; `/getTasksUnderAccount` uses `success`. Both report
		// failure in the body while returning HTTP 200.
		if (payload.status === false) {
			throw new Error(payload.errorMessage ?? payload.error ?? `getATask_v2 ${taskId}: DS reported failure`);
		}

		return payload.task ?? null;
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

		while (queryString) {
			const response = await fetch(`${this.config.historyBaseUrl}/v1/Interaction?${queryString}`, { headers: this.headers });
			const page = (await readJson(response, `history page ${pagesFetched + 1} for ${taskId}`)) as InteractionPage;
			pagesFetched += 1;

			yield page.data ?? [];

			// `links.next.parameters` is the COMPLETE next-page query string, substituted wholesale.
			// An empty object or a missing `next` marks the last page.
			queryString = page.links?.next?.parameters ?? '';
		}
	}
}
