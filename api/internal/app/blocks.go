package app

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"net/http"
	"strings"
	"time"
)

const clientCookie = "gs_cid"

// clientIdentity は来場者の識別子（Cookieまたはアプリの識別値）。同一人物の断定には使わない。
type clientIdentity struct {
	ID   string
	Kind string
}

func (a *App) hashIdentity(v string) string {
	m := hmac.New(sha256.New, a.Cfg.Secret)
	m.Write([]byte("client:" + v))
	return hex.EncodeToString(m.Sum(nil))
}

// resolveClient は来場者識別を取得・作成する。WebはCookie、アプリは X-Client-Id/X-Client-Kind。
func (a *App) resolveClient(ctx context.Context, w http.ResponseWriter, r *http.Request) (*clientIdentity, error) {
	kind := "web"
	value := ""
	if cid := strings.TrimSpace(r.Header.Get("X-Client-Id")); cid != "" {
		k := r.Header.Get("X-Client-Kind")
		switch k {
		case "appclip", "ios", "android":
			kind = k
		default:
			return nil, badRequest("X-Client-Kind が正しくありません")
		}
		if len(cid) < 16 || len(cid) > 200 {
			return nil, badRequest("X-Client-Id が正しくありません")
		}
		value = cid
	} else {
		value = cookieValue(r, clientCookie)
		if len(value) < 16 || len(value) > 100 {
			value = randomToken()
			http.SetCookie(w, &http.Cookie{Name: clientCookie, Value: value, Path: "/", HttpOnly: true,
				Secure: a.Cfg.CookieSecure, SameSite: http.SameSiteLaxMode, MaxAge: 60 * 60 * 24 * 30})
		}
	}
	var id string
	err := a.DB.QueryRowContext(ctx, `INSERT INTO client_identities(kind, value_hash) VALUES ($1,$2)
		ON CONFLICT (kind, value_hash) DO UPDATE SET last_seen_at=now() RETURNING id`, kind, a.hashIdentity(value)).Scan(&id)
	if err != nil {
		return nil, err
	}
	return &clientIdentity{ID: id, Kind: kind}, nil
}

// checkBlocked は scope（order / reservation）の新規受付がブロックされているかをサーバーで判定する。
func checkBlocked(ctx context.Context, q queryer, clientID, scope string) error {
	var blocked bool
	err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM access_blocks WHERE client_identity_id=$1
		AND (scope=$2 OR scope='both') AND lifted_at IS NULL AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now()))`,
		clientID, scope).Scan(&blocked)
	if err != nil {
		return err
	}
	if blocked {
		return forbidden("現在この端末からは受け付けできません。お近くのスタッフにお声がけください")
	}
	return nil
}

// POST /api/v1/admin/blocks {source_type: order|reservation, source_id, scope, reason, ends_at}
// 注文・予約の詳細からその来場者識別をブロックする。既存取引は自動取消しない。
func (a *App) handleCreateBlock(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var in struct {
		SourceType string     `json:"source_type"`
		SourceID   string     `json:"source_id"`
		Scope      string     `json:"scope"`
		Reason     string     `json:"reason"`
		EndsAt     *time.Time `json:"ends_at"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if err := requireText("理由", in.Reason, 200); err != nil {
		return err
	}
	switch in.Scope {
	case "order", "reservation", "both":
	default:
		return badRequest("制限範囲を指定してください")
	}
	if !isUUID(in.SourceID) {
		return badRequest("対象を指定してください")
	}
	ctx := r.Context()
	var clientID sql.NullString
	var err error
	switch in.SourceType {
	case "order":
		err = a.DB.QueryRowContext(ctx, `SELECT client_identity_id FROM orders WHERE id=$1`, in.SourceID).Scan(&clientID)
	case "reservation":
		err = a.DB.QueryRowContext(ctx, `SELECT client_identity_id FROM reservations WHERE id=$1`, in.SourceID).Scan(&clientID)
	default:
		return badRequest("対象の種類が正しくありません")
	}
	if err != nil {
		return err
	}
	if !clientID.Valid {
		return unprocessable("no_identity", "この取引はスタッフ入力のため、来場者識別がありません")
	}
	var id string
	err = a.withTx(ctx, func(tx *sql.Tx) error {
		if err := tx.QueryRowContext(ctx, `INSERT INTO access_blocks(client_identity_id, scope, reason, source_type, source_id, created_by, ends_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, clientID.String, in.Scope, in.Reason, in.SourceType, in.SourceID, s.ID, in.EndsAt).Scan(&id); err != nil {
			return err
		}
		return audit(ctx, tx, s, "block.create", "access_block", id, in)
	})
	if err != nil {
		return err
	}
	writeJSON(w, 201, map[string]any{"id": id})
	return nil
}

func (a *App) handleListBlocks(w http.ResponseWriter, r *http.Request, s *Staff) error {
	raw, err := queryRaw(r.Context(), a.DB, `SELECT COALESCE(json_agg(x ORDER BY x.created_at DESC), '[]') FROM (
		SELECT b.id, b.scope, b.reason, b.source_type, b.source_id, b.starts_at, b.ends_at, b.lifted_at, b.lift_reason, b.created_at,
		  c.kind AS client_kind, m.name AS created_by_name, lm.name AS lifted_by_name,
		  (b.lifted_at IS NULL AND (b.ends_at IS NULL OR b.ends_at > now())) AS effective
		FROM access_blocks b JOIN client_identities c ON c.id=b.client_identity_id
		JOIN members m ON m.id=b.created_by LEFT JOIN members lm ON lm.id=b.lifted_by) x`)
	if err != nil {
		return err
	}
	writeJSON(w, 200, raw)
	return nil
}

// POST /api/v1/admin/blocks/{id}/lift {reason}
func (a *App) handleLiftBlock(w http.ResponseWriter, r *http.Request, s *Staff) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Reason string `json:"reason"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if err := requireText("解除理由", in.Reason, 200); err != nil {
		return err
	}
	ctx := r.Context()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE access_blocks SET lifted_at=now(), lifted_by=$2, lift_reason=$3, updated_at=now()
			WHERE id=$1 AND lifted_at IS NULL`, id, s.ID, in.Reason)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return conflict("already_lifted", "既に解除されているか、存在しません")
		}
		if err := audit(ctx, tx, s, "block.lift", "access_block", id, in); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return nil
	})
}
