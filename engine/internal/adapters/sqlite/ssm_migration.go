package sqlite

// Existing profiles remain direct connections; no secrets are stored here.
var SSMProfileMigration = Migration{
	Version: 18,
	Name:    "add_ssm_connection_route",
	SQL: `ALTER TABLE connection_profiles ADD COLUMN connection_mode TEXT NOT NULL DEFAULT '';
 ALTER TABLE connection_profiles ADD COLUMN ssm_config TEXT NOT NULL DEFAULT '';`,
	Checksum: "profile-ssm-route-v1",
}
