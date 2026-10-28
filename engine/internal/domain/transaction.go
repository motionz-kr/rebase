package domain

import (
	"errors"
	"strings"
)

// ErrRowLimitReached stops delivery without failing an open transaction.
var ErrRowLimitReached = errors.New("row limit reached")

// TransactionCommand describes SQL transaction boundaries without changing the
// SQL sent to the database. In particular ROLLBACK TO is not a full rollback.
type TransactionCommand struct {
	Action string
	Chain  bool
	Name   string
}

func StatementText(query string) string { return strings.TrimSpace(stripSQLComments(query)) }

func ParseTransactionCommand(query string) TransactionCommand {
	words := strings.Fields(strings.ToUpper(strings.TrimSpace(stripSQLComments(query))))
	for i := range words {
		words[i] = strings.TrimSuffix(words[i], ";")
	}
	if len(words) == 0 {
		return TransactionCommand{}
	}
	action := ""
	switch words[0] {
	case "BEGIN":
		action = "begin"
	case "START":
		if len(words) > 1 && words[1] == "TRANSACTION" {
			action = "begin"
		}
	case "COMMIT", "END":
		action = "commit"
	case "ROLLBACK", "ABORT":
		action = "rollback"
		for _, word := range words[1:] {
			if word == "TO" {
				action = "rollback-to"
				break
			}
		}
	case "SAVEPOINT":
		action = "savepoint"
	case "RELEASE":
		action = "release"
	}
	chain := false
	for i := 1; i < len(words); i++ {
		if words[i-1] == "AND" && words[i] == "CHAIN" {
			chain = true
		}
	}
	name := ""
	text := strings.ToUpper(StatementText(query))
	if action == "savepoint" {
		name = strings.TrimSpace(text[len("SAVEPOINT"):])
	}
	if action == "release" {
		name = strings.TrimSpace(text[len("RELEASE"):])
		if parts := strings.Fields(name); len(parts) > 1 && parts[0] == "SAVEPOINT" {
			name = strings.TrimSpace(name[len("SAVEPOINT"):])
		}
	}
	name = strings.TrimSpace(strings.TrimSuffix(name, ";"))
	return TransactionCommand{Action: action, Chain: chain, Name: name}
}

// SessionStatement identifies commands that configure a connection rather than
// starting the next implicit Manual transaction.
func IsSessionStatement(query string) bool {
	switch ClassifyQuery(query).Verb {
	case "SET", "USE", "PRAGMA":
		return true
	}
	return false
}
