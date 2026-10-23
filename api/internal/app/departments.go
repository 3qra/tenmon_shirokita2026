package app

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
	"time"
)

type Department struct {
	ID                  string `json:"id"`
	Code                string `json:"code"`
	Name                string `json:"name"`
	Kind                string `json:"kind"`
	BusinessStatus      string `json:"business_status"`
	MobileOrderEnabled  bool   `json:"mobile_order_enabled"`
	SiteCodeEnabled     bool   `json:"site_code_enabled"`
	SiteCodeIntervalSec int    `json:"site_code_interval_sec"`
	SiteCodeGraceSec    int    `json:"site_code_grace_sec"`
	SiteCodeEpoch       int    `json:"-"`
	Notice              string `json:"notice"`
	SortOrder           int    `json:"sort_order"`
}

const deptCols = `id, code, name, kind, business_status, mobile_order_enabled, site_code_enabled,
	site_code_interval_sec, site_code_grace_sec, site_code_epoch, notice, sort_order`

func scanDept(row interface{ Scan(...any) error }) (*Department, error) {
	var d Department
	err := row.Scan(&d.ID, &d.Code, &d.Name, &d.Kind, &d.BusinessStatus, &d.MobileOrderEnabled, &d.SiteCodeEnabled,
		&d.SiteCodeIntervalSec, &d.SiteCodeGraceSec, &d.SiteCodeEpoch, &d.Notice, &d.SortOrder)
	if err != nil {
		return nil, err
	}
	return &d, nil
}

func (a *App) getDept(ctx context.Context, q queryer, id string, lock bool) (*Department, error) {
	query := `SELECT ` + deptCols + ` FROM departments WHERE id=$1`
	if lock {
		query += ` FOR SHARE`
	}
	d, err := scanDept(q.QueryRowContext(ctx, query, id))
	if err == sql.ErrNoRows {
		return nil, notFound("部門")
	}
	return d, err
}

func (a *App) listDepts(ctx context.Context) ([]*Department, error) {
	rows, err := a.DB.QueryContext(ctx, `SELECT `+deptCols+` FROM departments ORDER BY sort_order, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Department{}
	for rows.Next() {
		d, err := scanDept(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// GET /api/v1/public/departments
func (a *App) handlePublicDepartments(w http.ResponseWriter, r *http.Request) error {
	ds, err := a.listDepts(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, 200, ds)
	return nil
}

func (a *App) handleStaffDepartments(w http.ResponseWriter, r *http.Request, s *Staff) error {
	return a.handlePublicDepartments(w, r)
}

func (a *App) handleCreateDepartment(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var in struct {
		Code      string `json:"code"`
		Name      string `json:"name"`
		Kind      string `json:"kind"`
		SortOrder int    `json:"sort_order"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if err := requireText("コード", in.Code, 30); err != nil {
		return err
	}
	if in.Kind != "food" && in.Kind != "planetarium" && in.Kind != "goods" {
		return badRequest("部門の種類を選んでください")
	}
	if err := requireText("部門名", in.Name, 50); err != nil {
		return err
	}
	ctx := r.Context()
	var id string
	err := a.withTx(ctx, func(tx *sql.Tx) error {
		if err := tx.QueryRowContext(ctx, `INSERT INTO departments(code, name, kind, sort_order) VALUES ($1,$2,$3,$4) RETURNING id`,
			strings.TrimSpace(in.Code), strings.TrimSpace(in.Name), in.Kind, in.SortOrder).Scan(&id); err != nil {
			return err
		}
		return audit(ctx, tx, s, "department.create", "department", id, in)
	})
	if err != nil {
		return err
	}
	writeJSON(w, 201, map[string]any{"id": id})
	return nil
}

// PATCH /api/v1/admin/departments/{id}
// 営業状態・モバイル受付・現地コードはそれぞれ独立して変更できる。
func (a *App) handleUpdateDepartment(w http.ResponseWriter, r *http.Request, s *Staff) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Name                *string `json:"name"`
		BusinessStatus      *string `json:"business_status"`
		MobileOrderEnabled  *bool   `json:"mobile_order_enabled"`
		SiteCodeEnabled     *bool   `json:"site_code_enabled"`
		SiteCodeIntervalSec *int    `json:"site_code_interval_sec"`
		SiteCodeGraceSec    *int    `json:"site_code_grace_sec"`
		RotateSiteCode      bool    `json:"rotate_site_code"`
		Notice              *string `json:"notice"`
		SortOrder           *int    `json:"sort_order"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if in.BusinessStatus != nil {
		switch *in.BusinessStatus {
		case "before", "open", "paused", "closed":
		default:
			return badRequest("営業状態が正しくありません")
		}
	}
	if in.Notice != nil && len([]rune(*in.Notice)) > 200 {
		return badRequest("案内文は200文字以内にしてください")
	}
	ctx := r.Context()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		epochInc := 0
		if in.RotateSiteCode {
			epochInc = 1
		}
		res, err := tx.ExecContext(ctx, `UPDATE departments SET
			name = COALESCE($2, name),
			business_status = COALESCE($3, business_status),
			mobile_order_enabled = COALESCE($4, mobile_order_enabled),
			site_code_enabled = COALESCE($5, site_code_enabled),
			site_code_interval_sec = COALESCE($6, site_code_interval_sec),
			site_code_grace_sec = COALESCE($7, site_code_grace_sec),
			site_code_epoch = site_code_epoch + $8,
			notice = COALESCE($9, notice),
			sort_order = COALESCE($10, sort_order),
			updated_at = now()
			WHERE id=$1`, id, in.Name, in.BusinessStatus, in.MobileOrderEnabled, in.SiteCodeEnabled,
			in.SiteCodeIntervalSec, in.SiteCodeGraceSec, epochInc, in.Notice, in.SortOrder)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return notFound("部門")
		}
		if err := audit(ctx, tx, s, "department.update", "department", id, in); err != nil {
			return err
		}
		if err := publish(ctx, tx, "departments"); err != nil {
			return err
		}
		d, err := a.getDept(ctx, tx, id, false)
		if err != nil {
			return err
		}
		writeJSON(w, 200, d)
		return nil
	})
}

// ---------------------------------------------------------------
// 現地確認コード
// ---------------------------------------------------------------

type siteCodeInfo struct {
	Code       string    `json:"code"`
	ValidFrom  time.Time `json:"valid_from"`
	ValidUntil time.Time `json:"valid_until"`
}

func (a *App) currentSiteCode(d *Department, now time.Time) siteCodeInfo {
	iv := int64(d.SiteCodeIntervalSec)
	win := now.Unix() / iv
	return siteCodeInfo{
		Code:       a.siteCode(d.ID, d.SiteCodeEpoch, win),
		ValidFrom:  time.Unix(win*iv, 0),
		ValidUntil: time.Unix((win+1)*iv, 0),
	}
}

// verifySiteCode は現在の窓、および更新直後 grace 秒以内なら直前の窓のコードも受け付ける。
func (a *App) verifySiteCode(d *Department, code string, now time.Time) bool {
	code = strings.TrimSpace(code)
	if len(code) != 3 {
		return false
	}
	iv := int64(d.SiteCodeIntervalSec)
	win := now.Unix() / iv
	if a.siteCode(d.ID, d.SiteCodeEpoch, win) == code {
		return true
	}
	if now.Unix()-win*iv < int64(d.SiteCodeGraceSec) && a.siteCode(d.ID, d.SiteCodeEpoch, win-1) == code {
		return true
	}
	return false
}

// GET /api/v1/display/departments/{id}/site-code — 表示端末（display権限）または管理者のみ
func (a *App) handleDisplaySiteCode(w http.ResponseWriter, r *http.Request, s *Staff) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	d, err := a.getDept(ctx, a.DB, id, false)
	if err != nil {
		return err
	}
	if s.Has("display") {
		a.DB.ExecContext(ctx, `INSERT INTO display_heartbeats(member_id, department_id, screen, last_seen_at) VALUES ($1,$2,'sitecode',now())
			ON CONFLICT (member_id) DO UPDATE SET department_id=EXCLUDED.department_id, screen=EXCLUDED.screen, last_seen_at=now()`, s.ID, d.ID)
	}
	if !d.SiteCodeEnabled {
		writeJSON(w, 200, map[string]any{"enabled": false, "server_time": a.Now()})
		return nil
	}
	info := a.currentSiteCode(d, a.Now())
	writeJSON(w, 200, map[string]any{"enabled": true, "code": info.Code, "valid_from": info.ValidFrom,
		"valid_until": info.ValidUntil, "server_time": a.Now()})
	return nil
}

// GET /api/v1/admin/displays — 表示端末の最終接続
func (a *App) handleDisplayStatus(w http.ResponseWriter, r *http.Request, s *Staff) error {
	l, err := a.limits(r.Context(), a.DB)
	if err != nil {
		return err
	}
	raw, err := queryRaw(r.Context(), a.DB, `SELECT COALESCE(json_agg(x ORDER BY x.name), '[]') FROM (
		SELECT m.name, h.screen, h.last_seen_at, d.name AS department_name,
		  (h.last_seen_at < now() - make_interval(secs => $1)) AS stale
		FROM display_heartbeats h JOIN members m ON m.id=h.member_id LEFT JOIN departments d ON d.id=h.department_id) x`,
		l.DisplayStaleSeconds)
	if err != nil {
		return err
	}
	writeJSON(w, 200, raw)
	return nil
}

// POST /api/v1/display/heartbeat {screen, department_id}
func (a *App) handleDisplayHeartbeat(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var in struct {
		Screen       string `json:"screen"`
		DepartmentID string `json:"department_id"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if in.DepartmentID != "" && !isUUID(in.DepartmentID) {
		return badRequest("部門IDが正しくありません")
	}
	_, err := a.DB.ExecContext(r.Context(), `INSERT INTO display_heartbeats(member_id, department_id, screen, last_seen_at) VALUES ($1,$2,$3,now())
		ON CONFLICT (member_id) DO UPDATE SET department_id=EXCLUDED.department_id, screen=EXCLUDED.screen, last_seen_at=now()`,
		s.ID, nullStr(in.DepartmentID), in.Screen)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"server_time": a.Now()})
	return nil
}

// ---------------------------------------------------------------
// 営業日
// ---------------------------------------------------------------

func (a *App) handleListBusinessDays(w http.ResponseWriter, r *http.Request) error {
	raw, err := queryRaw(r.Context(), a.DB, `SELECT COALESCE(json_agg(json_build_object('id',id,'day',day,'label',label) ORDER BY day), '[]') FROM business_days`)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"days": raw, "today": a.today()})
	return nil
}

func (a *App) handlePutBusinessDays(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var in struct {
		EventName string `json:"event_name"`
		Days      []struct {
			Day   string `json:"day"`
			Label string `json:"label"`
		} `json:"days"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	for _, d := range in.Days {
		if _, err := time.Parse("2006-01-02", d.Day); err != nil {
			return badRequest("日付の形式が正しくありません: %s", d.Day)
		}
	}
	ctx := r.Context()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		var eventID string
		err := tx.QueryRowContext(ctx, `SELECT id FROM festival_events ORDER BY created_at LIMIT 1`).Scan(&eventID)
		if err == sql.ErrNoRows {
			name := in.EventName
			if name == "" {
				name = "学園祭"
			}
			err = tx.QueryRowContext(ctx, `INSERT INTO festival_events(name) VALUES ($1) RETURNING id`, name).Scan(&eventID)
		} else if err == nil && in.EventName != "" {
			_, err = tx.ExecContext(ctx, `UPDATE festival_events SET name=$2, updated_at=now() WHERE id=$1`, eventID, in.EventName)
		}
		if err != nil {
			return err
		}
		for _, d := range in.Days {
			if _, err := tx.ExecContext(ctx, `INSERT INTO business_days(event_id, day, label) VALUES ($1,$2,$3)
				ON CONFLICT (day) DO UPDATE SET label=EXCLUDED.label, updated_at=now()`, eventID, d.Day, d.Label); err != nil {
				return err
			}
		}
		if err := audit(ctx, tx, s, "business_days.update", "festival_event", eventID, in); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return nil
	})
}
