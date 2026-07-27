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
		const target = value.trim();
		if (!target || /[\u0000-\u001f\u007f]/.test(target)) {
			return null;
		}

		return /^(?:https?|mailto):/i.test(target) ? target : null;
	}

	// escaped[i] is 1 when text[i] sits behind an odd run of backslashes. Judged once
	// from the left of the whole string, so every scan agrees on what is escaped no
	// matter where it starts — which is what lets a failed scan speak for later ones.
	function escapedPositions(text) {
		const escaped = new Uint8Array(text.length);
		for (let index = 0; index + 1 < text.length; index += 1) {
			if (text[index] === "\\" && !escaped[index]) {
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

	function isWordCharacter(character) {
		return character !== undefined && /[\p{L}\p{N}]/u.test(character);
	}

	// Consecutive markers act as one delimiter, so flanking is judged from the
	// characters on either side of the whole run rather than a single marker.
	function runStart(text, index, marker) {
		let start = index;
		while (start > 0 && text[start - 1] === marker) {
			start -= 1;
		}
		return start;
	}

	function runEnd(text, index, marker) {
		let end = index;
		while (end < text.length && text[end] === marker) {
			end += 1;
		}
		return end;
	}

	// Backtick runs, measured once. A code span closes at the next run at least as
	// long as its opener, so a search can hop run to run instead of rescanning text —
	// and, knowing the longest length that remains, a doomed search can give up at
	// once. The failed-scan memo cannot do this job: each backtick of an unclosed
	// run is a fresh opener of a different length, so no two scans share a marker.
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

	// One linear pass. A rejected `_` run is skipped whole rather than re-scanned from
	// its second character, which keeps pathological delimiter runs from going quadratic.
	function findClosingEmphasis(text, escaped, start, marker) {
		let index = start;

		while (index <= text.length - marker.length) {
			if (!escaped[index] && text.startsWith(marker, index)) {
				if (marker[0] !== "_") {
					return index;
				}
				const after = runEnd(text, index, "_");
				if (!isWordCharacter(text[after])) {
					return index;
				}
				index = after;
				continue;
			}
			index += 1;
		}

		return -1;
	}

	function renderInline(text, depth = 0) {
		if (depth > MAX_NESTING_DEPTH) {
			return escapeHtml(text);
		}

		// If no closer exists from one point, none exists from any later point, so a
		// failed scan is worth remembering: without this a long run of `_` or `[`
		// rescans the rest of the text once per character. That guarantee needs every
		// scan to agree on which characters are escaped, hence the precomputed map
		// rather than counting backslashes from wherever a scan happens to start.
		const escaped = escapedPositions(text);
		const exhausted = { "](": Infinity, ")": Infinity, "*": Infinity, "**": Infinity, _: Infinity, __: Infinity };

		// longestTickRun[r] is the longest backtick run length from run r onward, so
		// an opener longer than everything after it fails without walking the runs.
		const tickRuns = backtickRuns(text);
		const longestTickRun = new Array(tickRuns.length + 1).fill(0);
		for (let r = tickRuns.length - 1; r >= 0; r -= 1) {
			longestTickRun[r] = Math.max(tickRuns[r].end - tickRuns[r].start, longestTickRun[r + 1]);
		}
		let tickRunIndex = 0;

		// Every position in a run shares one run start, and the loop usually steps
		// through a run one character at a time, so carry the last answer forward
		// rather than walking the run again from each of its characters.
		let cachedRunIndex = -1;
		let cachedRunStart = -1;

		// A `[` whose target turns out to be unsafe consumes nothing, and the scan that
		// found that target succeeded, so `exhausted` has nothing to say about it. Every
		// earlier `[` reaches this same `](` — there is no closer one, or the scan would
		// have stopped there — and so is rejected over the same target. Without this a
		// run of `[` before one bad link rescans the rest of the text once per bracket.
		let rejectedLabelEnd = -1;

		// CommonMark allows `*` to emphasise inside a word but not `_`, so identifiers
		// and file names such as snake_case_here survive intact.
		function canOpen(index, marker) {
			if (marker[0] !== "_") {
				return true;
			}

			// Reused both for a second marker tried at the same position and for the
			// next character of the same run.
			const sameRun = cachedRunIndex === index
				|| (cachedRunIndex === index - 1 && text[index - 1] === "_");
			const start = sameRun ? cachedRunStart : runStart(text, index, "_");
			cachedRunIndex = index;
			cachedRunStart = start;

			return !isWordCharacter(text[start - 1]);
		}

		function findCloser(start, marker) {
			if (start >= exhausted[marker]) {
				return -1;
			}
			const scan = marker === "](" || marker === ")" ? findClosingBracket : findClosingEmphasis;
			const end = scan(text, escaped, start, marker);
			if (end === -1) {
				exhausted[marker] = start;
			}
			return end;
		}

		let html = "";
		let index = 0;

		while (index < text.length) {
			if (text[index] === "\\" && index + 1 < text.length) {
				html += escapeHtml(text[index + 1]);
				index += 2;
				continue;
			}

			if (text[index] === "`") {
				while (tickRuns[tickRunIndex].end <= index) {
					tickRunIndex += 1;
				}
				const ticks = tickRuns[tickRunIndex].end - index;
				if (longestTickRun[tickRunIndex + 1] >= ticks) {
					let closer = tickRunIndex + 1;
					while (tickRuns[closer].end - tickRuns[closer].start < ticks) {
						closer += 1;
					}
					const code = text.slice(index + ticks, tickRuns[closer].start).trim();
					html += `<code>${escapeHtml(code)}</code>`;
					index = tickRuns[closer].start + ticks;
					continue;
				}
			}

			if (text[index] === "[" && index + 1 > rejectedLabelEnd) {
				const labelEnd = findCloser(index + 1, "](");
				if (labelEnd !== -1) {
					const targetEnd = findCloser(labelEnd + 2, ")");
					if (targetEnd !== -1) {
						const label = text.slice(index + 1, labelEnd);
						const rawTarget = text.slice(labelEnd + 2, targetEnd);
						const target = safeLinkTarget(rawTarget);
						if (target) {
							const attribute = escapeHtml(target);
							html += `<a href="${attribute}" data-href="${attribute}" rel="noreferrer">${renderInline(label, depth + 1)}</a>`;
							index = targetEnd + 1;
							continue;
						}
						rejectedLabelEnd = labelEnd;
					}
				}
			}

			const strongMarker = text.startsWith("**", index) ? "**" : text.startsWith("__", index) ? "__" : null;
			if (strongMarker && canOpen(index, strongMarker)) {
				const end = findCloser(index + 2, strongMarker);
				if (end > index + 2) {
					html += `<strong>${renderInline(text.slice(index + 2, end), depth + 1)}</strong>`;
					index = end + 2;
					continue;
				}
			}

			const emphasisMarker = text[index] === "*" || text[index] === "_" ? text[index] : null;
			if (emphasisMarker && canOpen(index, emphasisMarker)) {
				const end = findCloser(index + 1, emphasisMarker);
				if (end > index + 1) {
					html += `<em>${renderInline(text.slice(index + 1, end), depth + 1)}</em>`;
					index = end + 1;
					continue;
				}
			}

			if (text[index] === "\n") {
				const hardBreak = index >= 2 && text.slice(index - 2, index) === "  ";
				if (hardBreak) {
					html = html.slice(0, -2) + "<br>";
				} else {
					html += " ";
				}
				index += 1;
				continue;
			}

			html += escapeHtml(text[index]);
			index += 1;
		}

		return html;
	}

	function listMatch(line) {
		const match = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/);
		if (!match) {
			return null;
		}

		return {
			content: match[3],
			indent: match[1].replaceAll("\t", "    ").length,
			ordered: /^\d/.test(match[2]),
			start: /^\d/.test(match[2]) ? Number.parseInt(match[2], 10) : null,
		};
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
		let html = `<${tag}${startAttribute}>`;
		let index = startIndex;

		while (index < lines.length) {
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
							contentLines.push(lines[index].trim());
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
					break;
				}

				const indentation = (lines[index].match(/^\s*/) || [""])[0].replaceAll("\t", "    ").length;
				if (indentation > baseIndent) {
					contentLines.push(lines[index].trim());
					index += 1;
					continue;
				}
				break;
			}

			const content = unwrapSingleParagraph(renderBlocks(contentLines, 0, depth + 1).html);
			html += `<li>${content}${nestedHtml}</li>`;
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
				const codeLines = [];
				index += 1;
				while (index < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[index])) {
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
