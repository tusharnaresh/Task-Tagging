import { describe, expect, it } from 'vitest';
import { resolveTaskTypeName } from '../../../src/constants/task-types.ts';
import { renderTranscript } from '../../../src/render/transcript.ts';
import type { NormalizedComment, NormalizedTask } from '../../../src/types.ts';

const comment = (overrides: Partial<NormalizedComment> & { text: string }): NormalizedComment => ({
	commentId: 'i:0',
	sourceInteractionId: 'i',
	createdDate: 1_780_000_000_000,
	createdAt: new Date(1_780_000_000_000).toISOString(),
	speakerName: 'Tony C',
	speakerRole: 'agent',
	roleBasis: 'sub-type',
	subType: 'note',
	sourceField: 'historyComments',
	quotedReplyTrimmed: false,
	sequence: 0,
	...overrides,
});

const task = (comments: NormalizedComment[]): NormalizedTask => ({
	taskId: 'task-1',
	title: 'Integration Update',
	taskType: 'type-uuid',
	accountId: 'SEN42',
	linkedAccount: 'acct',
	open: false,
	createdDate: null,
	lastUpdatedDate: null,
	comments,
	meta: {
		historyEntries: comments.length,
		historyPages: 1,
		commentsEmitted: comments.length,
		droppedLogEntries: 0,
		unreadStatusCount: 0,
		unreadInfoFieldCount: 0,
		unknownSubTypeCounts: {},
		missingSubTypeCount: 0,
		quotedRepliesTrimmed: 0,
		roleCounts: { client: 0, agent: 0, system: 0, unknown: 0 },
		warnings: [],
		fetchedAt: '',
	},
});

describe('renderTranscript', () => {
	it('states the task once in a header', () => {
		const { text } = renderTranscript(task([comment({ text: 'Something happened.' })]));

		expect(text).toContain('TASK: Integration Update');
		expect(text).toContain('STATUS: closed');
		expect(text).toContain('CONVERSATION: 1 messages');
	});

	it('resolves the task-type UUID to its display name', () => {
		const withRealType = { ...task([comment({ text: 'x' })]), taskType: '6af264cc-ef97-4b85-ad80-0750af3acbcf' };

		expect(renderTranscript(withRealType).text).toContain('TASK TYPE: Cancel Request');
		expect(renderTranscript(withRealType).text).not.toContain('6af264cc');
	});

	it('falls back to the raw UUID for a task type added after the snapshot', () => {
		const unknownType = { ...task([comment({ text: 'x' })]), taskType: 'ffffffff-0000-0000-0000-000000000000' };

		expect(renderTranscript(unknownType).text).toContain('TASK TYPE: ffffffff-0000-0000-0000-000000000000');
	});

	it('carries no per-comment scaffolding', () => {
		const { text } = renderTranscript(task([comment({ text: 'Something happened.' })]));

		for (const noise of ['commentId', 'sourceInteractionId', 'roleBasis', 'quotedReplyTrimmed', 'sequence', 'sourceField']) {
			expect(text).not.toContain(noise);
		}
	});

	it('keeps speaker, role and sub-type on each line', () => {
		const { text } = renderTranscript(task([comment({ text: 'Something happened.' })]));

		expect(text).toMatch(/\[\d{4}-\d\d-\d\d \d\d:\d\d\] agent\/note Tony C: Something happened\./);
	});

	it('drops repeated envelope headers but keeps the body', () => {
		const { text } = renderTranscript(
			task([comment({ subType: 'inboundemail', speakerRole: 'client', text: 'From: a@b.com\nSubject: Re: X\nTo: c@d.com\nMy card was charged twice.' })])
		);

		expect(text).toContain('My card was charged twice.');
		expect(text).not.toContain('To: c@d.com');
	});

	it('matches the "From :" spacing DS also emits', () => {
		const { text } = renderTranscript(task([comment({ text: 'From : a@b.com\nSubject : Re: X\nThe actual message.' })]));

		expect(text).toContain('The actual message.');
		expect(text).not.toContain('a@b.com');
	});

	it('promotes the shared email subject into the header instead of repeating it per message', () => {
		const { text } = renderTranscript(
			task([
				comment({ text: 'From: a@b.com\nSubject: Re: Webhook fields\nFirst message.' }),
				comment({ text: 'From: c@d.com\nSubject: Re: Webhook fields\nSecond message.' }),
			])
		);

		expect(text).toContain('EMAIL SUBJECT: Re: Webhook fields');
		expect(text.match(/Webhook fields/g)).toHaveLength(1);
	});

	it('drops a comment that is nothing but routing shorthand', () => {
		const { text, commentsRendered, commentsDropped } = renderTranscript(
			task([comment({ text: 'AR Received' }), comment({ text: 'Sending to Derek' }), comment({ text: 'The webhook returns a 500.' })])
		);

		expect(commentsRendered).toBe(1);
		expect(commentsDropped).toBe(2);
		expect(text).toContain('The webhook returns a 500.');
	});

	it('strips a routing prefix but keeps the content behind it', () => {
		// The most substantive notes on a real task open with this shorthand. Dropping the whole
		// comment because it starts with "AR Received" would delete the actual findings.
		const { text, commentsRendered } = renderTranscript(
			task([comment({ text: '- AR Received - Reviewing test webhook, it fails on the date field.' })])
		);

		expect(commentsRendered).toBe(1);
		expect(text).toContain('Reviewing test webhook, it fails on the date field.');
		expect(text).not.toMatch(/AR Received/i);
	});

	it('drops a duplicate message', () => {
		const { commentsRendered, commentsDropped } = renderTranscript(
			task([comment({ text: 'Chasing the client for a reply.' }), comment({ text: 'chasing the client for a reply.' })])
		);

		expect(commentsRendered).toBe(1);
		expect(commentsDropped).toBe(1);
	});

	it('keeps everything when the cleanups are turned off', () => {
		const noisy = task([
			comment({ text: 'AR Received' }),
			comment({ text: 'From: a@b.com\nSubject: Re: X\nBody text.' }),
			comment({ text: 'AR Received' }),
		]);

		const { text, commentsRendered } = renderTranscript(noisy, {
			stripEnvelopeHeaders: false,
			stripRoutingChatter: false,
			dedupe: false,
		});

		expect(commentsRendered).toBe(3);
		expect(text).toContain('From: a@b.com');
		expect(text).toMatch(/AR Received/);
	});

	it('does not strip content that merely resembles routing shorthand mid-sentence', () => {
		const { text } = renderTranscript(task([comment({ text: 'The client asked whether we had assigned to Derek already.' })]));

		expect(text).toContain('The client asked whether we had');
	});
});

describe('routing chatter', () => {
	const render = (text: string) => {
		const comment = {
			commentId: 'c:0',
			sourceInteractionId: 'entry-1',
			createdDate: 1_780_000_000_000,
			createdAt: '2026-05-29T00:00:00.000Z',
			speakerName: 'Tony C',
			speakerRole: 'agent' as const,
			roleBasis: 'sub-type' as const,
			subType: 'note',
			sourceField: 'historyComments' as const,
			text,
			quotedReplyTrimmed: false,
			sequence: 0,
		};
		const task = {
			taskId: 'task-1',
			title: null,
			taskType: null,
			accountId: null,
			linkedAccount: null,
			open: null,
			createdDate: null,
			lastUpdatedDate: null,
			comments: [comment],
			meta: {
				historyEntries: 1,
				historyPages: 1,
				commentsEmitted: 1,
				droppedLogEntries: 0,
				unknownSubTypeCounts: {},
				missingSubTypeCount: 0,
				unreadStatusCount: 0,
				unreadInfoFieldCount: 0,
				quotedRepliesTrimmed: 0,
				roleCounts: { client: 0, agent: 1, system: 0, unknown: 0 },
				warnings: [],
				fetchedAt: '',
			},
		};

		return renderTranscript(task).text;
	};

	it('strips shorthand that is the whole note', () => {
		expect(render('AR Received')).not.toContain('AR Received');
		expect(render('Sent to Derek')).not.toContain('Derek');
	});

	it('strips shorthand that opens a substantive note', () => {
		const rendered = render('- AR Received - Reviewing test webhook in zap');

		expect(rendered).toContain('Reviewing test webhook in zap');
		expect(rendered).not.toContain('AR Received');
	});

	// The alternations matched a prefix of an ordinary sentence and took the sentence's subject with
	// them: "Sent to collections" lost "collections", "PC Richards" lost the caller's name.
	it('keeps the words that follow when the opening is prose, not shorthand', () => {
		expect(render('Sent to collections for non-payment, account is 90 days in arrears')).toContain('collections for non-payment');
		expect(render('Assigned to Verizon port-out team, ETA 5 days')).toContain('Verizon port-out team');
		expect(render('PC Richards is the caller, they want a callback')).toContain('PC Richards');
		expect(render('Taking a break from the integration until Q3')).toContain('break from the integration');
	});
});

describe('task-type resolution', () => {
	it('resolves a known UUID to its display name', () => {
		expect(resolveTaskTypeName('10c8ccb2-1990-4ea7-8886-71ef3531002c')).toBe('Integrations Request');
	});

	it('returns null for a UUID outside the snapshot', () => {
		expect(resolveTaskTypeName('00000000-0000-0000-0000-000000000000')).toBeNull();
	});

	// A bare index read falls through to the prototype, which rendered `TASK TYPE: function Object()`.
	it('does not resolve inherited object properties', () => {
		expect(resolveTaskTypeName('constructor')).toBeNull();
		expect(resolveTaskTypeName('toString')).toBeNull();
	});

	// These are test rows left in the live DS list; rendering them describes the task falsely.
	it('does not resolve the test-junk types that were stripped from the map', () => {
		expect(resolveTaskTypeName('1482fb7e-b89a-45a8-a0c8-9b712666e7ca')).toBeNull();
		expect(resolveTaskTypeName('9138baff-19cb-44ba-b6da-2448cfb37645')).toBeNull();
	});
});
