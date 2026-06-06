package analyzer

import "testing"

func TestQuoteIdent(t *testing.T) {
	cases := []struct{ driver, in, want string }{
		{"mysql", "User", "`User`"},
		{"postgres", "User", `"User"`},
		{"sqlite", "User", `"User"`},
		{"sqlserver", "User", "[User]"},
		{"mysql", "a`b", "`a``b`"},
		{"postgres", `a"b`, `"a""b"`},
		{"sqlserver", "a]b", "[a]]b]"},
	}
	for _, c := range cases {
		if got := QuoteIdent(c.driver, c.in); got != c.want {
			t.Errorf("QuoteIdent(%s,%q)=%q want %q", c.driver, c.in, got, c.want)
		}
	}
}

func TestBuildCountSQL(t *testing.T) {
	p := ParsedDML{Verb: "DELETE", Table: "User", WhereClause: "hospitalId = 153", HasWhere: true}
	got := BuildCountSQL("mysql", p)
	want := "SELECT COUNT(*) FROM `User` WHERE hospitalId = 153"
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
}

func TestBuildCountSQL_NoWhere(t *testing.T) {
	p := ParsedDML{Verb: "DELETE", Table: "User", HasWhere: false}
	if got := BuildCountSQL("postgres", p); got != `SELECT COUNT(*) FROM "User"` {
		t.Errorf("got %q", got)
	}
}

func TestBuildPreviewSQL(t *testing.T) {
	p := ParsedDML{Table: "User", WhereClause: "id=1", HasWhere: true}
	if got := BuildPreviewSQL("sqlite", p); got != `SELECT * FROM "User" WHERE id=1` {
		t.Errorf("got %q", got)
	}
}

func TestBuildSnapshotSQL_Update(t *testing.T) {
	p := ParsedDML{Verb: "UPDATE", Table: "User", WhereClause: "id=1", HasWhere: true, SetCols: []string{"deletedAt"}}
	got := BuildSnapshotSQL("mysql", p, []string{"id"})
	want := "SELECT `id`, `deletedAt` FROM `User` WHERE id=1"
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
}
