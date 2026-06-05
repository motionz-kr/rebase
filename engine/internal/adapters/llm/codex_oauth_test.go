package llm

import (
	"encoding/base64"
	"testing"
)

func makeJWT(payloadJSON string) string {
	seg := base64.RawURLEncoding.EncodeToString([]byte(payloadJSON))
	return "eyJhbGciOiJSUzI1NiJ9." + seg + ".sig"
}

func TestDecodeJWTPayload(t *testing.T) {
	tok := makeJWT(`{"sub":"user_1","email":"a@b.com"}`)
	claims, err := decodeJWTPayload(tok)
	if err != nil {
		t.Fatalf("decodeJWTPayload err: %v", err)
	}
	if claims["sub"] != "user_1" || claims["email"] != "a@b.com" {
		t.Fatalf("claims = %v", claims)
	}
}

func TestDecodeJWTPayload_Bad(t *testing.T) {
	if _, err := decodeJWTPayload("not-a-jwt"); err == nil {
		t.Error("expected error for malformed token")
	}
}

func TestCodexAccountID(t *testing.T) {
	// Nested claim path used by ChatGPT id tokens.
	claims, _ := decodeJWTPayload(makeJWT(`{"https://api.openai.com/auth":{"chatgpt_account_id":"acct-xyz"}}`))
	if got := codexAccountID(claims); got != "acct-xyz" {
		t.Errorf("nested account id = %q, want acct-xyz", got)
	}
	// Top-level fallback.
	flat, _ := decodeJWTPayload(makeJWT(`{"chatgpt_account_id":"acct-top"}`))
	if got := codexAccountID(flat); got != "acct-top" {
		t.Errorf("top-level account id = %q, want acct-top", got)
	}
	// Missing → empty.
	none, _ := decodeJWTPayload(makeJWT(`{"sub":"x"}`))
	if got := codexAccountID(none); got != "" {
		t.Errorf("missing account id = %q, want empty", got)
	}
}
