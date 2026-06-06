package analyzer

import (
	"testing"
	"time"
)

func TestFormatLiteral(t *testing.T) {
	ts := time.Date(2026, 6, 6, 10, 30, 0, 0, time.UTC)
	cases := []struct {
		driver string
		val    any
		want   string
	}{
		{"mysql", nil, "NULL"},
		{"mysql", int64(42), "42"},
		{"mysql", 3.5, "3.5"},
		{"mysql", true, "1"},
		{"mysql", false, "0"},
		{"mysql", "a'b", "'a''b'"},
		{"mysql", []byte("x'y"), "'x''y'"},
		{"mysql", ts, "'2026-06-06 10:30:00'"},
		{"postgres", true, "TRUE"},
		{"postgres", false, "FALSE"},
		{"sqlserver", true, "1"},
		{"mysql", uint64(18446744073709551615), "18446744073709551615"},
		{"mysql", uint(7), "7"},
	}
	for _, c := range cases {
		if got := FormatLiteral(c.driver, c.val); got != c.want {
			t.Errorf("FormatLiteral(%s,%v)=%q want %q", c.driver, c.val, got, c.want)
		}
	}
}
