package domain

import (
	"encoding/json"
	"testing"
)

func TestSSMProfileValidation(t *testing.T) {
	valid := func() ConnectionProfile {
		return ConnectionProfile{Name: "prod", Driver: "mysql", Host: "db.internal", Port: 3306, Database: "app", ConnectionMode: "ssm", SSM: &SSMConfig{Profile: "prod", Region: "ap-northeast-2", InstanceID: "i-0123456789abcdef0"}}
	}
	for _, driver := range []string{"mysql", "postgres"} {
		p := valid()
		p.Driver = driver
		if err := p.Validate(); err != nil {
			t.Fatal(err)
		}
	}
	cases := map[string]func(*ConnectionProfile){
		"missing settings":   func(p *ConnectionProfile) { p.SSM = nil },
		"missing region":     func(p *ConnectionProfile) { p.SSM.Region = "" },
		"invalid instance":   func(p *ConnectionProfile) { p.SSM.InstanceID = "--target" },
		"profile option":     func(p *ConnectionProfile) { p.SSM.Profile = "--debug" },
		"unsupported driver": func(p *ConnectionProfile) { p.Driver = "sqlite" },
		"unknown mode":       func(p *ConnectionProfile) { p.ConnectionMode = "unsupported" },
		"invalid host":       func(p *ConnectionProfile) { p.Host = "db\ninternal" },
	}
	for name, edit := range cases {
		t.Run(name, func(t *testing.T) {
			p := valid()
			edit(&p)
			if err := p.Validate(); err == nil {
				t.Fatal("expected invalid SSM configuration")
			}
		})
	}
	p := valid()
	p.SSM.Profile = ""
	if err := p.Validate(); err != nil {
		t.Fatal("default AWS credential chain must work:", err)
	}
	p.ConnectionMode = ""
	p.SSM = nil
	if err := p.Validate(); err != nil {
		t.Fatal("legacy direct profile:", err)
	}
}

func TestSSMCustomDocumentValidation(t *testing.T) {
	for _, tc := range []struct {
		name, settings string
		host           string
		port           int
		valid          bool
	}{
		{"document owns destination", `{"documentName":"Revisit-RdsPortForwarding","destinationMode":"document"}`, "", 0, true},
		{"custom remote host document", `{"documentName":"CustomForwarding","destinationMode":"remote-host"}`, "db.internal", 3306, true},
		{"document ARN", `{"documentName":"arn:aws:ssm:ap-northeast-2:123456789012:document/CustomForwarding","destinationMode":"document"}`, "", 0, true},
		{"missing document", `{"destinationMode":"document"}`, "db.internal", 3306, false},
		{"unknown destination mode", `{"destinationMode":"shell"}`, "db.internal", 3306, false},
		{"document option", `{"documentName":"--debug"}`, "db.internal", 3306, false},
		{"document whitespace", `{"documentName":"Bad Document"}`, "db.internal", 3306, false},
		{"standard mode still requires destination", `{"documentName":"CustomForwarding"}`, "", 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := ConnectionProfile{Name: "prod", Driver: "mysql", Host: tc.host, Port: tc.port, Database: "app", ConnectionMode: "ssm", SSM: &SSMConfig{Region: "ap-northeast-2", InstanceID: "i-0123456789abcdef0"}}
			if err := json.Unmarshal([]byte(tc.settings), p.SSM); err != nil {
				t.Fatal(err)
			}
			if err := p.Validate(); (err == nil) != tc.valid {
				t.Fatalf("valid=%t, error=%v", tc.valid, err)
			}
		})
	}
}
