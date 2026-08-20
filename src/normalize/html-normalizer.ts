import type { HistoryTextField, InteractionEntry, InteractionStatus } from '../types.ts';
import { decodeHtmlEntities, normalizeWhitespace, stripHtmlTags } from './text.ts';

/**
 * Turns one history entry's `historyComments` / `resolutionComments` HTML into speaker-attributed
 * plain-text turns.
 *
 * Ported from ds-task-analyzer's `history/html-normalizer.ts` with contact resolution removed. In
 * the original, a speaker name was matched against the task's linked contacts to claim
 * `customer`; with no contacts resolved that branch was unreachable and every non-system speaker
 * fell through to `unknown`. Rather than carry an always-empty contact list through the call graph,
 * this module emits the speaker NAME and leaves the client/agent decision to `speaker-role.ts`,
 * which decides from sub-type and speaker-name shape. Behaviour is identical to running the
 * original with an empty contact set.
 *
 * Images are not carried. A turn whose only content was an image keeps its place in the timeline
 * as `[image]` so the conversation structure survives, but nothing is downloaded or analysed.
 */

const SYSTEM_MESSAGE_PREFIXES = ['this conversation has been overflowed and auto assigned to', 'auto assigned to', 'system note:'];

/**
 * `<label>` marks a speaker turn in a chat transcript, but agents also use it to format numbered
 * walkthroughs inside their own message ("Step 1:", "Step 2:"). Those are not speakers: treating
 * them as such invents speaker names that can never be attributed, and inflates a single-author
 * entry into an apparently multi-speaker one.
 */
const NON_SPEAKER_LABEL = /^(?:step|steps|option|options|note|notes|q|a|answer|question|tip|example|part|phase)\b[\s.:#-]*\d*[\s.:)-]*$/i;

const isNonSpeakerLabel = (label: string) => !label || NON_SPEAKER_LABEL.test(label.trim());

/**
 * Repairs speaker names whose first character is missing in the SOURCE data.
 *
 * The upstream system emits the first `<label>` of a transcript with its leading character dropped
 * — `>ackie Zbignewich</label>` — while later labels in the same entry carry the full
 * `Jackie Zbignewich`. Since the full form is present in the same entry, a truncated label can be
 * repaired by matching it as a one-character-shorter suffix of another label. Requiring an exact
 * length difference of one keeps this from merging genuinely different people.
 */
const buildTruncatedNameRepair = (labels: string[]) => {
	const candidates = Array.from(new Set(labels.filter(Boolean)));
	const repairs = new Map<string, string>();

	for (const short of candidates) {
		if (short.length < 3) {
			continue;
		}

		const full = candidates.find((other) => other.length === short.length + 1 && other.endsWith(short));
		if (full) {
			repairs.set(short, full);
		}
	}

	return (label: string) => repairs.get(label) ?? label;
};

/** One extracted turn, before role resolution. */
export interface ExtractedTurn {
	speakerName: string;
	text: string;
	isSystemMessage: boolean;
	sourceField: HistoryTextField;
}

export interface ExtractEntryResult {
	turns: ExtractedTurn[];
	/** Display name of the staff member who logged the entry, when present. */
	ownerName: string | null;
	/** True when the entry yielded more than one distinct speaker — i.e. a transcript. */
	multiSpeaker: boolean;
	warnings: string[];
}

const IMAGE_PLACEHOLDER = '[image]';

/** Speaker name given to a notice the system emitted, as opposed to either side of the conversation. */
const SYSTEM_SPEAKER = 'System';

/**
 * Closing tags that end a block of text.
 *
 * Splitting on these rather than matching `<p>` alone: the extractor used to take paragraphs and
 * fall back to the whole block only when there were none at all, so a `<div>` or `<li>` sitting
 * beside a paragraph was dropped without a warning — including, on one shape, the sentence that
 * stated the subject. Splitting means a nested `<p>` inside a `<div>` still yields one text, since
 * the outer close has nothing left before it.
 *
 * `<br>` is deliberately absent: it breaks a line within one message, not between two.
 */
const BLOCK_END = /<\/(?:p|div|li|td|th|tr|h[1-6]|blockquote|section|article|pre)\s*>/gi;

const extractParagraphTexts = (html: string) => {
	const texts = html
		.split(BLOCK_END)
		.map((segment) => normalizeWhitespace(stripHtmlTags(segment)))
		.filter(Boolean);

	return texts;
};

const hasImage = (html: string) => /<img\b[^>]*>/i.test(html);

/**
 * `<small>` carries the turn's timestamp, not its content.
 *
 * It used to terminate the speaker's block instead. A timestamp printed between two paragraphs then
 * dropped everything after it, and a timestamp printed before the text dropped the turn entirely —
 * in both cases silently. The block now runs to the next speaker and the timestamp is removed from
 * it; a second turn from the same speaker merges into the first, which loses no text.
 */
const stripTimestamps = (html: string) => html.replace(/<small\b[^>]*>[\s\S]*?<\/small\s*>/gi, ' ');

const isSystemMessageText = (text: string) => {
	const normalizedText = normalizeWhitespace(text).toLowerCase();
	return SYSTEM_MESSAGE_PREFIXES.some((prefix) => normalizedText.startsWith(prefix));
};

const extractSystemMessages = (html: string) => Array.from(new Set(extractParagraphTexts(html).filter((text) => isSystemMessageText(text))));

const extractClassText = (html: string, className: string) => {
	const classPattern = new RegExp(`<span\\b(?=[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${className}\\b[^"']*["'])[^>]*>([\\s\\S]*?)<\\/span>`, 'i');
	const match = html.match(classPattern);
	return match ? normalizeWhitespace(stripHtmlTags(match[1])) : null;
};

const extractDisplayNameFromAddress = (input: string | null) => {
	if (!input) {
		return null;
	}

	const withoutEmail = input.replace(/<[^>]+>/g, '').trim();
	return normalizeWhitespace(withoutEmail) || input;
};

const decodeHtmlEntitiesDeep = (input: string) => {
	let decoded = input;
	for (let index = 0; index < 3; index += 1) {
		const nextDecoded = decodeHtmlEntities(decoded);
		if (nextDecoded === decoded) {
			break;
		}
		decoded = nextDecoded;
	}
	return decoded;
};

/**
 * End offset (exclusive) of the element whose opening tag starts at `startIndex`, honouring nesting
 * of the same tag name. Returns null when the element is never closed.
 *
 * The three callers below used to approximate this with "the next `</div>`" or "the end of the
 * document". Both approximations delete the message body on ordinary nested markup.
 */
const findElementEnd = (html: string, startIndex: number): number | null => {
	const openingTag = /^<([a-z][a-z0-9]*)\b[^>]*>/i.exec(html.slice(startIndex));
	if (!openingTag) {
		return null;
	}

	if (openingTag[0].endsWith('/>')) {
		return startIndex + openingTag[0].length;
	}

	const tagName = openingTag[1];
	const boundary = new RegExp(`<${tagName}\\b[^>]*>|</${tagName}\\s*>`, 'gi');
	boundary.lastIndex = startIndex + openingTag[0].length;

	let depth = 1;
	for (let match = boundary.exec(html); match; match = boundary.exec(html)) {
		depth += match[0].startsWith('</') ? -1 : 1;
		if (depth === 0) {
			return match.index + match[0].length;
		}
	}

	return null;
};

const extractHtmlTextBody = (html: string) => {
	// Anchoring on `</div>\s*$` meant one trailing `<br>` after the wrapper dropped the whole entry
	// to the generic path, where the speaker becomes whoever logged it rather than who sent it.
	const opening = /<div\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bhtml_text\b[^"']*["'])[^>]*>/i.exec(html);
	if (!opening) {
		return null;
	}

	const startIndex = opening.index;
	const endIndex = findElementEnd(html, startIndex);
	if (endIndex === null) {
		return null;
	}

	const inner = html.slice(startIndex + opening[0].length, endIndex - '</div>'.length);
	return decodeHtmlEntitiesDeep(inner);
};

const removeElementRangeBeforeNextClass = (html: string, className: string, nextClassName: string) => {
	const classIndex = html.search(new RegExp(`\\bclass\\s*=\\s*["'][^"']*\\b${className}\\b`, 'i'));
	if (classIndex < 0) {
		return html;
	}

	const nextClassIndex = html.slice(classIndex).search(new RegExp(`\\bclass\\s*=\\s*["'][^"']*\\b${nextClassName}\\b`, 'i'));
	const startIndex = html.lastIndexOf('<', classIndex);
	if (startIndex < 0) {
		return html;
	}

	// No following quote container: remove the signature element itself. Slicing to end of document
	// here discarded every below-signature afterthought ("PS: also cancel the second line").
	if (nextClassIndex < 0) {
		const endIndex = findElementEnd(html, startIndex);
		return endIndex === null ? html : `${html.slice(0, startIndex)}${html.slice(endIndex)}`;
	}

	const absoluteNextClassIndex = classIndex + nextClassIndex;
	const nextStartIndex = html.lastIndexOf('<', absoluteNextClassIndex);
	return `${html.slice(0, startIndex)}${html.slice(nextStartIndex >= 0 ? nextStartIndex : absoluteNextClassIndex)}`;
};

const removeElementByAttributeValue = (html: string, attributeName: string, value: string) => {
	const attributeIndex = html.search(new RegExp(`\\b${attributeName}\\s*=\\s*["']${value}["']`, 'i'));
	if (attributeIndex < 0) {
		return html;
	}

	const startIndex = html.lastIndexOf('<', attributeIndex);
	if (startIndex < 0) {
		return html;
	}

	// The end of *this* element. Taking the next `</div>` instead meant a marker nested inside a
	// wrapper div deleted the body that shared that wrapper.
	const endIndex = findElementEnd(html, startIndex);
	return endIndex === null ? html : `${html.slice(0, startIndex)}${html.slice(endIndex)}`;
};

/**
 * Removes an element by class name, wherever it sits. Used for the Gmail quote container, which
 * `quoted-reply.ts` documented as already handled here but which nothing actually removed — so a
 * thread whose attribution line the text-level markers do not recognise repeated in every reply.
 */
const removeElementByClass = (html: string, className: string) => {
	const classIndex = html.search(new RegExp(`\\bclass\\s*=\\s*["'][^"']*\\b${className}\\b`, 'i'));
	if (classIndex < 0) {
		return html;
	}

	const startIndex = html.lastIndexOf('<', classIndex);
	if (startIndex < 0) {
		return html;
	}

	const endIndex = findElementEnd(html, startIndex);
	return endIndex === null ? html : `${html.slice(0, startIndex)}${html.slice(endIndex)}`;
};

const sanitizeEmailBodyHtml = (html: string) => {
	let sanitized = removeElementRangeBeforeNextClass(html, 'gmail_signature', 'gmail_quote');
	sanitized = removeElementByClass(sanitized, 'gmail_quote');
	sanitized = removeElementByAttributeValue(sanitized, 'id', 'user-signature-content');
	return removeElementByAttributeValue(sanitized, 'title', 'distsource_custom_threadid');
};

const readInfoValue = (status: InteractionStatus | undefined, title: string) =>
	status?.interactionInfoList?.find((field) => field.title === title)?.value ?? '';

/**
 * Fields and statuses this entry carries beyond the first of each, which the extractor does not
 * read. Whether DS ever returns them is unverifiable offline; counting them means a shape that
 * silently loses text would show up in `meta` rather than not at all.
 */
export const countUnreadDuplicates = (historyEntry: InteractionEntry) => {
	const statuses = historyEntry.interactionStatusList ?? [];
	const fields = statuses[0]?.interactionInfoList ?? [];
	const readTitles = ['historyComments', 'resolutionComments', 'ownerName'];
	const seen = new Set<string>();
	let unreadFields = 0;

	for (const field of fields) {
		if (!readTitles.includes(field.title)) {
			continue;
		}
		if (seen.has(field.title)) {
			unreadFields += 1;
		}
		seen.add(field.title);
	}

	return { unreadStatuses: Math.max(0, statuses.length - 1), unreadFields };
};

/**
 * `historyComments` is the documented activity text, but a share of task history — call
 * dispositions in particular — carries its only human-authored text in `resolutionComments`. Both
 * are emitted, except when `historyComments` already embeds the resolution text (the app renders it
 * inline in some paths, and assigns both fields the same value in another).
 *
 * `taskComments` is deliberately NOT read. It holds the task's own subject line repeated on each
 * entry, not per-comment content; measured on a 189-entry task, 60 entries carried it and ZERO had
 * it as their only text, so reading it would duplicate the title rather than recover anything.
 */
const collectCommentSources = (status: InteractionStatus | undefined): Array<{ field: HistoryTextField; html: string }> => {
	const historyHtml = readInfoValue(status, 'historyComments');
	const resolutionHtml = readInfoValue(status, 'resolutionComments');
	const sources: Array<{ field: HistoryTextField; html: string }> = [];

	if (historyHtml.trim()) {
		sources.push({ field: 'historyComments', html: historyHtml });
	}

	if (resolutionHtml.trim()) {
		const historyText = normalizeWhitespace(stripHtmlTags(historyHtml)).toLowerCase();
		const resolutionText = normalizeWhitespace(stripHtmlTags(resolutionHtml)).toLowerCase();
		const alreadyIncluded = Boolean(resolutionText) && Boolean(historyText) && historyText.includes(resolutionText);

		if (!alreadyIncluded) {
			sources.push({ field: 'resolutionComments', html: resolutionHtml });
		}
	}

	return sources;
};

/** The DS email wrapper: a `history_from` / `history_subject` / `history_to` header plus a body. */
const extractDsEmailTurn = (historyHtml: string, sourceField: HistoryTextField): ExtractedTurn | null => {
	const from = extractClassText(historyHtml, 'history_from');
	const subject = extractClassText(historyHtml, 'history_subject');
	const to = extractClassText(historyHtml, 'history_to');
	const bodyHtml = extractHtmlTextBody(historyHtml);

	if (!bodyHtml || (!from && !subject && !to)) {
		return null;
	}

	const bodyText = normalizeWhitespace(stripHtmlTags(sanitizeEmailBodyHtml(bodyHtml)));
	const headerLines = [from ? `From: ${from}` : null, subject ? `Subject: ${subject}` : null, to ? `To: ${to}` : null].filter(
		(line): line is string => line !== null
	);
	const text = [...headerLines, bodyText].filter(Boolean).join('\n');

	if (!text) {
		return null;
	}

	return {
		speakerName: extractDisplayNameFromAddress(from) ?? 'Unknown',
		text,
		isSystemMessage: false,
		sourceField,
	};
};

export const extractTurnsFromEntry = (historyEntry: InteractionEntry): ExtractEntryResult => {
	const status = historyEntry.interactionStatusList?.[0];
	const sourceInteractionId = historyEntry.interactionId;
	const ownerName = readInfoValue(status, 'ownerName') || null;
	const turns: ExtractedTurn[] = [];
	const warnings: string[] = [];

	const commentSources = collectCommentSources(status);
	if (commentSources.length === 0) {
		warnings.push(`Entry ${sourceInteractionId} has no historyComments or resolutionComments text`);
		return { turns, ownerName, multiSpeaker: false, warnings };
	}

	for (const { field: sourceField, html: historyHtml } of commentSources) {
		const emailTurn = extractDsEmailTurn(historyHtml, sourceField);
		if (emailTurn) {
			turns.push(emailTurn);
			continue;
		}

		const systemMessages = extractSystemMessages(historyHtml);
		for (const systemMessage of systemMessages) {
			turns.push({ speakerName: SYSTEM_SPEAKER, text: systemMessage, isSystemMessage: true, sourceField });
		}

		const labelMatches = Array.from(historyHtml.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi));

		if (labelMatches.length === 0) {
			// Whatever was already emitted as a notice is dropped here. Leaving it in meant the notice
			// appeared twice, and the combined text then began with it — so `isSystemMessageText`
			// flagged the whole turn as system, and the only turn carrying the subject was the one the
			// prompt is told to discount.
			const remainingTexts = extractParagraphTexts(stripTimestamps(historyHtml)).filter((text) => !systemMessages.includes(text));
			const strippedText = remainingTexts.join(' ');

			if (strippedText) {
				turns.push({
					speakerName: ownerName ?? 'Unknown',
					text: strippedText,
					isSystemMessage: isSystemMessageText(strippedText),
					sourceField,
				});
			} else if (hasImage(historyHtml)) {
				// Reached whenever the text branch did not fire — including when the entry's only text
				// was already emitted as a system message. Mirrors the original's `imageRefs.length > 0`
				// fallback so an image-only turn keeps its slot in the timeline either way.
				turns.push({ speakerName: ownerName ?? 'Unknown', text: IMAGE_PLACEHOLDER, isSystemMessage: false, sourceField });
			}

			continue;
		}

		// Carried across labels so a formatting label ("Step 2:") keeps the text attributed to
		// whoever was actually speaking, instead of becoming a speaker of its own.
		let lastSpeakerName: string | null = null;
		const repairName = buildTruncatedNameRepair(labelMatches.map((match) => normalizeWhitespace(stripHtmlTags(match[1]))));

		for (let index = 0; index < labelMatches.length; index += 1) {
			const currentMatch = labelMatches[index];
			const nextMatch = labelMatches[index + 1];
			const labelText = repairName(normalizeWhitespace(stripHtmlTags(currentMatch[1])));
			const speakerName = isNonSpeakerLabel(labelText) ? lastSpeakerName ?? ownerName ?? 'Unknown' : labelText;

			if (!isNonSpeakerLabel(labelText)) {
				lastSpeakerName = labelText;
			}

			const blockStart = (currentMatch.index ?? 0) + currentMatch[0].length;
			const blockEnd = nextMatch?.index ?? historyHtml.length;
			const bodyHtml = stripTimestamps(historyHtml.slice(blockStart, blockEnd));
			const paragraphTexts = extractParagraphTexts(bodyHtml);

			if (paragraphTexts.length === 0) {
				if (hasImage(bodyHtml)) {
					turns.push({ speakerName, text: IMAGE_PLACEHOLDER, isSystemMessage: false, sourceField });
				} else {
					warnings.push(`Entry ${sourceInteractionId} for speaker ${speakerName} did not contain extractable text`);
				}
				continue;
			}

			for (const paragraphText of paragraphTexts) {
				turns.push({
					speakerName,
					text: paragraphText,
					isSystemMessage: isSystemMessageText(paragraphText),
					sourceField,
				});
			}
		}
	}

	// Excluding every system-flagged turn collapsed a two-speaker chat to one speaker whenever one
	// side's turn opened like a notice, which handed attribution back to the entry sub-type — and a
	// chat is stored as a single `note`, so the client's own words came out labelled `agent`. Only
	// the synthetic notice speaker is excluded.
	const distinctSpeakers = new Set(turns.filter((turn) => turn.speakerName !== SYSTEM_SPEAKER).map((turn) => turn.speakerName));

	return { turns, ownerName, multiSpeaker: distinctSpeakers.size > 1, warnings };
};
