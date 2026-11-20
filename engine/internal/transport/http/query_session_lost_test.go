package http

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlsession"
	"github.com/smlee/database-local-engine/engine/internal/domain"
)

func TestQueryErrorMessageReplacesDriverErrorsOfLostSessions(t *testing.T) {
	raw := errors.New("invalid connection")
	tests := []struct {
		name  string
		state string
		want  string
	}{
		{"idle loss", "lost", "DB 연결이 끊겼습니다. 이 문장의 결과는 확인되지 않았습니다. 다시 실행하면 새 연결로 실행합니다."},
		{"loss in transaction", "lost_transaction", "트랜잭션 중 DB 연결이 끊겼습니다. 커밋되지 않은 변경은 서버에서 취소됩니다. Rollback 후 다시 실행하세요."},
		{"failed transaction keeps driver text", "failed", "invalid connection"},
		{"idle keeps driver text", "idle", "invalid connection"},
		{"no session keeps driver text", "", "invalid connection"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := queryErrorMessage(tc.state, raw); got != tc.want {
				t.Fatalf("queryErrorMessage(%q) = %q, want %q", tc.state, got, tc.want)
			}
		})
	}
	// A curated error from sqlsession wins over the state (commit outcome unknown is "lost").
	if got := queryErrorMessage("lost", sqlsession.ErrCommitOutcomeUnknown); got != "커밋 중 DB 연결이 끊겨 커밋 여부를 확인할 수 없습니다. 새 연결에서 데이터를 확인한 뒤 진행하세요." {
		t.Fatalf("commit outcome message = %q", got)
	}
	// The curated text lives in sqlsession only.
	if got := queryErrorMessage("lost", raw); got != sqlsession.ErrConnectionLost.Error() {
		t.Fatalf("lost message is not sqlsession.ErrConnectionLost: %q", got)
	}
	if got := queryErrorMessage("lost_transaction", raw); got != sqlsession.ErrConnectionLostInTransaction.Error() {
		t.Fatalf("lost_transaction message is not sqlsession.ErrConnectionLostInTransaction: %q", got)
	}
}

func TestSessionControlResponseCarriesTransactionState(t *testing.T) {
	got := sessionControlResponse("sid", "lost")
	if got["success"] != true || got["sessionId"] != "sid" || got["transactionState"] != "lost" {
		t.Fatalf("response = %#v", got)
	}
	if _, ok := sessionControlResponse("sid", "")["transactionState"]; ok {
		t.Fatal("transactionState must be omitted when unknown")
	}
}

type fakeSessionConnector struct {
	commitErr, rollbackErr error
	state                  string
	stateErr               error
}

func (f *fakeSessionConnector) OpenQuerySession(context.Context, domain.ConnectionProfile, string, string, string, bool, ...bool) (string, error) {
	return "new-session", nil
}
func (f *fakeSessionConnector) ExecuteQuerySessionStream(context.Context, domain.ConnectionProfile, string, string, string, string, string, bool, func(int64), func([]string) error, func([]any) error) (int64, error) {
	return 0, nil
}
func (f *fakeSessionConnector) CommitQuerySession(context.Context, string, string) error {
	return f.commitErr
}
func (f *fakeSessionConnector) RollbackQuerySession(context.Context, string, string) error {
	return f.rollbackErr
}
func (f *fakeSessionConnector) CloseQuerySession(string, string) error { return nil }
func (f *fakeSessionConnector) QuerySessionState(string, string) (string, error) {
	return f.state, f.stateErr
}
func (f *fakeSessionConnector) SetQuerySessionAutoCommit(string, string, bool) error { return nil }

func controlResponse(t *testing.T, c *fakeSessionConnector, action string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	serveSessionControl(context.Background(), w, c, domain.ConnectionProfile{}, "", QuerySessionRequest{
		Action: action, ProfileID: "p", SessionID: "s"})
	return w
}

func TestSessionControlFailedCommitKeepsTextBodyAndReportsState(t *testing.T) {
	lostInCommit := &fakeSessionConnector{commitErr: sqlsession.ErrCommitOutcomeUnknown, state: "lost"}
	w := controlResponse(t, lostInCommit, "commit")
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", w.Code)
	}
	// Same contract as before: the plain-text body is the error message shown to the user.
	if got := strings.TrimSpace(w.Body.String()); got != sqlsession.ErrCommitOutcomeUnknown.Error() {
		t.Fatalf("body = %q", got)
	}
	if got := w.Header().Get("X-Transaction-State"); got != "lost" {
		t.Fatalf("X-Transaction-State = %q, want lost", got)
	}

	// A raw driver error that discovered the loss is replaced by the curated text.
	discovered := &fakeSessionConnector{commitErr: errors.New("invalid connection"), state: "lost_transaction"}
	w = controlResponse(t, discovered, "commit")
	if got := strings.TrimSpace(w.Body.String()); got != sqlsession.ErrConnectionLostInTransaction.Error() {
		t.Fatalf("body = %q", got)
	}
	if got := w.Header().Get("X-Transaction-State"); got != "lost_transaction" {
		t.Fatalf("X-Transaction-State = %q", got)
	}

	// Ordinary failures are unchanged.
	ordinary := &fakeSessionConnector{commitErr: errors.New("there is no active transaction to commit"), state: "idle"}
	w = controlResponse(t, ordinary, "commit")
	if got := strings.TrimSpace(w.Body.String()); got != "there is no active transaction to commit" {
		t.Fatalf("body = %q", got)
	}
}

func TestSessionControlRollbackOfLostTransactionReportsLost(t *testing.T) {
	w := controlResponse(t, &fakeSessionConnector{state: "lost"}, "rollback")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["success"] != true || body["transactionState"] != "lost" {
		t.Fatalf("body = %#v", body)
	}
	// Unknown state is simply omitted; non commit/rollback actions never report one.
	w = controlResponse(t, &fakeSessionConnector{stateErr: sqlsession.ErrNotFound}, "commit")
	if strings.Contains(w.Body.String(), "transactionState") {
		t.Fatalf("body = %s", w.Body.String())
	}
	w = controlResponse(t, &fakeSessionConnector{state: "lost"}, "close")
	if strings.Contains(w.Body.String(), "transactionState") {
		t.Fatalf("close must not report state: %s", w.Body.String())
	}
}
