package analyzer

import (
	"strings"
	"testing"
)

func TestBuildRollbackSQL_Delete(t *testing.T) {
	p := ParsedDML{Verb: "DELETE", Table: "User", WhereClause: "id=1", HasWhere: true}
	cols := []string{"id", "name"}
	rows := [][]any{{int64(1), "alice"}, {int64(2), "bob"}}
	sql, ok := BuildRollbackSQL("mysql", p, cols, nil, rows)
	if !ok {
		t.Fatal("expected rollback ok")
	}
	if !strings.Contains(sql, "INSERT INTO `User` (`id`, `name`) VALUES (1, 'alice');") {
		t.Errorf("missing first insert:\n%s", sql)
	}
	if !strings.Contains(sql, "(2, 'bob')") {
		t.Errorf("missing second insert:\n%s", sql)
	}
}

func TestBuildRollbackSQL_Update(t *testing.T) {
	p := ParsedDML{Verb: "UPDATE", Table: "User", WhereClause: "id=1", HasWhere: true, SetCols: []string{"deletedAt"}}
	cols := []string{"id", "deletedAt"}
	rows := [][]any{{int64(7), nil}}
	sql, ok := BuildRollbackSQL("mysql", p, cols, []string{"id"}, rows)
	if !ok {
		t.Fatal("expected ok")
	}
	want := "UPDATE `User` SET `deletedAt` = NULL WHERE `id` = 7;"
	if !strings.Contains(sql, want) {
		t.Errorf("got:\n%s\nwant substring: %s", sql, want)
	}
}

func TestBuildRollbackSQL_UpdateNoPK(t *testing.T) {
	p := ParsedDML{Verb: "UPDATE", Table: "User", SetCols: []string{"x"}}
	if _, ok := BuildRollbackSQL("mysql", p, []string{"x"}, nil, [][]any{{1}}); ok {
		t.Error("UPDATE without PK must not produce rollback")
	}
}
