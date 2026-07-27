(function exposeMarkdownRenderer(globalObject) {
	"use strict";

	// Blocks, lists, and inline spans all recurse. Real documents nest a handful of
	// levels deep; a hostile one nests thousands and exhausts the stack, so past this
	// limit the remaining content is rendered as plain text instead of recursing.
	const MAX_NESTING_DEPTH = 64;

	function escapeHtml(value) {
		return String(value)
			.replaceAll("&", "&amp;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;")
			.replaceAll('"', "&quot;")
			.replaceAll("'", "&#39;");
	}

	// Only targets the viewer can actually act on are marked up as links: http(s) and
	// mailto, which it hands to the browser or mail client. Anything else — a relative
	// path, an absolute one, another scheme, a fragment — stays plain text, so a
	// document has no way to name a local file at all, let alone ask for one to open.
	function safeLinkTarget(value) {
		// The destination ends at the first whitespace; what follows is a
		// CommonMark title, dropped rather than folded into the target.
		const target = value.trim().match(/^\S*/)[0];
		if (!target || /[\u0000-\u001f\u007f]/.test(target)) {
			return null;
		}

		return /^(?:https?|mailto):/i.test(target) ? target : null;
	}

	// CommonMark lets a backslash escape ASCII punctuation and nothing else, so the
	// backslashes in ordinary prose — a Windows path, a TeX macro — stay literal.
	const ESCAPABLE_CHARACTER = /[!-\/:-@\[-`{-~]/;

	// escaped[i] is 1 when text[i] is punctuation behind an odd run of backslashes.
	// Judged once from the left of the whole string, so every scan agrees on what is
	// escaped no matter where it starts — which is what lets a failed scan speak for
	// later ones. The render loop consumes escape pairs from this same map, so the
	// two can never disagree about which backslashes are spent escaping.
	function escapedPositions(text) {
		const escaped = new Uint8Array(text.length);
		for (let index = 0; index + 1 < text.length; index += 1) {
			if (text[index] === "\\" && !escaped[index] && ESCAPABLE_CHARACTER.test(text[index + 1])) {
				escaped[index + 1] = 1;
			}
		}
		return escaped;
	}

	function findClosingBracket(text, escaped, start, marker) {
		for (let index = start; index <= text.length - marker.length; index += 1) {
			if (!escaped[index] && text.startsWith(marker, index)) {
				return index;
			}
		}
		return -1;
	}

	function runEnd(text, index, marker) {
		let end = index;
		while (end < text.length && text[end] === marker) {
			end += 1;
		}
		return end;
	}

	// Backtick runs, measured once. A code span closes at the next run at least as
	// long as its opener, so pairing hops run to run instead of rescanning text.
	function backtickRuns(text) {
		const runs = [];
		let index = text.indexOf("`");
		while (index !== -1) {
			const end = runEnd(text, index, "`");
			runs.push({ start: index, end });
			index = text.indexOf("`", end);
		}
		return runs;
	}

	// Code spans, resolved left to right before anything else looks at the text.
	// An opener takes the first later run long enough to close it; opening ticks
	// that no later run can match stay literal, and a closing run longer than
	// needed leaves its tail as the next opener. Settling spans first is what
	// lets the emphasis pass refuse delimiters inside them: CommonMark binds
	// code tighter than emphasis, so the * inside `a*b` may close nothing.
	function computeCodeSpans(text, escaped) {
		const runs = backtickRuns(text);

		// longestFrom[r] is the longest run length from run r onward, so an opener
		// longer than everything after it sheds its hopeless leading ticks at once.
		const longestFrom = new Array(runs.length + 1).fill(0);
		for (let r = runs.length - 1; r >= 0; r -= 1) {
			longestFrom[r] = Math.max(runs[r].end - runs[r].start, longestFrom[r + 1]);
		}

		const spans = [];
		let runIndex = 0;
		let position = 0;
		while (runIndex < runs.length) {
			const run = runs[runIndex];
			let start = Math.max(run.start, position);
			if (escaped[start]) {
				// Only a run's first tick can be escaped, and an escaped tick is
				// literal text, not an opener.
				start += 1;
			}
			if (start >= run.end || longestFrom[runIndex + 1] === 0) {
				runIndex += 1;
				continue;
			}
			let ticks = run.end - start;
			if (ticks > longestFrom[runIndex + 1]) {
				start = run.end - longestFrom[runIndex + 1];
				ticks = longestFrom[runIndex + 1];
			}
			let closer = runIndex + 1;
			while (runs[closer].end - runs[closer].start < ticks) {
				closer += 1;
			}
			spans.push({
				start,
				contentStart: start + ticks,
				contentEnd: runs[closer].start,
				end: runs[closer].start + ticks,
			});
			position = runs[closer].start + ticks;
			runIndex = closer;
		}
		return spans;
	}

	// CommonMark judges flanking with two character classes: Unicode whitespace
	// and Unicode punctuation (which takes in the symbol categories).
	const UNICODE_PUNCTUATION = /[\p{P}\p{S}]/u;

	function isFlankingWhitespace(character) {
		return character === undefined || /\s/u.test(character);
	}

	function isFlankingPunctuation(character) {
		return character !== undefined && UNICODE_PUNCTUATION.test(character);
	}

	// Every * and _ run with CommonMark's flanking verdicts, consecutive markers
	// judged as one delimiter from the characters on either side of the whole
	// run. A run followed by whitespace cannot open and one preceded by it
	// cannot close — what keeps "a * b * c" prose — and the punctuation clauses
	// settle runs pressed against punctuation. `_` is stricter: flanked by
	// letters on both sides it can do neither, so snake_case_here survives.
	// Runs inside code spans are no delimiters at all.
	function emphasisDelimiters(text, escaped, codeSpans) {
		const delimiters = [];
		let spanIndex = 0;
		let index = 0;
		while (index < text.length) {
			if (spanIndex < codeSpans.length && index >= codeSpans[spanIndex].start) {
				index = codeSpans[spanIndex].end;
				spanIndex += 1;
				continue;
			}
			const character = text[index];
			if ((character !== "*" && character !== "_") || escaped[index]) {
				index += 1;
				continue;
			}
			let end = index;
			while (end < text.length && text[end] === character && !escaped[end]) {
				end += 1;
			}
			const before = text[index - 1];
			const after = text[end];
			const leftFlanking = !isFlankingWhitespace(after)
				&& (!isFlankingPunctuation(after) || isFlankingWhitespace(before) || isFlankingPunctuation(before));
			const rightFlanking = !isFlankingWhitespace(before)
				&& (!isFlankingPunctuation(before) || isFlankingWhitespace(after) || isFlankingPunctuation(after));
			const canOpen = character === "*" ? leftFlanking : leftFlanking && (!rightFlanking || isFlankingPunctuation(before));
			const canClose = character === "*" ? rightFlanking : rightFlanking && (!leftFlanking || isFlankingPunctuation(after));
			if (canOpen || canClose) {
				delimiters.push({ character, start: index, end, length: end - index, originalLength: end - index, canOpen, canClose });
			}
			index = end;
		}
		return delimiters;
	}

	// CommonMark's rule of three: when either side of a candidate pair could
	// face both ways, run lengths summing to a multiple of three cannot pair —
	// unless both are multiples of three themselves. This is what sends the
	// inner ** of *foo**bar**baz* looking past the outer * for its partner.
	function breaksRuleOfThree(opener, closer) {
		return (closer.canOpen || opener.canClose)
			&& (opener.originalLength + closer.originalLength) % 3 === 0
			&& (opener.originalLength % 3 !== 0 || closer.originalLength % 3 !== 0);
	}

	// CommonMark's delimiter matching. Each closing run pairs with the nearest
	// compatible opener still on the stack, two markers at a time as <strong>
	// and then singly as <em>; an opener spends markers from its right end and
	// a closer from its left, which is how ***a*** nests instead of breaking.
	// Openers left between a matched pair sit inside the new emphasis and can
	// never pair outward, so they leave the stack with it. Pairs are keyed by
	// the position of the opener's first spent marker — the exact index at
	// which the render loop will meet them.
	function matchEmphasisPairs(delimiters) {
		const pairs = new Map();
		const openers = [];

		// A search that came up empty speaks for every later closer of the same
		// kind — same character, length class, and facing — so each kind records
		// the depth below which looking again is pointless. Without this, a pile
		// of openers that all fail the rule of three is rescanned whole by every
		// closer that follows.
		const searchFloor = new Map();

		for (const delimiter of delimiters) {
			if (!delimiter.canClose) {
				if (delimiter.canOpen) {
					openers.push(delimiter);
				}
				continue;
			}
			while (delimiter.length > 0) {
				const kind = `${delimiter.character}/${delimiter.originalLength % 3}/${delimiter.canOpen}`;
				const floor = searchFloor.get(kind) || 0;
				let openerIndex = openers.length - 1;
				while (openerIndex >= floor
					&& (openers[openerIndex].character !== delimiter.character
						|| breaksRuleOfThree(openers[openerIndex], delimiter))) {
					openerIndex -= 1;
				}
				if (openerIndex < floor) {
					searchFloor.set(kind, openers.length);
					break;
				}
				const opener = openers[openerIndex];
				const spend = Math.min(2, opener.length, delimiter.length);
				opener.length -= spend;
				opener.end -= spend;
				pairs.set(opener.end, { spend, closerStart: delimiter.start });
				delimiter.length -= spend;
				delimiter.start += spend;
				const keep = opener.length > 0 ? openerIndex + 1 : openerIndex;
				openers.length = keep;
				for (const [recordedKind, recordedFloor] of searchFloor) {
					if (recordedFloor > keep) {
						searchFloor.set(recordedKind, keep);
					}
				}
			}
			if (delimiter.length > 0 && delimiter.canOpen) {
				openers.push(delimiter);
			}
		}
		return pairs;
	}

	function renderInline(text, depth = 0) {
		if (depth > MAX_NESTING_DEPTH) {
			return escapeHtml(text);
		}

		const escaped = escapedPositions(text);

		// Code spans and emphasis are settled before rendering starts: spans
		// first, then delimiter pairing over everything outside them. The loop
		// below just plays the decisions back — a delimiter it meets either
		// begins a recorded pair or is literal text.
		const codeSpans = computeCodeSpans(text, escaped);
		const codeSpanAt = new Map();
		for (const span of codeSpans) {
			codeSpanAt.set(span.start, span);
		}
		const emphasisPairs = matchEmphasisPairs(emphasisDelimiters(text, escaped, codeSpans));

		// If no "](" exists from one point, none exists from any later point, so a
		// failed label scan is worth remembering: without this a long run of "["
		// rescans the rest of the text once per bracket. That guarantee needs every
		// scan to agree on which characters are escaped, hence the precomputed map
		// rather than counting backslashes from wherever a scan happens to start.
		let labelScanFailedFrom = Infinity;

		function findLabelEnd(start) {
			if (start >= labelScanFailedFrom) {
				return -1;
			}
			const end = findClosingBracket(text, escaped, start, "](");
			if (end === -1) {
				labelScanFailedFrom = start;
			}
			return end;
		}

		// A link target ends at the first unescaped ")" that is not matching a "("
		// opened inside it, so a parenthesised URL survives whole. That closer is
		// the first ")" whose running paren balance equals the scan start's, so
		// indexing the ")"s by balance turns each search into one binary lookup.
		// The failed-scan memo cannot cover this marker any more: a failed balance
		// scan says nothing about later scans, which start at depth zero afresh.
		const parenBalance = new Int32Array(text.length + 1);
		const parenClosers = new Map();
		for (let index = 0; index < text.length; index += 1) {
			let delta = 0;
			if (!escaped[index] && text[index] === "(") {
				delta = 1;
			} else if (!escaped[index] && text[index] === ")") {
				delta = -1;
				let closers = parenClosers.get(parenBalance[index]);
				if (!closers) {
					parenClosers.set(parenBalance[index], closers = []);
				}
				closers.push(index);
			}
			parenBalance[index + 1] = parenBalance[index] + delta;
		}

		function findClosingParen(start) {
			const closers = parenClosers.get(parenBalance[start]);
			if (!closers) {
				return -1;
			}
			let low = 0;
			let high = closers.length;
			while (low < high) {
				const middle = (low + high) >> 1;
				if (closers[middle] < start) {
					low = middle + 1;
				} else {
					high = middle;
				}
			}
			return low < closers.length ? closers[low] : -1;
		}

		// A `[` whose target turns out to be unsafe consumes nothing, and the scan that
		// found that target succeeded, so the failed-scan memo has nothing to say about
		// it. Every earlier `[` reaches this same `](` — there is no closer one, or the
		// scan would have stopped there — and so is rejected over the same target.
		// Without this a run of `[` before one bad link rescans the rest of the text
		// once per bracket.
		let rejectedLabelEnd = -1;

		// A link parsed from its opening bracket, or null when no safe link
		// starts there. Shared by plain links and image syntax.
		function tryLink(start) {
			if (start + 1 <= rejectedLabelEnd) {
				return null;
			}
			const labelEnd = findLabelEnd(start + 1);
			if (labelEnd === -1) {
				return null;
			}
			const targetEnd = findClosingParen(labelEnd + 2);
			if (targetEnd === -1) {
				return null;
			}
			const target = safeLinkTarget(text.slice(labelEnd + 2, targetEnd));
			if (!target) {
				rejectedLabelEnd = labelEnd;
				return null;
			}
			const attribute = escapeHtml(target);
			const label = renderInline(text.slice(start + 1, labelEnd), depth + 1);
			return {
				html: `<a href="${attribute}" data-href="${attribute}" rel="noreferrer">${label}</a>`,
				nextIndex: targetEnd + 1,
			};
		}

		let html = "";
		let index = 0;

		while (index < text.length) {
			if (text[index] === "\\" && escaped[index + 1]) {
				html += escapeHtml(text[index + 1]);
				index += 2;
				continue;
			}

			if (text[index] === "`") {
				const span = codeSpanAt.get(index);
				if (span) {
					html += `<code>${escapeHtml(text.slice(span.contentStart, span.contentEnd).trim())}</code>`;
					index = span.end;
					continue;
				}
			}

			// The viewer loads no remote content, so an image is shown as the one
			// thing it can honour: a link to the source, labelled by the alt text.
			// A bang followed by no safe link is literal like any other character.
			if (text[index] === "!" && text[index + 1] === "[") {
				const link = tryLink(index + 1);
				if (link) {
					html += link.html;
					index = link.nextIndex;
					continue;
				}
			}

			if (text[index] === "[") {
				const link = tryLink(index);
				if (link) {
					html += link.html;
					index = link.nextIndex;
					continue;
				}
			}

			if (text[index] === "*" || text[index] === "_") {
				const pair = emphasisPairs.get(index);
				if (pair) {
					const tag = pair.spend === 2 ? "strong" : "em";
					html += `<${tag}>${renderInline(text.slice(index + pair.spend, pair.closerStart), depth + 1)}</${tag}>`;
					index = pair.closerStart + pair.spend;
					continue;
				}
			}

			// Spaces are taken as a whole run so a hard break replaces its trailing
			// spaces as they are met, never after the fact: splicing them back out of
			// the rendered string re-flattened it each time, which made a paragraph
			// of hard breaks quadratic. Every other construct ends at a delimiter,
			// so a run before a newline can never have been partly consumed.
			if (text[index] === " ") {
				const end = runEnd(text, index, " ");
				if (text[end] === "\n" && end - index >= 2) {
					html += "<br>";
					index = end + 1;
				} else {
					html += text.slice(index, end);
					index = end;
				}
				continue;
			}

			if (text[index] === "\n") {
				html += " ";
				index += 1;
				continue;
			}

			html += escapeHtml(text[index]);
			index += 1;
		}

		return html;
	}

	function listMatch(line) {
		const match = line.match(/^(\s*)([-+*]|\d+[.)])(\s+)(.+)$/);
		if (!match) {
			return null;
		}

		return {
			content: match[4],
			indent: match[1].replaceAll("\t", "    ").length,
			// The column where the item's content begins, which is what a
			// continuation line must be dedented by to mean what it would at
			// top level — no more, or a code block inside the item flattens.
			contentIndent: (match[1] + match[2] + match[3]).replaceAll("\t", "    ").length,
			ordered: /^\d/.test(match[2]),
			start: /^\d/.test(match[2]) ? Number.parseInt(match[2], 10) : null,
		};
	}

	// Removes leading whitespace up to `width` columns, tabs counting four as
	// indentWidth judges them; whatever indent the line carries past that point
	// is meaningful and stays.
	function dedent(line, width) {
		let column = 0;
		let index = 0;
		while (index < line.length && column < width) {
			if (line[index] === " ") {
				column += 1;
			} else if (line[index] === "\t") {
				column += 4;
			} else {
				break;
			}
			index += 1;
		}
		return line.slice(index);
	}

	function indentWidth(line) {
		return (line.match(/^\s*/) || [""])[0].replaceAll("\t", "    ").length;
	}

	function nextContentLine(lines, index) {
		while (index < lines.length && lines[index].trim() === "") {
			index += 1;
		}
		return index;
	}

	function isBlockStart(lines, index) {
		const line = lines[index] || "";
		const next = lines[index + 1] || "";
		// Indented code is deliberately absent: an indented line after text is a
		// hanging indent continuing the paragraph, not the start of a code block.
		return /^ {0,3}(#{1,6})\s+/.test(line)
			|| /^ {0,3}(```+|~~~+)/.test(line)
			|| /^ {0,3}>\s?/.test(line)
			|| /^ {0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)
			|| listMatch(line) !== null
			|| (/^\s*(=+|-+)\s*$/.test(next) && line.trim() !== "");
	}

	// Paragraph text is escaped, so an interior </p> can only be a real block
	// boundary — unwrapping across one would splice tags out of a multi-block item.
	function unwrapSingleParagraph(html) {
		const match = html.match(/^<p>([\s\S]*)<\/p>$/);
		return match && !match[1].includes("</p>") ? match[1] : html;
	}

	function renderList(lines, startIndex, depth = 0) {
		const first = listMatch(lines[startIndex]);
		const baseIndent = first.indent;
		const ordered = first.ordered;
		const tag = ordered ? "ol" : "ul";
		const startAttribute = ordered && first.start !== 1 ? ` start="${first.start}"` : "";
		const items = [];
		let loose = false;
		let index = startIndex;

		while (index < lines.length) {
			if (lines[index].trim() === "") {
				// A blank line ends the list only when no sibling item follows it;
				// when one does, the gap continues the list and makes it loose.
				const next = nextContentLine(lines, index);
				const sibling = next < lines.length ? listMatch(lines[next]) : null;
				if (!sibling || sibling.indent !== baseIndent || sibling.ordered !== ordered) {
					break;
				}
				loose = true;
				index = next;
				continue;
			}

			const item = listMatch(lines[index]);
			if (!item || item.indent !== baseIndent || item.ordered !== ordered) {
				break;
			}

			index += 1;
			const contentLines = [item.content];
			let nestedHtml = "";

			while (index < lines.length) {
				const nestedItem = listMatch(lines[index]);
				if (nestedItem) {
					if (nestedItem.indent > baseIndent) {
						if (depth >= MAX_NESTING_DEPTH) {
							// Too deep to open another list; fold the line into this item
							// instead, which also guarantees index still advances.
							contentLines.push(dedent(lines[index], item.contentIndent));
							index += 1;
							continue;
						}
						const nested = renderList(lines, index, depth + 1);
						nestedHtml += nested.html;
						index = nested.nextIndex;
						continue;
					}
					break;
				}

				if (lines[index].trim() === "") {
					// Anything indented past the marker after a gap still belongs
					// to this item, split into paragraphs by the gap — which also
					// makes the list loose. Anything else is the next item's or
					// the list's end, both the outer loop's to judge.
					const next = nextContentLine(lines, index);
					if (next === lines.length || indentWidth(lines[next]) <= baseIndent) {
						break;
					}
					loose = true;
					contentLines.push("");
					index = next;
					continue;
				}

				if (indentWidth(lines[index]) > baseIndent) {
					contentLines.push(dedent(lines[index], item.contentIndent));
					index += 1;
					continue;
				}
				break;
			}

			items.push({ contentLines, nestedHtml });
		}

		// Rendered only now because looseness belongs to the whole list: a gap
		// before its last item still wraps its first in <p>.
		let html = `<${tag}${startAttribute}>`;
		for (const { contentLines, nestedHtml } of items) {
			const rendered = renderBlocks(contentLines, 0, depth + 1).html;
			html += `<li>${loose ? rendered : unwrapSingleParagraph(rendered)}${nestedHtml}</li>`;
		}
		html += `</${tag}>`;
		return { html, nextIndex: index };
	}

	function renderBlocks(lines, initialIndex = 0, depth = 0) {
		// Only ever reached through a nested call, where `lines` is a slice of one
		// block's own content, so consuming the rest of it here is contained.
		if (depth > MAX_NESTING_DEPTH) {
			const text = lines.slice(initialIndex).join("\n").trim();
			return { html: text === "" ? "" : `<p>${escapeHtml(text)}</p>`, nextIndex: lines.length };
		}

		const output = [];
		let index = initialIndex;

		while (index < lines.length) {
			const line = lines[index];

			if (line.trim() === "") {
				index += 1;
				continue;
			}

			const fence = line.match(/^ {0,3}(```+|~~~+)(.*)$/);
			if (fence) {
				const marker = fence[1];
				const closingFence = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`);
				const codeLines = [];
				index += 1;
				while (index < lines.length && !closingFence.test(lines[index])) {
					codeLines.push(lines[index]);
					index += 1;
				}
				if (index < lines.length) {
					index += 1;
				}
				output.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
				continue;
			}

			const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
			if (heading) {
				const level = heading[1].length;
				output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
				index += 1;
				continue;
			}

			if (/^ {0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
				output.push("<hr>");
				index += 1;
				continue;
			}

			if (/^ {0,3}>\s?/.test(line)) {
				const quoteLines = [];
				while (index < lines.length && /^ {0,3}>\s?/.test(lines[index])) {
					quoteLines.push(lines[index].replace(/^ {0,3}>\s?/, ""));
					index += 1;
				}
				output.push(`<blockquote>${renderBlocks(quoteLines, 0, depth + 1).html}</blockquote>`);
				continue;
			}

			if (/^ {4}/.test(line)) {
				const codeLines = [];
				while (index < lines.length && (/^ {4}/.test(lines[index]) || lines[index] === "")) {
					codeLines.push(lines[index].replace(/^ {4}/, ""));
					index += 1;
				}
				output.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
				continue;
			}

			if (listMatch(line)) {
				const list = renderList(lines, index, depth);
				output.push(list.html);
				index = list.nextIndex;
				continue;
			}

			// Last, because a `---` underline only makes a heading of a line that would
			// otherwise have been a paragraph. Tried any earlier it also swallows the
			// line above a thematic break — a one-item list, a quote, another rule —
			// since every one of those can be followed by `---`. This is the order
			// `isBlockStart` already uses to decide where a paragraph stops.
			if (index + 1 < lines.length && /^\s*(=+|-+)\s*$/.test(lines[index + 1]) && line.trim()) {
				const level = lines[index + 1].trim()[0] === "=" ? 1 : 2;
				output.push(`<h${level}>${renderInline(line.trim())}</h${level}>`);
				index += 2;
				continue;
			}

			const paragraph = [line.trimStart()];
			index += 1;
			while (index < lines.length && lines[index].trim() !== "" && !isBlockStart(lines, index)) {
				paragraph.push(lines[index].trimStart());
				index += 1;
			}
			output.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
		}

		return { html: output.join("\n"), nextIndex: index };
	}

	function renderMarkdown(markdown) {
		const normalized = String(markdown ?? "").replace(/\r\n?/g, "\n");
		return renderBlocks(normalized.split("\n")).html;
	}

	const api = { escapeHtml, renderMarkdown };
	if (typeof module !== "undefined" && module.exports) {
		module.exports = api;
	}
	if (globalObject) {
		globalObject.markdown = api;
	}
})(typeof window === "undefined" ? null : window);
