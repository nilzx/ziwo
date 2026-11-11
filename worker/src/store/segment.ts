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

// Words and characters that say nothing about what a memory is about. Terms
// are joined with OR and a keyword match is scored against the best keyword
// match of the same search, so a memory that shares only "for" and "a" with
// the query would count as a full match, outrank what the query means, and
// have its decay restarted by being listed. Measured on the platform
// (2026-11-11): English queries listed unrelated English memories ahead of
// the Chinese one they were about. They are left out of a search unless the
// search has nothing else. Go's matchQuery keeps them.
const stopWords = new Set(
  (
    "a an the and or but if then so of to in on at by for from with without about into over under as " +
    "is am are was were be been being it its this that these those i me my we us our you your he him his she her " +
    "they them their do does did have has had not no can could will would should may might must " +
    "what which who whom when where why how there here than too very just also some any all each"
  ).split(" "),
);
// A two-character phrase holding one of these is a particle or a pronoun
// stuck to its neighbour, such as 的问 in 上涨的问题.
const stopChars = new Set("的了着吗呢吧啊是在和就都也把被我你他她它们这那");

// matchQuery turns free text into an FTS5 MATCH expression. A run of CJK
// characters becomes overlapping two-character phrases; other words are
// matched whole. Terms are joined with OR and left to bm25 to rank. It returns
// "" when q has nothing to match.
export function matchQuery(q: string): string {
  return searchTerms(q)
    .map((t) => `"${t}"`)
    .join(" OR ");
}

// searchTerms returns what a search for q looks for: words in lower case,
// and pairs of CJK characters written with a space between them.
export function searchTerms(q: string): string[] {
  const strong: string[] = [];
  const weak: string[] = [];
  const seen = new Set<string>();
  const add = (t: string, isWeak = false): void => {
    if (seen.has(t)) return;
    seen.add(t);
    (isWeak ? weak : strong).push(t);
  };

  let run: string[] = [];
  let word: string[] = [];
  const flushCJK = (): void => {
    if (run.length === 1) add(run[0]!, stopChars.has(run[0]!));
    else {
      for (let i = 0; i + 1 < run.length; i++) {
        add(`${run[i]} ${run[i + 1]}`, stopChars.has(run[i]!) || stopChars.has(run[i + 1]!));
      }
    }
    run = [];
  };
  const flushWord = (): void => {
    if (word.length > 0) {
      const w = lower(word.join(""));
      add(w, stopWords.has(w));
    }
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
  // A search made of nothing else still searches.
  return (strong.length > 0 ? strong : weak).slice(0, maxQueryTerms);
}

// covered counts how many of the terms a text holds, as the keyword index
// matches them: a word whole and in any case, two CJK characters when one
// follows the other.
export function covered(terms: string[], text: string): number {
  const tokens: string[] = [];
  let word = "";
  for (const ch of text) {
    if (isCJK(ch) || !isWordChar(ch)) {
      if (word !== "") tokens.push(lower(word));
      word = "";
      if (isCJK(ch)) tokens.push(ch);
    } else {
      word += ch;
    }
  }
  if (word !== "") tokens.push(lower(word));
  const held = new Set(tokens);
  for (let i = 0; i + 1 < tokens.length; i++) held.add(`${tokens[i]} ${tokens[i + 1]}`);
  return terms.filter((t) => held.has(t)).length;
}
