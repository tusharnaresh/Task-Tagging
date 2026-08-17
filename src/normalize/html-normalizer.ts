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

const extractParagraphTexts = (html: string) => {
	const paragraphTexts = Array.from(html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi))
		.map((match) => normalizeWhitespace(stripHtmlTags(match[1])))
		.filter(Boolean);

	if (paragraphTexts.length > 0) {
		return paragraphTexts;
	}

	const fallbackText = normalizeWhitespace(stripHtmlTags(html));
	return fallbackText ? [fallbackText] : [];
};

const hasImage = (html: string) => /<img\b[^>]*>/i.test(html);

const isSystemMessageText = (text: string) => {
	const normalizedText = normalizeWhitespace(text).toLowerCase();
	return SYSTEM_MESSAGE_PREFIXES.some((prefix) => normalizedText.startsWith(prefix));
};

const extractSystemMessages = (html: string) => {
	const texts = Array.from(html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi))
		.map((match) => normalizeWhitespace(stripHtmlTags(match[1])))
		.filter(Boolean)
		.filter((text) => isSystemMessageText(text));

	return Array.from(new Set(texts));
};

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

const extractHtmlTextBody = (html: string) => {
	const match = html.match(/<div\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bhtml_text\b[^"']*["'])[^>]*>([\s\S]*?)<\/div>\s*$/i);
	return match ? decodeHtmlEntitiesDeep(match[1]) : null;
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

	if (nextClassIndex < 0) {
		return html.slice(0, startIndex);
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
	const endIndex = html.indexOf('</div>', attributeIndex);
	if (startIndex < 0 || endIndex < 0) {
		return html;
	}

	return `${html.slice(0, startIndex)}${html.slice(endIndex + '</div>'.length)}`;
};

const sanitizeEmailBodyHtml = (html: string) => {
	let sanitized = removeElementRangeBeforeNextClass(html, 'gmail_signature', 'gmail_quote');
	sanitized = removeElementByAttributeValue(sanitized, 'id', 'user-signature-content');
	return removeElementByAttributeValue(sanitized, 'title', 'distsource_custom_threadid');
};

const readInfoValue = (status: InteractionStatus | undefined, title: string) =>
	status?.interactionInfoList?.find((field) => field.title === title)?.value ?? '';

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
			turns.push({ speakerName: 'System', text: systemMessage, isSystemMessage: true, sourceField });
		}

		const labelMatches = Array.from(historyHtml.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi));

		if (labelMatches.length === 0) {
			const strippedText = normalizeWhitespace(stripHtmlTags(historyHtml));

			if (strippedText && !systemMessages.includes(strippedText)) {
				turns.push({
					speakerName: ownerName ?? 'Unknown',
					text: strippedText,
					isSystemMessage: isSystemMessageText(strippedText),
					sourceField,
				});
			} else if (!strippedText && hasImage(historyHtml)) {
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
			const nextSmallIndex = historyHtml.indexOf('<small', blockStart);
			const nextLabelIndex = nextMatch?.index ?? historyHtml.length;
			const candidateEnds = [nextLabelIndex, nextSmallIndex].filter((value) => value >= 0);
			const blockEnd = candidateEnds.length > 0 ? Math.min(...candidateEnds) : historyHtml.length;
			const bodyHtml = historyHtml.slice(blockStart, blockEnd);
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

	const distinctSpeakers = new Set(turns.filter((turn) => !turn.isSystemMessage).map((turn) => turn.speakerName));

	return { turns, ownerName, multiSpeaker: distinctSpeakers.size > 1, warnings };
};
