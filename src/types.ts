/** Shapes returned by the DS APIs, narrowed to the fields this pipeline reads. */

export interface InteractionInfo {
	interactionInfoId?: string;
	fieldId?: string;
	infoType?: string;
	title: string;
	value?: string;
	order?: number;
	date?: number;
}

export interface InteractionStatus {
	interactionId?: string;
	interactionInfoList: InteractionInfo[];
	createdDate?: number;
	modifiedDate?: number;
	isDeleted?: boolean;
	type?: { id?: string; value?: string };
	customProperty?: {
		subType?: string | string[];
		linkedTask?: string | string[];
		departmentID?: string | string[];
	};
}

export interface InteractionEntry {
	interactionId: string;
	accountId?: string;
	interactionStatusList?: InteractionStatus[];
	[key: string]: unknown;
}

export interface InteractionPage {
	/** `false` on a session-scoped failure, which the history API reports under HTTP 200. */
	success?: boolean;
	error?: string;
	errorMessage?: string;
	data?: InteractionEntry[];
	links?: { next?: { link?: string; parameters?: string } };
}

/** The task record from `POST /getATask_v2`, narrowed to what the normalized output carries. */
export interface DsTask {
	id?: string;
	accountID?: string;
	linkedAccount?: string;
	type?: string;
	comments?: string;
	mailSubject?: string;
	mailContent?: string;
	taskContent?: string;
	notes?: string;
	open?: boolean;
	status?: string;
	createdDate?: number;
	lastUpdatedDate?: number;
	closedAt?: number;
	dueDate?: number;
	department?: string;
	ownerID?: string;
	source?: string;
	[key: string]: unknown;
}

/** Which history field a comment's text came from. */
export type HistoryTextField = 'historyComments' | 'resolutionComments';

export type SpeakerRole = 'client' | 'agent' | 'system' | 'unknown';

/** How a role was decided, so every label can be audited without re-running the pipeline. */
export type RoleBasis =
	| 'system-message'
	| 'sub-type'
	| `speaker:${string}`
	| 'unresolved';

export interface NormalizedComment {
	commentId: string;
	sourceInteractionId: string;
	/** Milliseconds since epoch. */
	createdDate: number;
	createdAt: string;
	speakerName: string;
	speakerRole: SpeakerRole;
	roleBasis: RoleBasis;
	/** DS sub-type of the source entry (`note`, `inboundemail`, `outboundemail`, …). */
	subType: string | null;
	sourceField: HistoryTextField;
	/**
	 * Plain text: HTML and images gone. Whitespace inside a turn is collapsed to single spaces, so
	 * a bulleted list arrives as a run-on sentence; only injected header lines carry `\n`.
	 */
	text: string;
	quotedReplyTrimmed: boolean;
	sequence: number;
}

export interface NormalizedTask {
	taskId: string;
	title: string | null;
	taskType: string | null;
	accountId: string | null;
	linkedAccount: string | null;
	open: boolean | null;
	createdDate: number | null;
	lastUpdatedDate: number | null;
	comments: NormalizedComment[];
	meta: NormalizeMeta;
}

export interface NormalizeMeta {
	historyEntries: number;
	historyPages: number;
	commentsEmitted: number;
	droppedLogEntries: number;
	/** Sub-types not in the DS mapping. Kept, not dropped — counted so new ones surface. */
	unknownSubTypeCounts: Record<string, number>;
	missingSubTypeCount: number;
	/** Extra `interactionStatusList` entries and repeated info fields the extractor does not read. */
	unreadStatusCount: number;
	unreadInfoFieldCount: number;
	quotedRepliesTrimmed: number;
	roleCounts: Record<SpeakerRole, number>;
	warnings: string[];
	fetchedAt: string;
}
