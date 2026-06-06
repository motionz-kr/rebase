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

func TestParseDML_WhereWordInLiteral(t *testing.T) {
	p := ParseDML("UPDATE t SET note='check WHERE cond', x=1 WHERE id=5")
	if !p.Parseable {
		t.Fatal("should parse")
	}
	if p.WhereClause != "id=5" {
		t.Errorf("where: got %q want id=5", p.WhereClause)
	}
	if !reflect.DeepEqual(p.SetCols, []string{"note", "x"}) {
		t.Errorf("setCols: got %v want [note x]", p.SetCols)
	}
}

func TestParseDML_NoWhereLiteralContainsWhere(t *testing.T) {
	p := ParseDML("UPDATE t SET note='no real where here'")
	if !p.Parseable {
		t.Fatal("should parse")
	}
	if p.HasWhere {
		t.Errorf("should have no WHERE, got %q", p.WhereClause)
	}
	if !reflect.DeepEqual(p.SetCols, []string{"note"}) {
		t.Errorf("setCols: got %v want [note]", p.SetCols)
	}
}

func TestParseDML_SemicolonInLiteralNotMultiStatement(t *testing.T) {
	p := ParseDML("DELETE FROM t WHERE name=';'")
	if !p.Parseable {
		t.Fatal("semicolon inside a literal should still parse")
	}
	if p.WhereClause != "name=';'" {
		t.Errorf("where: got %q", p.WhereClause)
	}
}

func TestParseDML_SchemaQualifiedRejected(t *testing.T) {
	if ParseDML("DELETE FROM mydb.users WHERE id=1").Parseable {
		t.Error("schema-qualified table must be unparseable in v1")
	}
}

func TestParseDML_StripOrderByLimit(t *testing.T) {
	p := ParseDML("DELETE FROM t WHERE id > 100 ORDER BY id LIMIT 10")
	if p.WhereClause != "id > 100" {
		t.Errorf("where: got %q want 'id > 100'", p.WhereClause)
	}
}

func TestParseDML_RealMultiStatementRejected(t *testing.T) {
	if ParseDML("DELETE FROM t WHERE id=1; DROP TABLE t").Parseable {
		t.Error("real multi-statement must be unparseable")
	}
}
