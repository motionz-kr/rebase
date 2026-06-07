package domain

import (
	"reflect"
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
	p := ConnectionProfile{Name: "my-sqlite", Driver: "sqlite", Database: "/tmp/local.db"}
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

func TestValidate_SQLServerAcceptedLikeRelational(t *testing.T) {
	p := ConnectionProfile{Name: "ms", Driver: "sqlserver", Host: "h", Port: 1433, Database: "db", Username: "sa"}
	if err := p.Validate(); err != nil {
		t.Fatalf("expected sqlserver profile to be valid, got: %v", err)
	}
}
func TestValidate_SQLServerRequiresHostPortDatabase(t *testing.T) {
	if (ConnectionProfile{Name: "x", Driver: "sqlserver", Host: "", Port: 1433, Database: "db"}).Validate() == nil {
		t.Fatal("expected missing host to be invalid")
	}
	if (ConnectionProfile{Name: "x", Driver: "sqlserver", Host: "h", Port: 1433, Database: ""}).Validate() == nil {
		t.Fatal("expected missing database to be invalid")
	}
}

func TestValidate_MongoStructured(t *testing.T) {
	p := ConnectionProfile{Name: "m", Driver: "mongodb", Host: "h", Port: 27017}
	if err := p.Validate(); err != nil {
		t.Fatalf("structured mongo should be valid: %v", err)
	}
}
func TestValidate_MongoConnectionURI(t *testing.T) {
	p := ConnectionProfile{Name: "m", Driver: "mongodb", ConnectionURI: "mongodb+srv://x/y"}
	if err := p.Validate(); err != nil {
		t.Fatalf("uri mongo should be valid: %v", err)
	}
}
func TestValidate_MongoNeedsHostOrURI(t *testing.T) {
	if (ConnectionProfile{Name: "m", Driver: "mongodb"}).Validate() == nil {
		t.Fatal("mongo with neither host nor uri should be invalid")
	}
}

func TestTenantColumnList_DefaultsWhenEmpty(t *testing.T) {
	p := ConnectionProfile{TenantColumns: ""}
	got := p.TenantColumnList()
	want := []string{"hospitalId", "tenantId"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("default tenant columns: got %v want %v", got, want)
	}
}

func TestTenantColumnList_ParsesAndTrims(t *testing.T) {
	p := ConnectionProfile{TenantColumns: " org_id , hospitalId ,"}
	got := p.TenantColumnList()
	want := []string{"org_id", "hospitalId"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parsed tenant columns: got %v want %v", got, want)
	}
}

func TestDomainGlossaryEntries(t *testing.T) {
	p := ConnectionProfile{DomainGlossary: `[{"kind":"table","table":"User","column":"","meaning":"환자"},{"kind":"column","table":"User","column":"hospitalId","meaning":"병원 구분값"}]`}
	got := p.DomainGlossaryEntries()
	if len(got) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(got))
	}
	if got[0].Table != "User" || got[0].Meaning != "환자" || got[0].Kind != "table" {
		t.Errorf("entry0 wrong: %+v", got[0])
	}
	if got[1].Column != "hospitalId" || got[1].Meaning != "병원 구분값" {
		t.Errorf("entry1 wrong: %+v", got[1])
	}
}

func TestDomainGlossaryEntries_InvalidOrEmpty(t *testing.T) {
	for _, in := range []string{"", "   ", "not json", "{}"} {
		got := ConnectionProfile{DomainGlossary: in}.DomainGlossaryEntries()
		if len(got) != 0 {
			t.Errorf("input %q: expected 0 entries, got %d", in, len(got))
		}
	}
}
