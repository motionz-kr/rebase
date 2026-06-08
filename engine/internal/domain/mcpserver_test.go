package domain

import "testing"

func TestMcpServerArgsList(t *testing.T) {
	s := McpServer{Args: `["-y","@modelcontextprotocol/server-everything"]`}
	got := s.ArgsList()
	if len(got) != 2 || got[0] != "-y" || got[1] != "@modelcontextprotocol/server-everything" {
		t.Fatalf("got %#v", got)
	}
	if len((McpServer{Args: ""}).ArgsList()) != 0 {
		t.Fatal("empty Args should yield no elements")
	}
	if len((McpServer{Args: "not json"}).ArgsList()) != 0 {
		t.Fatal("invalid Args should yield no elements")
	}
}
