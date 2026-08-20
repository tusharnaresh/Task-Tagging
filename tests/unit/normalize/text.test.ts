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

describe('stripHtmlTags and angle brackets', () => {
	// `/<[^>]+>/` treated a comparison as a tag and deleted the span between two of them.
	it('keeps arithmetic comparisons', () => {
		expect(stripHtmlTags('Charge is x > 5 but plan cost < 100 per seat and y > 3 total')).toBe(
			'Charge is x > 5 but plan cost < 100 per seat and y > 3 total'
		);
	});

	it('still removes real tags around them', () => {
		expect(stripHtmlTags('<p>Plan cost < 100 per seat</p>')).toBe('Plan cost < 100 per seat');
	});

	it('still removes closing tags and comments', () => {
		expect(stripHtmlTags('<div>a</div><!-- hidden -->b')).toBe('a b');
	});
});

describe('decodeHtmlEntities', () => {
	it('decodes named, decimal and hex entities', () => {
		expect(decodeHtmlEntities('&lt;a&gt; &#65; &#x42;')).toBe('<a> A B');
	});

	it('leaves unknown entities untouched', () => {
		expect(decodeHtmlEntities('&notarealentity;')).toBe('&notarealentity;');
	});

	// `String.fromCodePoint` throws above U+10FFFF, and the throw used to propagate out of the
	// normalizer — one malformed entity in one comment lost the whole task's output file.
	it('leaves an out-of-range numeric entity as literal text instead of throwing', () => {
		expect(decodeHtmlEntities('order &#x110000; confirmed')).toBe('order &#x110000; confirmed');
		expect(decodeHtmlEntities('order &#1114112; confirmed')).toBe('order &#1114112; confirmed');
	});

	it('still decodes the highest valid code point', () => {
		expect(decodeHtmlEntities('&#x10FFFF;')).toBe(String.fromCodePoint(0x10ffff));
	});
});
