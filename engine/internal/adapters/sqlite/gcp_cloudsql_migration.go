package sqlite

var GCPCloudSQLProfileMigration = Migration{
	Version: 21, Name: "add_gcp_cloudsql_connection_route",
	SQL:      `ALTER TABLE connection_profiles ADD COLUMN gcp_cloudsql_config TEXT NOT NULL DEFAULT '';`,
	Checksum: "profile-gcp-cloudsql-route-v1",
}
