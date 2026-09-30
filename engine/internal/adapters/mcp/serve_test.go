package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

type observedReader struct {
	io.Reader
	reading chan struct{}
	once    sync.Once
}

func (r *observedReader) Read(p []byte) (int, error) {
	r.once.Do(func() { close(r.reading) })
	return r.Reader.Read(p)
}

func TestServeCancellationWhileInputRemainsOpen(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	in := &observedReader{Reader: reader, reading: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- newServer().Serve(ctx, in, io.Discard) }()
	<-in.reading
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Serve is blocked on stdin after cancellation")
	}
}

func TestServePreservesMessageOrderAndEOF(t *testing.T) {
	input := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"padding":"` + strings.Repeat("x", 70000) + `"}}` + "\n\n" + `{"jsonrpc":"2.0","method":"notifications/initialized"}` + "\n" + `{"jsonrpc":"2.0","id":2,"method":"tools/list"}` + "\n"
	var output bytes.Buffer
	if err := newServer().Serve(context.Background(), strings.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(&output)
	for _, id := range []int{1, 2} {
		var reply struct {
			ID    int `json:"id"`
			Error any `json:"error"`
		}
		if err := decoder.Decode(&reply); err != nil {
			t.Fatal(err)
		}
		if reply.ID != id || reply.Error != nil {
			t.Fatal(reply)
		}
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		t.Fatal("notification or blank line produced unexpected output", extra, err)
	}
}

func TestServeEnforcesInputLimit(t *testing.T) {
	input := strings.NewReader(strings.Repeat("x", 8*1024*1024+1) + "\n")
	var out bytes.Buffer
	if err := newServer().Serve(context.Background(), input, &out); err == nil {
		t.Fatal("oversized RPC input must fail")
	}
	if out.Len() != 0 {
		t.Fatal("oversized input must not reach the registry")
	}
}

type failedWriter struct{ err error }

func (w failedWriter) Write([]byte) (int, error) { return 0, w.err }
func TestServePropagatesOutputFailure(t *testing.T) {
	failure := errors.New("closed MCP output")
	input := strings.NewReader("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n")
	if err := newServer().Serve(context.Background(), input, failedWriter{failure}); !errors.Is(err, failure) {
		t.Fatal(err)
	}
}
