package ssm

import (
	"context"
	"log"
	"os"
	"os/exec"
	"regexp"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

// Wait for a whole plugin line so split writes cannot produce a partial ID.
// Keep the first ID independently of the bounded diagnostic output buffer.
var sessionIDLine = regexp.MustCompile(`(?m)^Starting session with SessionId: ([A-Za-z0-9][A-Za-z0-9_:@.\-]{0,95})\r?\n`)

func terminateRemoteSession(command func(context.Context, string, ...string) *exec.Cmd, awsPath string, config domain.SSMConfig, id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	args := []string{"ssm", "terminate-session", "--session-id", id, "--region", config.Region}
	if config.Profile != "" {
		args = append(args, "--profile", config.Profile)
	}
	cmd := command(ctx, awsPath, args...)
	if cmd.Env == nil {
		cmd.Env = os.Environ()
	}
	cmd.Env = append(cmd.Env, "AWS_PAGER=", "AWS_CLI_AUTO_PROMPT=off")
	configureProcess(cmd)
	cmd.Cancel = func() error { killProcessTree(cmd); return nil }
	cmd.WaitDelay = 100 * time.Millisecond
	// Discard CLI output; it can contain credentials and must never reach MCP stdout.
	if err := cmd.Run(); err != nil {
		log.Print("AWS SSM: 원격 세션 종료를 확인하지 못했습니다. ssm:TerminateSession 권한, AWS 인증과 네트워크를 확인하세요")
	}
}
