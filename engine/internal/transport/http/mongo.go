package http

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/adapters/mongo"
	"github.com/smlee/database-local-engine/engine/internal/application"
)

const mongoRequestTimeout = 30 * time.Second

type MongoHandler struct {
	token          string
	service        *application.ConnectionService
	mongoConnector *mongo.MongoConnector
}

func NewMongoHandler(token string, service *application.ConnectionService) *MongoHandler {
	return &MongoHandler{
		token:          token,
		service:        service,
		mongoConnector: mongo.NewMongoConnector(),
	}
}

func (h *MongoHandler) checkToken(r *http.Request) bool {
	reqToken := r.Header.Get("X-App-Engine-Token")
	return validToken(reqToken, h.token)
}

// Routes returns a mux with every mongo endpoint registered under its full path,
// so main.go can mount it with mux.Handle("/mongo/", mongoHandler.Routes()).
func (h *MongoHandler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/mongo/databases", h.ListDatabases())
	mux.Handle("/mongo/collections", h.ListCollections())
	mux.Handle("/mongo/find", h.Find())
	mux.Handle("/mongo/aggregate", h.Aggregate())
	mux.Handle("/mongo/count", h.Count())
	mux.Handle("/mongo/insert", h.Insert())
	mux.Handle("/mongo/replace", h.Replace())
	mux.Handle("/mongo/delete", h.Delete())
	mux.Handle("/mongo/indexes", h.ListIndexes())
	mux.Handle("/mongo/index/create", h.CreateIndex())
	mux.Handle("/mongo/index/drop", h.DropIndex())
	mux.Handle("/mongo/schema", h.InferSchema())
	return mux
}

// ListDatabases handles POST /mongo/databases with body {profileId}.
func (h *MongoHandler) ListDatabases() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			ProfileID string `json:"profileId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if body.ProfileID == "" {
			http.Error(w, "profileId is required", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), mongoRequestTimeout)
		defer cancel()
		profile, password, err := h.service.GetProfile(ctx, body.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		dbs, err := h.mongoConnector.ListDatabases(ctx, *profile, password)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeMongoJSON(w, map[string]any{"data": dbs})
	})
}

// ListCollections handles POST /mongo/collections with body {profileId, database}.
func (h *MongoHandler) ListCollections() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			ProfileID string `json:"profileId"`
			Database  string `json:"database"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if body.ProfileID == "" || body.Database == "" {
			http.Error(w, "profileId and database are required", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), mongoRequestTimeout)
		defer cancel()
		profile, password, err := h.service.GetProfile(ctx, body.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		cols, err := h.mongoConnector.ListCollections(ctx, *profile, password, body.Database)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeMongoJSON(w, map[string]any{"data": cols})
	})
}

// Find handles POST /mongo/find with body
// {profileId, database, collection, filter, projection, sort, skip, limit}.
func (h *MongoHandler) Find() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			ProfileID  string `json:"profileId"`
			Database   string `json:"database"`
			Collection string `json:"collection"`
			Filter     string `json:"filter"`
			Projection string `json:"projection"`
			Sort       string `json:"sort"`
			Skip       int64  `json:"skip"`
			Limit      int64  `json:"limit"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if body.ProfileID == "" || body.Database == "" || body.Collection == "" {
			http.Error(w, "profileId, database and collection are required", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), mongoRequestTimeout)
		defer cancel()
		profile, password, err := h.service.GetProfile(ctx, body.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		res, err := h.mongoConnector.Find(ctx, *profile, password, body.Database, body.Collection, body.Filter, body.Projection, body.Sort, body.Skip, body.Limit)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeMongoJSON(w, res)
	})
}

// Aggregate handles POST /mongo/aggregate with body
// {profileId, database, collection, pipeline, limit}.
func (h *MongoHandler) Aggregate() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			ProfileID  string `json:"profileId"`
			Database   string `json:"database"`
			Collection string `json:"collection"`
			Pipeline   string `json:"pipeline"`
			Limit      int64  `json:"limit"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if body.ProfileID == "" || body.Database == "" || body.Collection == "" {
			http.Error(w, "profileId, database and collection are required", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), mongoRequestTimeout)
		defer cancel()
		profile, password, err := h.service.GetProfile(ctx, body.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		res, err := h.mongoConnector.Aggregate(ctx, *profile, password, body.Database, body.Collection, body.Pipeline, body.Limit)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeMongoJSON(w, res)
	})
}

// Count handles POST /mongo/count with body {profileId, database, collection, filter}.
func (h *MongoHandler) Count() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			ProfileID  string `json:"profileId"`
			Database   string `json:"database"`
			Collection string `json:"collection"`
			Filter     string `json:"filter"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if body.ProfileID == "" || body.Database == "" || body.Collection == "" {
			http.Error(w, "profileId, database and collection are required", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), mongoRequestTimeout)
		defer cancel()
		profile, password, err := h.service.GetProfile(ctx, body.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		count, err := h.mongoConnector.CountDocuments(ctx, *profile, password, body.Database, body.Collection, body.Filter)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeMongoJSON(w, map[string]any{"count": count})
	})
}

// Insert handles POST /mongo/insert with body {profileId, database, collection, document}.
func (h *MongoHandler) Insert() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			ProfileID  string `json:"profileId"`
			Database   string `json:"database"`
			Collection string `json:"collection"`
			Document   string `json:"document"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if body.ProfileID == "" || body.Database == "" || body.Collection == "" {
			http.Error(w, "profileId, database and collection are required", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), mongoRequestTimeout)
		defer cancel()
		profile, password, err := h.service.GetProfile(ctx, body.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		insertedID, err := h.mongoConnector.InsertDocument(ctx, *profile, password, body.Database, body.Collection, body.Document)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeMongoJSON(w, map[string]any{"insertedId": insertedID})
	})
}

// Replace handles POST /mongo/replace with body {profileId, database, collection, id, document}.
func (h *MongoHandler) Replace() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			ProfileID  string `json:"profileId"`
			Database   string `json:"database"`
			Collection string `json:"collection"`
			ID         string `json:"id"`
			Document   string `json:"document"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if body.ProfileID == "" || body.Database == "" || body.Collection == "" || body.ID == "" {
			http.Error(w, "profileId, database, collection and id are required", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), mongoRequestTimeout)
		defer cancel()
		profile, password, err := h.service.GetProfile(ctx, body.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := h.mongoConnector.ReplaceDocument(ctx, *profile, password, body.Database, body.Collection, body.ID, body.Document); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeMongoJSON(w, map[string]bool{"ok": true})
	})
}

// Delete handles POST /mongo/delete with body {profileId, database, collection, id}.
func (h *MongoHandler) Delete() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			ProfileID  string `json:"profileId"`
			Database   string `json:"database"`
			Collection string `json:"collection"`
			ID         string `json:"id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if body.ProfileID == "" || body.Database == "" || body.Collection == "" || body.ID == "" {
			http.Error(w, "profileId, database, collection and id are required", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), mongoRequestTimeout)
		defer cancel()
		profile, password, err := h.service.GetProfile(ctx, body.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := h.mongoConnector.DeleteDocument(ctx, *profile, password, body.Database, body.Collection, body.ID); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeMongoJSON(w, map[string]bool{"ok": true})
	})
}

// ListIndexes handles POST /mongo/indexes with body {profileId, database, collection}.
func (h *MongoHandler) ListIndexes() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			ProfileID  string `json:"profileId"`
			Database   string `json:"database"`
			Collection string `json:"collection"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if body.ProfileID == "" || body.Database == "" || body.Collection == "" {
			http.Error(w, "profileId, database and collection are required", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), mongoRequestTimeout)
		defer cancel()
		profile, password, err := h.service.GetProfile(ctx, body.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		idx, err := h.mongoConnector.ListIndexes(ctx, *profile, password, body.Database, body.Collection)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeMongoJSON(w, map[string]any{"data": idx})
	})
}

// CreateIndex handles POST /mongo/index/create with body
// {profileId, database, collection, keys, unique, name}.
func (h *MongoHandler) CreateIndex() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			ProfileID  string `json:"profileId"`
			Database   string `json:"database"`
			Collection string `json:"collection"`
			Keys       string `json:"keys"`
			Unique     bool   `json:"unique"`
			Name       string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if body.ProfileID == "" || body.Database == "" || body.Collection == "" || body.Keys == "" {
			http.Error(w, "profileId, database, collection and keys are required", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), mongoRequestTimeout)
		defer cancel()
		profile, password, err := h.service.GetProfile(ctx, body.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := h.mongoConnector.CreateIndex(ctx, *profile, password, body.Database, body.Collection, body.Keys, body.Unique, body.Name); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeMongoJSON(w, map[string]bool{"ok": true})
	})
}

// DropIndex handles POST /mongo/index/drop with body {profileId, database, collection, name}.
func (h *MongoHandler) DropIndex() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			ProfileID  string `json:"profileId"`
			Database   string `json:"database"`
			Collection string `json:"collection"`
			Name       string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if body.ProfileID == "" || body.Database == "" || body.Collection == "" || body.Name == "" {
			http.Error(w, "profileId, database, collection and name are required", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), mongoRequestTimeout)
		defer cancel()
		profile, password, err := h.service.GetProfile(ctx, body.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := h.mongoConnector.DropIndex(ctx, *profile, password, body.Database, body.Collection, body.Name); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeMongoJSON(w, map[string]bool{"ok": true})
	})
}

// InferSchema handles POST /mongo/schema with body
// {profileId, database, collection, sampleSize}.
func (h *MongoHandler) InferSchema() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			ProfileID  string `json:"profileId"`
			Database   string `json:"database"`
			Collection string `json:"collection"`
			SampleSize int64  `json:"sampleSize"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if body.ProfileID == "" || body.Database == "" || body.Collection == "" {
			http.Error(w, "profileId, database and collection are required", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), mongoRequestTimeout)
		defer cancel()
		profile, password, err := h.service.GetProfile(ctx, body.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		fields, err := h.mongoConnector.InferSchema(ctx, *profile, password, body.Database, body.Collection, body.SampleSize)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeMongoJSON(w, map[string]any{"data": fields})
	})
}

// writeMongoJSON writes v as a JSON response with the standard content type,
// mirroring redis.go's response convention.
func writeMongoJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
