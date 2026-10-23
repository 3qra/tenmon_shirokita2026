package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

func parseStringArray(raw []byte) []string {
	var out []string
	_ = json.Unmarshal(raw, &out)
	if out == nil {
		out = []string{}
	}
	return out
}

// audit は重要操作の監査ログを記録する（呼び出し側のトランザクション内で）。
func audit(ctx context.Context, q queryer, staff *Staff, action, targetType, targetID string, detail any) error {
	var memberID any
	if staff != nil {
		memberID = staff.ID
	}
	b, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	if detail == nil {
		b = []byte("{}")
	}
	_, err = q.ExecContext(ctx, `INSERT INTO audit_logs(member_id, action, target_type, target_id, detail) VALUES ($1,$2,$3,$4,$5)`,
		memberID, action, targetType, targetID, b)
	return err
}

func notify(ctx context.Context, q queryer, memberID, kind, title, body, link string) error {
	_, err := q.ExecContext(ctx, `INSERT INTO notifications(member_id, kind, title, body, link) VALUES ($1,$2,$3,$4,$5)`,
		memberID, kind, title, body, link)
	return err
}

// ---------------------------------------------------------------
// 冪等性キー
// ---------------------------------------------------------------

type bufferedWriter struct {
	header http.Header
	status int
	buf    bytes.Buffer
}

func (b *bufferedWriter) Header() http.Header         { return b.header }
func (b *bufferedWriter) WriteHeader(code int)        { b.status = code }
func (b *bufferedWriter) Write(p []byte) (int, error) { return b.buf.Write(p) }

// idempotent は Idempotency-Key ヘッダ付きの要求を一度だけ処理する。
// 同じキーで同じ内容 → 保存済みの応答を返す。同じキーで異なる内容 → 422。処理中 → 409。
// scopeFn は呼び出し主体（スタッフIDや来場者識別）でキー空間を分ける。
func (a *App) idempotent(scope string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
		if key == "" {
			writeError(w, r, badRequest("Idempotency-Key ヘッダが必要です"))
			return
		}
		if len(key) > 200 {
			writeError(w, r, badRequest("Idempotency-Key が長すぎます"))
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			writeError(w, r, badRequest("リクエストを読み取れません"))
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		h := sha256.Sum256(append([]byte(r.Method+" "+r.URL.Path+"\n"), body...))
		reqHash := hex.EncodeToString(h[:])
		// 主体でキー空間を分ける。Webの来場者で識別Cookieが未発行なら、ここで発行してから使う
		// （同じキーを送った別の来場者に応答が返らないように）。
		if sessionTokenFrom(r) == "" && r.Header.Get("X-Client-Id") == "" && len(cookieValue(r, clientCookie)) < 16 {
			cid := randomToken()
			http.SetCookie(w, &http.Cookie{Name: clientCookie, Value: cid, Path: "/", HttpOnly: true,
				Secure: a.Cfg.CookieSecure, SameSite: http.SameSiteLaxMode, MaxAge: 60 * 60 * 24 * 30})
			// 不正な値のCookieが残っていると r.Cookie がそちらを返すため、取り除いてから付け直す
			var kept []string
			for _, c := range r.Cookies() {
				if c.Name != clientCookie {
					kept = append(kept, c.Name+"="+c.Value)
				}
			}
			r.Header.Del("Cookie")
			if len(kept) > 0 {
				r.Header.Set("Cookie", strings.Join(kept, "; "))
			}
			r.AddCookie(&http.Cookie{Name: clientCookie, Value: cid})
		}
		subject := hashToken("idem-subject", sessionTokenFrom(r)+"|"+r.Header.Get("X-Client-Id")+"|"+cookieValue(r, clientCookie))
		fullScope := scope + ":" + subject[:16]

		ctx := r.Context()
		res, err := a.DB.ExecContext(ctx, `INSERT INTO idempotency_records(scope, key, request_hash) VALUES ($1,$2,$3)
			ON CONFLICT DO NOTHING`, fullScope, key, reqHash)
		if err != nil {
			writeError(w, r, err)
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			var storedHash, status string
			var code sql.NullInt64
			var respBody []byte
			err := a.DB.QueryRowContext(ctx, `SELECT request_hash, status, response_code, response_body FROM idempotency_records WHERE scope=$1 AND key=$2`,
				fullScope, key).Scan(&storedHash, &status, &code, &respBody)
			if err != nil {
				writeError(w, r, err)
				return
			}
			if storedHash != reqHash {
				writeError(w, r, unprocessable("idempotency_mismatch", "同じ操作IDで異なる内容が送信されました"))
				return
			}
			if status != "done" {
				writeError(w, r, conflict("in_progress", "同じ操作を処理中です"))
				return
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Idempotent-Replay", "true")
			w.WriteHeader(int(code.Int64))
			w.Write(respBody)
			return
		}

		bw := &bufferedWriter{header: http.Header{}, status: 200}
		next.ServeHTTP(bw, r)
		if bw.status >= 500 || bw.status == http.StatusConflict || bw.status == http.StatusTooManyRequests {
			// 一時的な失敗は再試行できるよう記録を消す
			a.DB.ExecContext(context.Background(), `DELETE FROM idempotency_records WHERE scope=$1 AND key=$2`, fullScope, key)
		} else {
			a.DB.ExecContext(context.Background(), `UPDATE idempotency_records SET status='done', response_code=$3, response_body=$4 WHERE scope=$1 AND key=$2`,
				fullScope, key, bw.status, bw.buf.Bytes())
		}
		for k, v := range bw.header {
			w.Header()[k] = v
		}
		w.WriteHeader(bw.status)
		w.Write(bw.buf.Bytes())
	})
}

func cookieValue(r *http.Request, name string) string {
	if c, err := r.Cookie(name); err == nil {
		return c.Value
	}
	return ""
}

// ---------------------------------------------------------------
// 設定値（仮案は設定値として変更可能にする）
// ---------------------------------------------------------------

type Limits struct {
	SeatThresholdPercent   int `json:"seat_threshold_percent"`    // 空席△の閾値（初期70）
	UnpaidWarnMinutes      int `json:"unpaid_warn_minutes"`       // 未払い注意表示までの分
	CookingWarnMinutes     int `json:"cooking_warn_minutes"`      // 長時間経過の注意
	MaxUnpaidOrders        int `json:"max_unpaid_orders"`         // 来場者1識別あたりの未払い注文上限
	MaxItemsPerOrder       int `json:"max_items_per_order"`       // 1注文の数量合計上限
	MaxPartySize           int `json:"max_party_size"`            // 1予約の人数上限
	MaxFutureReservations  int `json:"max_future_reservations"`   // 1識別あたりの将来予約数上限
	SiteCodeFailLimit      int `json:"site_code_fail_limit"`      // 現地コード失敗回数上限
	SiteCodeFailWindowMin  int `json:"site_code_fail_window_min"` // 失敗を数える期間（分）
	OrdersPerMinute        int `json:"orders_per_minute"`         // 来場者の注文作成頻度
	ReservationsPerMinute  int `json:"reservations_per_minute"`
	DisplayStaleSeconds    int `json:"display_stale_seconds"`     // 表示端末が古いとみなす秒数
	VisitorCancelBeforeMin int `json:"visitor_cancel_before_min"` // 上映開始の何分前まで本人取消可
}

var defaultLimits = Limits{
	SeatThresholdPercent:   70,
	UnpaidWarnMinutes:      15,
	CookingWarnMinutes:     15,
	MaxUnpaidOrders:        2,
	MaxItemsPerOrder:       10,
	MaxPartySize:           6,
	MaxFutureReservations:  2,
	SiteCodeFailLimit:      5,
	SiteCodeFailWindowMin:  10,
	OrdersPerMinute:        3,
	ReservationsPerMinute:  3,
	DisplayStaleSeconds:    30,
	VisitorCancelBeforeMin: 0,
}

func (a *App) limits(ctx context.Context, q queryer) (Limits, error) {
	l := defaultLimits
	var raw []byte
	err := q.QueryRowContext(ctx, `SELECT value FROM settings WHERE key='limits'`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return l, nil
	}
	if err != nil {
		return l, err
	}
	_ = json.Unmarshal(raw, &l)
	return l, nil
}

func (a *App) handleGetLimits(w http.ResponseWriter, r *http.Request, s *Staff) error {
	l, err := a.limits(r.Context(), a.DB)
	if err != nil {
		return err
	}
	writeJSON(w, 200, l)
	return nil
}

func (a *App) handlePutLimits(w http.ResponseWriter, r *http.Request, s *Staff) error {
	l, err := a.limits(r.Context(), a.DB)
	if err != nil {
		return err
	}
	if err := decodeJSON(r, &l); err != nil {
		return err
	}
	if l.SeatThresholdPercent < 1 || l.SeatThresholdPercent > 100 {
		return badRequest("空席の閾値は1〜100%%で指定してください")
	}
	for _, v := range []int{l.MaxUnpaidOrders, l.MaxItemsPerOrder, l.MaxPartySize, l.MaxFutureReservations,
		l.SiteCodeFailLimit, l.SiteCodeFailWindowMin, l.OrdersPerMinute, l.ReservationsPerMinute, l.DisplayStaleSeconds} {
		if v < 1 {
			return badRequest("上限値は1以上で指定してください")
		}
	}
	b, _ := json.Marshal(l)
	err = a.withTx(r.Context(), func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(r.Context(), `INSERT INTO settings(key, value) VALUES ('limits',$1)
			ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, b); err != nil {
			return err
		}
		return audit(r.Context(), tx, s, "settings.limits", "settings", "limits", l)
	})
	if err != nil {
		return err
	}
	writeJSON(w, 200, l)
	return nil
}

// recordAttempt / countFailures は試行回数制限に使う。
func (a *App) recordAttempt(ctx context.Context, q queryer, kind, subject string, success bool) error {
	_, err := q.ExecContext(ctx, `INSERT INTO attempt_logs(kind, subject, success) VALUES ($1,$2,$3)`, kind, subject, success)
	return err
}

func (a *App) countFailures(ctx context.Context, q queryer, kind, subject string, window time.Duration) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT count(*) FROM attempt_logs WHERE kind=$1 AND subject=$2 AND NOT success
		AND created_at > now() - make_interval(secs => $3)
		AND created_at > COALESCE((SELECT max(created_at) FROM attempt_logs WHERE kind=$1 AND subject=$2 AND success), '-infinity')`,
		kind, subject, window.Seconds()).Scan(&n)
	return n, err
}
