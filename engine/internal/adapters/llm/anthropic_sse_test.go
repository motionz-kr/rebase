package llm

import (
	"strings"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

func TestParseSSEStream(t *testing.T) {
	sse := strings.Join([]string{
		"event: message_start",
		"data: {}",
		"",
		"event: content_block_start",
		`data: {"index":0,"content_block":{"type":"text"}}`,
		"",
		"event: content_block_delta",
		`data: {"index":0,"delta":{"type":"text_delta","text":"Hi"}}`,
		"",
		"event: content_block_delta",
		`data: {"index":0,"delta":{"type":"text_delta","text":" there"}}`,
		"",
		"event: content_block_stop",
		`data: {"index":0}`,
		"",
		"event: message_stop",
		"data: {}",
		"",
	}, "\n")

	var text strings.Builder
	var done bool
	err := parseSSEStream(strings.NewReader(sse), func(e ports.LLMEvent) {
		switch e.Kind {
		case ports.EventText:
			text.WriteString(e.Text)
		case ports.EventDone:
			done = true
		}
	})
	if err != nil {
		t.Fatalf("parseSSEStream: %v", err)
	}
	if text.String() != "Hi there" {
		t.Errorf("text = %q, want 'Hi there'", text.String())
	}
	if !done {
		t.Errorf("expected EventDone")
	}
}

func TestAnthropicStatus(t *testing.T) {
	if s, _ := NewAnthropicProvider("", "", "").Status(nil); s.Ready {
		t.Error("no key should not be ready")
	}
	if s, _ := NewAnthropicProvider("sk-test", "", "").Status(nil); !s.Ready {
		t.Error("with key should be ready")
	}
}
