import 'dotenv/config';

export interface Config {
	accessToken: string;
	apikey: string;
	baseUrl: string;
	historyBaseUrl: string;
	pageSize: number;
	/** Optional server-side sub-type filter. Off by default — see README. */
	subType: string | null;
}

const DEFAULTS = {
	apikey: 'SEN42',
	baseUrl: 'https://my.distributedsource.com',
	historyBaseUrl: 'https://full-history.anywhere.co/live-read',
	pageSize: 50,
};

/**
 * Strips an optional `Bearer ` prefix. The token is routinely copied out of a curl example or a
 * browser devtools panel with the scheme attached; sending `Bearer Bearer <jwt>` fails as a plain
 * 401 with no hint about the cause.
 */
const normalizeToken = (raw: string) => raw.trim().replace(/^Bearer\s+/i, '').trim();

/**
 * Reports how long a JWT has left. The DS token lives ~2h, and a mid-run expiry surfaces as a 401
 * on some arbitrary later task, so the remaining budget is worth printing before the run starts.
 */
export const describeTokenExpiry = (token: string): { expiresAt: Date; minutesLeft: number } | null => {
	const payloadSegment = token.split('.')[1];
	if (!payloadSegment) {
		return null;
	}

	try {
		const payload = JSON.parse(Buffer.from(payloadSegment, 'base64').toString('utf8')) as { exp?: number };
		if (typeof payload.exp !== 'number') {
			return null;
		}

		const expiresAt = new Date(payload.exp * 1000);
		return { expiresAt, minutesLeft: Math.round((expiresAt.getTime() - Date.now()) / 60_000) };
	} catch {
		return null;
	}
};

export const loadConfig = (overrides: Partial<Config> = {}): Config => {
	const accessToken = normalizeToken(overrides.accessToken ?? process.env.DS_ACCESS_TOKEN ?? '');

	if (!accessToken) {
		throw new Error('No access token. Set DS_ACCESS_TOKEN in .env or pass --token <jwt>.');
	}

	return {
		accessToken,
		apikey: overrides.apikey ?? process.env.DS_APIKEY ?? DEFAULTS.apikey,
		baseUrl: (overrides.baseUrl ?? process.env.DS_BASE_URL ?? DEFAULTS.baseUrl).replace(/\/$/, ''),
		historyBaseUrl: (overrides.historyBaseUrl ?? process.env.DS_HISTORY_BASE_URL ?? DEFAULTS.historyBaseUrl).replace(/\/$/, ''),
		pageSize: overrides.pageSize ?? DEFAULTS.pageSize,
		subType: overrides.subType ?? null,
	};
};
