package app

import (
	"database/sql"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"
)

var allRoles = []string{"admin", "cashier", "kitchen", "reception", "treasurer", "member", "display"}

// POST /api/v1/auth/login {login_id, password}
// Webには HttpOnly Cookie を設定し、アプリ向けに token も返す。
func (a *App) handleLogin(w http.ResponseWriter, r *http.Request) error {
	if err := a.rateLimit(r, "login", 10, 10); err != nil {
		return err
	}
	var req struct {
		LoginID  string `json:"login_id"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	ctx := r.Context()
	subject := hashToken("login", strings.ToLower(req.LoginID))
	fails, err := a.countFailures(ctx, a.DB, "login", subject, 15*time.Minute)
	if err != nil {
		return err
	}
	if fails >= 10 {
		return errf(429, "locked", "ログイン失敗が続いたため一時的にロックしています。15分後にお試しください")
	}
	var id, hash string
	var active bool
	err = a.DB.QueryRowContext(ctx, `SELECT id, password_hash, active FROM members WHERE lower(login_id)=lower($1)`, req.LoginID).
		Scan(&id, &hash, &active)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && (!active || !checkPassword(hash, req.Password))) {
		if errors.Is(err, sql.ErrNoRows) {
			checkPassword("pbkdf2-sha256$210000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", req.Password) // タイミング差を減らす
		}
		a.recordAttempt(ctx, a.DB, "login", subject, false)
		return errf(401, "invalid_credentials", "IDまたはパスワードが違います")
	}
	if err != nil {
		return err
	}
	a.recordAttempt(ctx, a.DB, "login", subject, true)
	token := randomToken()
	expires := a.Now().Add(a.Cfg.SessionTTL)
	if _, err := a.DB.ExecContext(ctx, `INSERT INTO staff_sessions(token_hash, member_id, expires_at) VALUES ($1,$2,$3)`,
		hashToken("session", token), id, expires); err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: token, Path: "/", HttpOnly: true, Secure: a.Cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode, Expires: expires,
	})
	s, err := a.loadStaff(ctx, token)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"token": token, "expires_at": expires, "staff": s})
	return nil
}

func (a *App) handleLogout(w http.ResponseWriter, r *http.Request) error {
	if tok := sessionTokenFrom(r); tok != "" {
		a.DB.ExecContext(r.Context(), `DELETE FROM staff_sessions WHERE token_hash=$1`, hashToken("session", tok))
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", HttpOnly: true, MaxAge: -1, Secure: a.Cfg.CookieSecure})
	writeJSON(w, 200, map[string]any{"ok": true})
	return nil
}

func (a *App) handleMe(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var unread int
	a.DB.QueryRowContext(r.Context(), `SELECT count(*) FROM notifications WHERE member_id=$1 AND read_at IS NULL`, s.ID).Scan(&unread)
	writeJSON(w, 200, map[string]any{"staff": s, "unread_notifications": unread})
	return nil
}

// POST /api/v1/auth/password {current, new}
func (a *App) handleChangePassword(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var req struct {
		Current string `json:"current"`
		New     string `json:"new"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if len(req.New) < 8 {
		return badRequest("新しいパスワードは8文字以上にしてください")
	}
	var hash string
	if err := a.DB.QueryRowContext(r.Context(), `SELECT password_hash FROM members WHERE id=$1`, s.ID).Scan(&hash); err != nil {
		return err
	}
	if !checkPassword(hash, req.Current) {
		return errf(400, "invalid_credentials", "現在のパスワードが違います")
	}
	nh, err := hashPassword(req.New)
	if err != nil {
		return err
	}
	return a.withTx(r.Context(), func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(r.Context(), `UPDATE members SET password_hash=$2, updated_at=now() WHERE id=$1`, s.ID, nh); err != nil {
			return err
		}
		// 他の端末のセッションを無効化
		if _, err := tx.ExecContext(r.Context(), `DELETE FROM staff_sessions WHERE member_id=$1 AND token_hash<>$2`,
			s.ID, hashToken("session", sessionTokenFrom(r))); err != nil {
			return err
		}
		if err := audit(r.Context(), tx, s, "member.password_change", "member", s.ID, nil); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return nil
	})
}

// ---------------------------------------------------------------
// 部員・権限の管理（管理者）
// ---------------------------------------------------------------

func (a *App) handleListMembers(w http.ResponseWriter, r *http.Request, s *Staff) error {
	raw, err := queryRaw(r.Context(), a.DB, `SELECT COALESCE(json_agg(x ORDER BY x.name), '[]') FROM (
		SELECT m.id, m.name, m.login_id, m.active, m.created_at,
		  COALESCE((SELECT json_agg(role ORDER BY role) FROM member_roles WHERE member_id=m.id), '[]') AS roles,
		  (SELECT id FROM cash_accounts c WHERE c.member_id=m.id AND c.kind='wallet' AND c.active) AS wallet_account_id
		FROM members m) x`)
	if err != nil {
		return err
	}
	writeJSON(w, 200, raw)
	return nil
}

type memberInput struct {
	Name         string   `json:"name"`
	LoginID      string   `json:"login_id"`
	Password     string   `json:"password"`
	Roles        []string `json:"roles"`
	Active       *bool    `json:"active"`
	CreateWallet *bool    `json:"create_wallet"`
}

func validateRoles(roles []string) error {
	for _, r := range roles {
		if !slices.Contains(allRoles, r) {
			return badRequest("不明な権限です: %s", r)
		}
	}
	return nil
}

func (a *App) handleCreateMember(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var in memberInput
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if err := requireText("名前", in.Name, 50); err != nil {
		return err
	}
	if err := requireText("ログインID", in.LoginID, 50); err != nil {
		return err
	}
	if len(in.Password) < 8 {
		return badRequest("パスワードは8文字以上にしてください")
	}
	if err := validateRoles(in.Roles); err != nil {
		return err
	}
	hash, err := hashPassword(in.Password)
	if err != nil {
		return err
	}
	ctx := r.Context()
	var id string
	err = a.withTx(ctx, func(tx *sql.Tx) error {
		if err := tx.QueryRowContext(ctx, `INSERT INTO members(name, login_id, password_hash) VALUES ($1,$2,$3) RETURNING id`,
			strings.TrimSpace(in.Name), strings.TrimSpace(in.LoginID), hash).Scan(&id); err != nil {
			return err
		}
		for _, role := range in.Roles {
			if _, err := tx.ExecContext(ctx, `INSERT INTO member_roles(member_id, role) VALUES ($1,$2)`, id, role); err != nil {
				return err
			}
		}
		// 既定で個人財布の保管先を作る（現金を扱う可能性があるため）
		if in.CreateWallet == nil || *in.CreateWallet {
			if _, err := tx.ExecContext(ctx, `INSERT INTO cash_accounts(name, kind, member_id) VALUES ($1 || 'の財布','wallet',$2)`,
				strings.TrimSpace(in.Name), id); err != nil {
				return err
			}
		}
		return audit(ctx, tx, s, "member.create", "member", id, map[string]any{"login_id": in.LoginID, "roles": in.Roles})
	})
	if err != nil {
		return err
	}
	writeJSON(w, 201, map[string]any{"id": id})
	return nil
}

func (a *App) handleUpdateMember(w http.ResponseWriter, r *http.Request, s *Staff) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in memberInput
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if in.Roles != nil {
		if err := validateRoles(in.Roles); err != nil {
			return err
		}
		if id == s.ID && !slices.Contains(in.Roles, "admin") {
			return badRequest("自分自身の管理者権限は外せません")
		}
	}
	if in.Active != nil && !*in.Active && id == s.ID {
		return badRequest("自分自身を無効化できません")
	}
	ctx := r.Context()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE members SET
			name = COALESCE(NULLIF($2,''), name),
			active = COALESCE($3, active),
			updated_at = now() WHERE id=$1`, id, strings.TrimSpace(in.Name), in.Active)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return notFound("部員")
		}
		if in.Password != "" {
			if len(in.Password) < 8 {
				return badRequest("パスワードは8文字以上にしてください")
			}
			hash, err := hashPassword(in.Password)
			if err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE members SET password_hash=$2 WHERE id=$1`, id, hash); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM staff_sessions WHERE member_id=$1`, id); err != nil {
				return err
			}
		}
		if in.Roles != nil {
			if _, err := tx.ExecContext(ctx, `DELETE FROM member_roles WHERE member_id=$1`, id); err != nil {
				return err
			}
			for _, role := range in.Roles {
				if _, err := tx.ExecContext(ctx, `INSERT INTO member_roles(member_id, role) VALUES ($1,$2)`, id, role); err != nil {
					return err
				}
			}
		}
		if in.Active != nil && !*in.Active {
			if _, err := tx.ExecContext(ctx, `DELETE FROM staff_sessions WHERE member_id=$1`, id); err != nil {
				return err
			}
		}
		if err := audit(ctx, tx, s, "member.update", "member", id, map[string]any{
			"name": in.Name, "roles": in.Roles, "active": in.Active, "password_changed": in.Password != ""}); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return nil
	})
}

// GET /api/v1/staff/members/directory — シフト交代相手の選択などに使う（全スタッフ可）
func (a *App) handleMemberDirectory(w http.ResponseWriter, r *http.Request, s *Staff) error {
	raw, err := queryRaw(r.Context(), a.DB, `SELECT COALESCE(json_agg(json_build_object('id',id,'name',name) ORDER BY name), '[]')
		FROM members WHERE active`)
	if err != nil {
		return err
	}
	writeJSON(w, 200, raw)
	return nil
}

// ---------------------------------------------------------------
// 通知
// ---------------------------------------------------------------

func (a *App) handleListNotifications(w http.ResponseWriter, r *http.Request, s *Staff) error {
	raw, err := queryRaw(r.Context(), a.DB, `SELECT COALESCE(json_agg(n ORDER BY n.created_at DESC), '[]') FROM (
		SELECT id, kind, title, body, link, read_at, created_at FROM notifications WHERE member_id=$1
		ORDER BY created_at DESC LIMIT 100) n`, s.ID)
	if err != nil {
		return err
	}
	writeJSON(w, 200, raw)
	return nil
}

func (a *App) handleReadNotifications(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var req struct {
		IDs []string `json:"ids"`
		All bool     `json:"all"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	ctx := r.Context()
	if req.All {
		_, err := a.DB.ExecContext(ctx, `UPDATE notifications SET read_at=now() WHERE member_id=$1 AND read_at IS NULL`, s.ID)
		if err != nil {
			return err
		}
	} else {
		for _, id := range req.IDs {
			if !isUUID(id) {
				continue
			}
			if _, err := a.DB.ExecContext(ctx, `UPDATE notifications SET read_at=now() WHERE id=$1 AND member_id=$2 AND read_at IS NULL`, id, s.ID); err != nil {
				return err
			}
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true})
	return nil
}

func (a *App) handleAuditLogs(w http.ResponseWriter, r *http.Request, s *Staff) error {
	limit := queryInt(r, "limit", 200)
	if limit < 1 || limit > 1000 {
		limit = 200
	}
	raw, err := queryRaw(r.Context(), a.DB, `SELECT COALESCE(json_agg(x ORDER BY x.id DESC), '[]') FROM (
		SELECT l.id, l.action, l.target_type, l.target_id, l.detail, l.created_at, m.name AS member_name
		FROM audit_logs l LEFT JOIN members m ON m.id=l.member_id
		WHERE ($1='' OR l.target_type=$1) AND ($2='' OR l.target_id=$2)
		ORDER BY l.id DESC LIMIT $3) x`, r.URL.Query().Get("target_type"), r.URL.Query().Get("target_id"), limit)
	if err != nil {
		return err
	}
	writeJSON(w, 200, raw)
	return nil
}
