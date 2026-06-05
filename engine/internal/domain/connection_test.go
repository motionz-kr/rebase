package domain

import (
	"testing"
)

func TestConnectionProfile_Validate(t *testing.T) {
	tests := []struct {
		name    string
		profile ConnectionProfile
		wantErr bool
	}{
		{
			name: "valid mysql profile",
			profile: ConnectionProfile{
				ID:        "p-123",
				Name:      "Local MySQL",
				Driver:    "mysql",
				Host:      "127.0.0.1",
				Port:      3306,
				Database:  "mydb",
				Username:  "root",
				SecretRef: "s-123",
				TLSMode:   "none",
			},
			wantErr: false,
		},
		{
			name: "empty name",
			profile: ConnectionProfile{
				ID:        "p-123",
				Name:      "",
				Driver:    "mysql",
				Host:      "127.0.0.1",
				Port:      3306,
				Database:  "mydb",
				Username:  "root",
				SecretRef: "s-123",
				TLSMode:   "none",
			},
			wantErr: true,
		},
		{
			name: "invalid driver",
			profile: ConnectionProfile{
				ID:        "p-123",
				Name:      "Local DB",
				Driver:    "mssql", // Unsupported driver for connection profiles
				Host:      "127.0.0.1",
				Port:      1433,
				Database:  "mydb",
				Username:  "root",
				SecretRef: "s-123",
				TLSMode:   "none",
			},
			wantErr: true,
		},
		{
			name: "empty host",
			profile: ConnectionProfile{
				ID:        "p-123",
				Name:      "Local MySQL",
				Driver:    "mysql",
				Host:      "",
				Port:      3306,
				Database:  "mydb",
				Username:  "root",
				SecretRef: "s-123",
				TLSMode:   "none",
			},
			wantErr: true,
		},
		{
			name: "invalid port",
			profile: ConnectionProfile{
				ID:        "p-123",
				Name:      "Local MySQL",
				Driver:    "mysql",
				Host:      "127.0.0.1",
				Port:      0,
				Database:  "mydb",
				Username:  "root",
				SecretRef: "s-123",
				TLSMode:   "none",
			},
			wantErr: true,
		},
		{
			name: "empty database for mysql",
			profile: ConnectionProfile{
				ID:        "p-123",
				Name:      "Local MySQL",
				Driver:    "mysql",
				Host:      "127.0.0.1",
				Port:      3306,
				Database:  "",
				Username:  "root",
				SecretRef: "s-123",
				TLSMode:   "none",
			},
			wantErr: true,
		},
		{
			name: "valid redis profile with empty database",
			profile: ConnectionProfile{
				ID:        "p-123",
				Name:      "Local Redis",
				Driver:    "redis",
				Host:      "127.0.0.1",
				Port:      6379,
				Database:  "", // Redis database can be empty (defaults to 0)
				Username:  "",
				SecretRef: "s-123",
				TLSMode:   "none",
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.profile.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("ConnectionProfile.Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestValidate_SQLiteAcceptsFilePathWithoutHostPort(t *testing.T) {
	p := ConnectionProfile{Name: "local.db", Driver: "sqlite", Database: "/tmp/local.db"}
	if err := p.Validate(); err != nil {
		t.Fatalf("expected sqlite profile with a file path to be valid, got: %v", err)
	}
}

func TestValidate_SQLiteRequiresDatabasePath(t *testing.T) {
	p := ConnectionProfile{Name: "x", Driver: "sqlite", Database: ""}
	if err := p.Validate(); err == nil {
		t.Fatal("expected sqlite profile with empty Database (file path) to be invalid")
	}
}
