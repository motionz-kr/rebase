package domain

import (
	"strings"
	"unicode"
)

// SQLTokens returns uppercased SQL words and punctuation, omitting comments and
// replacing quoted strings/identifiers with an opaque token. It does not parse
// SQL or grant permission. complete is false for ambiguous or unfinished input.
func SQLTokens(query string) (tokens []string, complete bool) {
	r := []rune(query)
	complete = true
	for i := 0; i < len(r); {
		c := r[i]
		if unicode.IsSpace(c) {
			i++
			continue
		}
		if c == '-' && i+1 < len(r) && r[i+1] == '-' {
			i += 2
			for i < len(r) && r[i] != '\n' && r[i] != '\r' {
				i++
			}
			continue
		}
		if c == '/' && i+1 < len(r) && r[i+1] == '*' {
			i += 2
			// MySQL executable comments are SQL, not ordinary comments. Never
			// grant read-only classification by hiding their contents.
			if i < len(r) && (r[i] == '!' || (r[i] == 'M' && i+1 < len(r) && r[i+1] == '!')) {
				complete = false
			}
			depth := 1
			for i < len(r) && depth > 0 {
				if i+1 < len(r) && r[i] == '/' && r[i+1] == '*' {
					complete = false // nested comment semantics differ by driver
					depth++
					i += 2
				} else if i+1 < len(r) && r[i] == '*' && r[i+1] == '/' {
					depth--
					i += 2
				} else {
					i++
				}
			}
			if depth != 0 {
				complete = false
			}
			continue
		}
		if c == '\'' || c == '"' || c == '`' || c == '[' {
			end := c
			if c == '[' {
				end = ']'
			}
			i++
			closed := false
			for i < len(r) {
				if r[i] == '\\' {
					// Escape modes differ across DBs. Still find the likely end
					// for result routing, but keep the permission gate conservative.
					if i+1 < len(r) && (r[i+1] == end || r[i+1] == '\\') {
						complete = false
					}
					i += 2
				} else if r[i] == end {
					i++
					if i < len(r) && r[i] == end {
						i++
						continue
					}
					closed = true
					break
				} else {
					i++
				}
			}
			if !closed {
				complete = false
			}
			tokens = append(tokens, "?")
			continue
		}
		// PostgreSQL dollar-quoted bodies can contain quotes, comments and
		// semicolons verbatim. A $1 parameter is not a quote delimiter.
		if c == '$' {
			end := i + 1
			for end < len(r) && (unicode.IsLetter(r[end]) || r[end] == '_' || (end > i+1 && unicode.IsDigit(r[end]))) {
				end++
			}
			if end < len(r) && r[end] == '$' {
				delimiter := string(r[i : end+1])
				body := string(r[end+1:])
				closeAt := strings.Index(body, delimiter)
				if closeAt < 0 {
					complete = false
					i = len(r)
				} else {
					i = end + 1 + len([]rune(body[:closeAt])) + len([]rune(delimiter))
				}
				tokens = append(tokens, "?")
				continue
			}
		}
		if unicode.IsLetter(c) || unicode.IsDigit(c) || c == '_' || c == '$' {
			start := i
			for i < len(r) && (unicode.IsLetter(r[i]) || unicode.IsDigit(r[i]) || r[i] == '_' || r[i] == '$') {
				i++
			}
			tokens = append(tokens, strings.ToUpper(string(r[start:i])))
			continue
		}
		tokens = append(tokens, string(c))
		i++
	}
	return tokens, complete
}
