package analyzer

import (
	"reflect"
	"testing"
)

func TestParseDML_Update(t *testing.T) {
	p := ParseDML("UPDATE `User` SET deletedAt = NOW(), x=1 WHERE hospitalId = 153")
	if !p.Parseable || p.Verb != "UPDATE" {
		t.Fatalf("expected parseable UPDATE, got %+v", p)
	}
	if p.Table != "User" {
		t.Errorf("table: got %q want User", p.Table)
	}
	if !p.HasWhere || p.WhereClause != "hospitalId = 153" {
		t.Errorf("where: got hasWhere=%v %q", p.HasWhere, p.WhereClause)
	}
	if !reflect.DeepEqual(p.SetCols, []string{"deletedAt", "x"}) {
		t.Errorf("setCols: got %v", p.SetCols)
	}
}

func TestParseDML_DeleteNoWhere(t *testing.T) {
	p := ParseDML("DELETE FROM users")
	if !p.Parseable || p.Verb != "DELETE" || p.Table != "users" {
		t.Fatalf("got %+v", p)
	}
	if p.HasWhere {
		t.Error("expected HasWhere=false")
	}
}

func TestParseDML_UnparseableJoin(t *testing.T) {
	p := ParseDML("UPDATE a JOIN b ON a.id=b.id SET a.x=1 WHERE a.id=2")
	if p.Parseable {
		t.Error("multi-table UPDATE must be unparseable")
	}
}

func TestParseDML_NonDML(t *testing.T) {
	if ParseDML("SELECT 1").Parseable {
		t.Error("SELECT is not DML-parseable")
	}
}
