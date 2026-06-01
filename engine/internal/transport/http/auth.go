package http

import "crypto/subtle"

// validToken compares the request token against the launch token in constant
// time so a response-timing side channel can't be used to recover the token
// byte-by-byte. Both empty and length-mismatched tokens are rejected.
func validToken(reqToken, token string) bool {
	if reqToken == "" || token == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(reqToken), []byte(token)) == 1
}
