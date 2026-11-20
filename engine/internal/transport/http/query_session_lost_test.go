package http

import (
	"errors"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlsession"
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
