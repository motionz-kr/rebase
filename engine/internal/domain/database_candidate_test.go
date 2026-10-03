package domain

import "testing"

func TestDiscoveredDatabaseValidate(t *testing.T) {
	tests := []struct {
		name      string
		candidate DiscoveredDatabase
		wantErr   bool
	}{
		{
			name:      "loopback mysql candidate",
			candidate: DiscoveredDatabase{ID: CandidateID("mysql", "127.0.0.1", 3306), Driver: "mysql", Host: "127.0.0.1", Port: 3306, Source: "local"},
		},
		{
			name:      "docker postgres candidate",
			candidate: DiscoveredDatabase{ID: CandidateID("postgres", "127.0.0.1", 5433), Driver: "postgres", Host: "127.0.0.1", Port: 5433, Source: "docker", SourceName: "test-postgres"},
		},
		{
			name:      "remote host is rejected",
			candidate: DiscoveredDatabase{ID: CandidateID("mysql", "192.168.1.12", 3306), Driver: "mysql", Host: "192.168.1.12", Port: 3306, Source: "local"},
			wantErr:   true,
		},
		{
			name:      "unsupported driver is rejected",
			candidate: DiscoveredDatabase{ID: CandidateID("unknown", "127.0.0.1", 1234), Driver: "unknown", Host: "127.0.0.1", Port: 1234, Source: "local"},
			wantErr:   true,
		},
		{
			name:      "invalid port is rejected",
			candidate: DiscoveredDatabase{ID: CandidateID("mysql", "127.0.0.1", 70000), Driver: "mysql", Host: "127.0.0.1", Port: 70000, Source: "local"},
			wantErr:   true,
		},
		{
			name:      "invalid source is rejected",
			candidate: DiscoveredDatabase{ID: CandidateID("mysql", "127.0.0.1", 3306), Driver: "mysql", Host: "127.0.0.1", Port: 3306, Source: "remote-docker"},
			wantErr:   true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.candidate.Validate()
			if (err != nil) != tt.wantErr {
				t.Fatalf("Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
