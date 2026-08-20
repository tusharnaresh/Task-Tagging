import { describe, expect, it } from 'vitest';
import { classifySpeaker, cleanSpeakerLabel, normalizeDirectoryKey } from '../../../src/normalize/speaker-classifier.ts';
import { extractTurnsFromEntry } from '../../../src/normalize/html-normalizer.ts';
import { buildEntry } from '../../fixtures.ts';

const classify = (speaker: string, staff: string[] = []) =>
	classifySpeaker({ speaker, staffDirectory: new Set(staff.map(normalizeDirectoryKey)) });

describe('cleanSpeakerLabel', () => {
	it('drops the leading "Today " export artifact', () => {
		expect(cleanSpeakerLabel('Today Tony C')).toBe('Tony C');
	});

	it('leaves a name that merely starts with the word today alone', () => {
		expect(cleanSpeakerLabel('Todd C')).toBe('Todd C');
	});
});

describe('normalizeDirectoryKey', () => {
	it('lowercases, drops parentheticals and punctuation, collapses spaces', () => {
		expect(normalizeDirectoryKey('  Tony  C. (Support) ')).toBe('tony c');
	});

	it('gives the same key to the two spellings of one name', () => {
		expect(normalizeDirectoryKey('Tony C.')).toBe(normalizeDirectoryKey('Tony C'));
	});
});

describe('classifySpeaker', () => {
	it('treats an empty or formatting label as a non-speaker', () => {
		expect(classify('')).toMatchObject({ side: 'non-speaker', rule: 'non-speaker-label' });
		expect(classify('Step 2:')).toMatchObject({ side: 'non-speaker', rule: 'non-speaker-label' });
		expect(classify('Option 1')).toMatchObject({ side: 'non-speaker', rule: 'non-speaker-label' });
	});

	it('treats a form field label as a non-speaker', () => {
		expect(classify('Brief Description')).toMatchObject({ side: 'non-speaker', rule: 'non-speaker-label' });
		expect(classify('Appointment Date')).toMatchObject({ side: 'non-speaker', rule: 'non-speaker-label' });
	});

	it('reads a client role label as the client', () => {
		for (const label of ['Visitor', 'Customer', 'Caller', 'Guest', 'Client']) {
			expect(classify(label)).toMatchObject({ side: 'client', rule: 'role-label' });
		}
	});

	it('reads a staff role label as staff', () => {
		for (const label of ['Agent', 'Operator', 'Receptionist']) {
			expect(classify(label)).toMatchObject({ side: 'staff', rule: 'role-label' });
		}
	});

	it('reads a "took a note" row as staff', () => {
		expect(classify('Jamie Lawson took a note')).toMatchObject({ side: 'staff', rule: 'activity-marker' });
	});

	it('reads the internal display-name convention as staff', () => {
		expect(classify('Tony C')).toMatchObject({ side: 'staff', rule: 'name-shape' });
		expect(classify('Tony C.')).toMatchObject({ side: 'staff', rule: 'name-shape' });
	});

	it('does not read a full last name as the display-name convention', () => {
		expect(classify('Dana Reyes')).toMatchObject({ side: 'client', rule: 'client-by-elimination' });
	});

	it('reads a directory match as staff, ignoring case and punctuation', () => {
		expect(classify('Marguerite Delacroix', ['marguerite delacroix'])).toMatchObject({ side: 'staff', rule: 'staff-directory' });
		expect(classify('Marguerite Delacroix (Support)', ['Marguerite Delacroix'])).toMatchObject({ side: 'staff', rule: 'staff-directory' });
	});

	// Exact matching only: `April Powell` vs `April Pursell` collided 191 times under fuzzy matching.
	it('does not match a different person with the same first name', () => {
		expect(classify('April Pursell', ['April Powell'])).toMatchObject({ side: 'client', rule: 'client-by-elimination' });
	});

	it('falls through to the client rather than defaulting to staff', () => {
		expect(classify('Dana Reyes')).toMatchObject({ side: 'client', rule: 'client-by-elimination' });
	});
});

describe('truncated-name repair', () => {
	const speakers = (historyComments: string) =>
		extractTurnsFromEntry(
			buildEntry({ interactionId: 'entry-1', subType: ['note'], createdDate: 1, ownerName: 'Tony C', historyComments })
		).turns.map((turn) => turn.speakerName);

	// The source drops the first character of a transcript's opening label — `>ackie Zbignewich`.
	it('repairs a label missing its first character from a later full one', () => {
		expect(speakers('<label>ackie Zbignewich</label><p>Hello.</p><label>Jackie Zbignewich</label><p>Still here.</p>')).toEqual([
			'Jackie Zbignewich',
			'Jackie Zbignewich',
		]);
	});

	// Requiring an exact length difference of one is what keeps this from merging two people.
	it('does not merge two names that differ by more than one character', () => {
		expect(speakers('<label>Jan Kowalski</label><p>Hello.</p><label>Marian Kowalski</label><p>Hi.</p>')).toEqual([
			'Jan Kowalski',
			'Marian Kowalski',
		]);
	});

	it('does not repair a label shorter than three characters', () => {
		expect(speakers('<label>Jo</label><p>Hello.</p><label>Ajo</label><p>Hi.</p>')).toEqual(['Jo', 'Ajo']);
	});
});
