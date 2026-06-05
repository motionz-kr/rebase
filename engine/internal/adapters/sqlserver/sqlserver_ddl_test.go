package sqlserver

import (
	"testing"
)

func TestBuildCreateTableDDL(t *testing.T) {
	cols := []DDLColumn{
		{Name: "id", Type: "int", Nullable: false, Identity: true, IdentitySeed: 1, IdentityIncr: 1},
		{Name: "title", Type: "nvarchar(255)", Nullable: false},
		{Name: "note", Type: "nvarchar(max)", Nullable: true, Default: "('')"},
	}
	got := BuildCreateTableDDL("dbo", "todos", cols, []string{"id"})
	want := "CREATE TABLE [dbo].[todos] (\n" +
		"  [id] int IDENTITY(1,1) NOT NULL,\n" +
		"  [title] nvarchar(255) NOT NULL,\n" +
		"  [note] nvarchar(max) NULL DEFAULT (''),\n" +
		"  CONSTRAINT [PK_todos] PRIMARY KEY ([id])\n" +
		")"
	if got != want {
		t.Fatalf("DDL mismatch:\n got=%q\nwant=%q", got, want)
	}
}

func TestBuildCreateTableDDL_NoPK(t *testing.T) {
	got := BuildCreateTableDDL("dbo", "t", []DDLColumn{{Name: "a", Type: "int", Nullable: true}}, nil)
	want := "CREATE TABLE [dbo].[t] (\n  [a] int NULL\n)"
	if got != want {
		t.Fatalf("got=%q want=%q", got, want)
	}
}

func TestBuildCreateTableDDL_EscapesBrackets(t *testing.T) {
	got := BuildCreateTableDDL("dbo", "we]ird", []DDLColumn{{Name: "c]x", Type: "int", Nullable: false}}, nil)
	want := "CREATE TABLE [dbo].[we]]ird] (\n  [c]]x] int NOT NULL\n)"
	if got != want {
		t.Fatalf("got=%q want=%q", got, want)
	}
}
