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

test("item content after a nested list keeps its source order", () => {
	const html = renderMarkdown("- one\n- two\n  1. nested\n  after");
	assert.equal(html, "<ul><li>one</li><li>two<ol><li>nested</li></ol>after</li></ul>");
});

test("a paragraph aligned with a nested marker is text, not code", () => {
	const html = renderMarkdown("- before\n       - child\n\n       after");
	assert.equal(html, "<ul><li><p>before</p><ul><li>child</li></ul><p>after</p></li></ul>");
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

test("link targets may contain balanced parentheses", () => {
	// Wikipedia-style URLs end in a parenthesised disambiguator, so the target
	// must close at the first ")" that is not matching a "(" opened inside it.
	assert.equal(
		renderMarkdown("[rust](https://en.wikipedia.org/wiki/Rust_(programming_language))"),
		'<p><a href="https://en.wikipedia.org/wiki/Rust_(programming_language)"'
			+ ' data-href="https://en.wikipedia.org/wiki/Rust_(programming_language)" rel="noreferrer">rust</a></p>',
	);

	// An unmatched "(" leaves the link unformed rather than truncated early.
	assert.equal(renderMarkdown("[x](https://a(b)"), "<p>[x](https://a(b)</p>");

	// The first balanced ")" still closes; text after it stays outside.
	assert.equal(
		renderMarkdown("[x](https://a) b)"),
		'<p><a href="https://a" data-href="https://a" rel="noreferrer">x</a> b)</p>',
	);
});

test("image syntax renders as a link to the image", () => {
	// The viewer loads no remote content, so an image is shown as the one thing
	// it can honour: a link to the source, labelled by the alt text.
	assert.equal(
		renderMarkdown("![alt text](https://example.com/a.png)"),
		'<p><a href="https://example.com/a.png" data-href="https://example.com/a.png" rel="noreferrer">alt text</a></p>',
	);

	// An image whose target is unsafe stays literal, bang included.
	assert.equal(renderMarkdown("![x](./a.png)"), "<p>![x](./a.png)</p>");

	// An escaped bang is plain text ahead of an ordinary link.
	assert.equal(
		renderMarkdown("\\![x](https://a)"),
		'<p>!<a href="https://a" data-href="https://a" rel="noreferrer">x</a></p>',
	);
});

test("a link title is dropped rather than folded into the target", () => {
	assert.equal(
		renderMarkdown('[x](https://example.com "title")'),
		'<p><a href="https://example.com" data-href="https://example.com" rel="noreferrer">x</a></p>',
	);

	// The scheme check judges the destination alone, so a title cannot smuggle
	// a rejected target through — nor rescue one.
	assert.doesNotMatch(renderMarkdown('[x](javascript:a "https://ok")'), /<a /);
});

test("a target too long for the main process to open never becomes a link", () => {
	// The open-link handler drops targets over 2048 characters, so the renderer
	// draws no link it knows would go nowhere. At the limit it still works.
	const base = "https://example.com/";
	const atLimit = base + "a".repeat(2048 - base.length);
	const overLimit = atLimit + "a";
	assert.match(renderMarkdown(`[x](${atLimit})`), /<a /);
	assert.doesNotMatch(renderMarkdown(`[x](${overLimit})`), /<a /);
});

test("blank lines between items make one loose list, not two lists", () => {
	assert.equal(renderMarkdown("- a\n\n- b"), "<ul><li><p>a</p></li><li><p>b</p></li></ul>");

	// The gap may instead sit inside one item: indented content after it still
	// belongs to the item, as a second paragraph.
	assert.equal(
		renderMarkdown("- a\n\n  b\n- c"),
		"<ul><li><p>a</p>\n<p>b</p></li><li><p>c</p></li></ul>",
	);

	// Looseness belongs to one list at a time: the gap loosens the outer list
	// here while the nested list stays tight.
	assert.equal(
		renderMarkdown("- a\n  - b\n\n- c"),
		"<ul><li><p>a</p><ul><li>b</li></ul></li><li><p>c</p></li></ul>",
	);

	// A list not interrupted by blank lines stays tight, and content at the
	// list's own indent after a gap still ends it.
	assert.equal(renderMarkdown("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
	assert.equal(renderMarkdown("- a\n\ntext"), "<ul><li>a</li></ul>\n<p>text</p>");
});

test("an empty item stays in its list instead of splitting it", () => {
	assert.equal(renderMarkdown("- first\n-\n- third"), "<ul><li>first</li><li></li><li>third</li></ul>");

	// Trailing spaces after the marker are still an empty item, never an item
	// whose content is whitespace.
	assert.equal(renderMarkdown("- a\n-  \n- b"), "<ul><li>a</li><li></li><li>b</li></ul>");

	// An item that starts blank reads its content column as one past the
	// marker, so an indented line below still belongs to it.
	assert.equal(renderMarkdown("-\n  foo"), "<ul><li>foo</li></ul>");

	// An empty item cannot interrupt a paragraph: a lone marker mid-paragraph
	// is prose. (A lone "-" is a setext underline before it is a list item.)
	assert.equal(renderMarkdown("foo\n*\nbar"), "<p>foo * bar</p>");
	assert.equal(renderMarkdown("foo\n-\nbar"), "<h2>foo</h2>\n<p>bar</p>");
});

test("escapes raw HTML in prose and code blocks", () => {
	const html = renderMarkdown("<script>alert('no')</script>\n\n```\n<b>code</b>\n```");
	assert.doesNotMatch(html, /<script>/);
	assert.match(html, /&lt;script&gt;/);
	assert.match(html, /&lt;b&gt;code&lt;\/b&gt;/);
});

test("code spans pair backtick runs of exactly equal length", () => {
	// A span closes at the next run of exactly the opener's length, so a
	// shorter run inside the span stays part of the code.
	assert.equal(renderMarkdown("``a`b``"), "<p><code>a`b</code></p>");

	// A run with no equal-length partner is literal text — whole, not shed
	// tick by tick until something shorter matches.
	assert.equal(renderMarkdown("a`b"), "<p>a`b</p>");
	assert.equal(renderMarkdown("a``b`c"), "<p>a``b`c</p>");

	// CommonMark's own illustration of the equal-length rule: the lone opener
	// stays literal while the double runs behind it still pair.
	assert.equal(renderMarkdown("`foo``bar``"), "<p>`foo<code>bar</code></p>");
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

test("emphasis follows CommonMark flanking and pairing", () => {
	// A marker beside whitespace faces the wrong way to open or close there,
	// so starred arithmetic stays prose.
	assert.equal(renderMarkdown("a * b * c"), "<p>a * b * c</p>");
	assert.equal(renderMarkdown("2 * 3 * 4 = 24"), "<p>2 * 3 * 4 = 24</p>");

	// A ** closer pairs with the nearest ** opener, not with the first * the
	// outer emphasis happens to meet.
	assert.equal(
		renderMarkdown("*em **strong** em*"),
		"<p><em>em <strong>strong</strong> em</em></p>",
	);

	// A triple run spends two markers as strong and its last as em, from the
	// ends that leave the nesting whole.
	assert.equal(renderMarkdown("***both***"), "<p><em><strong>both</strong></em></p>");
	assert.equal(renderMarkdown("foo***bar***baz"), "<p>foo<em><strong>bar</strong></em>baz</p>");

	// The rule of three: the inner ** may not take one marker from the outer
	// *, so it waits for its matching ** and the outer * closes at the end.
	assert.equal(
		renderMarkdown("*foo**bar**baz*"),
		"<p><em>foo<strong>bar</strong>baz</em></p>",
	);

	// Markers are spent from an opener's right end and a closer's left, and
	// what neither side can spend stays literal.
	assert.equal(renderMarkdown("**a*"), "<p>*<em>a</em></p>");
	assert.equal(renderMarkdown("*a**"), "<p><em>a</em>*</p>");
});

test("code spans bind tighter than emphasis", () => {
	// The markers inside the spans are no delimiters, so the openers out front
	// find no partner and stay literal.
	assert.equal(renderMarkdown("*a `b*c`"), "<p>*a <code>b*c</code></p>");
	assert.equal(renderMarkdown("_a `b_c`"), "<p>_a <code>b_c</code></p>");

	// Emphasis may still wrap a span whole.
	assert.equal(renderMarkdown("*a `b` c*"), "<p><em>a <code>b</code> c</em></p>");
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

test("code blocks inside list items keep their inner indentation", () => {
	// Continuation lines are dedented by the item's content column, not trimmed
	// flat — trimming erased the indentation inside this fenced block.
	assert.equal(
		renderMarkdown("- item\n  ```\n  if (x) {\n      nested();\n  }\n  ```"),
		"<ul><li><p>item</p>\n<pre><code>if (x) {\n    nested();\n}</code></pre></li></ul>",
	);

	// A wider marker moves the content column with it.
	assert.equal(
		renderMarkdown("10. item\n    ```\n        code\n    ```"),
		'<ol start="10"><li><p>item</p>\n<pre><code>    code</code></pre></li></ol>',
	);

	// Four columns past the content column after a gap is an indented code
	// block, judged by the same rule it would meet at top level.
	assert.equal(
		renderMarkdown("- a\n\n      code"),
		"<ul><li><p>a</p>\n<pre><code>code</code></pre></li></ul>",
	);
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

test("a backslash before anything but punctuation is literal", () => {
	// Only ASCII punctuation can be escaped, so the backslashes of ordinary prose
	// survive — previously every backslash vanished into escaping its neighbour.
	assert.equal(renderMarkdown("C:\\Users\\Owner\\notes.md"), "<p>C:\\Users\\Owner\\notes.md</p>");
	assert.equal(renderMarkdown("a \\latex macro"), "<p>a \\latex macro</p>");

	// A backslash is itself punctuation: the first escapes the second, and a
	// delimiter after the pair is live again.
	assert.equal(renderMarkdown("\\\\_literal_"), "<p>\\<em>literal</em></p>");
	assert.equal(renderMarkdown("\\\\\\_no emphasis_"), "<p>\\_no emphasis_</p>");
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
		// Every hard break spliced its two spaces back out of the rendered string,
		// flattening the whole accumulation each time. The letters keep the lines
		// non-blank, so this is one paragraph rather than many.
		"a  \n".repeat(200000),
		// Every target scan here fails at a different paren depth, so no memo can
		// speak for another scan; the balance index answers each in one lookup
		// where a walk would rescan the rest of the text.
		"[a]((b)".repeat(32000),
		// Each ** here fails the rule of three against every stacked * opener.
		// The per-kind search floor records that futile depth once; without it
		// every closer walks the whole pile of openers again.
		" *a".repeat(40000) + "a**a".repeat(20000),
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

	// The whole run of trailing spaces becomes the break, however long, and a
	// single trailing space is not a break at all.
	assert.equal(renderMarkdown("first    \nsecond"), "<p>first<br>second</p>");
	assert.equal(renderMarkdown("first \nsecond"), "<p>first  second</p>");
});
