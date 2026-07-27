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

test("caps nesting depth instead of exhausting the stack", () => {
	const deepLists = Array.from({ length: 20000 }, (_, i) => " ".repeat(i * 2) + "- x").join("\n");
	assert.doesNotThrow(() => renderMarkdown(deepLists));
	assert.doesNotThrow(() => renderMarkdown(">".repeat(200000) + " x"));

	// Nesting within the limit is still rendered as real structure.
	const nested = renderMarkdown("- a\n  - b\n    - c");
	assert.equal(nested, "<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>");
});

test("renders blockquotes, rules, and hard breaks", () => {
	const html = renderMarkdown("> quoted\n\n---\n\nfirst  \nsecond");
	assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
	assert.match(html, /<hr>/);
	assert.match(html, /first<br>second/);
});
