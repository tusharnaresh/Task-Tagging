/**
 * Classifies a chat-transcript speaker as internal staff or client, with no API calls.
 *
 * Rules and thresholds come from an evidence review over a full 48,319-task export. Ground truth
 * was manufactured from the data itself: a transcript speaker matching the same event's `ownerName`
 * is staff; in a two-speaker transcript where exactly one speaker matched `ownerName`, the other is
 * the client. That produced 97 known-staff and 1,079 known-client names with no overlap.
 *
 * Measured on that labelled set, comment-weighted: staff precision 99.87%, client precision 100%.
 *
 * Two rules that look attractive were tested and rejected:
 *
 * - **Speaker breadth** (appears in N distinct tasks → staff). Client false-positive rate 12.8% at
 *   N=5. Repeat office-manager contacts break it: one client appears in 26 distinct tasks.
 * - **Fuzzy `ownerName` matching** on (first name, last initial). 191 client comments collided with
 *   different staff people — `April Powell` vs `April Pursell`. Exact matching yields none.
 */

export type SpeakerSide = 'staff' | 'client' | 'non-speaker';

export type SpeakerRule = 'non-speaker-label' | 'role-label' | 'activity-marker' | 'name-shape' | 'staff-directory' | 'client-by-elimination';

export interface SpeakerVerdict {
	side: SpeakerSide;
	rule: SpeakerRule;
}

/** Formatting and call-form labels that are not speakers at all. */
const NON_SPEAKER_LABEL = /^(?:step|option|part|phase)\s*\d*\s*[:.)\-]?$/i;

const FORM_FIELD_LABEL =
	/^(?:account goal|phone|first name|last name|message(?:\s*\(if any\))?|brief description|appointment (?:date|time)|finish call field|direct url to booking page|cross streets|fax|toll free|who we are|contact|address|add step)$/i;

const CLIENT_ROLE_LABEL = /^(?:visitor|customer|caller|guest|client)$/i;
const STAFF_ROLE_LABEL = /^(?:agent|operator|receptionist)$/i;

/** Rows ending in "took a note" are a task link rather than a spoken turn, and are always staff. */
const ACTIVITY_MARKER = /\btook a note$/i;

/**
 * The internal display-name convention: given name plus a single last initial ("Tony C").
 * Measured false-positive rate against known clients: 0.2% of client comments.
 */
const STAFF_NAME_SHAPE = /^[A-Z][A-Za-zÀ-ÿ'’-]+\s[A-Z]\.?$/;

/** Leading "Today " is an export artifact, not part of the name. */
const TODAY_PREFIX = /^today\s+(?=\S)/i;

export const cleanSpeakerLabel = (raw: string) => raw.replace(TODAY_PREFIX, '').trim();

/** Directory keys: lowercased, parentheticals dropped, punctuation stripped, spaces collapsed. */
export const normalizeDirectoryKey = (name: string) =>
	name
		.toLowerCase()
		.replace(/\([^)]*\)/g, ' ')
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

export const classifySpeaker = ({ speaker, staffDirectory }: { speaker: string; staffDirectory: ReadonlySet<string> }): SpeakerVerdict => {
	const label = cleanSpeakerLabel(speaker);

	if (!label || NON_SPEAKER_LABEL.test(label) || FORM_FIELD_LABEL.test(label)) {
		return { side: 'non-speaker', rule: 'non-speaker-label' };
	}

	if (CLIENT_ROLE_LABEL.test(label)) {
		return { side: 'client', rule: 'role-label' };
	}

	if (STAFF_ROLE_LABEL.test(label)) {
		return { side: 'staff', rule: 'role-label' };
	}

	if (ACTIVITY_MARKER.test(label)) {
		return { side: 'staff', rule: 'activity-marker' };
	}

	if (STAFF_NAME_SHAPE.test(label)) {
		return { side: 'staff', rule: 'name-shape' };
	}

	// Catches staff who break the convention — mononyms, and the full names that appear in
	// "conversation has been overflowed and auto assigned to" notices. Exact match only.
	if (staffDirectory.has(normalizeDirectoryKey(label))) {
		return { side: 'staff', rule: 'staff-directory' };
	}

	return { side: 'client', rule: 'client-by-elimination' };
};
