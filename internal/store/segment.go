package store

import (
	"strings"
	"unicode"
)

// maxQueryTerms bounds the size of a generated MATCH expression.
const maxQueryTerms = 48

// isCJK reports whether r belongs to a script written without spaces between
// words. FTS5's unicode61 tokenizer would treat a whole run of such runes as
// one token, so they are indexed one rune per token instead.
func isCJK(r rune) bool {
	return unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul)
}

func isWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r)
}

// indexText rewrites s so that every CJK rune becomes its own token. Other
// text is left for the tokenizer to split.
func indexText(s string) string {
	var b strings.Builder
	b.Grow(len(s) + len(s)/2)
	for _, r := range s {
		if isCJK(r) {
			b.WriteByte(' ')
			b.WriteRune(r)
			b.WriteByte(' ')
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// matchQuery turns free text into an FTS5 MATCH expression. A run of CJK runes
// becomes overlapping two-rune phrases, so "记忆系统" matches text containing
// 记忆, 忆系 or 系统 and ranks text containing all three highest. No dictionary
// or word segmenter is needed. Other words are matched whole. Terms are joined
// with OR and left to bm25 to rank. It returns "" when q has nothing to match.
func matchQuery(q string) string {
	var terms []string
	seen := make(map[string]bool)
	add := func(t string) {
		if seen[t] || len(terms) >= maxQueryTerms {
			return
		}
		seen[t] = true
		terms = append(terms, t)
	}

	var cjk, word []rune
	flushCJK := func() {
		switch len(cjk) {
		case 0:
		case 1:
			add(`"` + string(cjk) + `"`)
		default:
			for i := 0; i+1 < len(cjk); i++ {
				add(`"` + string(cjk[i]) + " " + string(cjk[i+1]) + `"`)
			}
		}
		cjk = cjk[:0]
	}
	flushWord := func() {
		if len(word) > 0 {
			add(`"` + strings.ToLower(string(word)) + `"`)
		}
		word = word[:0]
	}

	for _, r := range q {
		switch {
		case isCJK(r):
			flushWord()
			cjk = append(cjk, r)
		case isWordRune(r):
			flushCJK()
			word = append(word, r)
		default:
			flushCJK()
			flushWord()
		}
	}
	flushCJK()
	flushWord()
	return strings.Join(terms, " OR ")
}
