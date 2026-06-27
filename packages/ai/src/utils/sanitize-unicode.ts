/**
 * Zero-width / invisible "ghost" characters that carry no linguistic meaning but
 * still consume tokens (and can hide prompt-injection payloads). Stripping them
 * before text reaches the model reduces token usage with no semantic loss.
 *
 * Deliberately conservative — we do NOT strip characters that ARE meaningful:
 *   - U+200C ZWNJ / U+200D ZWJ: used by Indic/Persian scripts and emoji sequences
 *   - U+200E LRM / U+200F RLM: bidirectional layout control
 *   - U+FE00–U+FE0F variation selectors: e.g. VS16 emoji presentation
 * Normal whitespace is left untouched so whitespace-significant content (code,
 * diffs) in tool results and assistant messages is never corrupted.
 *
 *   U+00AD  SOFT HYPHEN
 *   U+180E  MONGOLIAN VOWEL SEPARATOR (deprecated)
 *   U+200B  ZERO WIDTH SPACE
 *   U+2060  WORD JOINER
 *   U+2061–U+2064  invisible math operators (function application/times/separator/plus)
 *   U+FEFF  ZERO WIDTH NO-BREAK SPACE / BOM
 *   U+E0000–U+E007F  TAG block (invisible; a known steganographic injection vector)
 */
const GHOST_CHARS = /[\u00AD\u180E\u200B\u2060\u2061\u2062\u2063\u2064\uFEFF]|[\u{E0000}-\u{E007F}]/gu;

/**
 * Removes zero-width / invisible "ghost" characters that waste tokens.
 *
 * Opt out with `PI_KEEP_GHOST_TOKENS=1` (e.g. when working on text where these
 * code points are intentional).
 *
 * @example
 * stripGhostTokens("he\u200bllo") // => "hello"
 */
export function stripGhostTokens(text: string): string {
	if (typeof process !== "undefined" && process.env?.PI_KEEP_GHOST_TOKENS === "1") {
		return text;
	}
	return text.replace(GHOST_CHARS, "");
}

/**
 * Removes unpaired Unicode surrogate characters from a string, and strips
 * zero-width / invisible ghost characters (see {@link stripGhostTokens}).
 *
 * Unpaired surrogates (high surrogates 0xD800-0xDBFF without matching low surrogates 0xDC00-0xDFFF,
 * or vice versa) cause JSON serialization errors in many API providers.
 *
 * Valid emoji and other characters outside the Basic Multilingual Plane use properly paired
 * surrogates and will NOT be affected by this function.
 *
 * @param text - The text to sanitize
 * @returns The sanitized text with unpaired surrogates and ghost characters removed
 *
 * @example
 * // Valid emoji (properly paired surrogates) are preserved
 * sanitizeSurrogates("Hello 🙈 World") // => "Hello 🙈 World"
 *
 * // Unpaired high surrogate is removed
 * const unpaired = String.fromCharCode(0xD83D); // high surrogate without low
 * sanitizeSurrogates(`Text ${unpaired} here`) // => "Text  here"
 */
export function sanitizeSurrogates(text: string): string {
	// Replace unpaired high surrogates (0xD800-0xDBFF not followed by low surrogate)
	// Replace unpaired low surrogates (0xDC00-0xDFFF not preceded by high surrogate)
	const withoutSurrogates = text.replace(
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
		"",
	);
	return stripGhostTokens(withoutSurrogates);
}
