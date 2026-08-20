import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/config.ts';
import { DsAuthError, DsClient } from '../../../src/client/ds-client.ts';

const config: Config = {
	accessToken: 'jwt',
	apikey: 'SEN42',
	baseUrl: 'https://my.example.test',
	historyBaseUrl: 'https://history.example.test',
	pageSize: 50,
	subType: null,
};

/** Queues one body per call, in order, all as HTTP 200 — the shape every DS failure mode arrives in. */
const stubResponses = (...bodies: unknown[]) => {
	const fetchMock = vi.fn(async () => new Response(typeof bodies[0] === 'string' ? (bodies.shift() as string) : JSON.stringify(bodies.shift()), { status: 200 }));
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
};

/** Queues `[status, body]` pairs, so a transient failure can precede a success. */
const stubStatuses = (...pairs: Array<[number, unknown]>) => {
	const fetchMock = vi.fn(async () => {
		const [status, body] = pairs.shift() ?? [500, {}];
		return new Response(JSON.stringify(body), { status });
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
};

const collect = async (client: DsClient, taskId: string) => {
	const pages = [];
	for await (const page of client.streamHistory(taskId)) {
		pages.push(page);
	}
	return pages;
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('getTask', () => {
	it('returns the task on a successful response', async () => {
		stubResponses({ status: true, task: { comments: 'Integration Update' } });

		expect(await new DsClient(config).getTask('task-1')).toMatchObject({ comments: 'Integration Update' });
	});

	it('throws on the `status: false` failure DS reports under HTTP 200', async () => {
		stubResponses({ status: false, errorMessage: 'Invalid task id' });

		await expect(new DsClient(config).getTask('task-1')).rejects.toThrow('Invalid task id');
	});

	// DS is not consistent about which root key a handler answers with, so checking only `status`
	// let a `success: false` body through as a task-less success.
	it('throws on `success: false` as well', async () => {
		stubResponses({ success: false, error: 'session expired' });

		await expect(new DsClient(config).getTask('task-1')).rejects.toThrow('session expired');
	});

	it('throws rather than returning null when the response carries no task', async () => {
		stubResponses({ status: true });

		await expect(new DsClient(config).getTask('task-1')).rejects.toThrow(/carried no task/);
	});

	it('reports the login page as an auth failure', async () => {
		stubResponses('<!DOCTYPE html><html><body>login</body></html>');

		await expect(new DsClient(config).getTask('task-1')).rejects.toBeInstanceOf(DsAuthError);
	});

	// The doctype branch lowercased and the `<html` branch did not, so an uppercase login page with
	// no doctype threw a generic Error — which the batch loop treats as retryable per task.
	it('reports an uppercase login page with no doctype as an auth failure', async () => {
		stubResponses('<HTML><body>login</body></HTML>');

		await expect(new DsClient(config).getTask('task-1')).rejects.toBeInstanceOf(DsAuthError);
	});
});

describe('streamHistory', () => {
	it('follows `links.next.parameters` until it is absent', async () => {
		stubResponses({ data: [{ interactionId: 'a' }], links: { next: { parameters: 'page=2' } } }, { data: [{ interactionId: 'b' }], links: {} });

		expect(await collect(new DsClient(config), 'task-1')).toEqual([[{ interactionId: 'a' }], [{ interactionId: 'b' }]]);
	});

	// A `success: false` body carries neither `data` nor a `next` link, so the loop used to end
	// cleanly and the task emitted a header-only transcript at exit 0.
	it('throws instead of yielding an empty page when DS reports failure', async () => {
		stubResponses({ success: false, errorMessage: 'not authorised for this account' });

		await expect(collect(new DsClient(config), 'task-1')).rejects.toThrow('not authorised for this account');
	});

	// Termination depended entirely on DS omitting the cursor, so a repeated one looped forever.
	it('throws when DS serves a next-page cursor it already served', async () => {
		const page = { data: [{ interactionId: 'a' }], links: { next: { parameters: 'page=2' } } };
		stubResponses(page, page, page);

		await expect(collect(new DsClient(config), 'task-1')).rejects.toThrow(/already served/);
	});

	it('names the page and task when a failure body carries no message', async () => {
		stubResponses({ data: [{ interactionId: 'a' }], links: { next: { parameters: 'page=2' } } }, { success: false });

		await expect(collect(new DsClient(config), 'task-1')).rejects.toThrow('history page 2 for task-1');
	});
});

describe('transient failures', () => {
	// A 502 on page 3 of 4 used to discard the two pages already fetched and normalized.
	it('retries a 502 and succeeds', async () => {
		const fetchMock = stubStatuses([502, {}], [200, { status: true, task: { comments: 'Integration Update' } }]);

		expect(await new DsClient(config).getTask('task-1')).toMatchObject({ comments: 'Integration Update' });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('gives up after the attempt limit and reports the status', async () => {
		stubStatuses([503, {}], [503, {}], [503, {}]);

		await expect(new DsClient(config).getTask('task-1')).rejects.toThrow(/503/);
	});

	it('does not retry a client error', async () => {
		const fetchMock = stubStatuses([404, { error: 'no such task' }]);

		await expect(new DsClient(config).getTask('task-1')).rejects.toThrow(/404/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('does not retry the login page', async () => {
		const fetchMock = vi.fn(async () => new Response('<!DOCTYPE html><html>login</html>', { status: 401 }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(new DsClient(config).getTask('task-1')).rejects.toBeInstanceOf(DsAuthError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('bounds every request with a timeout signal', async () => {
		const fetchMock = stubResponses({ status: true, task: {} });
		await new DsClient(config).getTask('task-1');

		expect((fetchMock.mock.calls[0] as unknown as [URL, RequestInit])[1].signal).toBeInstanceOf(AbortSignal);
	});
});
