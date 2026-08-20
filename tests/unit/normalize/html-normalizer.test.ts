import { describe, expect, it } from 'vitest';
import { extractTurnsFromEntry } from '../../../src/normalize/html-normalizer.ts';
import { buildEntry } from '../../fixtures.ts';

const extract = (historyComments: string, ownerName = 'Tony C') =>
	extractTurnsFromEntry(buildEntry({ interactionId: 'entry-1', subType: ['note'], createdDate: 1_780_000_000_000, ownerName, historyComments }));

const texts = (historyComments: string, ownerName?: string) => extract(historyComments, ownerName).turns.map((turn) => turn.text);

describe('paragraph extraction', () => {
	it('reads paragraphs in order', () => {
		expect(texts('<label>Dana</label><p>First.</p><p>Second.</p>')).toEqual(['First.', 'Second.']);
	});

	// The extractor matched `<p>` only, and fell back to the whole block just when there were no
	// paragraphs at all — so a `<div>` sitting beside a `<p>` was silently discarded.
	it('keeps sibling div text alongside a paragraph', () => {
		expect(texts('<label>Dana</label><div>URGENT: cancel my subscription today</div><p>thanks</p>')).toEqual([
			'URGENT: cancel my subscription today',
			'thanks',
		]);
	});

	it('keeps list and table cell text alongside a paragraph', () => {
		expect(texts('<label>Dana</label><ul><li>Move the fax line</li><li>Add Priya</li></ul><p>By Friday.</p>')).toEqual([
			'Move the fax line',
			'Add Priya',
			'By Friday.',
		]);
	});

	it('does not double-count a paragraph nested in a div', () => {
		expect(texts('<label>Dana</label><div><p>Only once.</p></div>')).toEqual(['Only once.']);
	});

	it('keeps a line-broken paragraph as one turn', () => {
		expect(texts('<label>Dana</label><p>Line one<br>Line two</p>')).toEqual(['Line one Line two']);
	});
});

describe('<small> inside a speaker block', () => {
	// `<small>` was used as a block terminator, so a timestamp between two paragraphs ended the turn
	// and everything after it was dropped without a warning.
	it('keeps text that follows a timestamp', () => {
		expect(texts('<label>Dana</label><p>My card was charged twice.</p><small>10:04 AM</small><p>Please refund order 8891.</p>')).toEqual([
			'My card was charged twice.',
			'Please refund order 8891.',
		]);
	});

	it('keeps a turn whose timestamp precedes its text', () => {
		expect(texts('<label>Dana</label><small>10:04 AM</small><p>My card was charged twice.</p>')).toEqual(['My card was charged twice.']);
	});

	it('does not emit the timestamp as content', () => {
		expect(texts('<label>Dana</label><small>10:04 AM</small><p>Hello.</p>').join(' ')).not.toContain('10:04');
	});

	it('still ends the block at the next speaker', () => {
		const turns = extract('<label>Dana</label><p>Hello.</p><label>Tony C</label><p>Hi Dana.</p>').turns;

		expect(turns.map((turn) => [turn.speakerName, turn.text])).toEqual([
			['Dana', 'Hello.'],
			['Tony C', 'Hi Dana.'],
		]);
	});
});

describe('system notices', () => {
	// The notice was emitted as its own turn AND left in the text of the following turn, whose
	// combined text then began with the notice and was itself flagged as a system message — so the
	// only turn carrying the subject was the one the prompt is told to discount.
	it('does not repeat a notice into the message that follows it', () => {
		const turns = extract('<p>Auto assigned to Jamie L</p><p>Customer says the checkout page is broken and wants a refund.</p>').turns;

		expect(turns).toHaveLength(2);
		expect(turns.filter((turn) => turn.isSystemMessage).map((turn) => turn.text)).toEqual(['Auto assigned to Jamie L']);
		expect(turns.find((turn) => !turn.isSystemMessage)).toMatchObject({
			speakerName: 'Tony C',
			text: 'Customer says the checkout page is broken and wants a refund.',
			isSystemMessage: false,
		});
	});

	it('still emits a notice-only entry as a single system turn', () => {
		const turns = extract('<p>Auto assigned to Jamie L</p>').turns;

		expect(turns).toHaveLength(1);
		expect(turns[0]).toMatchObject({ isSystemMessage: true, text: 'Auto assigned to Jamie L' });
	});
});

describe('multiSpeaker', () => {
	it('is true for a two-speaker chat', () => {
		expect(extract('<label>Visitor</label><p>Help?</p><label>Tony C</label><p>Sure.</p>').multiSpeaker).toBe(true);
	});

	it('is false for a single-author entry', () => {
		expect(extract('<p>Just a note.</p>').multiSpeaker).toBe(false);
	});

	// The distinct-speaker set excluded every system-flagged turn, so a chat where one side's turn
	// happened to read like a notice collapsed to one speaker and fell back to the entry sub-type —
	// labelling the other side's words by channel rather than by who said them.
	it('stays true when one speaker’s turn reads like a system notice', () => {
		const html = '<label>Dana</label><p>Auto assigned to Jamie L</p><label>Tony C</label><p>Picking this up now.</p>';

		expect(extract(html).multiSpeaker).toBe(true);
	});
});

describe('DS email wrapper', () => {
	const wrapper = (body: string, trailing = '') =>
		[
			'<span class="history_from">Dana Reyes &lt;dana@example.com&gt;</span>',
			'<span class="history_subject">Re: Billing question</span>',
			`<div class="html_text">${body}</div>`,
			trailing,
		].join('');

	it('names the sender, not the staff member who logged the entry', () => {
		expect(extract(wrapper('<p>Please cancel our account.</p>')).turns[0]).toMatchObject({ speakerName: 'Dana Reyes' });
	});

	// The body div was matched only when it ended the document, so one trailing `<br>` dropped the
	// entry to the generic path — where the speaker becomes the staff member who logged it.
	it('still finds the body when content follows the closing div', () => {
		const turn = extract(wrapper('<p>Please cancel our account.</p>', '<br>')).turns[0];

		expect(turn).toMatchObject({ speakerName: 'Dana Reyes' });
		expect(turn.text).toContain('Please cancel our account.');
	});

	it('finds the body when the wrapper nests another div inside it', () => {
		const turn = extract(wrapper('<div><p>Please cancel our account.</p></div>')).turns[0];

		expect(turn).toMatchObject({ speakerName: 'Dana Reyes' });
		expect(turn.text).toContain('Please cancel our account.');
	});
});

describe('email body sanitizers', () => {
	const wrapper = (body: string) =>
		['<span class="history_from">Dana Reyes &lt;dana@example.com&gt;</span>', `<div class="html_text">${body}</div>`].join('');

	// The signature range ran to end-of-document whenever no `gmail_quote` followed it, taking every
	// below-signature afterthought with it.
	it('removes a signature without discarding what follows it', () => {
		const text = extract(
			wrapper('<p>Please cancel our account.</p><div class="gmail_signature">Dana Reyes, VP</div><p>PS: also cancel the second line, account 4471.</p>')
		).turns[0].text;

		expect(text).toContain('Please cancel our account.');
		expect(text).toContain('account 4471');
		expect(text).not.toContain('VP');
	});

	// The thread-id remover deleted from its element to the *next* `</div>`, so a marker nested in a
	// wrapper div took the body with it.
	it('removes a nested thread-id marker without discarding the body', () => {
		const text = extract(
			wrapper('<div><span title="distsource_custom_threadid">x</span><p>Please cancel our account.</p></div>')
		).turns[0].text;

		expect(text).toContain('Please cancel our account.');
	});

	// `quoted-reply.ts` documented this removal as already happening here; nothing did it, so a thread
	// whose attribution line the text-level markers miss repeated in full in every reply.
	it('removes the Gmail quote container', () => {
		const text = extract(
			wrapper('<p>Please cancel our account.</p><div class="gmail_quote"><p>Le lun. 2 juin 2025, Support a ecrit : earlier thread text</p></div>')
		).turns[0].text;

		expect(text).toContain('Please cancel our account.');
		expect(text).not.toContain('earlier thread text');
	});

	it('removes the user signature block', () => {
		const text = extract(wrapper('<p>Please cancel our account.</p><div id="user-signature-content">Sent from my phone</div>')).turns[0].text;

		expect(text).toContain('Please cancel our account.');
		expect(text).not.toContain('Sent from my phone');
	});
});
