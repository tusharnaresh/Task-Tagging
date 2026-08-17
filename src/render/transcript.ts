import { resolveTaskTypeName } from '../constants/task-types.ts';
import type { NormalizedComment, NormalizedTask } from '../types.ts';

/**
 * Renders a normalized task as a plain-text transcript for an LLM prompt.
 *
 * The JSON output is deliberately lossless — it carries provenance (`commentId`,
 * `sourceInteractionId`, `roleBasis`, `quotedReplyTrimmed`) so any labelling decision can be
 * audited back to the source entry. None of that helps a model decide what a task is ABOUT, and
 * measured on a real 189-comment task it cost more than the conversation itself: 88 KB of keys,
 * braces and UUIDs wrapped around 54 KB of text.
 *
 * This renderer keeps the content and drops the scaffolding. Same task: 142 KB → 38.5 KB,
 * ~36k tokens → ~9.9k.
 *
 * Everything removed here is removed at RENDER time, not during normalization, so the audit trail
 * survives in the JSON form.
 */

/**
 * Envelope header lines. Note the optional space before the colon: DS emits both `From:` and
 * `From :`, and anchoring on the former silently leaves half the headers in place.
 */
const ENVELOPE_HEADER = /^(?:From|Subject|To|Cc|Bcc)\s*:/i;

/**
 * Internal workflow shorthand agents prepend to their notes.
 *
 * Two distinct cases, and conflating them loses content. Some notes are ONLY this — "AR Received",
 * "Sending to Derek" — and carry nothing about the customer's problem. But 45 of 58 on the
 * reference task open with the same shorthand and then continue into the most substantive content
 * on the task ("- AR Received - Reviewing test webhook in zap …"). So the phrases are stripped and
 * whatever remains is kept; a comment is dropped only when nothing survives.
 *
 * The byte saving is minor. The point is that "AR Received" appears ~30 times in one task, and a
 * tagger reading that repetition can drift toward acknowledgement/handoff themes on a task whose
 * actual subject is an API integration.
 */
const ROUTING_CHATTER =
	/(?:^|\n)\s*-?\s*(?:ar\s*(?:received|recieved|receied|rec'?d)|sent? to \w+|sending (?:back )?to \w+|chatt?ed(?: and assigned(?: the task)?(?: to \w+)?)?|assigned to \w+|pulled from inbox|pc \w+|per the pinned note|taking (?:a )?(?:scheduled )?break)\b[\s.,:-]*/gi;

export interface TranscriptOptions {
	/**
	 * Drop email envelope headers. They repeat `From` / `Subject` / `To` on every message: on the
	 * reference task, 59 emails shared ONE subject line, and in 59/59 cases the `From:` value was
	 * already carried by `speakerName`. The subject is emitted once in the header instead.
	 */
	stripEnvelopeHeaders?: boolean;
	stripRoutingChatter?: boolean;
	/** Drop a comment whose text repeats one already emitted. */
	dedupe?: boolean;
}

const DEFAULTS: Required<TranscriptOptions> = {
	stripEnvelopeHeaders: true,
	stripRoutingChatter: true,
	dedupe: true,
};

export interface TranscriptResult {
	text: string;
	commentsRendered: number;
	commentsDropped: number;
}

const cleanCommentText = (comment: NormalizedComment, options: Required<TranscriptOptions>) => {
	let text = comment.text;

	if (options.stripEnvelopeHeaders) {
		text = text
			.split('\n')
			.filter((line) => !ENVELOPE_HEADER.test(line.trim()))
			.join('\n');
	}

	if (options.stripRoutingChatter) {
		text = text.replace(ROUTING_CHATTER, ' ');
	}

	return text.replace(/\s+/g, ' ').trim();
};

/** The one subject line shared by a thread, worth stating once rather than per message. */
const extractSubject = (comments: NormalizedComment[]) => {
	for (const comment of comments) {
		const match = comment.text.match(/^Subject\s*:\s*(.+)$/im);
		if (match?.[1]?.trim()) {
			return match[1].trim();
		}
	}

	return null;
};

const formatTimestamp = (createdDate: number) => (createdDate ? new Date(createdDate).toISOString().slice(0, 16).replace('T', ' ') : 'unknown');

export const renderTranscript = (task: NormalizedTask, options: TranscriptOptions = {}): TranscriptResult => {
	const resolved = { ...DEFAULTS, ...options };
	const seen = new Set<string>();
	const lines: string[] = [];
	let commentsDropped = 0;

	for (const comment of task.comments) {
		const text = cleanCommentText(comment, resolved);

		// Nothing survived the cleanup — the comment was pure routing shorthand or pure envelope.
		if (!text) {
			commentsDropped += 1;
			continue;
		}

		if (resolved.dedupe) {
			const key = text.toLowerCase();
			if (seen.has(key)) {
				commentsDropped += 1;
				continue;
			}
			seen.add(key);
		}

		lines.push(`[${formatTimestamp(comment.createdDate)}] ${comment.speakerRole}/${comment.subType ?? 'unknown'} ${comment.speakerName}: ${text}`);
	}

	const subject = extractSubject(task.comments);
	// The raw type is a UUID and tells a model nothing. The resolved name — "Cancel Request",
	// "Retention", "Integrations Request" — is the strongest single prior about what the task is.
	const taskTypeName = resolveTaskTypeName(task.taskType);
	const header = [
		`TASK: ${task.title ?? '(untitled)'}`,
		subject && subject !== task.title ? `EMAIL SUBJECT: ${subject}` : null,
		taskTypeName ?? task.taskType ? `TASK TYPE: ${taskTypeName ?? task.taskType}` : null,
		typeof task.open === 'boolean' ? `STATUS: ${task.open ? 'open' : 'closed'}` : null,
		`CONVERSATION: ${lines.length} messages`,
	].filter((line): line is string => line !== null);

	return {
		text: `${header.join('\n')}\n\n${lines.join('\n')}\n`,
		commentsRendered: lines.length,
		commentsDropped,
	};
};
