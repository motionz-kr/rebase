package http

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/smlee/database-local-engine/engine/internal/analyzer"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type AnalyzeQueryRequest struct {
	ProfileID string `json:"profileId"`
	Query     string `json:"query"`
	Database  string `json:"database"`
}

// AnalyzeResponse is the pre-execution risk report sent to the renderer.
// Pointer fields are nil when not applicable (non-parseable / read-only / no PK).
type AnalyzeResponse struct {
	Level         string   `json:"level"`
	Verb          string   `json:"verb"`
	Reasons       []string `json:"reasons"`
	Table         string   `json:"table"`
	HasWhere      bool     `json:"hasWhere"`
	TenantMissing bool     `json:"tenantMissing"`
	Parseable     bool     `json:"parseable"`
	AffectedRows  *int64   `json:"affectedRows"`
	PreviewSQL    string   `json:"previewSql"`
	PreviewCols   []string `json:"previewCols"`
	PreviewRows   [][]any  `json:"previewRows"`
	RollbackSQL   string   `json:"rollbackSql"`
	RollbackNote  string   `json:"rollbackNote"`
}

const previewRowLimit = 20
const snapshotRowLimit = 1000

func assembleStaticReport(r analyzer.RiskReport) AnalyzeResponse {
	reasons := r.Reasons
	if reasons == nil {
		reasons = []string{}
	}
	return AnalyzeResponse{
		Level:         string(r.Level),
		Verb:          r.Verb,
		Reasons:       reasons,
		Table:         r.Table,
		HasWhere:      r.HasWhere,
		TenantMissing: r.TenantMissing,
		Parseable:     r.Parseable,
	}
}

func (h *QueryHandler) AnalyzeQuery() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var req AnalyzeQueryRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.ProfileID == "" || req.Query == "" {
			http.Error(w, "profileId and query are required", http.StatusBadRequest)
			return
		}
		profile, password, err := h.service.GetProfile(r.Context(), req.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		report := analyzer.Analyze(req.Query, profile.TenantColumnList())
		resp := assembleStaticReport(report)

		connector, cerr := h.getConnector(profile.Driver)
		if report.Parseable && cerr == nil && (report.Verb == "UPDATE" || report.Verb == "DELETE") {
			h.enrichReport(r.Context(), connector, *profile, password, req.Database, report, &resp)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
}

// enrichReport fills DB-derived fields (affected count, preview, rollback).
func (h *QueryHandler) enrichReport(ctx context.Context, connector ports.SQLConnector, profile domain.ConnectionProfile, password, database string, report analyzer.RiskReport, resp *AnalyzeResponse) {
	driver := profile.Driver
	p := report.Parsed

	// 1. Table introspection: columns + primary keys + tenant intersection.
	var allCols, pkCols []string
	if desc, err := connector.DescribeTable(ctx, profile, password, database, p.Table); err == nil {
		for _, c := range desc.Columns {
			allCols = append(allCols, c.Name)
			if c.PrimaryKey {
				pkCols = append(pkCols, c.Name)
			}
		}
		tenantCols := analyzer.IntersectColumns(allCols, profile.TenantColumnList())
		report = analyzer.ApplyTenantCheck(report, allCols, tenantCols, profile.SafeMode)
		resp.Level = string(report.Level)
		resp.TenantMissing = report.TenantMissing
		resp.Reasons = report.Reasons
	}

	// 2. Affected-row COUNT.
	if n, ok := h.scalarInt(ctx, connector, profile, password, analyzer.BuildCountSQL(driver, p)); ok {
		resp.AffectedRows = &n
	}

	// 3. SELECT preview (text + sample rows).
	resp.PreviewSQL = analyzer.BuildPreviewSQL(driver, p)
	cols, rows := h.collectRows(ctx, connector, profile, password, resp.PreviewSQL, previewRowLimit)
	resp.PreviewCols = cols
	resp.PreviewRows = rows

	// 4. Rollback (UPDATE needs PK; cap snapshot at snapshotRowLimit).
	if resp.AffectedRows != nil && *resp.AffectedRows > snapshotRowLimit {
		resp.RollbackNote = "영향 row가 1000건을 초과해 Rollback SQL을 생성하지 않았습니다"
		return
	}
	snapCols, snapRows := h.collectRows(ctx, connector, profile, password, analyzer.BuildSnapshotSQL(driver, p, pkCols), snapshotRowLimit+1)
	if len(snapRows) > snapshotRowLimit {
		resp.RollbackNote = "영향 row가 너무 많아 Rollback SQL을 생성하지 않았습니다"
		return
	}
	if sqlText, ok := analyzer.BuildRollbackSQL(driver, p, snapCols, pkCols, snapRows); ok {
		resp.RollbackSQL = sqlText
	} else if p.Verb == "UPDATE" && len(pkCols) == 0 {
		resp.RollbackNote = "PK가 없어 Rollback SQL을 생성할 수 없습니다"
	}
}

// scalarInt runs a single-value query (e.g. COUNT) and returns the int result.
func (h *QueryHandler) scalarInt(ctx context.Context, connector ports.SQLConnector, profile domain.ConnectionProfile, password, query string) (int64, bool) {
	var out int64
	var got bool
	_, err := connector.ExecuteQueryStream(ctx, profile, password, query, true,
		func(int64) {}, func([]string) error { return nil },
		func(row []any) error {
			if len(row) > 0 {
				out = toInt64(row[0])
				got = true
			}
			return nil
		})
	if err != nil {
		return 0, false
	}
	return out, got
}

// collectRows runs a read-only query and accumulates up to limit rows.
func (h *QueryHandler) collectRows(ctx context.Context, connector ports.SQLConnector, profile domain.ConnectionProfile, password, query string, limit int) ([]string, [][]any) {
	var cols []string
	var rows [][]any
	stop := fmtError("row limit reached")
	_, _ = connector.ExecuteQueryStream(ctx, profile, password, query, true,
		func(int64) {}, func(c []string) error { cols = c; return nil },
		func(row []any) error {
			if len(rows) >= limit {
				return stop
			}
			cp := make([]any, len(row))
			copy(cp, row)
			rows = append(rows, cp)
			return nil
		})
	return cols, rows
}

func toInt64(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case int:
		return int64(x)
	case []byte:
		n, _ := strconvParseInt(string(x))
		return n
	case string:
		n, _ := strconvParseInt(x)
		return n
	case float64:
		return int64(x)
	}
	return 0
}

// strconvParseInt is a thin wrapper used by toInt64.
func strconvParseInt(s string) (int64, error) { return strconv.ParseInt(strings.TrimSpace(s), 10, 64) }
