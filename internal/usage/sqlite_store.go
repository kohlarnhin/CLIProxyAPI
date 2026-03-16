package usage

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v6/internal/util"
	coreusage "github.com/router-for-me/CLIProxyAPI/v6/sdk/cliproxy/usage"
	log "github.com/sirupsen/logrus"
	_ "modernc.org/sqlite"
)

const (
	sqliteDriverName    = "sqlite"
	sqliteUsageFileName = "usage-statistics.db"
)

type PersistenceStatus struct {
	Enabled           bool       `json:"enabled"`
	Backend           string     `json:"backend,omitempty"`
	Driver            string     `json:"driver,omitempty"`
	Path              string     `json:"path,omitempty"`
	RecordCount       int64      `json:"record_count"`
	LastWriteAt       *time.Time `json:"last_write_at,omitempty"`
	CollectionEnabled bool       `json:"collection_enabled"`
	LastError         string     `json:"last_error,omitempty"`
}

type UsageLedgerQuery struct {
	DateFrom string `form:"date_from" json:"date_from"`
	DateTo   string `form:"date_to" json:"date_to"`
	APIKey   string `form:"api_key" json:"api_key"`
	Model    string `form:"model" json:"model"`
	Page     int    `form:"page" json:"page"`
	PageSize int    `form:"page_size" json:"page_size"`
}

type UsageLedgerTotals struct {
	RequestCount    int64 `json:"request_count"`
	InputTokens     int64 `json:"input_tokens"`
	OutputTokens    int64 `json:"output_tokens"`
	ReasoningTokens int64 `json:"reasoning_tokens"`
	CachedTokens    int64 `json:"cached_tokens"`
	TotalTokens     int64 `json:"total_tokens"`
	SuccessfulCount int64 `json:"successful_count"`
	FailedCount     int64 `json:"failed_count"`
}

type UsageLedgerBucket struct {
	Value  string            `json:"value"`
	Totals UsageLedgerTotals `json:"totals"`
}

type UsageLedgerDailyTotal struct {
	UsageDate   string `json:"usage_date"`
	TotalTokens int64  `json:"total_tokens"`
}

type UsageLedgerSummary struct {
	Query          UsageLedgerQuery        `json:"query"`
	Totals         UsageLedgerTotals       `json:"totals"`
	ByAPIKey       []UsageLedgerBucket     `json:"by_api_key"`
	ByModel        []UsageLedgerBucket     `json:"by_model"`
	Last7Days      []UsageLedgerDailyTotal `json:"last_7_days"`
	TrendDays      []UsageLedgerDailyTotal `json:"trend_days"`
	TrendRangeDays int                     `json:"trend_range_days"`
	Status         PersistenceStatus       `json:"status"`
}

type UsageLedgerRecord struct {
	UsageDate       string    `json:"usage_date"`
	RequestedAt     time.Time `json:"requested_at"`
	APIKey          string    `json:"api_key"`
	Model           string    `json:"model"`
	Source          string    `json:"source"`
	AuthIndex       string    `json:"auth_index"`
	Failed          bool      `json:"failed"`
	InputTokens     int64     `json:"input_tokens"`
	OutputTokens    int64     `json:"output_tokens"`
	ReasoningTokens int64     `json:"reasoning_tokens"`
	CachedTokens    int64     `json:"cached_tokens"`
	TotalTokens     int64     `json:"total_tokens"`
}

type UsageLedgerPage struct {
	Query     UsageLedgerQuery    `json:"query"`
	TotalRows int64               `json:"total_rows"`
	Page      int                 `json:"page"`
	PageSize  int                 `json:"page_size"`
	Records   []UsageLedgerRecord `json:"records"`
}

type UsageLedgerOptions struct {
	APIKeys []string          `json:"api_keys"`
	Models  []string          `json:"models"`
	DateMin string            `json:"date_min,omitempty"`
	DateMax string            `json:"date_max,omitempty"`
	Status  PersistenceStatus `json:"status"`
}

type persistedUsageRecord struct {
	UsageDate   string
	RequestedAt time.Time
	APIKey      string
	ModelName   string
	Source      string
	AuthIndex   string
	Failed      bool
	Tokens      TokenStats
}

type sqliteUsageStore struct {
	db   *sql.DB
	path string

	mu          sync.Mutex
	recordCount int64
	lastWriteAt time.Time
	lastError   string
}

type sqliteUsagePlugin struct{}

var (
	defaultSQLiteStoreMu sync.RWMutex
	defaultSQLiteStore   *sqliteUsageStore
)

func init() {
	coreusage.RegisterPlugin(sqliteUsagePlugin{})
}

func DefaultSQLitePersistence() *sqliteUsageStore {
	defaultSQLiteStoreMu.RLock()
	defer defaultSQLiteStoreMu.RUnlock()
	return defaultSQLiteStore
}

func ConfigureSQLitePersistence(authDir string) error {
	path, err := resolveSQLiteUsagePath(authDir)
	if err != nil {
		return err
	}

	defaultSQLiteStoreMu.Lock()
	defer defaultSQLiteStoreMu.Unlock()

	if defaultSQLiteStore != nil && defaultSQLiteStore.path == path && defaultSQLiteStore.db != nil {
		return nil
	}

	store, err := newSQLiteUsageStore(path)
	if err != nil {
		return err
	}
	if defaultSQLiteStore != nil {
		_ = defaultSQLiteStore.Close()
	}
	defaultSQLiteStore = store
	return nil
}

func SQLitePersistenceStatus() PersistenceStatus {
	store := DefaultSQLitePersistence()
	if store == nil {
		return PersistenceStatus{
			Backend:           "sqlite",
			Driver:            sqliteDriverName,
			CollectionEnabled: StatisticsEnabled(),
		}
	}
	return store.Status()
}

func (sqliteUsagePlugin) HandleUsage(ctx context.Context, record coreusage.Record) {
	if !StatisticsEnabled() {
		return
	}
	store := DefaultSQLitePersistence()
	if store == nil {
		return
	}
	if err := store.Upsert(normaliseSQLiteUsageRecord(ctx, record)); err != nil {
		log.WithError(err).Warn("usage sqlite store: persist record failed")
	}
}

func newSQLiteUsageStore(path string) (*sqliteUsageStore, error) {
	trimmedPath := strings.TrimSpace(path)
	if trimmedPath == "" {
		return nil, fmt.Errorf("usage sqlite store: empty database path")
	}
	if err := os.MkdirAll(filepath.Dir(trimmedPath), 0o755); err != nil {
		return nil, fmt.Errorf("usage sqlite store: create directory: %w", err)
	}

	db, err := sql.Open(sqliteDriverName, sqliteDSN(trimmedPath))
	if err != nil {
		return nil, fmt.Errorf("usage sqlite store: open database: %w", err)
	}

	store := &sqliteUsageStore{db: db, path: trimmedPath}
	if err := store.init(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *sqliteUsageStore) init() error {
	if s == nil || s.db == nil {
		return fmt.Errorf("usage sqlite store: not initialized")
	}

	statements := []string{
		`PRAGMA journal_mode = WAL;`,
		`PRAGMA busy_timeout = 5000;`,
		`PRAGMA synchronous = NORMAL;`,
		`CREATE TABLE IF NOT EXISTS usage_records (
			dedup_key TEXT PRIMARY KEY,
			usage_date TEXT NOT NULL,
			requested_at TEXT NOT NULL,
			api_key TEXT NOT NULL,
			model_name TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT '',
			auth_index TEXT NOT NULL DEFAULT '',
			failed INTEGER NOT NULL DEFAULT 0,
			input_tokens INTEGER NOT NULL DEFAULT 0,
			output_tokens INTEGER NOT NULL DEFAULT 0,
			reasoning_tokens INTEGER NOT NULL DEFAULT 0,
			cached_tokens INTEGER NOT NULL DEFAULT 0,
			total_tokens INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);`,
		`CREATE INDEX IF NOT EXISTS idx_usage_records_usage_date ON usage_records(usage_date);`,
		`CREATE INDEX IF NOT EXISTS idx_usage_records_api_key_usage_date ON usage_records(api_key, usage_date);`,
		`CREATE INDEX IF NOT EXISTS idx_usage_records_model_usage_date ON usage_records(model_name, usage_date);`,
		`CREATE INDEX IF NOT EXISTS idx_usage_records_requested_at ON usage_records(requested_at DESC);`,
	}

	for _, statement := range statements {
		if _, err := s.db.Exec(statement); err != nil {
			s.setError(err)
			return fmt.Errorf("usage sqlite store: exec statement: %w", err)
		}
	}

	count, err := s.countRows(context.Background())
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.recordCount = count
	s.lastError = ""
	s.mu.Unlock()
	return nil
}

func (s *sqliteUsageStore) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *sqliteUsageStore) Upsert(record persistedUsageRecord) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("usage sqlite store: not initialized")
	}

	record.Tokens = normaliseTokenStats(record.Tokens)
	if record.RequestedAt.IsZero() {
		record.RequestedAt = time.Now()
	}
	record.UsageDate = strings.TrimSpace(record.UsageDate)
	if record.UsageDate == "" {
		record.UsageDate = record.RequestedAt.Format("2006-01-02")
	}
	record.APIKey = strings.TrimSpace(record.APIKey)
	if record.APIKey == "" {
		record.APIKey = "unknown"
	}
	record.ModelName = strings.TrimSpace(record.ModelName)
	if record.ModelName == "" {
		record.ModelName = "unknown"
	}

	result, err := s.db.Exec(`
		INSERT OR IGNORE INTO usage_records (
			dedup_key, usage_date, requested_at, api_key, model_name, source, auth_index, failed,
			input_tokens, output_tokens, reasoning_tokens, cached_tokens, total_tokens
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
		dedupKey(record.APIKey, record.ModelName, RequestDetail{
			Timestamp: record.RequestedAt,
			Source:    record.Source,
			AuthIndex: record.AuthIndex,
			Tokens:    record.Tokens,
			Failed:    record.Failed,
		}),
		record.UsageDate,
		record.RequestedAt.UTC().Format(time.RFC3339Nano),
		record.APIKey,
		record.ModelName,
		record.Source,
		record.AuthIndex,
		boolToInt(record.Failed),
		record.Tokens.InputTokens,
		record.Tokens.OutputTokens,
		record.Tokens.ReasoningTokens,
		record.Tokens.CachedTokens,
		record.Tokens.TotalTokens,
	)
	if err != nil {
		s.setError(err)
		return fmt.Errorf("usage sqlite store: insert record: %w", err)
	}

	rowsAffected, _ := result.RowsAffected()
	s.mu.Lock()
	if rowsAffected > 0 {
		s.recordCount += rowsAffected
		s.lastWriteAt = time.Now().UTC()
	}
	s.lastError = ""
	s.mu.Unlock()
	return nil
}

func (s *sqliteUsageStore) QuerySummary(ctx context.Context, query UsageLedgerQuery) (UsageLedgerSummary, error) {
	result := UsageLedgerSummary{Query: normalizeUsageLedgerQuery(query)}
	if s == nil || s.db == nil {
		return result, fmt.Errorf("usage sqlite store: not initialized")
	}
	if ctx == nil {
		ctx = context.Background()
	}

	whereSQL, args, err := usageLedgerWhereClause(result.Query)
	if err != nil {
		return result, err
	}

	row := s.db.QueryRowContext(ctx, `
		SELECT
			COUNT(*),
			COALESCE(SUM(input_tokens), 0),
			COALESCE(SUM(output_tokens), 0),
			COALESCE(SUM(reasoning_tokens), 0),
			COALESCE(SUM(cached_tokens), 0),
			COALESCE(SUM(total_tokens), 0),
			COALESCE(SUM(CASE WHEN failed = 0 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN failed = 1 THEN 1 ELSE 0 END), 0)
		FROM usage_records
		WHERE `+whereSQL,
		args...,
	)
	if err := row.Scan(
		&result.Totals.RequestCount,
		&result.Totals.InputTokens,
		&result.Totals.OutputTokens,
		&result.Totals.ReasoningTokens,
		&result.Totals.CachedTokens,
		&result.Totals.TotalTokens,
		&result.Totals.SuccessfulCount,
		&result.Totals.FailedCount,
	); err != nil {
		s.setError(err)
		return result, fmt.Errorf("usage sqlite store: query summary: %w", err)
	}

	if result.ByAPIKey, err = s.queryBuckets(ctx, whereSQL, args, "api_key"); err != nil {
		return result, err
	}
	if result.ByModel, err = s.queryBuckets(ctx, whereSQL, args, "model_name"); err != nil {
		return result, err
	}
	if result.Last7Days, err = s.queryLastNDays(ctx, result.Query, 7); err != nil {
		return result, err
	}
	result.TrendRangeDays = usageLedgerTrendDays(result.Query)
	if result.TrendDays, err = s.queryLastNDays(ctx, result.Query, result.TrendRangeDays); err != nil {
		return result, err
	}
	result.Status = s.Status()
	return result, nil
}

func (s *sqliteUsageStore) QueryRecords(ctx context.Context, query UsageLedgerQuery) (UsageLedgerPage, error) {
	result := UsageLedgerPage{Query: normalizeUsageLedgerQuery(query)}
	if s == nil || s.db == nil {
		return result, fmt.Errorf("usage sqlite store: not initialized")
	}
	if ctx == nil {
		ctx = context.Background()
	}

	whereSQL, args, err := usageLedgerWhereClause(result.Query)
	if err != nil {
		return result, err
	}

	row := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM usage_records WHERE `+whereSQL, args...)
	if err := row.Scan(&result.TotalRows); err != nil {
		s.setError(err)
		return result, fmt.Errorf("usage sqlite store: count records: %w", err)
	}

	result.Page = result.Query.Page
	result.PageSize = result.Query.PageSize
	offset := (result.Page - 1) * result.PageSize
	queryArgs := append(append([]any{}, args...), result.PageSize, offset)
	rows, err := s.db.QueryContext(ctx, `
		SELECT usage_date, requested_at, api_key, model_name, source, auth_index, failed,
		       input_tokens, output_tokens, reasoning_tokens, cached_tokens, total_tokens
		FROM usage_records
		WHERE `+whereSQL+`
		ORDER BY requested_at DESC
		LIMIT ? OFFSET ?
	`, queryArgs...)
	if err != nil {
		s.setError(err)
		return result, fmt.Errorf("usage sqlite store: query records: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()

	for rows.Next() {
		var (
			record      UsageLedgerRecord
			requestedAt string
			failed      int
		)
		if err = rows.Scan(
			&record.UsageDate,
			&requestedAt,
			&record.APIKey,
			&record.Model,
			&record.Source,
			&record.AuthIndex,
			&failed,
			&record.InputTokens,
			&record.OutputTokens,
			&record.ReasoningTokens,
			&record.CachedTokens,
			&record.TotalTokens,
		); err != nil {
			s.setError(err)
			return result, fmt.Errorf("usage sqlite store: scan record: %w", err)
		}
		record.Failed = failed != 0
		if requestedAt != "" {
			record.RequestedAt, err = time.Parse(time.RFC3339Nano, requestedAt)
			if err != nil {
				s.setError(err)
				return result, fmt.Errorf("usage sqlite store: parse timestamp: %w", err)
			}
		}
		result.Records = append(result.Records, record)
	}
	if err = rows.Err(); err != nil {
		s.setError(err)
		return result, fmt.Errorf("usage sqlite store: iterate records: %w", err)
	}
	return result, nil
}

func (s *sqliteUsageStore) QueryOptions(ctx context.Context, query UsageLedgerQuery) (UsageLedgerOptions, error) {
	result := UsageLedgerOptions{Status: s.Status()}
	if s == nil || s.db == nil {
		return result, fmt.Errorf("usage sqlite store: not initialized")
	}
	if ctx == nil {
		ctx = context.Background()
	}

	optionQuery := normalizeUsageLedgerQuery(query)
	optionQuery.APIKey = ""
	optionQuery.Model = ""
	whereSQL, args, err := usageLedgerWhereClause(optionQuery)
	if err != nil {
		return result, err
	}

	dateRow := s.db.QueryRowContext(ctx, `SELECT COALESCE(MIN(usage_date), ''), COALESCE(MAX(usage_date), '') FROM usage_records`)
	if err := dateRow.Scan(&result.DateMin, &result.DateMax); err != nil {
		s.setError(err)
		return result, fmt.Errorf("usage sqlite store: query date range: %w", err)
	}

	if result.APIKeys, err = s.queryDistinctValues(ctx, "api_key", whereSQL, args); err != nil {
		return result, err
	}
	if result.Models, err = s.queryDistinctValues(ctx, "model_name", whereSQL, args); err != nil {
		return result, err
	}
	result.Status = s.Status()
	return result, nil
}

func (s *sqliteUsageStore) queryBuckets(ctx context.Context, whereSQL string, args []any, column string) ([]UsageLedgerBucket, error) {
	query := fmt.Sprintf(`
		SELECT %s,
		       COUNT(*),
		       COALESCE(SUM(input_tokens), 0),
		       COALESCE(SUM(output_tokens), 0),
		       COALESCE(SUM(reasoning_tokens), 0),
		       COALESCE(SUM(cached_tokens), 0),
		       COALESCE(SUM(total_tokens), 0),
		       COALESCE(SUM(CASE WHEN failed = 0 THEN 1 ELSE 0 END), 0),
		       COALESCE(SUM(CASE WHEN failed = 1 THEN 1 ELSE 0 END), 0)
		FROM usage_records
		WHERE %s
		GROUP BY %s
		ORDER BY COALESCE(SUM(total_tokens), 0) DESC, %s ASC
		LIMIT 200
	`, column, whereSQL, column, column)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		s.setError(err)
		return nil, fmt.Errorf("usage sqlite store: query buckets: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()

	buckets := make([]UsageLedgerBucket, 0, 32)
	for rows.Next() {
		var bucket UsageLedgerBucket
		if err = rows.Scan(
			&bucket.Value,
			&bucket.Totals.RequestCount,
			&bucket.Totals.InputTokens,
			&bucket.Totals.OutputTokens,
			&bucket.Totals.ReasoningTokens,
			&bucket.Totals.CachedTokens,
			&bucket.Totals.TotalTokens,
			&bucket.Totals.SuccessfulCount,
			&bucket.Totals.FailedCount,
		); err != nil {
			s.setError(err)
			return nil, fmt.Errorf("usage sqlite store: scan bucket: %w", err)
		}
		buckets = append(buckets, bucket)
	}
	if err = rows.Err(); err != nil {
		s.setError(err)
		return nil, fmt.Errorf("usage sqlite store: iterate buckets: %w", err)
	}
	return buckets, nil
}

func (s *sqliteUsageStore) queryDistinctValues(ctx context.Context, column, whereSQL string, args []any) ([]string, error) {
	query := fmt.Sprintf(`
		SELECT DISTINCT %s
		FROM usage_records
		WHERE %s AND %s <> ''
		ORDER BY %s ASC
	`, column, whereSQL, column, column)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		s.setError(err)
		return nil, fmt.Errorf("usage sqlite store: query distinct %s: %w", column, err)
	}
	defer func() {
		_ = rows.Close()
	}()

	values := make([]string, 0, 32)
	for rows.Next() {
		var value string
		if err = rows.Scan(&value); err != nil {
			s.setError(err)
			return nil, fmt.Errorf("usage sqlite store: scan distinct %s: %w", column, err)
		}
		values = append(values, value)
	}
	if err = rows.Err(); err != nil {
		s.setError(err)
		return nil, fmt.Errorf("usage sqlite store: iterate distinct %s: %w", column, err)
	}
	return values, nil
}

func (s *sqliteUsageStore) queryLastNDays(ctx context.Context, query UsageLedgerQuery, days int) ([]UsageLedgerDailyTotal, error) {
	if days <= 0 {
		days = 7
	}

	now := time.Now()
	endDate := now.Format("2006-01-02")
	startDate := now.AddDate(0, 0, -(days - 1)).Format("2006-01-02")

	trendQuery := normalizeUsageLedgerQuery(query)
	trendQuery.DateFrom = startDate
	trendQuery.DateTo = endDate

	whereSQL, args, err := usageLedgerWhereClause(trendQuery)
	if err != nil {
		return nil, err
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT usage_date, COALESCE(SUM(total_tokens), 0)
		FROM usage_records
		WHERE `+whereSQL+`
		GROUP BY usage_date
		ORDER BY usage_date ASC
	`, args...)
	if err != nil {
		s.setError(err)
		return nil, fmt.Errorf("usage sqlite store: query last %d days: %w", days, err)
	}
	defer func() {
		_ = rows.Close()
	}()

	values := make(map[string]int64, days)
	for rows.Next() {
		var (
			usageDate   string
			totalTokens int64
		)
		if err = rows.Scan(&usageDate, &totalTokens); err != nil {
			s.setError(err)
			return nil, fmt.Errorf("usage sqlite store: scan daily totals: %w", err)
		}
		values[usageDate] = totalTokens
	}
	if err = rows.Err(); err != nil {
		s.setError(err)
		return nil, fmt.Errorf("usage sqlite store: iterate daily totals: %w", err)
	}

	result := make([]UsageLedgerDailyTotal, 0, days)
	for offset := days - 1; offset >= 0; offset -= 1 {
		date := now.AddDate(0, 0, -offset).Format("2006-01-02")
		result = append(result, UsageLedgerDailyTotal{
			UsageDate:   date,
			TotalTokens: values[date],
		})
	}
	return result, nil
}

func (s *sqliteUsageStore) countRows(ctx context.Context) (int64, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	row := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM usage_records`)
	var count int64
	if err := row.Scan(&count); err != nil {
		s.setError(err)
		return 0, fmt.Errorf("usage sqlite store: count rows: %w", err)
	}
	return count, nil
}

func (s *sqliteUsageStore) Status() PersistenceStatus {
	status := PersistenceStatus{
		Backend:           "sqlite",
		Driver:            sqliteDriverName,
		CollectionEnabled: StatisticsEnabled(),
	}
	if s == nil {
		return status
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	status.Enabled = s.db != nil
	status.Path = s.path
	status.RecordCount = s.recordCount
	status.LastError = s.lastError
	if !s.lastWriteAt.IsZero() {
		lastWriteAt := s.lastWriteAt
		status.LastWriteAt = &lastWriteAt
	}
	return status
}

func (s *sqliteUsageStore) setError(err error) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err == nil {
		s.lastError = ""
		return
	}
	s.lastError = err.Error()
}

func normalizeUsageLedgerQuery(query UsageLedgerQuery) UsageLedgerQuery {
	query.DateFrom = normalizeDateOnly(query.DateFrom)
	query.DateTo = normalizeDateOnly(query.DateTo)
	query.APIKey = strings.TrimSpace(query.APIKey)
	query.Model = strings.TrimSpace(query.Model)
	if query.Page <= 0 {
		query.Page = 1
	}
	switch {
	case query.PageSize <= 0:
		query.PageSize = 50
	case query.PageSize > 200:
		query.PageSize = 200
	}
	return query
}

func usageLedgerTrendDays(query UsageLedgerQuery) int {
	if query.DateFrom == "" || query.DateTo == "" {
		return 7
	}
	start, errStart := time.Parse("2006-01-02", query.DateFrom)
	end, errEnd := time.Parse("2006-01-02", query.DateTo)
	if errStart != nil || errEnd != nil {
		return 7
	}
	if end.Before(start) {
		return 7
	}
	days := int(end.Sub(start).Hours()/24) + 1
	if days >= 30 {
		return 30
	}
	return 7
}

func usageLedgerWhereClause(query UsageLedgerQuery) (string, []any, error) {
	clauses := []string{"1=1"}
	args := make([]any, 0, 4)

	if query.DateFrom != "" {
		if _, err := time.Parse("2006-01-02", query.DateFrom); err != nil {
			return "", nil, fmt.Errorf("invalid date_from: %w", err)
		}
		clauses = append(clauses, "usage_date >= ?")
		args = append(args, query.DateFrom)
	}
	if query.DateTo != "" {
		if _, err := time.Parse("2006-01-02", query.DateTo); err != nil {
			return "", nil, fmt.Errorf("invalid date_to: %w", err)
		}
		clauses = append(clauses, "usage_date <= ?")
		args = append(args, query.DateTo)
	}
	if query.DateFrom != "" && query.DateTo != "" && query.DateFrom > query.DateTo {
		return "", nil, fmt.Errorf("date_from cannot be greater than date_to")
	}
	if query.APIKey != "" {
		clauses = append(clauses, "api_key = ?")
		args = append(args, query.APIKey)
	}
	if query.Model != "" {
		clauses = append(clauses, "model_name = ?")
		args = append(args, query.Model)
	}
	return strings.Join(clauses, " AND "), args, nil
}

func normaliseSQLiteUsageRecord(ctx context.Context, record coreusage.Record) persistedUsageRecord {
	timestamp := record.RequestedAt
	if timestamp.IsZero() {
		timestamp = time.Now()
	}

	apiKey := strings.TrimSpace(record.APIKey)
	if apiKey == "" {
		switch {
		case strings.TrimSpace(record.Source) != "":
			apiKey = strings.TrimSpace(record.Source)
		case strings.TrimSpace(record.AuthIndex) != "":
			apiKey = strings.TrimSpace(record.AuthIndex)
		case strings.TrimSpace(record.AuthID) != "":
			apiKey = strings.TrimSpace(record.AuthID)
		default:
			apiKey = resolveAPIIdentifier(ctx, record)
		}
	}
	if apiKey == "" {
		apiKey = "unknown"
	}

	modelName := strings.TrimSpace(record.Model)
	if modelName == "" {
		modelName = "unknown"
	}

	failed := record.Failed
	if !failed {
		failed = !resolveSuccess(ctx)
	}

	return persistedUsageRecord{
		UsageDate:   timestamp.Format("2006-01-02"),
		RequestedAt: timestamp,
		APIKey:      apiKey,
		ModelName:   modelName,
		Source:      strings.TrimSpace(record.Source),
		AuthIndex:   strings.TrimSpace(record.AuthIndex),
		Failed:      failed,
		Tokens:      normaliseDetail(record.Detail),
	}
}

func normalizeDateOnly(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if parsed, err := time.Parse("2006-01-02", value); err == nil {
		return parsed.Format("2006-01-02")
	}
	return value
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func resolveSQLiteUsagePath(authDir string) (string, error) {
	authDir = strings.TrimSpace(authDir)
	if authDir != "" {
		resolved, err := util.ResolveAuthDir(authDir)
		if err != nil {
			return "", err
		}
		return filepath.Join(resolved, sqliteUsageFileName), nil
	}
	if writable := util.WritablePath(); writable != "" {
		return filepath.Join(writable, sqliteUsageFileName), nil
	}
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	return filepath.Join(wd, sqliteUsageFileName), nil
}

func sqliteDSN(path string) string {
	u := &url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	return u.String() + "?cache=shared&mode=rwc"
}
