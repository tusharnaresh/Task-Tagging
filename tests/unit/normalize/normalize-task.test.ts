import { describe, expect, it } from 'vitest';
import { partitionHistoryByMasterType, resolveSubType } from '../../../src/normalize/master-type.ts';
import { TaskNormalizer } from '../../../src/normalize/normalize-task.ts';
import {
	agentNote,
	billingLogRow,
	buildEntry,
	chatTranscript,
	inboundEmail,
	resolutionOnly,
	systemNotice,
	taskCommentsOnly,
} from '../../fixtures.ts';

const normalize = (entries: Parameters<TaskNormalizer['addPage']>[0]) => {
	const normalizer = new TaskNormalizer('task-1');
	normalizer.addPage(entries);
	return normalizer.build(null);
};

describe('sub-type resolution', () => {
	it('reads subType from the array the API actually returns', () => {
		expect(resolveSubType(agentNote)).toBe('note');
	});

	it('returns null when the entry carries no subType', () => {
		expect(resolveSubType(buildEntry({ interactionId: 'x', createdDate: 1, historyComments: '<p>hi</p>' }))).toBeNull();
	});
});

describe('master-type partitioning', () => {
	it('drops audit rows', () => {
		const partition = partitionHistoryByMasterType([agentNote, billingLogRow]);
		expect(partition.droppedLogCount).toBe(1);
		expect(partition.kept).toHaveLength(1);
	});

	it('keeps unrecognised sub-types rather than discarding them, and counts them', () => {
		const novel = buildEntry({ interactionId: 'novel', subType: ['whatsapp'], createdDate: 1, historyComments: '<p>hi</p>' });
		const partition = partitionHistoryByMasterType([novel]);

		expect(partition.kept).toHaveLength(1);
		expect(partition.unknownSubTypeCounts).toEqual({ whatsapp: 1 });
	});
});

describe('TaskNormalizer', () => {
	it('emits plain text with no HTML', () => {
		const { comments } = normalize([agentNote]);

		expect(comments).toHaveLength(1);
		expect(comments[0].text).toBe('Called the customer about the failed payment. Left a voicemail.');
		expect(comments[0].text).not.toMatch(/<[a-z]/i);
	});

	it('attributes a single-author entry from its sub-type', () => {
		expect(normalize([agentNote]).comments[0]).toMatchObject({ speakerRole: 'agent', roleBasis: 'sub-type' });
		expect(normalize([inboundEmail]).comments[0]).toMatchObject({ speakerRole: 'client', roleBasis: 'sub-type' });
	});

	it('trims the quoted reply chain from an email body', () => {
		const { comments, meta } = normalize([inboundEmail]);

		expect(comments[0].text).toContain('My card was charged twice this month.');
		expect(comments[0].text).not.toContain('previous message body here');
		expect(comments[0].quotedReplyTrimmed).toBe(true);
		expect(meta.quotedRepliesTrimmed).toBe(1);
	});

	it('keeps the email envelope headers as text', () => {
		expect(normalize([inboundEmail]).comments[0].text).toContain('Subject: Re: Billing question');
	});

	it('splits a chat transcript into one comment per speaker turn', () => {
		const { comments } = normalize([chatTranscript]);

		expect(comments.map((comment) => comment.speakerName)).toEqual(['Visitor', 'Tony C', 'Tony C']);
	});

	it('attributes transcript turns by speaker rather than by the entry sub-type', () => {
		// The entry is a `note`, whose sub-type says `agent`. Trusting it would label the visitor's
		// own words as agent speech — the exact misattribution the speaker rules exist to prevent.
		const [visitor, staff] = normalize([chatTranscript]).comments;

		expect(visitor).toMatchObject({ speakerRole: 'client', roleBasis: 'speaker:role-label' });
		expect(staff.speakerRole).toBe('agent');
	});

	it('attributes a formatting label to the preceding speaker, not to a new one', () => {
		const stepTurn = normalize([chatTranscript]).comments[2];

		expect(stepTurn.speakerName).toBe('Tony C');
		expect(stepTurn.text).toBe('Open the billing tab.');
	});

	it('marks system notices as system', () => {
		expect(normalize([systemNotice]).comments[0]).toMatchObject({ speakerRole: 'system', roleBasis: 'system-message' });
	});

	it('keeps an image-only turn in the timeline as a placeholder', () => {
		const imageOnly = buildEntry({
			interactionId: 'entry-image',
			subType: ['note'],
			createdDate: 1,
			ownerName: 'Tony C',
			historyComments: '<p><img src="https://example.com/screenshot.png" width="640" height="480"></p>',
		});

		expect(normalize([imageOnly]).comments[0].text).toBe('[image]');
	});

	it('still records the image when the entry text was consumed as a system message', () => {
		const systemPlusImage = buildEntry({
			interactionId: 'entry-system-image',
			subType: ['note'],
			createdDate: 1,
			historyComments: '<p>Auto assigned to Jamie L</p><p><img src="https://example.com/a.png"></p>',
		});

		const texts = normalize([systemPlusImage]).comments.map((comment) => comment.text);
		expect(texts).toContain('[image]');
	});

	it('reads resolutionComments when it holds the only human text', () => {
		const { comments } = normalize([resolutionOnly]);

		expect(comments).toHaveLength(1);
		expect(comments[0].sourceField).toBe('resolutionComments');
		expect(comments[0].text).toBe('Customer confirmed the refund was received.');
	});

	it('does not read taskComments, which repeats the task subject rather than carrying content', () => {
		const { comments, meta } = normalize([taskCommentsOnly]);

		expect(comments).toHaveLength(0);
		expect(meta.warnings[0]).toContain('no historyComments or resolutionComments');
	});

	it('orders comments oldest-first even though the API returns newest-first', () => {
		const { comments } = normalize([systemNotice, inboundEmail, agentNote]);

		const timestamps = comments.map((comment) => comment.createdDate);
		expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
	});

	it('accumulates across pages without needing them all at once', () => {
		const normalizer = new TaskNormalizer('task-1');
		normalizer.addPage([agentNote]);
		normalizer.addPage([inboundEmail]);
		const result = normalizer.build(null);

		expect(result.meta.historyPages).toBe(2);
		expect(result.comments).toHaveLength(2);
	});

	it('counts roles and entries in meta', () => {
		const { meta } = normalize([agentNote, inboundEmail, systemNotice, billingLogRow]);

		expect(meta.historyEntries).toBe(4);
		expect(meta.droppedLogEntries).toBe(1);
		expect(meta.roleCounts).toMatchObject({ agent: 1, client: 1, system: 1 });
	});

	it('takes the task title from the task record when one is supplied', () => {
		const normalizer = new TaskNormalizer('task-1');
		normalizer.addPage([agentNote]);
		const result = normalizer.build({ comments: 'Integration Update', type: 'type-uuid', open: true });

		expect(result.title).toBe('Integration Update');
		expect(result.taskType).toBe('type-uuid');
		expect(result.open).toBe(true);
	});
});
