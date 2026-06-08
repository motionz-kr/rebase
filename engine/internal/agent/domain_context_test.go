package agent

import (
	"strings"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

func TestBuildDomainContext_Empty(t *testing.T) {
	if got := BuildDomainContext(nil, "", nil, ""); got != "" {
		t.Errorf("expected empty string, got %q", got)
	}
	if got := BuildDomainContext(nil, "   ", nil, ""); got != "" {
		t.Errorf("expected empty string for blank notes, got %q", got)
	}
}

func TestBuildDomainContext_Full(t *testing.T) {
	entries := []domain.DomainEntry{
		{Kind: "table", Table: "User", Meaning: "환자"},
		{Kind: "column", Table: "User", Column: "hospitalId", Meaning: "병원 구분값"},
	}
	got := BuildDomainContext(entries, "항상 deletedAt IS NULL", []string{"hospitalId"}, "deletedAt")

	for _, want := range []string{
		"도메인 맥락",
		"User (테이블) = 환자",
		"User.hospitalId (컬럼) = 병원 구분값",
		"항상 deletedAt IS NULL",
		"deletedAt",
		"hospitalId",
		"해석한 조건",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("context missing %q\n---\n%s", want, got)
		}
	}
}

func TestBuildDomainContext_OnlyNotes(t *testing.T) {
	got := BuildDomainContext(nil, "규칙만 있음", nil, "")
	if !strings.Contains(got, "규칙만 있음") {
		t.Errorf("expected notes included, got %q", got)
	}
}
