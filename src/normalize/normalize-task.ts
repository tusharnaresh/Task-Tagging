import type { DsTask, InteractionEntry, NormalizeMeta, NormalizedComment, NormalizedTask, SpeakerRole } from '../types.ts';
import { countUnreadDuplicates, extractTurnsFromEntry } from './html-normalizer.ts';
import { partitionHistoryByMasterType, resolveSubType } from './master-type.ts';
import { stripQuotedReplyChain } from './quoted-reply.ts';
import { normalizeDirectoryKey } from './speaker-classifier.ts';
import { resolveRole } from './speaker-role.ts';

/**
 * A comment with everything decided except who spoke.
 *
 * Role resolution consults `staffDirectory`, which is only complete once every page has been
 * folded in, so the two inputs that are not already on the comment are carried here until `build`.
 */
interface PendingComment {
	comment: Omit<NormalizedComment, 'speakerRole' | 'roleBasis'>;
	isSystemMessage: boolean;
	multiSpeakerEntry: boolean;
}

/**
 * Accumulates normalized comments across history pages.
 *
 * Pages are consumed and discarded one at a time: a single task can carry 11 MB of styled HTML
 * across four pages, so nothing keeps a reference to the raw entries once a page is folded in.
 */
export class TaskNormalizer {
	private readonly pending: PendingComment[] = [];
	private readonly warnings: string[] = [];
	private readonly unknownSubTypeCounts: Record<string, number> = {};
	private readonly staffDirectory = new Set<string>();
	private historyEntries = 0;
	private historyPages = 0;
	private droppedLogEntries = 0;
	private missingSubTypeCount = 0;
	private quotedRepliesTrimmed = 0;
	private unreadStatusCount = 0;
	private unreadInfoFieldCount = 0;
	private sequence = 0;

	constructor(private readonly taskId: string) {}

	addPage(entries: InteractionEntry[]): void {
		this.historyPages += 1;
		this.historyEntries += entries.length;

		const partition = partitionHistoryByMasterType(entries);
		this.droppedLogEntries += partition.droppedLogCount;
		this.missingSubTypeCount += partition.missingSubTypeCount;
		for (const [subType, count] of Object.entries(partition.unknownSubTypeCounts)) {
			this.unknownSubTypeCounts[subType] = (this.unknownSubTypeCounts[subType] ?? 0) + count;
		}

		// `ownerName` is the staff member who logged an entry, so every value seen is a known
		// internal name. Collected across pages, it lets transcript turns be attributed by exact
		// match instead of falling back to name shape alone.
		for (const entry of partition.kept) {
			const ownerName = entry.interactionStatusList?.[0]?.interactionInfoList?.find((info) => info.title === 'ownerName')?.value;
			if (ownerName?.trim()) {
				this.staffDirectory.add(normalizeDirectoryKey(ownerName));
			}
		}

		for (const entry of partition.kept) {
			this.addEntry(entry);
		}
	}

	private addEntry(entry: InteractionEntry): void {
		const status = entry.interactionStatusList?.[0];
		const createdDate = status?.createdDate ?? 0;
		const subType = resolveSubType(entry);
		const { turns, multiSpeaker, warnings } = extractTurnsFromEntry(entry);
		const unread = countUnreadDuplicates(entry);
		this.unreadStatusCount += unread.unreadStatuses;
		this.unreadInfoFieldCount += unread.unreadFields;

		this.warnings.push(...warnings);

		for (const turn of turns) {
			const { text, trimmed } = stripQuotedReplyChain(turn.text);
			if (!text.trim()) {
				continue;
			}

			if (trimmed) {
				this.quotedRepliesTrimmed += 1;
			}

			this.pending.push({
				comment: {
					commentId: `${entry.interactionId}:${this.sequence}`,
					sourceInteractionId: entry.interactionId,
					createdDate,
					createdAt: createdDate ? new Date(createdDate).toISOString() : '',
					speakerName: turn.speakerName,
					subType,
					sourceField: turn.sourceField,
					text,
					quotedReplyTrimmed: trimmed,
					sequence: this.sequence,
				},
				isSystemMessage: turn.isSystemMessage,
				multiSpeakerEntry: multiSpeaker,
			});

			this.sequence += 1;
		}
	}

	/**
	 * The API is queried newest-first (`order=DESC`) because that is the only ordering its cursor
	 * pagination is verified against; the conversation is re-sorted oldest-first here, which is the
	 * order anything reading it will expect. Entries sharing a timestamp keep extraction order.
	 *
	 * Roles are resolved here rather than per page. `staffDirectory` is filled page by page, so a
	 * staff member whose `ownerName` entry lands on a later page than their chat turn would be
	 * classified by name shape — and, on the newest-first ordering, labelled `client`. Resolving
	 * once the directory is complete makes attribution independent of page boundaries.
	 */
	build(task: DsTask | null): NormalizedTask {
		const comments = this.pending
			.map(({ comment, isSystemMessage, multiSpeakerEntry }): NormalizedComment => {
				const { role, basis } = resolveRole({
					speakerName: comment.speakerName,
					isSystemMessage,
					subType: comment.subType,
					multiSpeakerEntry,
					staffDirectory: this.staffDirectory,
				});

				return { ...comment, speakerRole: role, roleBasis: basis };
			})
			// An undated comment has `createdDate` 0, which would sort it ahead of every real message
			// in an oldest-first transcript — putting `[unknown]` where the opening exchange belongs,
			// which is exactly where a reader looks for the subject. Undated goes last instead.
			.sort((a, b) => {
				if (!a.createdDate !== !b.createdDate) {
					return a.createdDate ? -1 : 1;
				}

				return a.createdDate - b.createdDate || a.sequence - b.sequence;
			});

		const roleCounts: Record<SpeakerRole, number> = { client: 0, agent: 0, system: 0, unknown: 0 };
		for (const comment of comments) {
			roleCounts[comment.speakerRole] += 1;
		}

		const meta: NormalizeMeta = {
			historyEntries: this.historyEntries,
			historyPages: this.historyPages,
			commentsEmitted: comments.length,
			droppedLogEntries: this.droppedLogEntries,
			unknownSubTypeCounts: this.unknownSubTypeCounts,
			missingSubTypeCount: this.missingSubTypeCount,
			unreadStatusCount: this.unreadStatusCount,
			unreadInfoFieldCount: this.unreadInfoFieldCount,
			quotedRepliesTrimmed: this.quotedRepliesTrimmed,
			roleCounts,
			warnings: this.warnings,
			fetchedAt: new Date().toISOString(),
		};

		return {
			taskId: this.taskId,
			title: task?.comments?.trim() || task?.mailSubject?.trim() || null,
			taskType: task?.type ?? null,
			accountId: task?.accountID ?? null,
			linkedAccount: task?.linkedAccount ?? null,
			open: typeof task?.open === 'boolean' ? task.open : null,
			createdDate: task?.createdDate ?? null,
			lastUpdatedDate: task?.lastUpdatedDate ?? null,
			comments,
			meta,
		};
	}
}
