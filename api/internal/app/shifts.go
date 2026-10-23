package app

import (
	"database/sql"
	"fmt"
	"net/http"
	"time"
)

// シフト：希望提出 → 管理者が配置・確定 → 本人閲覧。
// 交代：申請 → 相手承諾 → 管理者承認 → 配置更新。希望と確定配置は別に保存し、変更履歴を残す。

// GET /api/v1/staff/shifts?day= — 枠・自分の希望・確定配置・警告
func (a *App) handleShifts(w http.ResponseWriter, r *http.Request, s *Staff) error {
	day, err := queryDate(r, "day")
	if err != nil {
		return err
	}
	isAdmin := s.Has("admin")
	raw, err := queryRaw(r.Context(), a.DB, `SELECT COALESCE(json_agg(x ORDER BY x.starts_at, x.location), '[]') FROM (
		SELECT sl.id, sl.business_day, sl.location, sl.starts_at, sl.ends_at, sl.required_count, sl.note, sl.active,
		  (SELECT count(*) FROM shift_assignments sa WHERE sa.slot_id=sl.id AND sa.status='active') AS assigned_count,
		  COALESCE((SELECT json_agg(json_build_object('id',sa.id,'member_id',sa.member_id,'member_name',m.name) ORDER BY m.name)
		    FROM shift_assignments sa JOIN members m ON m.id=sa.member_id WHERE sa.slot_id=sl.id AND sa.status='active'), '[]') AS assignments,
		  (SELECT json_build_object('preference',preference,'note',note) FROM shift_requests WHERE slot_id=sl.id AND member_id=$2) AS my_request,
		  EXISTS (SELECT 1 FROM shift_assignments sa WHERE sa.slot_id=sl.id AND sa.member_id=$2 AND sa.status='active') AS mine,
		  CASE WHEN $3 THEN COALESCE((SELECT json_agg(json_build_object('member_id',rq.member_id,'member_name',m.name,'preference',rq.preference,'note',rq.note)
		    ORDER BY rq.preference, m.name) FROM shift_requests rq JOIN members m ON m.id=rq.member_id WHERE rq.slot_id=sl.id), '[]') END AS requests
		FROM shift_slots sl WHERE ($1='' OR sl.business_day::text=$1) AND (sl.active OR $3)) x`, day, s.ID, isAdmin)
	if err != nil {
		return err
	}
	warnings, err := a.shiftWarnings(r, day)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"slots": raw, "warnings": warnings})
	return nil
}

func (a *App) shiftWarnings(r *http.Request, day string) ([]string, error) {
	out := []string{}
	rows, err := a.DB.QueryContext(r.Context(), `SELECT sl.location, sl.starts_at, sl.required_count,
		(SELECT count(*) FROM shift_assignments sa WHERE sa.slot_id=sl.id AND sa.status='active')
		FROM shift_slots sl WHERE sl.active AND ($1='' OR sl.business_day::text=$1) ORDER BY sl.starts_at`, day)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var loc string
		var st time.Time
		var req, got int
		if err := rows.Scan(&loc, &st, &req, &got); err != nil {
			rows.Close()
			return nil, err
		}
		if got < req {
			out = append(out, fmt.Sprintf("%s %s：必要%d人に対し%d人（%d人不足）", st.In(jst).Format("1/2 15:04"), loc, req, got, req-got))
		}
	}
	rows.Close()
	rows, err = a.DB.QueryContext(r.Context(), `SELECT m.name, s1.location, s1.starts_at, s2.location, s2.starts_at
		FROM shift_assignments a1 JOIN shift_slots s1 ON s1.id=a1.slot_id
		JOIN shift_assignments a2 ON a2.member_id=a1.member_id AND a2.id > a1.id AND a2.status='active'
		JOIN shift_slots s2 ON s2.id=a2.slot_id JOIN members m ON m.id=a1.member_id
		WHERE a1.status='active' AND s1.active AND s2.active AND tstzrange(s1.starts_at,s1.ends_at) && tstzrange(s2.starts_at,s2.ends_at)
		  AND ($1='' OR s1.business_day::text=$1)`, day)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var name, l1, l2 string
		var t1, t2 time.Time
		if err := rows.Scan(&name, &l1, &t1, &l2, &t2); err != nil {
			return nil, err
		}
		out = append(out, fmt.Sprintf("%sさんが重複配置：%s %s と %s %s", name, t1.In(jst).Format("1/2 15:04"), l1, t2.In(jst).Format("15:04"), l2))
	}
	return out, rows.Err()
}

// POST /api/v1/admin/shift-slots {business_day, location, starts_at, ends_at, required_count, note}
func (a *App) handleCreateShiftSlot(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var in struct {
		Location      string    `json:"location"`
		StartsAt      time.Time `json:"starts_at"`
		EndsAt        time.Time `json:"ends_at"`
		RequiredCount int       `json:"required_count"`
		Note          string    `json:"note"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if err := requireText("担当場所", in.Location, 50); err != nil {
		return err
	}
	if !in.EndsAt.After(in.StartsAt) || in.RequiredCount < 1 {
		return badRequest("時間帯と必要人数を正しく指定してください")
	}
	ctx := r.Context()
	var id string
	err := a.withTx(ctx, func(tx *sql.Tx) error {
		if err := tx.QueryRowContext(ctx, `INSERT INTO shift_slots(business_day, location, starts_at, ends_at, required_count, note)
			VALUES (($2 AT TIME ZONE 'Asia/Tokyo')::date,$1,$2,$3,$4,$5) RETURNING id`, in.Location, in.StartsAt, in.EndsAt, in.RequiredCount, in.Note).Scan(&id); err != nil {
			return err
		}
		if err := audit(ctx, tx, s, "shift_slot.create", "shift_slot", id, in); err != nil {
			return err
		}
		return publish(ctx, tx, "shifts")
	})
	if err != nil {
		return err
	}
	writeJSON(w, 201, map[string]any{"id": id})
	return nil
}

// PATCH /api/v1/admin/shift-slots/{id}
func (a *App) handleUpdateShiftSlot(w http.ResponseWriter, r *http.Request, s *Staff) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Location      *string    `json:"location"`
		StartsAt      *time.Time `json:"starts_at"`
		EndsAt        *time.Time `json:"ends_at"`
		RequiredCount *int       `json:"required_count"`
		Note          *string    `json:"note"`
		Active        *bool      `json:"active"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE shift_slots SET location=COALESCE($2,location), starts_at=COALESCE($3,starts_at),
			ends_at=COALESCE($4,ends_at), required_count=COALESCE($5,required_count), note=COALESCE($6,note), active=COALESCE($7,active),
			business_day=(COALESCE($3,starts_at) AT TIME ZONE 'Asia/Tokyo')::date, updated_at=now() WHERE id=$1`,
			id, in.Location, in.StartsAt, in.EndsAt, in.RequiredCount, in.Note, in.Active)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return notFound("シフト枠")
		}
		// 配置済みの人に変更を通知
		if _, err := tx.ExecContext(ctx, `INSERT INTO notifications(member_id, kind, title, body, link)
			SELECT member_id, 'shift', 'シフトが変更されました', '担当枠の内容が変更されました。確認してください', '/staff/shifts'
			FROM shift_assignments WHERE slot_id=$1 AND status='active'`, id); err != nil {
			return err
		}
		if err := audit(ctx, tx, s, "shift_slot.update", "shift_slot", id, in); err != nil {
			return err
		}
		if err := publish(ctx, tx, "shifts"); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return nil
	})
}

// PUT /api/v1/staff/shift-slots/{id}/request {preference: want|ok|ng, note}
func (a *App) handleShiftRequest(w http.ResponseWriter, r *http.Request, s *Staff) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Preference string `json:"preference"`
		Note       string `json:"note"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	switch in.Preference {
	case "want", "ok", "ng":
	default:
		return badRequest("希望を選んでください")
	}
	if len([]rune(in.Note)) > 200 {
		return badRequest("メモは200文字以内にしてください")
	}
	if _, err := a.DB.ExecContext(r.Context(), `INSERT INTO shift_requests(slot_id, member_id, preference, note) VALUES ($1,$2,$3,$4)
		ON CONFLICT (slot_id, member_id) DO UPDATE SET preference=EXCLUDED.preference, note=EXCLUDED.note, updated_at=now()`,
		id, s.ID, in.Preference, in.Note); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"ok": true})
	return nil
}

// POST /api/v1/admin/shift-slots/{id}/assignments {member_id}
func (a *App) handleAssignShift(w http.ResponseWriter, r *http.Request, s *Staff) error {
	slotID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		MemberID string `json:"member_id"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if !isUUID(in.MemberID) {
		return badRequest("部員を指定してください")
	}
	ctx := r.Context()
	var id string
	err = a.withTx(ctx, func(tx *sql.Tx) error {
		if err := tx.QueryRowContext(ctx, `INSERT INTO shift_assignments(slot_id, member_id, assigned_by) VALUES ($1,$2,$3) RETURNING id`,
			slotID, in.MemberID, s.ID).Scan(&id); err != nil {
			return err
		}
		if err := notify(ctx, tx, in.MemberID, "shift", "シフトに配置されました", "確定したシフトを確認してください", "/staff/shifts"); err != nil {
			return err
		}
		if err := audit(ctx, tx, s, "shift.assign", "shift_assignment", id, map[string]any{"slot_id": slotID, "member_id": in.MemberID}); err != nil {
			return err
		}
		return publish(ctx, tx, "shifts")
	})
	if err != nil {
		return err
	}
	writeJSON(w, 201, map[string]any{"id": id})
	return nil
}

// POST /api/v1/admin/shift-assignments/{id}/remove {reason}
func (a *App) handleRemoveAssignment(w http.ResponseWriter, r *http.Request, s *Staff) error {
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
	ctx := r.Context()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		var member string
		err := tx.QueryRowContext(ctx, `UPDATE shift_assignments SET status='removed', removed_by=$2, remove_reason=$3, removed_at=now()
			WHERE id=$1 AND status='active' RETURNING member_id`, id, s.ID, in.Reason).Scan(&member)
		if err == sql.ErrNoRows {
			return conflict("not_active", "有効な配置ではありません")
		}
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE shift_exchanges SET status='cancelled', updated_at=now() WHERE assignment_id=$1 AND status IN ('requested','accepted')`, id); err != nil {
			return err
		}
		if err := notify(ctx, tx, member, "shift", "シフトの配置が外れました", in.Reason, "/staff/shifts"); err != nil {
			return err
		}
		if err := audit(ctx, tx, s, "shift.unassign", "shift_assignment", id, in); err != nil {
			return err
		}
		if err := publish(ctx, tx, "shifts"); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return nil
	})
}

// ---------------------------------------------------------------
// 交代申請
// ---------------------------------------------------------------

// GET /api/v1/staff/shift-exchanges
func (a *App) handleListExchanges(w http.ResponseWriter, r *http.Request, s *Staff) error {
	raw, err := queryRaw(r.Context(), a.DB, `SELECT COALESCE(json_agg(x ORDER BY x.created_at DESC), '[]') FROM (
		SELECT e.id, e.status, e.reason, e.created_at, e.responded_at, e.decided_at,
		  e.from_member_id, fm.name AS from_name, e.to_member_id, tm.name AS to_name, dm.name AS decided_by_name,
		  sl.location, sl.starts_at, sl.ends_at
		FROM shift_exchanges e JOIN shift_assignments sa ON sa.id=e.assignment_id JOIN shift_slots sl ON sl.id=sa.slot_id
		JOIN members fm ON fm.id=e.from_member_id JOIN members tm ON tm.id=e.to_member_id LEFT JOIN members dm ON dm.id=e.decided_by
		WHERE $2 OR e.from_member_id=$1 OR e.to_member_id=$1 ORDER BY e.created_at DESC LIMIT 200) x`, s.ID, s.Has("admin"))
	if err != nil {
		return err
	}
	writeJSON(w, 200, raw)
	return nil
}

// POST /api/v1/staff/shift-exchanges {assignment_id, to_member_id, reason}
func (a *App) handleRequestExchange(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var in struct {
		AssignmentID string `json:"assignment_id"`
		ToMemberID   string `json:"to_member_id"`
		Reason       string `json:"reason"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if !isUUID(in.AssignmentID) || !isUUID(in.ToMemberID) {
		return badRequest("交代するシフトと相手を指定してください")
	}
	if in.ToMemberID == s.ID {
		return badRequest("自分自身とは交代できません")
	}
	ctx := r.Context()
	var id string
	err := a.withTx(ctx, func(tx *sql.Tx) error {
		var owner, slotID string
		if err := tx.QueryRowContext(ctx, `SELECT member_id, slot_id FROM shift_assignments WHERE id=$1 AND status='active' FOR UPDATE`, in.AssignmentID).Scan(&owner, &slotID); err != nil {
			if err == sql.ErrNoRows {
				return notFound("シフト")
			}
			return err
		}
		if owner != s.ID {
			return forbidden("自分のシフトのみ交代申請できます")
		}
		var already bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM shift_assignments WHERE slot_id=$1 AND member_id=$2 AND status='active')`, slotID, in.ToMemberID).Scan(&already); err != nil {
			return err
		}
		if already {
			return unprocessable("already_assigned", "相手は既にこの枠に配置されています")
		}
		if err := tx.QueryRowContext(ctx, `INSERT INTO shift_exchanges(assignment_id, from_member_id, to_member_id, reason) VALUES ($1,$2,$3,$4) RETURNING id`,
			in.AssignmentID, s.ID, in.ToMemberID, in.Reason).Scan(&id); err != nil {
			return err
		}
		if err := notify(ctx, tx, in.ToMemberID, "shift_exchange", "シフト交代の依頼", fmt.Sprintf("%sさんから交代の依頼があります", s.Name), "/staff/shifts"); err != nil {
			return err
		}
		return audit(ctx, tx, s, "shift.exchange_request", "shift_exchange", id, in)
	})
	if err != nil {
		return err
	}
	writeJSON(w, 201, map[string]any{"id": id})
	return nil
}

// POST /api/v1/staff/shift-exchanges/{id}/respond {action: accept|decline|cancel}
// POST /api/v1/admin/shift-exchanges/{id}/decide {action: approve|reject, reason}
func (a *App) handleRespondExchange(w http.ResponseWriter, r *http.Request, s *Staff) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Action string `json:"action"`
		Reason string `json:"reason"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		var status, from, to, assignment string
		if err := tx.QueryRowContext(ctx, `SELECT status, from_member_id, to_member_id, assignment_id FROM shift_exchanges WHERE id=$1 FOR UPDATE`, id).
			Scan(&status, &from, &to, &assignment); err != nil {
			return err
		}
		switch in.Action {
		case "accept", "decline":
			if to != s.ID {
				return forbidden("依頼された本人のみ回答できます")
			}
			if status != "requested" {
				return conflict("state_changed", "この依頼には回答できません")
			}
			newStatus := "accepted"
			if in.Action == "decline" {
				newStatus = "declined"
			}
			if _, err := tx.ExecContext(ctx, `UPDATE shift_exchanges SET status=$2, responded_at=now(), updated_at=now() WHERE id=$1`, id, newStatus); err != nil {
				return err
			}
			if err := notify(ctx, tx, from, "shift_exchange", "交代依頼への回答", fmt.Sprintf("%sさんが%s", s.Name, map[bool]string{true: "承諾しました（管理者の承認待ち）", false: "辞退しました"}[newStatus == "accepted"]), "/staff/shifts"); err != nil {
				return err
			}
			if newStatus == "accepted" {
				if _, err := tx.ExecContext(ctx, `INSERT INTO notifications(member_id, kind, title, body, link)
					SELECT member_id, 'shift_exchange', 'シフト交代の承認待ち', '交代申請が相手に承諾されました', '/admin/shifts' FROM member_roles WHERE role='admin'`); err != nil {
					return err
				}
			}
		case "cancel":
			if from != s.ID {
				return forbidden("申請者のみ取り下げできます")
			}
			if status != "requested" && status != "accepted" {
				return conflict("state_changed", "取り下げできない状態です")
			}
			if _, err := tx.ExecContext(ctx, `UPDATE shift_exchanges SET status='cancelled', updated_at=now() WHERE id=$1`, id); err != nil {
				return err
			}
		case "approve", "reject":
			if !s.Has("admin") {
				return forbidden("管理者のみ承認できます")
			}
			if status != "accepted" {
				return conflict("state_changed", "相手が承諾した申請のみ承認できます")
			}
			if in.Action == "reject" {
				if _, err := tx.ExecContext(ctx, `UPDATE shift_exchanges SET status='rejected', decided_by=$2, decided_at=now(), updated_at=now() WHERE id=$1`, id, s.ID); err != nil {
					return err
				}
			} else {
				// 確定配置の更新（旧配置を外し、相手の配置を作る）
				var slotID string
				err := tx.QueryRowContext(ctx, `UPDATE shift_assignments SET status='removed', removed_by=$2, remove_reason='交代', removed_at=now()
					WHERE id=$1 AND status='active' RETURNING slot_id`, assignment, s.ID).Scan(&slotID)
				if err == sql.ErrNoRows {
					return conflict("assignment_changed", "元のシフト配置が変更されています")
				}
				if err != nil {
					return err
				}
				var newID string
				if err := tx.QueryRowContext(ctx, `INSERT INTO shift_assignments(slot_id, member_id, assigned_by) VALUES ($1,$2,$3) RETURNING id`, slotID, to, s.ID).Scan(&newID); err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, `UPDATE shift_exchanges SET status='approved', decided_by=$2, decided_at=now(), new_assignment_id=$3, updated_at=now() WHERE id=$1`,
					id, s.ID, newID); err != nil {
					return err
				}
			}
			label := map[string]string{"approve": "承認", "reject": "却下"}[in.Action]
			for _, m := range []string{from, to} {
				if err := notify(ctx, tx, m, "shift_exchange", "シフト交代が"+label+"されました", in.Reason, "/staff/shifts"); err != nil {
					return err
				}
			}
		default:
			return badRequest("操作が正しくありません")
		}
		if err := audit(ctx, tx, s, "shift.exchange_"+in.Action, "shift_exchange", id, in); err != nil {
			return err
		}
		if err := publish(ctx, tx, "shifts"); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return nil
	})
}
