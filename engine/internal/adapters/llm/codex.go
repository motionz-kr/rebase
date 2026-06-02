package llm

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// CodexProvider drives the OpenAI `codex` CLI headless (codex exec --json), with
// Rebase's DB tools provided via an MCP server (configured through -c overrides
// that launch this engine binary in -mcp mode). codex runs its own agent loop
// and calls the tools, so this provider is self-driving. Reuses the user's
// `codex login` (ChatGPT/API) session.
type CodexProvider struct {
	bin        string
	enginePath string
	profileID  string
	model      string
	env        []string
}

func NewCodexProvider(enginePath, profileID, model string, env []string) *CodexProvider {
	return &CodexProvider{bin: "codex", enginePath: enginePath, profileID: profileID, model: model, env: sanitizeEnv(env)}
}

func (c *CodexProvider) SelfDriving() bool { return true }

func (c *CodexProvider) Status(_ context.Context) (ports.ProviderStatus, error) {
	if _, err := exec.LookPath(c.bin); err != nil {
		return ports.ProviderStatus{Ready: false, Detail: "codex CLI not found on PATH"}, nil
	}
	out, _ := exec.Command(c.bin, "login", "status").CombinedOutput()
	if strings.Contains(strings.ToLower(string(out)), "logged in") {
		return ports.ProviderStatus{Ready: true, Detail: "local codex CLI"}, nil
	}
	return ports.ProviderStatus{Ready: false, Detail: "codex CLI not logged in"}, nil
}

func (c *CodexProvider) Complete(ctx context.Context, req ports.LLMRequest, emit func(ports.LLMEvent)) error {
	prompt := "Use the rebase MCP tools to inspect the database and answer. " + lastUserText(req)
	args := append(buildCodexArgs(c.enginePath, c.profileID, c.model), prompt)
	cmd := exec.CommandContext(ctx, c.bin, args...)
	cmd.Env = c.env

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	var sawDone bool
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for sc.Scan() {
		for _, e := range decodeCodexLine(sc.Bytes()) {
			if e.Kind == ports.EventDone {
				sawDone = true
			}
			emit(e)
		}
	}
	if err := cmd.Wait(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		emit(ports.LLMEvent{Kind: ports.EventError, Err: "codex CLI failed: " + detail})
		if !sawDone {
			emit(ports.LLMEvent{Kind: ports.EventDone})
		}
	}
	return nil
}

// buildCodexArgs returns the codex exec flags (excluding the trailing prompt).
// The MCP server is registered via -c overrides that launch this engine binary
// in -mcp mode. --dangerously-bypass-approvals-and-sandbox is required for
// codex to run MCP tools non-interactively; our tools are read-only / propose-only.
func buildCodexArgs(enginePath, profileID, model string) []string {
	args := []string{
		"exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox",
		"-c", fmt.Sprintf("mcp_servers.rebase.command=%q", enginePath),
		"-c", fmt.Sprintf(`mcp_servers.rebase.args=["-mcp","%s","-token","mcp","-handshake","/dev/null"]`, profileID),
	}
	if model != "" {
		args = append(args, "-m", model)
	}
	return args
}

// decodeCodexLine converts one `codex exec --json` JSONL event to neutral events.
func decodeCodexLine(line []byte) []ports.LLMEvent {
	var ev struct {
		Type string `json:"type"`
		Item struct {
			Type string `json:"type"`
			Text string `json:"text"`
			Tool string `json:"tool"`
		} `json:"item"`
	}
	if err := json.Unmarshal(line, &ev); err != nil {
		return nil
	}
	switch ev.Type {
	case "item.completed":
		if ev.Item.Type == "agent_message" && ev.Item.Text != "" {
			return []ports.LLMEvent{{Kind: ports.EventText, Text: ev.Item.Text + "\n"}}
		}
	case "item.started":
		if ev.Item.Type == "mcp_tool_call" && ev.Item.Tool != "" {
			return []ports.LLMEvent{{Kind: ports.EventToolCall, ToolCall: &ports.ToolCall{Name: ev.Item.Tool}}}
		}
	case "turn.completed":
		return []ports.LLMEvent{{Kind: ports.EventDone}}
	case "error":
		return []ports.LLMEvent{{Kind: ports.EventError, Err: "codex error"}, {Kind: ports.EventDone}}
	}
	return nil
}
