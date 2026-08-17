import type { InteractionEntry } from '../types.ts';

/**
 * Mirrors `createSubTypeMasterTypeMap()` in the DS app
 * (`app/src/main/java/com/adaptavant/crm/dto/History.java`).
 *
 * `comment` entries are human-authored activity. `log` entries are system audit rows — billing
 * adjustments, plan changes, card updates — which read like content but carry no communication.
 *
 * On live data fetched from `/v1/Interaction` this should drop nothing: DS routes `log` sub-types
 * to a different upstream collection (`/v1/activity`), so audit rows never appear here in the first
 * place. The partition is kept as a guard — if it ever drops a row, the endpoint assumption broke.
 */
const SUBTYPE_TO_MASTER_TYPE: Record<string, 'comment' | 'log'> = {
	'Account-Edits': 'log',
	Billing: 'log',
	CCUpdate: 'log',
	PYMT: 'log',
	PlanChange: 'log',
	log: 'log',
	complete: 'comment',
	contacted: 'comment',
	'not contacted': 'comment',
	evaluation: 'comment',
	inboundemail: 'comment',
	outboundemail: 'comment',
	note: 'comment',
	sent: 'comment',
	sms: 'comment',
	feedback: 'comment',
};

export type MasterType = 'comment' | 'log' | 'unknown';

export type AuthorSide = 'client' | 'agent' | 'unknown';

/**
 * Who authored a history entry, inferred from its sub-type alone — no extra call needed.
 *
 * `ownerName` on an entry is the staff member who *logged* it, not necessarily who said it. For
 * agent-side sub-types those are the same person. For `inboundemail` the author is the client and
 * their identity sits in the message's `From:` header instead.
 *
 * `sms` is deliberately left unknown: DS uses it for both directions and the sub-type alone cannot
 * tell them apart. Guessing here would silently mislabel real client messages.
 */
const SUBTYPE_TO_AUTHOR_SIDE: Record<string, AuthorSide> = {
	inboundemail: 'client',
	feedback: 'client',
	note: 'agent',
	contacted: 'agent',
	'not contacted': 'agent',
	complete: 'agent',
	evaluation: 'agent',
	outboundemail: 'agent',
	sent: 'agent',
	sms: 'unknown',
};

export const resolveAuthorSideFromSubType = (subType: string | null): AuthorSide =>
	subType ? SUBTYPE_TO_AUTHOR_SIDE[subType] ?? 'unknown' : 'unknown';

export const resolveSubType = (historyEntry: InteractionEntry): string | null => {
	const raw = historyEntry.interactionStatusList?.[0]?.customProperty?.subType;

	if (Array.isArray(raw)) {
		const first = raw.find((value) => typeof value === 'string' && value.trim());
		return typeof first === 'string' ? first.trim() : null;
	}

	return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
};

export const resolveMasterType = (historyEntry: InteractionEntry): { subType: string | null; masterType: MasterType } => {
	const subType = resolveSubType(historyEntry);

	if (!subType) {
		return { subType: null, masterType: 'unknown' };
	}

	return { subType, masterType: SUBTYPE_TO_MASTER_TYPE[subType] ?? 'unknown' };
};

export interface HistoryPartition {
	kept: InteractionEntry[];
	droppedLogCount: number;
	/** Sub-types absent from the mapping, kept rather than dropped, counted so they surface. */
	unknownSubTypeCounts: Record<string, number>;
	missingSubTypeCount: number;
}

/**
 * Splits history into entries worth normalizing and system log rows.
 *
 * Unrecognised sub-types are KEPT, not dropped: a sub-type added to the app after this map was
 * written is far more likely to be a new communication channel than a new audit row, and silently
 * discarding it would bias the output in a way nobody would notice. They are counted so a new
 * sub-type shows up in the run metadata instead of vanishing.
 */
export const partitionHistoryByMasterType = (historyEntries: InteractionEntry[]): HistoryPartition => {
	const kept: InteractionEntry[] = [];
	const unknownSubTypeCounts: Record<string, number> = {};
	let droppedLogCount = 0;
	let missingSubTypeCount = 0;

	for (const historyEntry of historyEntries) {
		const { subType, masterType } = resolveMasterType(historyEntry);

		if (masterType === 'log') {
			droppedLogCount += 1;
			continue;
		}

		if (masterType === 'unknown') {
			if (subType) {
				unknownSubTypeCounts[subType] = (unknownSubTypeCounts[subType] ?? 0) + 1;
			} else {
				missingSubTypeCount += 1;
			}
		}

		kept.push(historyEntry);
	}

	return { kept, droppedLogCount, unknownSubTypeCounts, missingSubTypeCount };
};
