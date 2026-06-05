package llm

import (
	"strings"
	"testing"
)

func TestPKCEChallenge(t *testing.T) {
	// RFC 7636 Appendix B reference vector.
	verifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	want := "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
	if got := pkceChallenge(verifier); got != want {
		t.Fatalf("pkceChallenge = %q, want %q", got, want)
	}
}

func TestParseAuthCode(t *testing.T) {
	cases := []struct {
		in, code, state string
	}{
		{"abc#xyz", "abc", "xyz"},
		{"abc", "abc", ""},
		{"  abc#xyz  ", "abc", "xyz"},
		{"a#b#c", "a", "b#c"}, // split on first # only
	}
	for _, c := range cases {
		code, state := parseAuthCode(c.in)
		if code != c.code || state != c.state {
			t.Errorf("parseAuthCode(%q) = (%q,%q), want (%q,%q)", c.in, code, state, c.code, c.state)
		}
	}
}

func TestNeedsRefresh(t *testing.T) {
	// 60s safety margin.
	if needsRefresh(1_000_000, 900_000) {
		t.Error("not within margin (900k vs 940k) should not refresh")
	}
	if !needsRefresh(1_000_000, 950_000) {
		t.Error("within margin (950k >= 940k) should refresh")
	}
	if !needsRefresh(1_000_000, 1_000_001) {
		t.Error("already expired should refresh")
	}
	if !needsRefresh(0, 1) {
		t.Error("zero expiry (never set) should refresh")
	}
}

func TestBuildAuthorizeURL(t *testing.T) {
	u := buildAuthorizeURL("CHAL", "STATE")
	for _, want := range []string{
		"https://claude.ai/oauth/authorize?",
		"client_id=" + anthropicOAuthClientID,
		"code_challenge=CHAL",
		"code_challenge_method=S256",
		"state=STATE",
		"response_type=code",
	} {
		if !strings.Contains(u, want) {
			t.Errorf("authorize URL missing %q\ngot: %s", want, u)
		}
	}
}
