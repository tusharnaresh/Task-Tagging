/**
 * Trims the quoted reply chain from an email comment.
 *
 * The HTML normalizer already removes Gmail's `gmail_quote` containers, but Outlook and several
 * webmail clients quote as plain text with no distinguishing markup, so the previous message
 * survives tag stripping. Left in, the same complaint reappears in every reply of a thread.
 *
 * Detection is substring-based rather than line-based on purpose: a quoted header often ends up
 * mid-line after whitespace normalisation, so line-anchored patterns match nothing on real data.
 */

/** Header lines the DS email wrapper prepends. The first `From:` is ours, not a quote marker. */
const HEADER_LINE = /^(From|Subject|To|Cc|Bcc):\s/i;

const QUOTE_MARKERS: RegExp[] = [
	/-{2,}\s*Original Message\s*-{2,}/i,
	/\bOn\s[\s\S]{0,140}?\bwrote:/i,
	/\bFrom:\s[\s\S]{0,220}?\b(?:Sent|Date):\s/i,
	/\b(?:Sent|Date):\s[\s\S]{0,220}?\bSubject:\s/i,
];

export interface QuoteTrimResult {
	text: string;
	trimmed: boolean;
	bytesRemoved: number;
}

const findHeaderBlockEnd = (input: string) => {
	let offset = 0;

	while (offset < input.length) {
		const newlineIndex = input.indexOf('\n', offset);
		if (newlineIndex < 0) {
			break;
		}

		const line = input.slice(offset, newlineIndex);
		if (!HEADER_LINE.test(line) && line.trim()) {
			break;
		}

		offset = newlineIndex + 1;
	}

	return offset;
};

export const stripQuotedReplyChain = (input: string): QuoteTrimResult => {
	const unchanged: QuoteTrimResult = { text: input, trimmed: false, bytesRemoved: 0 };
	const bodyStart = findHeaderBlockEnd(input);
	const body = input.slice(bodyStart);

	let earliest = -1;
	for (const pattern of QUOTE_MARKERS) {
		const match = pattern.exec(body);
		if (match && (earliest < 0 || match.index < earliest)) {
			earliest = match.index;
		}
	}

	if (earliest < 0) {
		return unchanged;
	}

	const kept = input.slice(0, bodyStart + earliest).trimEnd();

	// A marker at the very start of the body means the comment is nothing but quoted material.
	// Keeping the original beats emitting a comment that is only wrapper headers.
	if (!kept.slice(bodyStart).trim()) {
		return unchanged;
	}

	return { text: kept, trimmed: true, bytesRemoved: input.length - kept.length };
};
