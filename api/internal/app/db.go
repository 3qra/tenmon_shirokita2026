package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/lib/pq"
)

// queryer は *sql.DB と *sql.Tx の共通インターフェース。
type queryer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// withTx はトランザクション内で fn を実行する。直列化失敗・デッドロック時は数回再試行する。
func (a *App) withTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	var err error
	for attempt := 0; attempt < 4; attempt++ {
		err = a.runTx(ctx, fn)
		var pe *pq.Error
		var ce errCommit
		if !errors.As(err, &ce) && errors.As(err, &pe) && (pe.Code == "40001" || pe.Code == "40P01") {
			time.Sleep(time.Duration(20*(attempt+1)) * time.Millisecond)
			continue
		}
		return err
	}
	return err
}

// errCommit は COMMIT 時の失敗。応答を書いた後の可能性があるため再試行しない。
type errCommit struct{ err error }

func (e errCommit) Error() string { return "commit: " + e.err.Error() }
func (e errCommit) Unwrap() error { return e.err }

func (a *App) runTx(ctx context.Context, fn func(tx *sql.Tx) error) (err error) {
	tx, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback()
			panic(p)
		}
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if err = fn(tx); err != nil {
		return err
	}
	if cerr := tx.Commit(); cerr != nil {
		return errCommit{cerr}
	}
	return nil
}

// queryJSON はJSONを1行返すSQLを実行し、v にデコードする。
// 一覧系は json_agg を使ってまとめて返す。
func queryJSON(ctx context.Context, q queryer, v any, query string, args ...any) error {
	var raw []byte
	if err := q.QueryRowContext(ctx, query, args...).Scan(&raw); err != nil {
		return err
	}
	if raw == nil {
		raw = []byte("null")
	}
	return json.Unmarshal(raw, v)
}

// rawJSON はSQLが返すJSONをそのまま返したいときに使う。
func queryRaw(ctx context.Context, q queryer, query string, args ...any) (json.RawMessage, error) {
	var raw []byte
	if err := q.QueryRowContext(ctx, query, args...).Scan(&raw); err != nil {
		return nil, err
	}
	if raw == nil {
		return json.RawMessage("null"), nil
	}
	return json.RawMessage(raw), nil
}

// Migrate は未適用のマイグレーションを順に適用する。
func Migrate(ctx context.Context, db *sql.DB, files fs.FS) error {
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return err
	}
	// 複数インスタンス同時起動でも二重適用しない
	if _, err := db.ExecContext(ctx, `SELECT pg_advisory_lock(727001)`); err != nil {
		return err
	}
	defer db.ExecContext(context.Background(), `SELECT pg_advisory_unlock(727001)`)

	names, err := fs.Glob(files, "*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)
	for _, name := range names {
		version := strings.TrimSuffix(name, ".sql")
		var exists bool
		if err := db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1)`, version).Scan(&exists); err != nil {
			return err
		}
		if exists {
			continue
		}
		body, err := fs.ReadFile(files, name)
		if err != nil {
			return err
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, string(body)); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %s: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations(version) VALUES ($1)`, version); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		slog.Info("migration applied", "version", version)
	}
	return nil
}
