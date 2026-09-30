package ssm

import (
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

func ssmProfile() domain.ConnectionProfile {
	return domain.ConnectionProfile{ID: "prod", Name: "prod", Driver: "mysql", Host: "db.internal", Port: 3306, Database: "app", ConnectionMode: "ssm", SSM: &domain.SSMConfig{Profile: "production", Region: "ap-northeast-2", InstanceID: "i-0123456789abcdef0"}}
}
func TestStartSessionArgs(t *testing.T) {
	p := ssmProfile()
	args, err := startSessionArgs(p, 15432)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"ssm", "start-session", "--target", p.SSM.InstanceID, "--document-name", "AWS-StartPortForwardingSessionToRemoteHost", "--region", p.SSM.Region, "--parameters"}
	if !reflect.DeepEqual(args[:len(want)], want) {
		t.Fatalf("args: %v", args)
	}
	var params map[string][]string
	if err := json.Unmarshal([]byte(args[len(want)]), &params); err != nil {
		t.Fatal(err)
	}
	if params["host"][0] != p.Host || params["portNumber"][0] != "3306" || params["localPortNumber"][0] != "15432" {
		t.Fatal(params)
	}
	if !reflect.DeepEqual(args[len(want)+1:], []string{"--profile", "production"}) {
		t.Fatal(args)
	}
	p.SSM.Profile = ""
	args, err = startSessionArgs(p, 1234)
	if err != nil || strings.Contains(strings.Join(args, " "), "--profile") {
		t.Fatal(args, err)
	}
	if _, err = startSessionArgs(p, 0); err == nil {
		t.Fatal("expected invalid local port")
	}
}
func TestSafeStartupErrors(t *testing.T) {
	for _, tc := range []struct{ output, hint string }{
		{"Token has expired SECRET", "aws sso login"},
		{"AccessDeniedException SECRET", "IAM"},
		{"AccessDeniedException User: arn:aws:sts::123:assumed-role/AWSReservedSSO_readonly SECRET", "IAM"},
		{"SessionManagerPlugin is not found SECRET", "session-manager-plugin"},
		{"TargetNotConnected SECRET", "SSM Agent"},
		{"unknown diagnostic SECRET", "SSM"},
	} {
		err := startupError(tc.output)
		if !strings.Contains(err.Error(), tc.hint) || strings.Contains(err.Error(), "SECRET") {
			t.Fatal(err)
		}
	}
}

func TestCustomDocumentParameters(t *testing.T) {
	for _, mode := range []string{"document", "remote-host"} {
		t.Run(mode, func(t *testing.T) {
			p := ssmProfile()
			if err := json.Unmarshal([]byte(`{"documentName":"Revisit-RdsPortForwarding","destinationMode":"`+mode+`","profile":"default"}`), p.SSM); err != nil {
				t.Fatal(err)
			}
			args, err := startSessionArgs(p, 13306)
			if err != nil {
				t.Fatal(err)
			}
			if args[5] != "Revisit-RdsPortForwarding" {
				t.Fatal("custom document ignored", args)
			}
			var params map[string][]string
			if err = json.Unmarshal([]byte(args[9]), &params); err != nil {
				t.Fatal(err)
			}
			want := map[string][]string{"localPortNumber": {"13306"}}
			if mode == "remote-host" {
				want["host"] = []string{p.Host}
				want["portNumber"] = []string{"3306"}
			}
			if !reflect.DeepEqual(params, want) {
				t.Fatalf("document received wrong parameters: %v", params)
			}
		})
	}
}

func TestTunnelIdentityIncludesDocumentAndDestinationMode(t *testing.T) {
	p := ssmProfile()
	before := tunnelKey(p)
	if err := json.Unmarshal([]byte(`{"documentName":"Revisit-RdsPortForwarding"}`), p.SSM); err != nil {
		t.Fatal(err)
	}
	after := tunnelKey(p)
	if before == after {
		t.Fatal("different documents must not share a tunnel")
	}
	if err := json.Unmarshal([]byte(`{"destinationMode":"document"}`), p.SSM); err != nil {
		t.Fatal(err)
	}
	if after == tunnelKey(p) {
		t.Fatal("different parameter modes must not share a tunnel")
	}
}

func FuzzStartSessionArgs(f *testing.F) {
	f.Add("db.internal", "production", "ap-northeast-2", "i-0123456789abcdef0", 3306, 15432)
	f.Add("::1", "", "us-gov-west-1", "i-12345678", 5432, 65535)
	f.Add("db;touch${IFS}oops", "name;$(echo quote)\"'", "us-east-1", "i-12345678", 3306, 1)
	f.Add("db\ninternal", "--debug", "invalid", "--target", -1, 0)
	f.Fuzz(func(t *testing.T, host, profile, region, instance string, port, localPort int) {
		// Profiles arrive through JSON, whose strings are always valid UTF-8.
		if !utf8.ValidString(host) || !utf8.ValidString(profile) {
			t.Skip()
		}
		p := ssmProfile()
		p.Host, p.Port = host, port
		p.SSM = &domain.SSMConfig{Profile: profile, Region: region, InstanceID: instance}
		args, err := startSessionArgs(p, localPort)
		invalid := p.ValidateConnectionRoute() != nil || localPort < 1 || localPort > 65535
		if invalid {
			if err == nil {
				t.Fatal("invalid route accepted")
			}
			return
		}
		if err != nil {
			t.Fatal(err)
		}
		want := []string{"ssm", "start-session", "--target", instance, "--document-name", "AWS-StartPortForwardingSessionToRemoteHost", "--region", region, "--parameters"}
		if !reflect.DeepEqual(args[:9], want) {
			t.Fatal("input altered command options", args)
		}
		var params map[string][]string
		if err := json.Unmarshal([]byte(args[9]), &params); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(params, map[string][]string{"host": {host}, "portNumber": {strconv.Itoa(port)}, "localPortNumber": {strconv.Itoa(localPort)}}) {
			t.Fatal("parameters did not round-trip", params)
		}
		if profile == "" {
			if len(args) != 10 {
				t.Fatal(args)
			}
		} else if !reflect.DeepEqual(args[10:], []string{"--profile", profile}) {
			t.Fatal("profile must remain a single argument", args)
		}
	})
}

func FuzzCustomDocumentArgs(f *testing.F) {
	f.Add("Revisit-RdsPortForwarding", "document", 13306)
	f.Add("CustomForwarding", "remote-host", 15432)
	f.Add("", "", 1234)
	f.Add("--debug", "document", 13306)
	f.Fuzz(func(t *testing.T, document, mode string, localPort int) {
		p := ssmProfile()
		p.SSM.DocumentName = document
		p.SSM.DestinationMode = mode
		if mode == "document" {
			p.Host = ""
			p.Port = 0
		}
		args, err := startSessionArgs(p, localPort)
		if p.ValidateConnectionRoute() != nil || localPort < 1 || localPort > 65535 {
			if err == nil {
				t.Fatal("invalid document route accepted")
			}
			return
		}
		if err != nil {
			t.Fatal(err)
		}
		wantDocument := document
		if wantDocument == "" {
			wantDocument = "AWS-StartPortForwardingSessionToRemoteHost"
		}
		if args[5] != wantDocument {
			t.Fatal("document name did not round-trip", args)
		}
		var params map[string][]string
		if err = json.Unmarshal([]byte(args[9]), &params); err != nil {
			t.Fatal(err)
		}
		want := map[string][]string{"localPortNumber": {strconv.Itoa(localPort)}}
		if mode != "document" {
			want["host"] = []string{p.Host}
			want["portNumber"] = []string{strconv.Itoa(p.Port)}
		}
		if !reflect.DeepEqual(params, want) {
			t.Fatal("document parameter mode changed", params)
		}
	})
}
