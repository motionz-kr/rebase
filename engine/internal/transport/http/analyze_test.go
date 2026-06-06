package http

import (
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/analyzer"
)

func TestAssembleStaticReport_NonParseablePassThrough(t *testing.T) {
	r := analyzer.Analyze("DROP TABLE x", nil)
	resp := assembleStaticReport(r)
	if resp.Level != "high" || resp.Verb != "DROP" {
		t.Fatalf("got %+v", resp)
	}
	if resp.AffectedRows != nil {
		t.Error("non-parseable must not carry affectedRows")
	}
}
