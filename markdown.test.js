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

test("only a marker numbered 1 interrupts a paragraph", () => {
	// A sentence wrapping onto a number stays prose — CommonMark lets an
	// ordered marker interrupt a paragraph only when it is numbered 1.
	assert.equal(
		renderMarkdown("The number of windows is\n14. The number of doors is six."),
		"<p>The number of windows is 14. The number of doors is six.</p>",
	);

	// "1." still interrupts, and after a blank line any number starts a list.
	assert.equal(
		renderMarkdown("A sentence\n1. one\n2. two"),
		"<p>A sentence</p>\n<ol><li>one</li><li>two</li></ol>",
	);
	assert.equal(
		renderMarkdown("A sentence\n\n14. one"),
		'<p>A sentence</p>\n<ol start="14"><li>one</li></ol>',
	);
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

test("code spans shed one framing space but keep interior padding", () => {
	// One space comes off each end only when both ends have one — the padding
	// that lets a span hold a backtick — never a wholesale trim.
	assert.equal(renderMarkdown("` x `"), "<p><code>x</code></p>");
	assert.equal(renderMarkdown("`  x  `"), "<p><code> x </code></p>");
	assert.equal(renderMarkdown("`` ` ``"), "<p><code>`</code></p>");

	// A span of nothing but spaces has no content to set apart, so it keeps
	// every one; one-sided padding is likewise content.
	assert.equal(renderMarkdown("`  `"), "<p><code>  </code></p>");
	assert.equal(renderMarkdown("` x`"), "<p><code> x</code></p>");
});

test("closing hashes need whitespace to set them apart from a heading", () => {
	// Pressed against the text, hashes are content — headings about C# and
	// hashtags survive whole.
	assert.equal(renderMarkdown("# C#"), "<h1>C#</h1>");
	assert.equal(renderMarkdown("# foo#"), "<h1>foo#</h1>");

	// Separated, they are the optional closing run and vanish, trailing
	// spaces or not.
	assert.equal(renderMarkdown("## foo ##"), "<h2>foo</h2>");
	assert.equal(renderMarkdown("# foo ##  "), "<h1>foo</h1>");
});

test("an indented fence sheds its indentation from the code inside", () => {
	// Up to the fence's own indent comes off every content line, so an
	// indented fence yields the same code an unindented one would.
	assert.equal(renderMarkdown("  ```\n  x\n   y\n  ```"), "<pre><code>x\n y</code></pre>");

	// A line shallower than the fence loses only what it has.
	assert.equal(renderMarkdown("   ```\n x\n```"), "<pre><code>x</code></pre>");
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
	// This crosses the 64-level cap comfortably while keeping the fixture small
	// enough for routine test runs. The outer list plus 64 nested lists render;
	// markers beyond the cap stay text instead of opening more structure.
	const deepLists = Array.from({ length: 256 }, (_, i) => " ".repeat(i * 2) + "- x").join("\n");
	const renderedLists = renderMarkdown(deepLists);
	assert.equal((renderedLists.match(/<ul>/g) || []).length, 65);
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

test("tab-indented lines are code, not markup", () => {
	assert.equal(
		renderMarkdown("\t*text* [link](https://example.com)"),
		"<pre><code>*text* [link](https://example.com)</code></pre>",
	);
});

test("whitespace-only lines continue an indented code block", () => {
	// A line of spaces between two indented chunks is blank, not a block
	// boundary — one code block, with the gap inside it.
	assert.equal(
		renderMarkdown("    a\n   \n    b"),
		"<pre><code>a\n\nb</code></pre>",
	);

	// Blank lines after the last chunk belong to what follows, not the code.
	assert.equal(
		renderMarkdown("    code\n\nafter"),
		"<pre><code>code</code></pre>\n<p>after</p>",
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

	// Only the nearest bracket is spent on the rejected target; the outer one
	// finds no later "](" and stays text with it.
	assert.equal(renderMarkdown("[a[b](javascript:a)"), "<p>[a[b](javascript:a)</p>");
});

test('a "](" closes the nearest open bracket, not the first', () => {
	// An unmatched "[" ahead of a real link stays literal instead of swallowing
	// the link into its own label.
	assert.equal(
		renderMarkdown("[a [b](https://google.com)"),
		'<p>[a <a href="https://google.com" data-href="https://google.com" rel="noreferrer">b</a></p>',
	);

	// A bracket pair that forms no link is spent as plain text, so the "]("
	// after it still serves the bracket before it.
	assert.equal(
		renderMarkdown("[a] [b](https://x)"),
		'<p>[a] <a href="https://x" data-href="https://x" rel="noreferrer">b</a></p>',
	);
	assert.equal(
		renderMarkdown("[a[b]c](https://x)"),
		'<p><a href="https://x" data-href="https://x" rel="noreferrer">a[b]c</a></p>',
	);

	// A completed link seals off the brackets opened before it: nothing may
	// reach across it to a later "](", so links never nest.
	assert.equal(
		renderMarkdown("[a [b](https://x) c](https://y)"),
		'<p>[a <a href="https://x" data-href="https://x" rel="noreferrer">b</a> c](https://y)</p>',
	);
});

test("pathological delimiter runs render in linear time", () => {
	// Each of these previously re-scanned the rest of the text once per delimiter,
	// taking tens of seconds at this size and far longer at the file size limit.
	const cases = [
		" _a\\_".repeat(32000),
		"[a".repeat(80000),
		"[a](b".repeat(32000),
		// The lone "](" here once drew a scan from every bracket before it; the
		// bracket stack spends at most one opener on it, safe target or not.
		"[a".repeat(80000) + "](javascript:x)",
		"[a".repeat(80000) + "](http://x)",
		// Each backtick of an unclosed run opens with a different length, so no
		// equal-length partner exists; each opener once measured and rescanned
		// the rest of the text. The leading letter keeps the line a paragraph
		// rather than a cheap code fence.
		"a" + "`".repeat(200000),
		// Every hard break spliced its two spaces back out of the rendered string,
		// flattening the whole accumulation each time. The letters keep the lines
		// non-blank, so this is one paragraph rather than many.
		"a  \n".repeat(200000),
		// Every target scan here fails at a different paren depth; the balance
		// index answers each in one lookup where a walk would rescan the rest
		// of the text.
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

	// The underline closes the whole paragraph, so every line of it lands in
	// the heading — not just the one directly above.
	assert.equal(renderMarkdown("Foo\nBar\n---"), "<h2>Foo Bar</h2>");
	assert.equal(renderMarkdown("Foo\nBar\n==="), "<h1>Foo Bar</h1>");
	assert.equal(renderMarkdown("before\n\nFoo\nBar\n---\nafter"), "<p>before</p>\n<h2>Foo Bar</h2>\n<p>after</p>");

	// Every one of these can be followed by a thematic break, and each was swallowed
	// into a heading while the underline was tested before the block it sits on.
	assert.equal(renderMarkdown("- a\n---"), "<ul><li>a</li></ul>\n<hr>");
	assert.equal(renderMarkdown("> q\n---"), "<blockquote><p>q</p></blockquote>\n<hr>");
	assert.equal(renderMarkdown("---\n---"), "<hr>\n<hr>");
	assert.equal(renderMarkdown("    code\n---"), "<pre><code>code</code></pre>\n<hr>");

	// A list of more than one item never regressed: the underline is not the line
	// directly below the first item, so the list branch got its turn regardless.
	assert.equal(renderMarkdown("- a\n- b\n---"), "<ul><li>a</li><li>b</li></ul>\n<hr>");

	// An underline indented four columns is no underline at all: after text it
	// is the paragraph continuing, and after a gap it is indented code. Three
	// columns is still within every block marker's allowance.
	assert.equal(renderMarkdown("Title\n    ---"), "<p>Title ---</p>");
	assert.equal(renderMarkdown("Title\n    ==="), "<p>Title ===</p>");
	assert.equal(renderMarkdown("Title\n\n    ---"), "<p>Title</p>\n<pre><code>---</code></pre>");
	assert.equal(renderMarkdown("Title\n   ---"), "<h2>Title</h2>");
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

	// A backslash before the newline is the other hard break, consumed with
	// it; an escaped backslash there is literal and the break stays soft, and
	// a backslash at the very end of the text has no newline to break.
	assert.equal(renderMarkdown("first\\\nsecond"), "<p>first<br>second</p>");
	assert.equal(renderMarkdown("first\\\\\nsecond"), "<p>first\\ second</p>");
	assert.equal(renderMarkdown("first\\"), "<p>first\\</p>");
});

test("decodes numeric and common named character references", () => {
	assert.equal(renderMarkdown("&copy; &#169; &#xA9; &Omega;"), "<p>© © © Ω</p>");

	// A decoded character is escaped like any other text, so a reference can
	// spell markup but never emit it — and &amp;copy; round-trips as text.
	assert.equal(renderMarkdown("&lt;b&gt; &amp;copy;"), "<p>&lt;b&gt; &amp;copy;</p>");

	// An unknown name, a bare ampersand, an unterminated reference, and an
	// escaped ampersand all stay the text they are.
	assert.equal(renderMarkdown("&bogus; AT&T &copy"), "<p>&amp;bogus; AT&amp;T &amp;copy</p>");
	assert.equal(renderMarkdown("\\&copy;"), "<p>&amp;copy;</p>");

	// Zero, surrogates, and points beyond Unicode become the replacement
	// character, as CommonMark requires.
	assert.equal(renderMarkdown("&#0; &#xD800; &#x110000;"), "<p>� � �</p>");

	// Code stays raw, and a link's destination is never decoded: the target
	// checked is the target opened.
	assert.equal(renderMarkdown("`&copy;`"), "<p><code>&amp;copy;</code></p>");
	assert.equal(
		renderMarkdown("[a](https://x.test/?q=&amp;b)"),
		'<p><a href="https://x.test/?q=&amp;amp;b" data-href="https://x.test/?q=&amp;amp;b" rel="noreferrer">a</a></p>',
	);
});

// Many entity values are glyphs a reader cannot tell from their neighbours —
// Greek capitals from Latin ones, minus signs from hyphens, no-break spaces
// from spaces — so the whole table is pinned to codepoints stated numerically,
// where a wrong character cannot hide.
test("every named reference decodes to the codepoint the name means", () => {
	const expected = {
		amp: 38, lt: 60, gt: 62, quot: 34, apos: 39,
		nbsp: 160, iexcl: 161, cent: 162, pound: 163, curren: 164, yen: 165,
		brvbar: 166, sect: 167, uml: 168, copy: 169, ordf: 170, laquo: 171,
		not: 172, shy: 173, reg: 174, macr: 175, deg: 176, plusmn: 177,
		sup2: 178, sup3: 179, acute: 180, micro: 181, para: 182, middot: 183,
		cedil: 184, sup1: 185, ordm: 186, raquo: 187, frac14: 188, frac12: 189,
		frac34: 190, iquest: 191, times: 215, divide: 247,
		Agrave: 192, Aacute: 193, Acirc: 194, Atilde: 195, Auml: 196, Aring: 197,
		AElig: 198, Ccedil: 199, Egrave: 200, Eacute: 201, Ecirc: 202, Euml: 203,
		Igrave: 204, Iacute: 205, Icirc: 206, Iuml: 207, ETH: 208, Ntilde: 209,
		Ograve: 210, Oacute: 211, Ocirc: 212, Otilde: 213, Ouml: 214, Oslash: 216,
		Ugrave: 217, Uacute: 218, Ucirc: 219, Uuml: 220, Yacute: 221, THORN: 222,
		szlig: 223, agrave: 224, aacute: 225, acirc: 226, atilde: 227, auml: 228,
		aring: 229, aelig: 230, ccedil: 231, egrave: 232, eacute: 233, ecirc: 234,
		euml: 235, igrave: 236, iacute: 237, icirc: 238, iuml: 239, eth: 240,
		ntilde: 241, ograve: 242, oacute: 243, ocirc: 244, otilde: 245, ouml: 246,
		oslash: 248, ugrave: 249, uacute: 250, ucirc: 251, uuml: 252, yacute: 253,
		thorn: 254, yuml: 255, OElig: 0x152, oelig: 0x153,
		ensp: 0x2002, emsp: 0x2003, thinsp: 0x2009, ndash: 0x2013, mdash: 0x2014,
		lsquo: 0x2018, rsquo: 0x2019, sbquo: 0x201a, ldquo: 0x201c, rdquo: 0x201d,
		bdquo: 0x201e, dagger: 0x2020, Dagger: 0x2021, bull: 0x2022, hellip: 0x2026,
		permil: 0x2030, prime: 0x2032, Prime: 0x2033, lsaquo: 0x2039, rsaquo: 0x203a,
		oline: 0x203e, frasl: 0x2044, euro: 0x20ac, trade: 0x2122,
		larr: 0x2190, uarr: 0x2191, rarr: 0x2192, darr: 0x2193, harr: 0x2194,
		crarr: 0x21b5, lArr: 0x21d0, uArr: 0x21d1, rArr: 0x21d2, dArr: 0x21d3,
		hArr: 0x21d4,
		forall: 0x2200, part: 0x2202, exist: 0x2203, empty: 0x2205, nabla: 0x2207,
		isin: 0x2208, notin: 0x2209, ni: 0x220b, prod: 0x220f, sum: 0x2211,
		minus: 0x2212, lowast: 0x2217, radic: 0x221a, prop: 0x221d, infin: 0x221e,
		ang: 0x2220, and: 0x2227, or: 0x2228, cap: 0x2229, cup: 0x222a,
		int: 0x222b, there4: 0x2234, sim: 0x223c, cong: 0x2245, asymp: 0x2248,
		ne: 0x2260, equiv: 0x2261, le: 0x2264, ge: 0x2265, sub: 0x2282,
		sup: 0x2283, nsub: 0x2284, sube: 0x2286, supe: 0x2287, oplus: 0x2295,
		otimes: 0x2297, perp: 0x22a5, sdot: 0x22c5, loz: 0x25ca,
		Alpha: 0x391, Beta: 0x392, Gamma: 0x393, Delta: 0x394, Epsilon: 0x395,
		Zeta: 0x396, Eta: 0x397, Theta: 0x398, Iota: 0x399, Kappa: 0x39a,
		Lambda: 0x39b, Mu: 0x39c, Nu: 0x39d, Xi: 0x39e, Omicron: 0x39f,
		Pi: 0x3a0, Rho: 0x3a1, Sigma: 0x3a3, Tau: 0x3a4, Upsilon: 0x3a5,
		Phi: 0x3a6, Chi: 0x3a7, Psi: 0x3a8, Omega: 0x3a9,
		alpha: 0x3b1, beta: 0x3b2, gamma: 0x3b3, delta: 0x3b4, epsilon: 0x3b5,
		zeta: 0x3b6, eta: 0x3b7, theta: 0x3b8, iota: 0x3b9, kappa: 0x3ba,
		lambda: 0x3bb, mu: 0x3bc, nu: 0x3bd, xi: 0x3be, omicron: 0x3bf,
		pi: 0x3c0, rho: 0x3c1, sigmaf: 0x3c2, sigma: 0x3c3, tau: 0x3c4,
		upsilon: 0x3c5, phi: 0x3c6, chi: 0x3c7, psi: 0x3c8, omega: 0x3c9,
		spades: 0x2660, clubs: 0x2663, hearts: 0x2665, diams: 0x2666,
	};

	const escapeHtml = (value) => value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");

	for (const [name, code] of Object.entries(expected)) {
		assert.equal(
			renderMarkdown(`&${name};`),
			`<p>${escapeHtml(String.fromCodePoint(code))}</p>`,
			`&${name};`,
		);
	}
});
