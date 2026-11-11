// Port of segment.go: CJK text is indexed one character per token and
// searched by overlapping two-character phrases, so no dictionary or word
// segmenter is needed.

// maxQueryTerms bounds the size of a generated MATCH expression.
const maxQueryTerms = 48;

// Scripts written without spaces between words. FTS5's unicode61 tokenizer
// would treat a whole run of them as one token. Script, not Script_Extensions,
// as Go's unicode.Han and friends.
const cjk = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
// Go's unicode.IsLetter or unicode.IsDigit; IsDigit is Nd only.
const wordChar = /^[\p{L}\p{Nd}]$/u;

export function isCJK(ch: string): boolean {
  return cjk.test(ch);
}

function isWordChar(ch: string): boolean {
  return wordChar.test(ch);
}

// lower lower-cases one code point at a time, as Go's strings.ToLower does,
// so no context-dependent rule (a final sigma) applies. U+0130 is the one
// code point whose JS lower case is two code points; Go maps it to "i".
function lower(word: string): string {
  let out = "";
  for (const ch of word) out += ch === "\u0130" ? "i" : ch.toLowerCase();
  return out;
}

// indexText rewrites s so that every CJK character becomes its own token.
// Other text is left for the tokenizer to split.
export function indexText(s: string): string {
  let out = "";
  for (const ch of s) out += isCJK(ch) ? " " + ch + " " : ch;
  return out;
}

// matchQuery turns free text into an FTS5 MATCH expression. A run of CJK
// characters becomes overlapping two-character phrases; other words are
// matched whole. Terms are joined with OR and left to bm25 to rank. It returns
// "" when q has nothing to match.
export function matchQuery(q: string): string {
  const terms: string[] = [];
  const seen = new Set<string>();
  const add = (t: string): void => {
    if (seen.has(t) || terms.length >= maxQueryTerms) return;
    seen.add(t);
    terms.push(t);
  };

  let run: string[] = [];
  let word: string[] = [];
  const flushCJK = (): void => {
    if (run.length === 1) add(`"${run[0]}"`);
    else for (let i = 0; i + 1 < run.length; i++) add(`"${run[i]} ${run[i + 1]}"`);
    run = [];
  };
  const flushWord = (): void => {
    if (word.length > 0) add(`"${lower(word.join(""))}"`);
    word = [];
  };

  for (const ch of q) {
    if (isCJK(ch)) {
      flushWord();
      run.push(ch);
    } else if (isWordChar(ch)) {
      flushCJK();
      word.push(ch);
    } else {
      flushCJK();
      flushWord();
    }
  }
  flushCJK();
  flushWord();
  return terms.join(" OR ");
}
