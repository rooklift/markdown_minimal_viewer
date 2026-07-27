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

test("only http, https, and mailto targets become links", () => {
	const html = renderMarkdown("[a](https://example.com) [b](http://example.com) [c](mailto:x@example.com)");
	assert.equal(html.match(/<a /g).length, 3);
	assert.match(html, /data-href="https:\/\/example\.com"/);

	// Everything else stays plain text. Local paths in particular never reach the
	// main process, which is what stops a document naming a file for the viewer to
	// read — a UNC path especially, which would open a connection to its host.
	const inert = [
		"./notes.md",
		"/etc/passwd.md",
		"../../../secret.md",
		"//attacker.example/share/doc.md",
		"C:/Windows/notes.md",
		"file:///etc/passwd",
		"#section",
		"javascript:alert(1)",
		"vbscript:msgbox",
		"data:text/html,<script>alert(1)</script>",
	];

	for (const target of inert) {
		const rendered = renderMarkdown(`[x](${target})`);
		assert.doesNotMatch(rendered, /<a /, `${target} should not become a link`);
	}
});

test("escapes raw HTML in prose and code blocks", () => {
	const html = renderMarkdown("<script>alert('no')</script>\n\n```\n<b>code</b>\n```");
	assert.doesNotMatch(html, /<script>/);
	assert.match(html, /&lt;script&gt;/);
	assert.match(html, /&lt;b&gt;code&lt;\/b&gt;/);
});

test("code spans pair backtick runs by length", () => {
	// A closing run must be at least as long as the opener, so a shorter run
	// inside the span stays part of the code.
	assert.equal(renderMarkdown("``a`b``"), "<p><code>a`b</code></p>");

	// An opener with no closer is literal text; its tail may still pair up.
	assert.equal(renderMarkdown("a`b"), "<p>a`b</p>");
	assert.equal(renderMarkdown("a``b`c"), "<p>a`<code>b</code>c</p>");
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

test("keeps paragraphs wrapped when a list item holds several blocks", () => {
	const html = renderMarkdown("- a\n  ```\n  x\n  ```\n  b");
	assert.equal(html, "<ul><li><p>a</p>\n<pre><code>x</code></pre>\n<p>b</p></li></ul>");

	// Single-paragraph items still lose the wrapper.
	assert.equal(renderMarkdown("- one"), "<ul><li>one</li></ul>");
});

test("indented lines continue a paragraph instead of starting code", () => {
	assert.equal(
		renderMarkdown("A sentence that\n    continues indented."),
		"<p>A sentence that continues indented.</p>",
	);

	// Indented code still works when it is not interrupting a paragraph.
	assert.equal(
		renderMarkdown("Intro:\n\n    code here"),
		"<p>Intro:</p>\n<pre><code>code here</code></pre>",
	);
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

test("a rejected link target does not suppress later links", () => {
	// The bracket that owns the unsafe target renders as literal text, and so do the
	// ones before it, but a genuine link further on still has to be found.
	assert.equal(
		renderMarkdown("[x](javascript:a) [y](https://example.com)"),
		'<p>[x](javascript:a) <a href="https://example.com" data-href="https://example.com" rel="noreferrer">y</a></p>',
	);

	// Brackets ahead of a rejected target share its verdict, not its consumption.
	assert.equal(renderMarkdown("[a[b](javascript:a)"), "<p>[a[b](javascript:a)</p>");
});

test("pathological delimiter runs render in linear time", () => {
	// Each of these previously re-scanned the rest of the text once per delimiter,
	// taking tens of seconds at this size and hours at the 10 MB file limit.
	const cases = [
		" _a\\_".repeat(32000),
		"[a".repeat(80000),
		"[a](b".repeat(32000),
		// These two scan successfully every time and still consume nothing, so the
		// failed-scan memo never fires and they need one of their own.
		"[a".repeat(80000) + "](javascript:x)",
		"[a".repeat(80000) + "](http://x)",
		// Each backtick of an unclosed run opens with a different length, so the
		// failed-scan memo cannot cover backticks; each opener measured and rescanned
		// the rest of the text. The leading letter keeps the line a paragraph rather
		// than a cheap code fence.
		"a" + "`".repeat(200000),
	];

	for (const text of cases) {
		const started = process.hrtime.bigint();
		renderMarkdown(text);
		const seconds = Number(process.hrtime.bigint() - started) / 1e9;
		assert.ok(seconds < 5, `took ${seconds.toFixed(1)}s for input of length ${text.length}`);
	}
});

test("an underline only makes a heading of what would have been a paragraph", () => {
	assert.equal(renderMarkdown("Title\n---"), "<h2>Title</h2>");
	assert.equal(renderMarkdown("Title\n==="), "<h1>Title</h1>");

	// Every one of these can be followed by a thematic break, and each was swallowed
	// into a heading while the underline was tested before the block it sits on.
	assert.equal(renderMarkdown("- a\n---"), "<ul><li>a</li></ul>\n<hr>");
	assert.equal(renderMarkdown("> q\n---"), "<blockquote><p>q</p></blockquote>\n<hr>");
	assert.equal(renderMarkdown("---\n---"), "<hr>\n<hr>");
	assert.equal(renderMarkdown("    code\n---"), "<pre><code>code</code></pre>\n<hr>");

	// A list of more than one item never regressed: the underline is not the line
	// directly below the first item, so the list branch got its turn regardless.
	assert.equal(renderMarkdown("- a\n- b\n---"), "<ul><li>a</li><li>b</li></ul>\n<hr>");
});

test("renders blockquotes, rules, and hard breaks", () => {
	const html = renderMarkdown("> quoted\n\n---\n\nfirst  \nsecond");
	assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
	assert.match(html, /<hr>/);
	assert.match(html, /first<br>second/);
});
