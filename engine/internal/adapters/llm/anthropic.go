package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

const (
	defaultAnthropicBaseURL = "https://api.anthropic.com"
	anthropicVersion        = "2023-06-01"
	defaultMaxTokens        = 2048
)

// AnthropicProvider implements ports.LLMProvider over the Anthropic Messages API
// (streaming). Translation and SSE decoding live in translate.go and are unit
// tested; this type only handles HTTP transport.
type AnthropicProvider struct {
	apiKey     string
	model      string
	baseURL    string
	maxTokens  int
	httpClient *http.Client
}

func NewAnthropicProvider(apiKey, model, baseURL string) *AnthropicProvider {
	if baseURL == "" {
		baseURL = defaultAnthropicBaseURL
	}
	if model == "" {
		model = "claude-sonnet-4-6"
	}
	return &AnthropicProvider{
		apiKey:     apiKey,
		model:      model,
		baseURL:    strings.TrimRight(baseURL, "/"),
		maxTokens:  defaultMaxTokens,
		httpClient: &http.Client{Timeout: 120 * time.Second},
	}
}

func (a *AnthropicProvider) Status(_ context.Context) (ports.ProviderStatus, error) {
	if a.apiKey == "" {
		return ports.ProviderStatus{Ready: false, Detail: "no API key set"}, nil
	}
	return ports.ProviderStatus{Ready: true, Detail: "Anthropic API (" + a.model + ")"}, nil
}

func (a *AnthropicProvider) Complete(ctx context.Context, req ports.LLMRequest, emit func(ports.LLMEvent)) error {
	if req.Model == "" {
		req.Model = a.model
	}
	body := BuildAnthropicBody(req, a.maxTokens)
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, a.baseURL+"/v1/messages", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	httpReq.Header.Set("content-type", "application/json")
	httpReq.Header.Set("accept", "text/event-stream")
	httpReq.Header.Set("anthropic-version", anthropicVersion)
	httpReq.Header.Set("x-api-key", a.apiKey)

	resp, err := a.httpClient.Do(httpReq)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("anthropic API %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	return parseSSEStream(resp.Body, emit)
}

// parseSSEStream reads an Anthropic event stream (event:/data: lines, blank-line
// separated) and forwards decoded neutral events to emit.
func parseSSEStream(r io.Reader, emit func(ports.LLMEvent)) error {
	dec := NewStreamDecoder()
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	var event string
	var data []byte
	flush := func() {
		if event == "" {
			return
		}
		for _, e := range dec.Event(event, data) {
			emit(e)
		}
		event, data = "", nil
	}

	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			flush()
		case strings.HasPrefix(line, "event:"):
			event = strings.TrimSpace(line[len("event:"):])
		case strings.HasPrefix(line, "data:"):
			data = []byte(strings.TrimSpace(line[len("data:"):]))
		}
	}
	flush()
	return sc.Err()
}
