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
// Implemented in Task 10.
func (h *QueryHandler) enrichReport(ctx context.Context, connector ports.SQLConnector, profile domain.ConnectionProfile, password, database string, report analyzer.RiskReport, resp *AnalyzeResponse) {
}

// strconvParseInt is a thin wrapper used by toInt64.
func strconvParseInt(s string) (int64, error) { return strconv.ParseInt(strings.TrimSpace(s), 10, 64) }
