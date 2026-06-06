package analyzer

import "testing"

func TestAnalyze_Levels(t *testing.T) {
	tenant := []string{"hospitalId", "tenantId"}
	cases := []struct {
		name  string
		sql   string
		level RiskLevel
		verb  string
	}{
		{"plain select", "SELECT * FROM users WHERE id = 1", RiskSafe, "SELECT"},
		{"update with where", "UPDATE users SET a=1 WHERE id=2", RiskMedium, "UPDATE"},
		{"update no where", "UPDATE users SET a=1", RiskHigh, "UPDATE"},
		{"delete no where", "DELETE FROM users", RiskHigh, "DELETE"},
		{"truncate", "TRUNCATE TABLE users", RiskHigh, "TRUNCATE"},
		{"drop", "DROP TABLE users", RiskHigh, "DROP"},
		{"alter", "ALTER TABLE users ADD COLUMN x INT", RiskHigh, "ALTER"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := Analyze(c.sql, tenant)
			if r.Level != c.level {
				t.Errorf("level: got %q want %q", r.Level, c.level)
			}
			if r.Verb != c.verb {
				t.Errorf("verb: got %q want %q", r.Verb, c.verb)
			}
		})
	}
}

func TestAnalyze_ReasonsPopulated(t *testing.T) {
	r := Analyze("DELETE FROM users", nil)
	if len(r.Reasons) == 0 {
		t.Fatal("expected reasons for WHERE-less DELETE")
	}
}
