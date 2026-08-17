import { describe, expect, it } from 'vitest';
import { decodeHtmlEntities, normalizeUnicode, stripHtmlTags } from '../../../src/normalize/text.ts';

describe('stripHtmlTags', () => {
	it('strips tags and decodes entities', () => {
		expect(stripHtmlTags('<p>Hello &amp; welcome</p>')).toBe('Hello & welcome');
	});

	it('drops style and script bodies rather than leaking their contents as text', () => {
		const html = '<style>.a{color:red;}</style><p>Real content</p>';
		expect(stripHtmlTags(html)).toBe('Real content');
	});

	it('keeps bracketed email addresses that a naive tag strip would delete', () => {
		expect(stripHtmlTags('From: Jane <jane@example.com>')).toContain('jane@example.com');
	});

	// `</p>` becomes a newline and the following `<p ...>` becomes a space, so block boundaries
	// carry a leading space. Every caller runs the result through `normalizeWhitespace`, so this
	// never reaches the output — asserted here to pin the actual contract rather than an assumed one.
	it('turns <br> and </p> into newlines', () => {
		expect(stripHtmlTags('<p>one</p><p>two<br>three</p>')).toBe('one\n two\nthree');
	});

	it('collapses runs of blank lines', () => {
		expect(stripHtmlTags('<p>a</p><p></p><p></p><p></p><p>b</p>')).toBe('a\n\n b');
	});
});

describe('normalizeUnicode', () => {
	it('removes zero-width characters', () => {
		expect(normalizeUnicode('a​b﻿c')).toBe('abc');
	});

	it('normalises non-breaking spaces to plain spaces', () => {
		expect(normalizeUnicode('a b')).toBe('a b');
	});

	it('normalises CRLF to LF', () => {
		expect(normalizeUnicode('a\r\nb')).toBe('a\nb');
	});

	it('replaces the object-replacement character left behind by stripped images', () => {
		expect(normalizeUnicode('see￼this')).toBe('see this');
	});
});

describe('decodeHtmlEntities', () => {
	it('decodes named, decimal and hex entities', () => {
		expect(decodeHtmlEntities('&lt;a&gt; &#65; &#x42;')).toBe('<a> A B');
	});

	it('leaves unknown entities untouched', () => {
		expect(decodeHtmlEntities('&notarealentity;')).toBe('&notarealentity;');
	});
});
