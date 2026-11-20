package domain

import "testing"

func validCloudSQL() ConnectionProfile {
	return ConnectionProfile{
		Name: "cvi", Driver: "postgres", Database: "app", ConnectionMode: "gcp_cloudsql",
		GCPCloudSQL: &GCPCloudSQLConfig{InstanceConnectionName: "my-project:asia-northeast3:cvi-db"},
	}
}

func TestGCPCloudSQLValidation(t *testing.T) {
	for _, driver := range []string{"mysql", "postgres", "sqlserver"} {
		p := validCloudSQL()
		p.Driver = driver
		if err := p.Validate(); err != nil {
			t.Fatalf("%s: %v", driver, err)
		}
	}
	for _, name := range []string{"my-project:asia-northeast3:cvi-db", "example.com:my-project:us-central1:db1"} {
		p := validCloudSQL()
		p.GCPCloudSQL.InstanceConnectionName = name
		if err := p.Validate(); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	for _, mode := range []string{"", "gcloud", "adc"} {
		p := validCloudSQL()
		p.GCPCloudSQL.AuthMode = mode
		p.GCPCloudSQL.CredentialsFile = "relative/ignored.json"
		if err := p.Validate(); err != nil {
			t.Fatalf("auth %q: %v", mode, err)
		}
	}
	p := validCloudSQL()
	p.GCPCloudSQL.AuthMode = "credentials_file"
	p.GCPCloudSQL.CredentialsFile = "/etc/key.json"
	p.GCPCloudSQL.ProxyPath = "/usr/local/bin/cloud-sql-proxy"
	p.TLSMode = "prefer"
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}

	const (
		msgDriver = "Cloud SQL connections support MySQL, PostgreSQL and SQL Server"
		msgName   = "Cloud SQL requires an instance connection name (project:region:instance)"
		msgAuth   = "unsupported Cloud SQL auth mode"
		msgKey    = "Cloud SQL: absolute service account key file path is required"
		msgProxy  = "Cloud SQL: cloud-sql-proxy path must be absolute"
		msgTLS    = "Cloud SQL Proxy encrypts the connection; set TLS to none"
	)
	cases := []struct {
		name string
		edit func(*ConnectionProfile)
		want string
	}{
		{"sqlite driver", func(p *ConnectionProfile) { p.Driver = "sqlite" }, msgDriver},
		{"redis driver", func(p *ConnectionProfile) { p.Driver = "redis" }, msgDriver},
		{"nil config", func(p *ConnectionProfile) { p.GCPCloudSQL = nil }, msgName},
		{"empty name", func(p *ConnectionProfile) { p.GCPCloudSQL.InstanceConnectionName = "" }, msgName},
		{"badname", func(p *ConnectionProfile) { p.GCPCloudSQL.InstanceConnectionName = "badname" }, msgName},
		{"leading dash", func(p *ConnectionProfile) { p.GCPCloudSQL.InstanceConnectionName = "-p:asia-northeast3:db" }, msgName},
		{"uppercase", func(p *ConnectionProfile) { p.GCPCloudSQL.InstanceConnectionName = "My-Project:asia-northeast3:db" }, msgName},
		{"space", func(p *ConnectionProfile) { p.GCPCloudSQL.InstanceConnectionName = "my-project:asia-northeast3:c db" }, msgName},
		{"newline", func(p *ConnectionProfile) { p.GCPCloudSQL.InstanceConnectionName = "my-project:asia-northeast3:db\n" }, msgName},
		{"unknown auth", func(p *ConnectionProfile) { p.GCPCloudSQL.AuthMode = "oauth" }, msgAuth},
		{"key missing", func(p *ConnectionProfile) { p.GCPCloudSQL.AuthMode = "credentials_file" }, msgKey},
		{"key relative", func(p *ConnectionProfile) {
			p.GCPCloudSQL.AuthMode, p.GCPCloudSQL.CredentialsFile = "credentials_file", "key.json"
		}, msgKey},
		{"key newline", func(p *ConnectionProfile) {
			p.GCPCloudSQL.AuthMode, p.GCPCloudSQL.CredentialsFile = "credentials_file", "/a\nb.json"
		}, msgKey},
		{"key nul", func(p *ConnectionProfile) {
			p.GCPCloudSQL.AuthMode, p.GCPCloudSQL.CredentialsFile = "credentials_file", "/a\x00b"
		}, msgKey},
		{"proxy relative", func(p *ConnectionProfile) { p.GCPCloudSQL.ProxyPath = "cloud-sql-proxy" }, msgProxy},
		{"proxy newline", func(p *ConnectionProfile) { p.GCPCloudSQL.ProxyPath = "/a\r/b" }, msgProxy},
		{"tls require", func(p *ConnectionProfile) { p.TLSMode = "require" }, msgTLS},
		{"no database", func(p *ConnectionProfile) { p.Database = "" }, "database name is required for relational databases"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := validCloudSQL()
			tc.edit(&p)
			err := p.Validate()
			if err == nil || err.Error() != tc.want {
				t.Fatalf("got %v, want %q", err, tc.want)
			}
		})
	}
}

func TestUsesProxyManagedEndpoint(t *testing.T) {
	if !validCloudSQL().UsesProxyManagedEndpoint() {
		t.Fatal("gcp_cloudsql should use proxy managed endpoint")
	}
	ssm := ConnectionProfile{ConnectionMode: "ssm", SSM: &SSMConfig{DestinationMode: "document"}}
	if !ssm.UsesProxyManagedEndpoint() {
		t.Fatal("ssm document should use proxy managed endpoint")
	}
	if (ConnectionProfile{ConnectionMode: "ssm", SSM: &SSMConfig{}}).UsesProxyManagedEndpoint() || (ConnectionProfile{}).UsesProxyManagedEndpoint() {
		t.Fatal("remote-host ssm and direct must not")
	}
}
