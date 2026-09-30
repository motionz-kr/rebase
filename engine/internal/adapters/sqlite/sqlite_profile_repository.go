package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type SQLiteProfileRepository struct {
	db *sql.DB
}

func NewSQLiteProfileRepository(db *sql.DB) *SQLiteProfileRepository {
	return &SQLiteProfileRepository{db: db}
}

func (r *SQLiteProfileRepository) Create(ctx context.Context, p *domain.ConnectionProfile) error {
	ssmJSON, marshalErr := json.Marshal(p.SSM)
	if marshalErr != nil {
		return marshalErr
	}
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO connection_profiles (id, name, driver, host, port, database, username, secret_ref, tls_mode, mcp_enabled, mcp_data_exposure, mcp_write_mode, mcp_allowed_databases, mcp_allowed_schemas, mcp_allowed_tables, read_only, connection_uri, safe_mode, tenant_columns, domain_bindings, domain_glossary, domain_notes, connection_mode, ssm_config, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, p.ID, p.Name, p.Driver, p.Host, p.Port, p.Database, p.Username, p.SecretRef, p.TLSMode, p.McpEnabled, p.McpDataExposure, domain.NormalizeMCPWriteMode(p.McpWriteMode), p.McpAllowedDatabases, p.McpAllowedSchemas, p.McpAllowedTables, p.ReadOnly, p.ConnectionURI, p.SafeMode, p.TenantColumns, p.DomainBindings, p.DomainGlossary, p.DomainNotes, p.ConnectionMode, string(ssmJSON), p.CreatedAt, p.UpdatedAt)
	return err
}

func (r *SQLiteProfileRepository) GetByID(ctx context.Context, id string) (*domain.ConnectionProfile, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, name, driver, host, port, database, username, secret_ref, tls_mode, mcp_enabled, mcp_data_exposure, mcp_write_mode, mcp_allowed_databases, mcp_allowed_schemas, mcp_allowed_tables, read_only, connection_uri, safe_mode, tenant_columns, domain_bindings, domain_glossary, domain_notes, connection_mode, ssm_config, created_at, updated_at
		FROM connection_profiles WHERE id = ?
	`, id)

	var p domain.ConnectionProfile
	var ssmJSON string
	err := row.Scan(&p.ID, &p.Name, &p.Driver, &p.Host, &p.Port, &p.Database, &p.Username, &p.SecretRef, &p.TLSMode, &p.McpEnabled, &p.McpDataExposure, &p.McpWriteMode, &p.McpAllowedDatabases, &p.McpAllowedSchemas, &p.McpAllowedTables, &p.ReadOnly, &p.ConnectionURI, &p.SafeMode, &p.TenantColumns, &p.DomainBindings, &p.DomainGlossary, &p.DomainNotes, &p.ConnectionMode, &ssmJSON, &p.CreatedAt, &p.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, errors.New("profile not found")
	}
	if err != nil {
		return nil, err
	}
	if err := decodeSSM(ssmJSON, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

func (r *SQLiteProfileRepository) List(ctx context.Context) ([]domain.ConnectionProfile, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, name, driver, host, port, database, username, secret_ref, tls_mode, mcp_enabled, mcp_data_exposure, mcp_write_mode, mcp_allowed_databases, mcp_allowed_schemas, mcp_allowed_tables, read_only, connection_uri, safe_mode, tenant_columns, domain_bindings, domain_glossary, domain_notes, connection_mode, ssm_config, created_at, updated_at
		FROM connection_profiles
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []domain.ConnectionProfile
	for rows.Next() {
		var p domain.ConnectionProfile
		var ssmJSON string
		err := rows.Scan(&p.ID, &p.Name, &p.Driver, &p.Host, &p.Port, &p.Database, &p.Username, &p.SecretRef, &p.TLSMode, &p.McpEnabled, &p.McpDataExposure, &p.McpWriteMode, &p.McpAllowedDatabases, &p.McpAllowedSchemas, &p.McpAllowedTables, &p.ReadOnly, &p.ConnectionURI, &p.SafeMode, &p.TenantColumns, &p.DomainBindings, &p.DomainGlossary, &p.DomainNotes, &p.ConnectionMode, &ssmJSON, &p.CreatedAt, &p.UpdatedAt)
		if err != nil {
			return nil, err
		}
		if err := decodeSSM(ssmJSON, &p); err != nil {
			return nil, err
		}
		list = append(list, p)
	}
	return list, nil
}

func (r *SQLiteProfileRepository) Update(ctx context.Context, p *domain.ConnectionProfile) error {
	ssmJSON, marshalErr := json.Marshal(p.SSM)
	if marshalErr != nil {
		return marshalErr
	}
	p.UpdatedAt = time.Now()
	res, err := r.db.ExecContext(ctx, `
		UPDATE connection_profiles
		SET name = ?, driver = ?, host = ?, port = ?, database = ?, username = ?, secret_ref = ?, tls_mode = ?, mcp_enabled = ?, mcp_data_exposure = ?, mcp_write_mode = ?, mcp_allowed_databases = ?, mcp_allowed_schemas = ?, mcp_allowed_tables = ?, read_only = ?, connection_uri = ?, safe_mode = ?, tenant_columns = ?, domain_bindings = ?, domain_glossary = ?, domain_notes = ?, connection_mode = ?, ssm_config = ?, updated_at = ?
		WHERE id = ?
	`, p.Name, p.Driver, p.Host, p.Port, p.Database, p.Username, p.SecretRef, p.TLSMode, p.McpEnabled, p.McpDataExposure, domain.NormalizeMCPWriteMode(p.McpWriteMode), p.McpAllowedDatabases, p.McpAllowedSchemas, p.McpAllowedTables, p.ReadOnly, p.ConnectionURI, p.SafeMode, p.TenantColumns, p.DomainBindings, p.DomainGlossary, p.DomainNotes, p.ConnectionMode, string(ssmJSON), p.UpdatedAt, p.ID)
	if err != nil {
		return err
	}
	rowsAffected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if rowsAffected == 0 {
		return errors.New("profile not found")
	}
	return nil
}

func (r *SQLiteProfileRepository) Delete(ctx context.Context, id string) error {
	res, err := r.db.ExecContext(ctx, "DELETE FROM connection_profiles WHERE id = ?", id)
	if err != nil {
		return err
	}
	rowsAffected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if rowsAffected == 0 {
		return errors.New("profile not found")
	}
	return nil
}

func decodeSSM(raw string, p *domain.ConnectionProfile) error {
	if raw == "" || raw == "null" {
		return nil
	}
	if err := json.Unmarshal([]byte(raw), &p.SSM); err != nil {
		return fmt.Errorf("invalid stored SSM configuration: %w", err)
	}
	return nil
}
