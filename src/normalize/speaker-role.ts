import type { RoleBasis, SpeakerRole } from '../types.ts';
import { resolveAuthorSideFromSubType } from './master-type.ts';
import { classifySpeaker } from './speaker-classifier.ts';

export interface ResolvedRole {
	role: SpeakerRole;
	basis: RoleBasis;
}

/**
 * Decides who authored a turn, strongest signal first.
 *
 * 1. System notices are neither side.
 * 2. For a multi-speaker entry the sub-type cannot attribute anything: a chat transcript is stored
 *    as a single `note` entry, so trusting the sub-type would label the client's own words `agent`.
 *    Speaker-name shape decides instead — the rules in `speaker-classifier.ts` were validated
 *    against labelled data.
 * 3. Otherwise the entry's sub-type decides, which covers single-author entries exactly.
 * 4. Anything else stays `unknown` rather than defaulting to `agent`, which would quietly convert
 *    unattributable text into agent speech.
 */
export const resolveRole = ({
	speakerName,
	isSystemMessage,
	subType,
	multiSpeakerEntry,
	staffDirectory,
}: {
	speakerName: string;
	isSystemMessage: boolean;
	subType: string | null;
	multiSpeakerEntry: boolean;
	/** Display names seen as `ownerName` on entries, i.e. known internal staff. */
	staffDirectory?: ReadonlySet<string>;
}): ResolvedRole => {
	if (isSystemMessage) {
		return { role: 'system', basis: 'system-message' };
	}

	if (multiSpeakerEntry) {
		const verdict = classifySpeaker({ speaker: speakerName, staffDirectory: staffDirectory ?? new Set() });

		if (verdict.side === 'staff') {
			return { role: 'agent', basis: `speaker:${verdict.rule}` };
		}

		if (verdict.side === 'client') {
			return { role: 'client', basis: `speaker:${verdict.rule}` };
		}

		return { role: 'unknown', basis: `speaker:${verdict.rule}` };
	}

	const subTypeSide = resolveAuthorSideFromSubType(subType);
	if (subTypeSide !== 'unknown') {
		return { role: subTypeSide, basis: 'sub-type' };
	}

	return { role: 'unknown', basis: 'unresolved' };
};
