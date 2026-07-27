"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { renderMarkdown } = require("./markdown");

test("renders headings, paragraphs, and inline formatting", () => {
	const html = renderMarkdown("# Hello\n\nA **bold** and *small* `test`.");
	assert.equal(html, "<h1>Hello</h1>\n<p>A <strong>bold</strong> and <em>small</em> <code>test</code>.</p>");
});

test("renders ordered, unordered, and nested lists", () => {
	const html = renderMarkdown("- one\n- two\n  1. nested\n  2. again");
	assert.equal(html, "<ul><li>one</li><li>two<ol><li>nested</li><li>again</li></ol></li></ul>");
});

test("renders safe links and rejects executable protocols", () => {
	const html = renderMarkdown("[site](https://example.com) [bad](javascript:alert(1))");
	assert.match(html, /data-href="https:\/\/example\.com"/);
	assert.doesNotMatch(html, /href="javascript:/);
});

test("escapes raw HTML in prose and code blocks", () => {
	const html = renderMarkdown("<script>alert('no')</script>\n\n```\n<b>code</b>\n```");
	assert.doesNotMatch(html, /<script>/);
	assert.match(html, /&lt;script&gt;/);
	assert.match(html, /&lt;b&gt;code&lt;\/b&gt;/);
});

test("does not treat underscores inside a word as emphasis", () => {
	assert.equal(renderMarkdown("snake_case_here"), "<p>snake_case_here</p>");
	assert.equal(renderMarkdown("snake__case__here"), "<p>snake__case__here</p>");
	assert.equal(renderMarkdown("my_file_name.txt"), "<p>my_file_name.txt</p>");

	// Asterisks may still emphasise inside a word, and word-external underscores work.
	assert.equal(renderMarkdown("foo*bar*baz"), "<p>foo<em>bar</em>baz</p>");
	assert.equal(renderMarkdown("_foo_ and __bar__"), "<p><em>foo</em> and <strong>bar</strong></p>");

	// A run that cannot close is skipped in favour of one that can.
	assert.equal(renderMarkdown("_foo_bar_"), "<p><em>foo_bar</em></p>");
});

test("caps nesting depth instead of exhausting the stack", () => {
	const deepLists = Array.from({ length: 20000 }, (_, i) => " ".repeat(i * 2) + "- x").join("\n");
	assert.doesNotThrow(() => renderMarkdown(deepLists));
	assert.doesNotThrow(() => renderMarkdown(">".repeat(200000) + " x"));

	// Nesting within the limit is still rendered as real structure.
	const nested = renderMarkdown("- a\n  - b\n    - c");
	assert.equal(nested, "<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>");
});

test("backslash escapes suppress emphasis and link delimiters", () => {
	assert.equal(renderMarkdown("\\_not em\\_"), "<p>_not em_</p>");
	assert.equal(renderMarkdown("*a\\*b*"), "<p><em>a*b</em></p>");
	assert.equal(renderMarkdown("\\[not](a-link)"), "<p>[not](a-link)</p>");

	// An escaped closer is passed over in favour of the real one.
	assert.equal(
		renderMarkdown("[x\\](y)](https://example.com)"),
		'<p><a href="https://example.com" data-href="https://example.com" rel="noreferrer">x](y)</a></p>',
	);
});

test("pathological delimiter runs render in linear time", () => {
	// Each of these previously re-scanned the rest of the text once per delimiter,
	// taking tens of seconds at this size and hours at the 10 MB file limit.
	const cases = [
		" _a\\_".repeat(32000),
		"[a".repeat(80000),
		"[a](b".repeat(32000),
	];

	for (const text of cases) {
		const started = process.hrtime.bigint();
		renderMarkdown(text);
		const seconds = Number(process.hrtime.bigint() - started) / 1e9;
		assert.ok(seconds < 5, `took ${seconds.toFixed(1)}s for input of length ${text.length}`);
	}
});

test("renders blockquotes, rules, and hard breaks", () => {
	const html = renderMarkdown("> quoted\n\n---\n\nfirst  \nsecond");
	assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
	assert.match(html, /<hr>/);
	assert.match(html, /first<br>second/);
});
