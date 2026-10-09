package domain

import (
	"encoding/json"
	"testing"
)

func TestSSHRouteValidation(t *testing.T) {
	base := `{"name":"bastion","driver":"mysql","host":"db.internal","port":3306,"database":"app","connectionMode":"ssh","ssh":{"host":"bastion.example.com","port":22,"username":"ec2-user","identityFile":"/tmp/key.pem"}}`
	var p ConnectionProfile
	if err := json.Unmarshal([]byte(base), &p); err != nil {
		t.Fatal(err)
	}
	if err := p.Validate(); err != nil {
		t.Fatalf("valid SSH route rejected: %v", err)
	}
	for _, driver := range []string{"redis", "sqlite", "mongodb", "sqlserver"} {
		q := p
		q.Driver = driver
		if q.ValidateConnectionRoute() == nil {
			t.Fatalf("SSH must reject %s", driver)
		}
	}
	var invalid ConnectionProfile
	for _, raw := range []string{
		`{"driver":"mysql","connectionMode":"ssh"}`,
		`{"driver":"mysql","host":"db","port":3306,"connectionMode":"ssh","ssh":{"host":"-bad","port":22,"username":"u","identityFile":"/key"}}`,
		`{"driver":"mysql","host":"db","port":3306,"connectionMode":"ssh","ssh":{"host":"bastion","port":0,"username":"u","identityFile":"/key"}}`,
		`{"driver":"mysql","host":"db","port":3306,"connectionMode":"ssh","ssh":{"host":"bastion","port":22,"username":"","identityFile":"/key"}}`,
		`{"driver":"mysql","host":"db","port":3306,"connectionMode":"ssh","ssh":{"host":"bastion","port":22,"username":"u","identityFile":""}}`,
		`{"driver":"mysql","host":"db host","port":3306,"connectionMode":"ssh","ssh":{"host":"bastion","port":22,"username":"u","identityFile":"/key"}}`,
	} {
		invalid = ConnectionProfile{}
		json.Unmarshal([]byte(raw), &invalid)
		if invalid.ValidateConnectionRoute() == nil {
			t.Fatalf("invalid route accepted: %s", raw)
		}
	}
}
