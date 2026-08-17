import type { InteractionEntry } from '../src/types.ts';

/**
 * Synthetic history entries shaped like the live `/v1/Interaction` payload.
 *
 * These are hand-written on purpose. Real captures carry live customer conversations, so they are
 * never committed; the structure here mirrors what the API returns (verified against task
 * 73a6ff24 on 2026-08-17) while the content is invented.
 */
export const buildEntry = ({
	interactionId,
	subType,
	createdDate,
	historyComments,
	resolutionComments,
	taskComments,
	ownerName,
	isDeleted = false,
}: {
	interactionId: string;
	subType?: string | string[];
	createdDate: number;
	historyComments?: string;
	resolutionComments?: string;
	taskComments?: string;
	ownerName?: string;
	isDeleted?: boolean;
}): InteractionEntry => ({
	interactionId,
	accountId: 'SEN42',
	interactionStatusList: [
		{
			interactionId,
			createdDate,
			isDeleted,
			type: { id: 'c3595da3-0494-4e08-85f8-6d88ce98c715', value: 'Task' },
			customProperty: subType === undefined ? {} : { subType, linkedTask: ['task-1'] },
			interactionInfoList: [
				...(historyComments === undefined ? [] : [{ title: 'historyComments', value: historyComments }]),
				...(resolutionComments === undefined ? [] : [{ title: 'resolutionComments', value: resolutionComments }]),
				...(taskComments === undefined ? [] : [{ title: 'taskComments', value: taskComments }]),
				...(ownerName === undefined ? [] : [{ title: 'ownerName', value: ownerName }]),
			],
		},
	],
});

/** A plain agent-authored note. */
export const agentNote = buildEntry({
	interactionId: 'entry-note',
	subType: ['note'],
	createdDate: 1_780_000_001_000,
	ownerName: 'Tony C',
	historyComments: '<p>Called the customer about the failed payment. Left a voicemail.</p>',
	taskComments: 'Integration Update',
});

/** An inbound email in the DS email wrapper, with a quoted reply chain below the body. */
export const inboundEmail = buildEntry({
	interactionId: 'entry-inbound',
	subType: ['inboundemail'],
	createdDate: 1_780_000_002_000,
	ownerName: 'Tony C',
	historyComments: [
		'<span class="history_from">Dana Reyes &lt;dana@example.com&gt;</span>',
		'<span class="history_subject">Re: Billing question</span>',
		'<span class="history_to">support@example.com</span>',
		'<div class="html_text"><p>My card was charged twice this month.</p>',
		'<p>On Mon, Jun 2, 2025 at 9:14 AM Support wrote: previous message body here</p></div>',
	].join(''),
});

/** A chat transcript: one entry, multiple `<label>` speaker turns. */
export const chatTranscript = buildEntry({
	interactionId: 'entry-transcript',
	subType: ['note'],
	createdDate: 1_780_000_003_000,
	ownerName: 'Tony C',
	historyComments: [
		'<label>Visitor</label><p>Is anyone available to help?</p>',
		'<label>Tony C</label><p>Yes, how can I help today?</p>',
		'<label>Step 2:</label><p>Open the billing tab.</p>',
	].join(''),
});

/** A system notice; neither side authored it. */
export const systemNotice = buildEntry({
	interactionId: 'entry-system',
	subType: ['note'],
	createdDate: 1_780_000_004_000,
	historyComments: '<p>This conversation has been overflowed and auto assigned to Jamie L</p>',
});

/** An audit row. On live data these live on /v1/activity and should never reach us. */
export const billingLogRow = buildEntry({
	interactionId: 'entry-log',
	subType: ['Billing'],
	createdDate: 1_780_000_005_000,
	historyComments: '<p>Plan charged $49.00</p>',
});

/** Only a `taskComments` value — deliberately not read, so this yields nothing. */
export const taskCommentsOnly = buildEntry({
	interactionId: 'entry-taskcomments-only',
	subType: ['note'],
	createdDate: 1_780_000_006_000,
	taskComments: 'Integration Update',
});

/** A resolution-only disposition: the human text lives in `resolutionComments`. */
export const resolutionOnly = buildEntry({
	interactionId: 'entry-resolution',
	subType: ['contacted'],
	createdDate: 1_780_000_007_000,
	ownerName: 'Tony C',
	resolutionComments: '<p>Customer confirmed the refund was received.</p>',
});
