/**
 * Text cleaning primitives. Ported unchanged from the ds-task-analyzer corpus pipeline, where the
 * measurements in these comments were taken against a 15k-task export.
 */

const NAMED_HTML_ENTITIES: Record<string, string> = {
	amp: '&',
	apos: "'",
	gt: '>',
	lt: '<',
	nbsp: ' ',
	quot: '"',
};

/**
 * A numeric entity that names no character, left as its literal source text.
 *
 * `String.fromCodePoint` throws `RangeError` above U+10FFFF, and the throw propagates all the way
 * out of the normalizer: one `&#x110000;` in one of a task's ~189 comments would otherwise lose the
 * entire task rather than the one entity.
 */
const MAX_CODE_POINT = 0x10ffff;

const fromCodePointOrLiteral = (codePoint: number, match: string) =>
	Number.isNaN(codePoint) || codePoint < 0 || codePoint > MAX_CODE_POINT ? match : String.fromCodePoint(codePoint);

export const decodeHtmlEntities = (input: string) =>
	input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
		if (entity.startsWith('#x')) {
			return fromCodePointOrLiteral(Number.parseInt(entity.slice(2), 16), match);
		}

		if (entity.startsWith('#')) {
			return fromCodePointOrLiteral(Number.parseInt(entity.slice(1), 10), match);
		}

		return NAMED_HTML_ENTITIES[entity] ?? match;
	});

/**
 * Elements whose *body* is markup machinery rather than content. Tag-stripping alone leaves their
 * innards behind, which is how CSS rules, VML declarations and MailChimp merge-tags end up in
 * comment text (`v\:* {behavior:url(#default#VML);}`, `*|MC:SUBJECT|*`).
 */
const MARKUP_ONLY_ELEMENTS = /<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * An email address inside literal angle brackets — `<sender@example.com>`.
 *
 * Older exports HTML-escaped these, so tag-stripping left them intact. Plain-text ones do not, and
 * `/<[^>]+>/` then deletes the address entirely: measured at 7,694 addresses lost across 2,721
 * comments. Re-escaping before the tag pass lets the entity decode restore them afterwards.
 */
const BRACKETED_EMAIL = /<([^<>\s@]+@[^<>\s]+)>/g;

/**
 * A tag, comment or processing instruction — not every pair of angle brackets.
 *
 * `/<[^>]+>/` also deleted arithmetic: "x > 5 but plan cost < 100 per seat and y > 3" came out as
 * "x > 5 but plan cost 3", losing the plan cost on exactly the kind of note that states one.
 * Requiring a letter, `/`, `!` or `?` after the `<` leaves comparisons alone.
 */
const HTML_TAG = /<[/!?]?[a-zA-Z][^>]*>|<!--[\s\S]*?-->/g;

/**
 * Invisible characters that survive naive cleaning and corrupt tokenisation and dedup.
 *
 * Built from an escaped string rather than written as a regex literal: two of these code points
 * (U+2028, U+2029) are line terminators, and pasted raw into a `/.../` literal they end the line
 * and produce an unterminated-regex parse error.
 */
const ZERO_WIDTH_AND_BIDI = new RegExp('[\\u200b\\u200c\\u200d\\u2060\\ufeff\\u00ad\\u200e\\u200f\\u202a-\\u202e]', 'g');

/** Non-breaking and typographic spaces, normalised to a plain space. */
const EXOTIC_SPACES = new RegExp('[\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]', 'g');

/** Object-replacement characters stand in for inline images that were stripped upstream. */
const OBJECT_REPLACEMENT = new RegExp('\\ufffc', 'g');

export const normalizeUnicode = (input: string) =>
	input
		.replace(/\r\n?/g, '\n')
		.replace(ZERO_WIDTH_AND_BIDI, '')
		.replace(OBJECT_REPLACEMENT, ' ')
		.replace(EXOTIC_SPACES, ' ');

export const stripHtmlTags = (input: string) =>
	decodeHtmlEntities(
		normalizeUnicode(input)
			.replace(MARKUP_ONLY_ELEMENTS, ' ')
			.replace(BRACKETED_EMAIL, '&lt;$1&gt;')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/p>/gi, '\n')
			.replace(HTML_TAG, ' ')
	)
		.replace(EXOTIC_SPACES, ' ')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.replace(/[ \t]{2,}/g, ' ')
		.trim();

export const normalizeWhitespace = (input: string) => input.replace(/\s+/g, ' ').trim();
