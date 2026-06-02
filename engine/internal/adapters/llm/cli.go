package llm

import (
	"bufio"
	"context"
	"encoding/json"
	"os/exec"
	"strings"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// CliProvider drives a local `claude` CLI in headless stream-json mode, with DB
// tools provided via an MCP server (see ADR 0006). The pure helpers below
// (decodeClaudeLine, sanitizeEnv, buildClaudeArgs) are unit-tested; the spawn
// path requires a real logged-in claude and is verified in the user's
// environment (the sandbox cannot authenticate a nested claude).
type CliProvider struct {
	bin           string
	mcpConfigPath string
	permission    string
	env           []string
}

func NewCliProvider(mcpConfigPath, permissionMode string, env []string) *CliProvider {
	if permissionMode == "" {
		permissionMode = "default"
	}
	return &CliProvider{bin: "claude", mcpConfigPath: mcpConfigPath, permission: permissionMode, env: sanitizeEnv(env)}
}

func (c *CliProvider) Status(_ context.Context) (ports.ProviderStatus, error) {
	if _, err := exec.LookPath(c.bin); err != nil {
		return ports.ProviderStatus{Ready: false, Detail: "claude CLI not found on PATH"}, nil
	}
	return ports.ProviderStatus{Ready: true, Detail: "local claude CLI"}, nil
}

// Complete spawns claude headless and streams decoded events. The user turn is
// sent as the prompt; claude runs the loop and calls our MCP tools.
func (c *CliProvider) Complete(ctx context.Context, req ports.LLMRequest, emit func(ports.LLMEvent)) error {
	prompt := lastUserText(req)
	args := append(buildClaudeArgs(c.mcpConfigPath, c.permission), "--", prompt)
	cmd := exec.CommandContext(ctx, c.bin, args...)
	cmd.Env = c.env

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for sc.Scan() {
		for _, e := range decodeClaudeLine(sc.Bytes()) {
			emit(e)
		}
	}
	return cmd.Wait()
}

func lastUserText(req ports.LLMRequest) string {
	for i := len(req.Messages) - 1; i >= 0; i-- {
		if req.Messages[i].Role == ports.RoleUser {
			return req.Messages[i].Text
		}
	}
	return ""
}

// buildClaudeArgs returns the headless flags (excluding the trailing prompt).
func buildClaudeArgs(mcpConfigPath, permissionMode string) []string {
	return []string{
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--mcp-config", mcpConfigPath,
		"--strict-mcp-config",
		"--allowedTools", "mcp__rebase__*",
		"--permission-mode", permissionMode,
	}
}

// sanitizeEnv drops the agent-harness overrides so a spawned claude uses the
// user's own login (ADR 0006: an empty ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL
// override is what caused the spike's 401).
func sanitizeEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		key := kv
		if i := strings.IndexByte(kv, '='); i >= 0 {
			key = kv[:i]
		}
		if key == "ANTHROPIC_BASE_URL" || key == "ANTHROPIC_API_KEY" || strings.HasPrefix(key, "CLAUDE_CODE_") {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// decodeClaudeLine converts one `claude --output-format stream-json` line into
// neutral events. Each line is a complete JSON object (assistant messages are
// whole, not deltas, without --include-partial-messages).
func decodeClaudeLine(line []byte) []ports.LLMEvent {
	var env struct {
		Type    string `json:"type"`
		IsError bool   `json:"is_error"`
		Result  string `json:"result"`
		Message struct {
			Content []struct {
				Type  string          `json:"type"`
				Text  string          `json:"text"`
				ID    string          `json:"id"`
				Name  string          `json:"name"`
				Input json.RawMessage `json:"input"`
			} `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(line, &env); err != nil {
		return nil
	}
	switch env.Type {
	case "assistant":
		var out []ports.LLMEvent
		for _, c := range env.Message.Content {
			switch c.Type {
			case "text":
				if c.Text != "" {
					out = append(out, ports.LLMEvent{Kind: ports.EventText, Text: c.Text})
				}
			case "tool_use":
				args := map[string]any{}
				_ = json.Unmarshal(c.Input, &args)
				out = append(out, ports.LLMEvent{Kind: ports.EventToolCall, ToolCall: &ports.ToolCall{ID: c.ID, Name: c.Name, Args: args}})
			}
		}
		return out
	case "result":
		if env.IsError {
			return []ports.LLMEvent{{Kind: ports.EventError, Err: env.Result}, {Kind: ports.EventDone}}
		}
		return []ports.LLMEvent{{Kind: ports.EventDone}}
	}
	return nil
}
