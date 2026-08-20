/**
 * Trims the quoted reply chain from an email comment.
 *
 * The HTML normalizer removes Gmail's `gmail_quote` containers, but Outlook and several webmail
 * clients quote as plain text with no distinguishing markup, so the previous message survives tag
 * stripping. Left in, the same complaint reappears in every reply of a thread.
 *
 * Detection is substring-based rather than line-based on purpose: a quoted header often ends up
 * mid-line after whitespace normalisation, so line-anchored patterns match nothing on real data.
 * That is also what makes it dangerous — every marker below truncates the comment at its match, so
 * a marker matching a sentence discards everything the client actually asked for. Each pattern
 * therefore requires a date or a clock time, which is what a real quote header has and prose does
 * not: "On the invoice the accountant wrote:" and "Sent: nothing yet. Subject: …" both used to
 * trigger a trim.
 */

/** Header lines the DS email wrapper prepends. The first `From:` is ours, not a quote marker. */
const HEADER_LINE = /^(From|Subject|To|Cc|Bcc):\s/i;

/** A calendar date or a clock time, in the forms mail clients print in an attribution line. */
const DATE_OR_TIME = String.raw`(?:\d{1,2}:\d{2}|\b\d{4}\b|\b\d{1,2}[/.-]\d{1,2}\b)`;

const QUOTE_MARKERS: RegExp[] = [
	/-{2,}\s*Original Message\s*-{2,}/i,
	new RegExp(String.raw`\bOn\s[\s\S]{0,160}?${DATE_OR_TIME}[\s\S]{0,100}?\bwrote:`, 'i'),
	new RegExp(String.raw`\bFrom:\s[\s\S]{0,220}?\b(?:Sent|Date):\s[\s\S]{0,60}?${DATE_OR_TIME}`, 'i'),
	new RegExp(String.raw`\b(?:Sent|Date):\s[\s\S]{0,60}?${DATE_OR_TIME}[\s\S]{0,220}?\bSubject:\s`, 'i'),
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
