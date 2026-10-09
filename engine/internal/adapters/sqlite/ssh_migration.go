package sqlite

var SSHProfileMigration = Migration{
	Version: 20, Name: "add_ssh_connection_route",
	SQL:      `ALTER TABLE connection_profiles ADD COLUMN ssh_config TEXT NOT NULL DEFAULT '';`,
	Checksum: "profile-ssh-route-v1",
}
