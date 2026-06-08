package agent

import (
	"fmt"
	"strings"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

// BuildDomainContext serializes the connection's domain glossary, free-form
// rules, and tenant/soft-delete bindings into a Korean system-prompt block.
// Returns "" when there is nothing to inject (so the agent's default behavior
// is unchanged for connections without a domain dictionary).
func BuildDomainContext(entries []domain.DomainEntry, notes string, tenantCols []string, softDelete string) string {
	notes = strings.TrimSpace(notes)
	hasEntries := false
	for _, e := range entries {
		if strings.TrimSpace(e.Meaning) != "" {
			hasEntries = true
			break
		}
	}
	hasAuto := softDelete != "" || len(tenantCols) > 0
	if !hasEntries && notes == "" && !hasAuto {
		return ""
	}

	var b strings.Builder
	b.WriteString("## 도메인 맥락 (이 연결의 업무 의미)\n")

	if hasEntries {
		b.WriteString("다음 용어 의미를 반영해 질의를 해석하라:\n")
		for _, e := range entries {
			if strings.TrimSpace(e.Meaning) == "" {
				continue
			}
			if e.Kind == "column" && e.Column != "" {
				fmt.Fprintf(&b, "- %s.%s (컬럼) = %s\n", e.Table, e.Column, e.Meaning)
			} else {
				fmt.Fprintf(&b, "- %s (테이블) = %s\n", e.Table, e.Meaning)
			}
		}
	}

	if notes != "" {
		b.WriteString("도메인 규칙:\n")
		for _, line := range strings.Split(notes, "\n") {
			if t := strings.TrimSpace(line); t != "" {
				fmt.Fprintf(&b, "- %s\n", t)
			}
		}
	}

	if hasAuto {
		b.WriteString("자동 적용 규칙(사용자가 명시적으로 해제하지 않는 한):\n")
		if softDelete != "" {
			fmt.Fprintf(&b, "- soft-delete 컬럼 `%s` 은 IS NULL 로 필터한다.\n", softDelete)
		}
		if len(tenantCols) > 0 {
			fmt.Fprintf(&b, "- 특정 병원/조직이 언급되면 tenant 컬럼(%s)으로 범위를 제한한다.\n", strings.Join(tenantCols, ", "))
		}
	}

	b.WriteString("지시: 쓰기 또는 조회 SQL을 제안하기 전에, 네가 해석한 조건을 한국어 불릿 목록으로 먼저 제시하라.\n")
	return b.String()
}
