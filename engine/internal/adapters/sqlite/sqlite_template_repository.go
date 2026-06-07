package sqlite

import (
	"context"
	"database/sql"
	"errors"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type SQLiteTemplateRepository struct {
	db *sql.DB
}

func NewSQLiteTemplateRepository(db *sql.DB) *SQLiteTemplateRepository {
	return &SQLiteTemplateRepository{db: db}
}

func (r *SQLiteTemplateRepository) Create(ctx context.Context, t *domain.Template) error {
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO templates (id, workspace_id, name, description, category, sql_text, parameters, driver, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
			category=excluded.category, sql_text=excluded.sql_text, parameters=excluded.parameters,
			driver=excluded.driver, updated_at=excluded.updated_at
	`, t.ID, t.WorkspaceID, t.Name, t.Description, t.Category, t.SQLText, t.Parameters, t.Driver, t.CreatedAt, t.UpdatedAt)
	return err
}

func (r *SQLiteTemplateRepository) scan(rows interface{ Scan(...any) error }) (*domain.Template, error) {
	var t domain.Template
	err := rows.Scan(&t.ID, &t.WorkspaceID, &t.Name, &t.Description, &t.Category, &t.SQLText, &t.Parameters, &t.Driver, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func (r *SQLiteTemplateRepository) List(ctx context.Context, workspaceID string) ([]*domain.Template, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, workspace_id, name, description, category, sql_text, parameters, driver, created_at, updated_at
		FROM templates WHERE workspace_id = ? ORDER BY category, name
	`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*domain.Template
	for rows.Next() {
		t, err := r.scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, nil
}

func (r *SQLiteTemplateRepository) GetByID(ctx context.Context, id string) (*domain.Template, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, workspace_id, name, description, category, sql_text, parameters, driver, created_at, updated_at
		FROM templates WHERE id = ?
	`, id)
	t, err := r.scan(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("template not found")
	}
	return t, err
}

func (r *SQLiteTemplateRepository) Update(ctx context.Context, t *domain.Template) error {
	return r.Create(ctx, t) // upsert
}

func (r *SQLiteTemplateRepository) Delete(ctx context.Context, id string) error {
	res, err := r.db.ExecContext(ctx, "DELETE FROM templates WHERE id = ?", id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return errors.New("template not found")
	}
	return nil
}
