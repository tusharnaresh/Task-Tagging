import { describe, expect, it } from 'vitest';
import { stripQuotedReplyChain } from '../../../src/normalize/quoted-reply.ts';

const trim = (input: string) => stripQuotedReplyChain(input);

describe('quote markers that should fire', () => {
	it('trims an Original Message separator', () => {
		const { text, trimmed } = trim('We cancelled the line.\n-----Original Message-----\nFrom: Dana\nplease cancel');

		expect(trimmed).toBe(true);
		expect(text).toBe('We cancelled the line.');
	});

	it('trims a dated attribution line', () => {
		const { text, trimmed } = trim('Confirmed, the refund is processed. On Mon, Jun 2, 2025 at 9:14 AM Support wrote: my card was charged twice');

		expect(trimmed).toBe(true);
		expect(text).toBe('Confirmed, the refund is processed.');
	});

	it('trims an Outlook header block', () => {
		const { text, trimmed } = trim('Done. From: Dana Reyes <dana@example.com> Sent: Monday, June 2, 2025 10:04 AM Subject: Billing');

		expect(trimmed).toBe(true);
		expect(text).toBe('Done.');
	});

	it('trims a Sent/Subject header block with no From line', () => {
		const { text, trimmed } = trim('Done. Sent: Monday, June 2, 2025 10:04 AM To: support@example.com Subject: Billing');

		expect(trimmed).toBe(true);
		expect(text).toBe('Done.');
	});

	it('keeps the DS wrapper headers it is given above the body', () => {
		const { text } = trim('From: Dana Reyes\nSubject: Billing\nMy card was charged twice. On Mon, Jun 2, 2025 at 9:14 AM Support wrote: earlier text');

		expect(text).toBe('From: Dana Reyes\nSubject: Billing\nMy card was charged twice.');
	});

	it('leaves a comment that is nothing but quoted material untouched', () => {
		const input = 'From: Dana Reyes\nOn Mon, Jun 2, 2025 at 9:14 AM Support wrote: earlier text';

		expect(trim(input)).toMatchObject({ text: input, trimmed: false });
	});
});

describe('prose that must not be mistaken for a quote', () => {
	// Every marker was a substring match, so ordinary sentences truncated the message at the match
	// and everything the client actually asked for was discarded.
	it('keeps a sentence where someone "wrote" something undated', () => {
		const input = 'Client called about the renewal. On the invoice the accountant wrote: charge net-30, so we need a new PO.';

		expect(trim(input)).toMatchObject({ text: input, trimmed: false });
	});

	it('keeps a note that happens to use Sent: and Subject: as words', () => {
		const input = 'Summary of the outage. Sent: nothing yet. Subject: the API keys still need rotating.';

		expect(trim(input)).toMatchObject({ text: input, trimmed: false });
	});

	it('keeps a note that reports where something was sent from', () => {
		const input = 'Escalation summary. From: the overnight queue. Sent: still pending, no ETA yet.';

		expect(trim(input)).toMatchObject({ text: input, trimmed: false });
	});

	it('keeps a sentence about what a caller wrote on a form', () => {
		const input = 'On the intake form the caller wrote: please only contact me by email.';

		expect(trim(input)).toMatchObject({ text: input, trimmed: false });
	});
});
