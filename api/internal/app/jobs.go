package app

import (
	"context"
	"database/sql"
	"log/slog"
	"time"
)

// RunJobs は定期処理：上映状態の自動遷移、終了後のクーポン自動発券、古いデータの掃除。
func (a *App) RunJobs(ctx context.Context) {
	t := time.NewTicker(20 * time.Second)
	defer t.Stop()
	clean := time.NewTicker(time.Hour)
	defer clean.Stop()
	a.tick(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			a.tick(ctx)
		case <-clean.C:
			a.cleanup(ctx)
		}
	}
}

func (a *App) tick(ctx context.Context) {
	err := a.withTx(ctx, func(tx *sql.Tx) error {
		res1, err := tx.ExecContext(ctx, `UPDATE screenings SET run_status='running', updated_at=now()
			WHERE run_status='scheduled' AND starts_at <= now() AND ends_at > now()`)
		if err != nil {
			return err
		}
		res2, err := tx.ExecContext(ctx, `UPDATE screenings SET run_status='finished', updated_at=now()
			WHERE run_status IN ('scheduled','running') AND ends_at <= now()`)
		if err != nil {
			return err
		}
		n1, _ := res1.RowsAffected()
		n2, _ := res2.RowsAffected()
		if n1+n2 > 0 {
			return publish(ctx, tx, "screenings")
		}
		return nil
	})
	if err != nil {
		slog.Error("job: screening status", "err", err)
	}
	rows, err := a.DB.QueryContext(ctx, `SELECT id FROM screenings WHERE run_status='finished' AND coupons_issued_at IS NULL ORDER BY ends_at LIMIT 20`)
	if err != nil {
		slog.Error("job: list finished", "err", err)
		return
	}
	var ids []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		var n int
		err := a.withTx(ctx, func(tx *sql.Tx) error {
			var err error
			n, err = a.issueScreeningCoupons(ctx, tx, id)
			return err
		})
		if err != nil {
			slog.Error("job: issue coupons", "screening", id, "err", err)
		} else if n > 0 {
			slog.Info("coupons issued", "screening", id, "count", n)
		}
	}
}

func (a *App) cleanup(ctx context.Context) {
	for _, q := range []string{
		`DELETE FROM staff_sessions WHERE expires_at < now()`,
		`DELETE FROM attempt_logs WHERE created_at < now() - interval '2 days'`,
		`DELETE FROM idempotency_records WHERE created_at < now() - interval '2 days'`,
	} {
		if _, err := a.DB.ExecContext(ctx, q); err != nil {
			slog.Error("cleanup", "err", err)
		}
	}
}
