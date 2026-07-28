(function exposeMarkdownRenderer(globalObject) {
	"use strict";

	// Blocks and lists recurse. Real documents nest a handful of levels deep; a
	// hostile one nests thousands and exhausts the stack, so past this limit the
	// remaining content is rendered as plain text instead of recursing. Inline
	// rendering is iterative and borrows the limit only to bound how deeply the
	// tags it emits can nest.
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

		// The main process refuses to open targets longer than this, so marking
		// one up would only make a link that goes nowhere when clicked.
		if (target.length > 2048) {
			return null;
		}
		if (!target || /[\u0000-\u001f\u007f]/.test(target)) {
			return null;
		}

		return /^(?:https?|mailto):/i.test(target) ? target : null;
	}

	// CommonMark lets a backslash escape ASCII punctuation and nothing else, so the
	// backslashes in ordinary prose — a Windows path, a TeX macro — stay literal.
	const ESCAPABLE_CHARACTER = /[!-\/:-@\[-`{-~]/;

	// escaped[i] is 1 when text[i] is punctuation behind an odd run of backslashes.
	// Judged once from the left of the whole string, so every pass — code spans,
	// links, emphasis — agrees on what is escaped no matter where it looks. The
	// render loop consumes escape pairs from this same map, so the two can never
	// disagree about which backslashes are spent escaping.
	function escapedPositions(text) {
		const escaped = new Uint8Array(text.length);
		for (let index = 0; index + 1 < text.length; index += 1) {
			if (text[index] === "\\" && !escaped[index] && ESCAPABLE_CHARACTER.test(text[index + 1])) {
				escaped[index + 1] = 1;
			}
		}
		return escaped;
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
	// A span opens at a backtick run and closes at the next run of exactly the
	// same length, as CommonMark demands; a run with no equal-length partner
	// after it stays literal whole, and scanning resumes at the very next run.
	// Settling spans first is what lets the emphasis pass refuse delimiters
	// inside them: CommonMark binds code tighter than emphasis, so the * inside
	// `a*b` may close nothing.
	function computeCodeSpans(text, escaped) {
		const runs = [];
		for (const run of backtickRuns(text)) {
			// Only a run's first tick can be escaped, and an escaped tick is
			// literal text, not part of a delimiter.
			const start = escaped[run.start] ? run.start + 1 : run.start;
			if (start < run.end) {
				runs.push({ start, end: run.end });
			}
		}

		// Run indices grouped by length, in text order, so an opener finds its
		// first equal-length partner in one binary search — a pile of unequal
		// runs would otherwise be rescanned once per opener.
		const runsOfLength = new Map();
		for (let index = 0; index < runs.length; index += 1) {
			const length = runs[index].end - runs[index].start;
			let indices = runsOfLength.get(length);
			if (!indices) {
				runsOfLength.set(length, indices = []);
			}
			indices.push(index);
		}

		const spans = [];
		let runIndex = 0;
		while (runIndex < runs.length) {
			const run = runs[runIndex];
			const indices = runsOfLength.get(run.end - run.start);
			// First equal-length run after this one.
			let low = 0;
			let high = indices.length;
			while (low < high) {
				const middle = (low + high) >> 1;
				if (indices[middle] <= runIndex) {
					low = middle + 1;
				} else {
					high = middle;
				}
			}
			if (low === indices.length) {
				runIndex += 1;
				continue;
			}
			const closer = runs[indices[low]];
			spans.push({
				start: run.start,
				contentStart: run.end,
				contentEnd: closer.start,
				end: closer.end,
			});
			runIndex = indices[low] + 1;
		}
		return spans;
	}

	// A code span's content, by CommonMark's stripping rule: line endings count
	// as spaces, and one space comes off each end only when both ends have one
	// and something besides spaces remains. The padding exists so a span can
	// hold backticks — `` ` `` — not to be trimmed away wholesale; a span of
	// nothing but spaces keeps them all.
	function codeSpanContent(raw) {
		const content = raw.replaceAll("\n", " ");
		if (content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "") {
			return content.slice(1, -1);
		}
		return content;
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

	// Links are settled in one pass over the whole text, after code spans and
	// before emphasis. Every unescaped "[" outside a code span — code binds
	// tighter, so a span may swallow a bracket — goes on a stack, and a "]("
	// closes the nearest one still open, as CommonMark demands: in
	// "[a [b](url)" the inner bracket takes the link and "[a " stays text. A
	// "]" that forms no link — nothing follows it, no balanced ")", a target
	// safeLinkTarget rejects — spends its opener as text, which is how the
	// outer pair of "[a[b]c](url)" still reaches its "](". Each bracket is
	// pushed once and popped at most once, so no position is ever rescanned.
	function computeLinks(text, escaped, codeSpans) {
		const links = [];
		if (text.indexOf("[") === -1) {
			return links;
		}

		// A link target ends at the first unescaped ")" that is not matching a "("
		// opened inside it, so a parenthesised URL survives whole. That closer is
		// the first ")" whose running paren balance equals the scan start's, so
		// indexing the ")"s by balance turns each search into one binary lookup
		// where a walk would rescan the rest of the text once per "](".
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

		const openers = [];
		let spanIndex = 0;
		let index = 0;
		while (index < text.length) {
			if (spanIndex < codeSpans.length && codeSpans[spanIndex].end <= index) {
				spanIndex += 1;
				continue;
			}
			if (spanIndex < codeSpans.length && index >= codeSpans[spanIndex].start) {
				index = codeSpans[spanIndex].end;
				spanIndex += 1;
				continue;
			}
			const character = text[index];
			if (escaped[index] || (character !== "[" && character !== "]")) {
				index += 1;
				continue;
			}
			if (character === "[") {
				openers.push(index);
				index += 1;
				continue;
			}
			if (openers.length === 0) {
				index += 1;
				continue;
			}
			if (text[index + 1] !== "(") {
				// A bare "]" and its "[" fail together, as text — CommonMark has
				// reference links to try here; this renderer has only literal.
				openers.pop();
				index += 1;
				continue;
			}
			const targetEnd = findClosingParen(index + 2);
			const target = targetEnd === -1 ? null : safeLinkTarget(text.slice(index + 2, targetEnd));
			if (!target) {
				// The bracket pair is spent either way; the "(" and what follows
				// were never consumed and are scanned as the text they are.
				openers.pop();
				index += 1;
				continue;
			}
			const bracket = openers.pop();
			// Brackets opened before a link die with it — nothing may reach
			// across a link to a later "](" — so a label can never hold a
			// complete link and the links come out disjoint, in text order.
			openers.length = 0;
			// The viewer loads no remote content, so an image is shown as the one
			// thing it can honour: a link to the source, labelled by the alt text.
			// A bang ahead of no safe link is literal like any other character.
			const image = bracket > 0 && text[bracket - 1] === "!" && !escaped[bracket - 1];
			links.push({
				start: image ? bracket - 1 : bracket,
				labelStart: bracket + 1,
				labelEnd: index,
				targetEnd,
				target,
			});
			index = targetEnd + 1;
		}
		return links;
	}

	// Emphasis is paired within each link label apart from the text outside: a
	// link, once formed, is a boundary emphasis cannot cross, which is why the
	// links are settled first. Delimiters between a label's end and its
	// target's ")" sit inside consumed link syntax and can pair with nothing.
	// The scopes are disjoint and pairs are keyed by text position, so one map
	// holds every scope's verdicts for the render walk to meet.
	function computeEmphasisPairs(text, escaped, codeSpans, links) {
		const delimiters = emphasisDelimiters(text, escaped, codeSpans);
		if (delimiters.length === 0) {
			return new Map();
		}
		if (links.length === 0) {
			return matchEmphasisPairs(delimiters);
		}

		const pairs = new Map();
		const mergePairs = (scope) => {
			if (scope.length > 0) {
				for (const [key, pair] of matchEmphasisPairs(scope)) {
					pairs.set(key, pair);
				}
			}
		};

		const outside = [];
		let label = [];
		let labelOf = -1;
		let linkIndex = 0;
		for (const delimiter of delimiters) {
			while (linkIndex < links.length && links[linkIndex].targetEnd < delimiter.start) {
				linkIndex += 1;
			}
			const link = linkIndex < links.length ? links[linkIndex] : null;
			if (!link || delimiter.start < link.start) {
				outside.push(delimiter);
			} else if (delimiter.start >= link.labelStart && delimiter.end <= link.labelEnd) {
				// A run never straddles a label boundary — "[" and "]" break it —
				// so containment needs no splitting.
				if (labelOf !== linkIndex) {
					mergePairs(label);
					label = [];
					labelOf = linkIndex;
				}
				label.push(delimiter);
			}
		}
		mergePairs(label);
		mergePairs(outside);
		return pairs;
	}

	// The named references prose actually uses. CommonMark demands HTML's full
	// list of some two thousand names, which is more table than parser; a name
	// beyond this set stays literal text, exactly as CommonMark itself treats
	// a name it does not know. Values invisible on screen are written as
	// escapes; every entry, visible or not, is pinned by a codepoint test.
	const NAMED_ENTITY = new Map(Object.entries({
		// Markup and quoting.
		amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
		// Latin-1 signs and fractions.
		nbsp: "\u00a0", iexcl: "¡", cent: "¢", pound: "£", curren: "¤", yen: "¥",
		brvbar: "¦", sect: "§", uml: "¨", copy: "©", ordf: "ª", laquo: "«",
		not: "¬", shy: "\u00ad", reg: "®", macr: "¯", deg: "°", plusmn: "±",
		sup2: "²", sup3: "³", acute: "´", micro: "µ", para: "¶", middot: "·",
		cedil: "¸", sup1: "¹", ordm: "º", raquo: "»", frac14: "¼", frac12: "½",
		frac34: "¾", iquest: "¿", times: "×", divide: "÷",
		// Latin-1 letters.
		Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä", Aring: "Å",
		AElig: "Æ", Ccedil: "Ç", Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë",
		Igrave: "Ì", Iacute: "Í", Icirc: "Î", Iuml: "Ï", ETH: "Ð", Ntilde: "Ñ",
		Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö", Oslash: "Ø",
		Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û", Uuml: "Ü", Yacute: "Ý", THORN: "Þ",
		szlig: "ß", agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä",
		aring: "å", aelig: "æ", ccedil: "ç", egrave: "è", eacute: "é", ecirc: "ê",
		euml: "ë", igrave: "ì", iacute: "í", icirc: "î", iuml: "ï", eth: "ð",
		ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö",
		oslash: "ø", ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý",
		thorn: "þ", yuml: "ÿ", OElig: "Œ", oelig: "œ",
		// Spaces, dashes, and typographer's punctuation.
		ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009", ndash: "–", mdash: "—",
		lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“",
		rdquo: "”", bdquo: "„", dagger: "†", Dagger: "‡", bull: "•",
		hellip: "…", permil: "‰", prime: "′", Prime: "″", lsaquo: "‹",
		rsaquo: "›", oline: "‾", frasl: "⁄", euro: "€", trade: "™",
		// Arrows.
		larr: "←", uarr: "↑", rarr: "→", darr: "↓", harr: "↔", crarr: "↵",
		lArr: "⇐", uArr: "⇑", rArr: "⇒", dArr: "⇓", hArr: "⇔",
		// Mathematics.
		forall: "∀", part: "∂", exist: "∃", empty: "∅", nabla: "∇", isin: "∈",
		notin: "∉", ni: "∋", prod: "∏", sum: "∑", minus: "−",
		lowast: "∗", radic: "√", prop: "∝", infin: "∞", ang: "∠",
		and: "∧", or: "∨", cap: "∩", cup: "∪", int: "∫", there4: "∴",
		sim: "∼", cong: "≅", asymp: "≈", ne: "≠", equiv: "≡", le: "≤",
		ge: "≥", sub: "⊂", sup: "⊃", nsub: "⊄", sube: "⊆", supe: "⊇",
		oplus: "⊕", otimes: "⊗", perp: "⊥", sdot: "⋅", loz: "◊",
		// Greek.
		Alpha: "Α", Beta: "Β", Gamma: "Γ", Delta: "Δ",
		Epsilon: "Ε", Zeta: "Ζ", Eta: "Η", Theta: "Θ",
		Iota: "Ι", Kappa: "Κ", Lambda: "Λ", Mu: "Μ",
		Nu: "Ν", Xi: "Ξ", Omicron: "Ο", Pi: "Π",
		Rho: "Ρ", Sigma: "Σ", Tau: "Τ", Upsilon: "Υ",
		Phi: "Φ", Chi: "Χ", Psi: "Ψ", Omega: "Ω",
		alpha: "α", beta: "β", gamma: "γ", delta: "δ",
		epsilon: "ε", zeta: "ζ", eta: "η", theta: "θ",
		iota: "ι", kappa: "κ", lambda: "λ", mu: "μ",
		nu: "ν", xi: "ξ", omicron: "ο", pi: "π",
		rho: "ρ", sigmaf: "ς", sigma: "σ", tau: "τ",
		upsilon: "υ", phi: "φ", chi: "χ", psi: "ψ",
		omega: "ω",
		// Suits.
		spades: "♠", clubs: "♣", hearts: "♥", diams: "♦",
	}));

	// A numeric reference is any code point, with U+FFFD standing in for zero,
	// surrogates, and points beyond Unicode, as CommonMark requires; a named
	// reference is looked up, and an unknown name decodes to null so the
	// caller can leave it as the text it already was. References decode only
	// in displayed text, never in a link's destination: the target is used
	// exactly as written, so the scheme the renderer and the main process
	// check is the scheme the shell receives — decoding there would let
	// &colon; smuggle a scheme past both.
	function decodeCharacterReference(body) {
		if (body[0] !== "#") {
			return NAMED_ENTITY.get(body) ?? null;
		}
		const code = body[1] === "x" || body[1] === "X"
			? Number.parseInt(body.slice(2), 16)
			: Number.parseInt(body.slice(1), 10);
		if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
			return "\ufffd";
		}
		return String.fromCodePoint(code);
	}

	// Text between constructs, rendered in one regex pass: an escape pair
	// collapses to its character, a backslash or a run of two or more spaces
	// before a newline is the hard break it means, a lone newline is a space,
	// a character reference becomes the character it names, and what remains
	// is escaped in slices rather than character by character. The escape
	// alternative consumes pairs left to right exactly as escapedPositions
	// judges them, so the two cannot disagree — which is also what keeps an
	// escaped backslash at a line's end literal, and \&copy; six characters
	// of text.
	const TEXT_TOKEN = new RegExp(
		`\\\\(${ESCAPABLE_CHARACTER.source})|\\\\\\n|( +)\\n|\\n|&(#\\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});`,
		"g",
	);

	function renderTextRun(raw) {
		let html = "";
		let last = 0;
		TEXT_TOKEN.lastIndex = 0;
		let match;
		while ((match = TEXT_TOKEN.exec(raw)) !== null) {
			html += escapeHtml(raw.slice(last, match.index));
			if (match[1] !== undefined) {
				html += escapeHtml(match[1]);
			} else if (match[2] !== undefined) {
				html += match[2].length >= 2 ? "<br>" : `${match[2]} `;
			} else if (match[0] === "\\\n") {
				html += "<br>";
			} else if (match[3] !== undefined) {
				// The decoded character is escaped like any other text, so a
				// reference can spell markup but never emit it.
				const decoded = decodeCharacterReference(match[3]);
				html += escapeHtml(decoded ?? match[0]);
			} else {
				html += " ";
			}
			last = match.index + match[0].length;
		}
		return html + escapeHtml(raw.slice(last));
	}

	// Inline rendering in one pass over the whole text: code spans, links, and
	// emphasis scoped by the links are all settled up front, and a single walk
	// plays the decisions back with an explicit stack of open tags. Nothing
	// recurses and nothing is re-derived on inner slices — nesting once cost a
	// fresh set of maps over nearly the whole remaining text per level, which a
	// document at the size limit turned into gigabytes — so a paragraph costs
	// one set of maps however deeply it nests. The depth cap only bounds the
	// emitted tree: a construct past it is skipped and its markers stay text.
	function renderInline(text) {
		const escaped = escapedPositions(text);
		const codeSpans = computeCodeSpans(text, escaped);
		const links = computeLinks(text, escaped, codeSpans);
		const pairs = computeEmphasisPairs(text, escaped, codeSpans, links);

		const events = [];
		for (const span of codeSpans) {
			events.push({ position: span.start, span });
		}
		for (const link of links) {
			events.push({ position: link.start, link });
		}
		for (const [position, pair] of pairs) {
			events.push({ position, pair });
		}
		events.sort((left, right) => left.position - right.position);

		let html = "";
		const stack = [];
		let eventIndex = 0;
		let index = 0;

		while (true) {
			// Events the walk jumped over — inside a consumed link target, or a
			// span straddling out of one — are spent, not replayed.
			while (eventIndex < events.length && events[eventIndex].position < index) {
				eventIndex += 1;
			}
			const closeAt = stack.length > 0 ? stack[stack.length - 1].at : Infinity;
			const eventAt = eventIndex < events.length ? events[eventIndex].position : Infinity;
			const boundary = Math.min(closeAt, eventAt, text.length);

			if (index < boundary) {
				html += renderTextRun(text.slice(index, boundary));
				index = boundary;
				continue;
			}

			if (stack.length > 0 && closeAt <= eventAt) {
				const top = stack.pop();
				html += top.closing;
				index = top.jumpTo;
				continue;
			}

			if (eventIndex >= events.length) {
				return html;
			}

			const event = events[eventIndex];
			eventIndex += 1;

			if (event.span) {
				html += `<code>${escapeHtml(codeSpanContent(text.slice(event.span.contentStart, event.span.contentEnd)))}</code>`;
				index = event.span.end;
				continue;
			}

			// Past the depth cap no more structure opens: the construct is
			// skipped whole and its markers render as the text they are.
			if (stack.length >= MAX_NESTING_DEPTH) {
				continue;
			}

			if (event.link) {
				const attribute = escapeHtml(event.link.target);
				html += `<a href="${attribute}" data-href="${attribute}" rel="noreferrer">`;
				stack.push({ at: event.link.labelEnd, closing: "</a>", jumpTo: event.link.targetEnd + 1 });
				index = event.link.labelStart;
				continue;
			}

			const tag = event.pair.spend === 2 ? "strong" : "em";
			html += `<${tag}>`;
			stack.push({ at: event.pair.closerStart, closing: `</${tag}>`, jumpTo: event.pair.closerStart + event.pair.spend });
			index = event.position + event.pair.spend;
		}
	}

	function listMatch(line) {
		// A marker with nothing after it is an empty item, trailing spaces or
		// not; content proper starts at its first non-space character so those
		// two cases cannot blur into an item whose content is whitespace.
		const match = line.match(/^(\s*)([-+*]|\d+[.)])(?:(\s+)(\S.*)|\s*)$/);
		if (!match) {
			return null;
		}

		return {
			content: match[4] ?? "",
			indent: match[1].replaceAll("\t", "    ").length,
			// The column where the item's content begins, which is what a
			// continuation line must be dedented by to mean what it would at
			// top level — no more, or a code block inside the item flattens.
			// An empty item offers no content to measure from; its column is
			// one past the marker, as CommonMark reads items that start blank.
			contentIndent: (match[1] + match[2] + (match[3] ?? " ")).replaceAll("\t", "    ").length,
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
		// Only an item with content can interrupt a paragraph — CommonMark keeps
		// a lone marker mid-paragraph as prose, so a line of "foo\n*\nbar" stays
		// one paragraph rather than splitting around an empty list. An ordered
		// marker interrupts only when numbered 1, so a sentence wrapping onto
		// "14. The number of doors" keeps reading as prose.
		const item = listMatch(line);
		// Indented code is deliberately absent: an indented line after text is a
		// hanging indent continuing the paragraph, not the start of a code block.
		return /^ {0,3}(#{1,6})\s+/.test(line)
			|| /^ {0,3}(```+|~~~+)/.test(line)
			|| /^ {0,3}>\s?/.test(line)
			|| /^ {0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)
			|| (item !== null && item.content !== "" && (!item.ordered || item.start === 1))
			|| (/^ {0,3}(=+|-+)\s*$/.test(next) && line.trim() !== "");
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
			// An item is a sequence of segments — runs of text lines interleaved
			// with nested lists — so content that follows a nested list renders
			// after it, in source order.
			const segments = [{ lines: [item.content] }];

			// Continuation lines are measured against the deepest construct they
			// can hang from: the item's own content column until a nested list
			// intervenes, then that list's marker column — so text aligned with
			// a nested marker reads as a hanging indent, not indented code.
			let continuationIndent = item.contentIndent;

			const pushLine = (line) => {
				const last = segments[segments.length - 1];
				if (last.lines) {
					last.lines.push(line);
				} else {
					segments.push({ lines: [line] });
				}
			};

			while (index < lines.length) {
				const nestedItem = listMatch(lines[index]);
				if (nestedItem) {
					if (nestedItem.indent > baseIndent) {
						if (depth >= MAX_NESTING_DEPTH) {
							// Too deep to open another list; fold the line into this item
							// instead, which also guarantees index still advances.
							pushLine(dedent(lines[index], continuationIndent));
							index += 1;
							continue;
						}
						const nested = renderList(lines, index, depth + 1);
						segments.push({ html: nested.html });
						continuationIndent = Math.max(continuationIndent, nestedItem.indent);
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
					pushLine("");
					index = next;
					continue;
				}

				if (indentWidth(lines[index]) > baseIndent) {
					pushLine(dedent(lines[index], continuationIndent));
					index += 1;
					continue;
				}
				break;
			}

			items.push(segments);
		}

		// Rendered only now because looseness belongs to the whole list: a gap
		// before its last item still wraps its first in <p>.
		let html = `<${tag}${startAttribute}>`;
		for (const segments of items) {
			let itemHtml = "";
			for (const segment of segments) {
				if (segment.lines) {
					const rendered = renderBlocks(segment.lines, 0, depth + 1).html;
					itemHtml += loose ? rendered : unwrapSingleParagraph(rendered);
				} else {
					itemHtml += segment.html;
				}
			}
			html += `<li>${itemHtml}</li>`;
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

			const fence = line.match(/^( {0,3})(```+|~~~+)(.*)$/);
			if (fence) {
				const marker = fence[2];
				const closingFence = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`);
				// The fence's own indentation is structure, not content: up to
				// that many leading spaces come off every line inside, so an
				// indented fence yields the same code an unindented one would.
				const contentIndent = new RegExp(`^ {0,${fence[1].length}}`);
				const codeLines = [];
				index += 1;
				while (index < lines.length && !closingFence.test(lines[index])) {
					codeLines.push(lines[index].replace(contentIndent, ""));
					index += 1;
				}
				if (index < lines.length) {
					index += 1;
				}
				output.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
				continue;
			}

			// A closing hash run only counts when whitespace sets it apart from
			// the text; pressed against it, the hashes are content — "# C#".
			const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
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

			// Indentation is measured in columns, tabs counting four as everywhere
			// else, so a tab-indented line is code and never parsed as markup. A
			// blank line — whitespace-only included — continues the block, but
			// trailing blanks belong to what follows, not to the code.
			if (indentWidth(line) >= 4) {
				const codeLines = [];
				while (index < lines.length && (indentWidth(lines[index]) >= 4 || lines[index].trim() === "")) {
					codeLines.push(lines[index].trim() === "" ? "" : dedent(lines[index], 4));
					index += 1;
				}
				while (codeLines[codeLines.length - 1] === "") {
					codeLines.pop();
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
			// Like every block marker, an underline may be indented at most three
			// spaces; deeper it is no underline, just the paragraph continuing.
			if (index + 1 < lines.length && /^ {0,3}(=+|-+)\s*$/.test(lines[index + 1]) && line.trim()) {
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
