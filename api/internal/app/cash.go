package app

import (
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

// 売上と所持金は分離する。所持金（理論残高）は cash_entries の合計。
// 理論残高 = 開始残高 + 入金 + 受取移動 − 返金 − 引渡移動 （＋精算差額の調整）

// GET /api/v1/staff/cash/accounts — 保管先と理論残高
// 一般の会計担当は自分の財布と共用レジのみ、会計責任者・管理者は全件。
func (a *App) handleCashAccounts(w http.ResponseWriter, r *http.Request, s *Staff) error {
	all := s.Has("treasurer", "admin")
	raw, err := queryRaw(r.Context(), a.DB, `SELECT COALESCE(json_agg(x ORDER BY x.kind_order, x.name), '[]') FROM (
		SELECT c.id, c.name, c.kind, c.member_id, c.active, m.name AS member_name,
		  CASE c.kind WHEN 'safe' THEN 0 WHEN 'register' THEN 1 ELSE 2 END AS kind_order,
		  COALESCE((SELECT sum(amount) FROM cash_entries e WHERE e.cash_account_id=c.id AND e.medium='cash'),0) AS cash_balance,
		  COALESCE((SELECT sum(amount) FROM cash_entries e WHERE e.cash_account_id=c.id AND e.medium='voucher'),0) AS voucher_balance,
		  (SELECT count(*) FROM cash_transfers t WHERE t.status='pending' AND (t.to_account_id=c.id OR t.from_account_id=c.id)) AS pending_transfers,
		  (SELECT json_build_object('created_at',rc.created_at,'difference',rc.difference) FROM cash_reconciliations rc
		     WHERE rc.cash_account_id=c.id AND rc.medium='cash' ORDER BY rc.created_at DESC LIMIT 1) AS last_reconciliation
		FROM cash_accounts c LEFT JOIN members m ON m.id=c.member_id
		WHERE c.active AND ($1 OR c.member_id=$2 OR c.kind='register')) x`, all, s.ID)
	if err != nil {
		return err
	}
	var total struct {
		Cash    int `json:"cash"`
		Voucher int `json:"voucher"`
	}
	if all {
		a.DB.QueryRowContext(r.Context(), `SELECT COALESCE(sum(amount) FILTER (WHERE medium='cash'),0), COALESCE(sum(amount) FILTER (WHERE medium='voucher'),0)
			FROM cash_entries`).Scan(&total.Cash, &total.Voucher)
	}
	writeJSON(w, 200, map[string]any{"accounts": raw, "total": total, "can_view_all": all})
	return nil
}

// POST /api/v1/admin/cash/accounts {name, kind, member_id}
func (a *App) handleCreateCashAccount(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var in struct {
		Name     string `json:"name"`
		Kind     string `json:"kind"`
		MemberID string `json:"member_id"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if in.Kind != "wallet" && in.Kind != "safe" && in.Kind != "register" {
		return badRequest("種類（個人財布／金庫／共用レジ）を選んでください")
	}
	if err := requireText("保管先の名前", in.Name, 50); err != nil {
		return err
	}
	if in.Kind == "wallet" && !isUUID(in.MemberID) {
		return badRequest("財布の持ち主を指定してください")
	}
	ctx := r.Context()
	var id string
	err := a.withTx(ctx, func(tx *sql.Tx) error {
		if err := tx.QueryRowContext(ctx, `INSERT INTO cash_accounts(name, kind, member_id) VALUES ($1,$2,$3) RETURNING id`,
			in.Name, in.Kind, nullStr(in.MemberID)).Scan(&id); err != nil {
			return err
		}
		return audit(ctx, tx, s, "cash_account.create", "cash_account", id, in)
	})
	if err != nil {
		return err
	}
	writeJSON(w, 201, map[string]any{"id": id})
	return nil
}

// PATCH /api/v1/admin/cash/accounts/{id} {name, active}
func (a *App) handleUpdateCashAccount(w http.ResponseWriter, r *http.Request, s *Staff) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Name   *string `json:"name"`
		Active *bool   `json:"active"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		if in.Active != nil && !*in.Active {
			var cash, voucher int
			if err := tx.QueryRowContext(ctx, `SELECT COALESCE(sum(amount) FILTER (WHERE medium='cash'),0), COALESCE(sum(amount) FILTER (WHERE medium='voucher'),0)
				FROM cash_entries WHERE cash_account_id=$1`, id).Scan(&cash, &voucher); err != nil {
				return err
			}
			if cash != 0 || voucher != 0 {
				return unprocessable("balance_remaining", "残高（現金%d円・金券%d円）があるため無効化できません。先に回収してください", cash, voucher)
			}
		}
		res, err := tx.ExecContext(ctx, `UPDATE cash_accounts SET name=COALESCE($2,name), active=COALESCE($3,active), updated_at=now() WHERE id=$1`,
			id, in.Name, in.Active)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return notFound("保管先")
		}
		if err := audit(ctx, tx, s, "cash_account.update", "cash_account", id, in); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return nil
	})
}

// GET /api/v1/staff/cash/destinations — 引継ぎ・回収の送り先候補（残高は含めない）
func (a *App) handleCashDestinations(w http.ResponseWriter, r *http.Request, s *Staff) error {
	raw, err := queryRaw(r.Context(), a.DB, `SELECT COALESCE(json_agg(x ORDER BY x.kind_order, x.name), '[]') FROM (
		SELECT c.id, c.name, c.kind, m.name AS member_name,
		  CASE c.kind WHEN 'safe' THEN 0 WHEN 'register' THEN 1 ELSE 2 END AS kind_order
		FROM cash_accounts c LEFT JOIN members m ON m.id=c.member_id
		WHERE c.active AND (m.id IS NULL OR m.active)) x`)
	if err != nil {
		return err
	}
	writeJSON(w, 200, raw)
	return nil
}

// GET /api/v1/staff/cash/accounts/{id}/entries — 明細
func (a *App) handleCashEntries(w http.ResponseWriter, r *http.Request, s *Staff) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	if !s.Has("treasurer", "admin") {
		var owner sql.NullString
		var kind string
		if err := a.DB.QueryRowContext(ctx, `SELECT member_id, kind FROM cash_accounts WHERE id=$1`, id).Scan(&owner, &kind); err != nil {
			return err
		}
		if owner.String != s.ID && kind != "register" {
			return forbidden("この保管先の明細は閲覧できません")
		}
	}
	raw, err := queryRaw(ctx, a.DB, `SELECT COALESCE(json_agg(x ORDER BY x.id DESC), '[]') FROM (
		SELECT e.id, e.medium, e.kind, e.amount, e.reason, e.created_at, m.name AS member_name,
		  (SELECT o.call_number FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=e.payment_id) AS call_number,
		  e.transfer_id, e.reconciliation_id
		FROM cash_entries e JOIN members m ON m.id=e.member_id WHERE e.cash_account_id=$1 ORDER BY e.id DESC LIMIT 500) x`, id)
	if err != nil {
		return err
	}
	writeJSON(w, 200, raw)
	return nil
}

// POST /api/v1/treasurer/cash/opening {cash_account_id, amount, medium, reason} — 開始釣銭
func (a *App) handleOpeningCash(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var in struct {
		CashAccountID string `json:"cash_account_id"`
		Amount        int    `json:"amount"`
		Medium        string `json:"medium"`
		Reason        string `json:"reason"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if !isUUID(in.CashAccountID) || in.Amount <= 0 {
		return badRequest("保管先と金額を指定してください")
	}
	if in.Medium == "" {
		in.Medium = "cash"
	}
	if in.Medium != "cash" && in.Medium != "voucher" {
		return badRequest("種類の指定が正しくありません")
	}
	if in.Reason == "" {
		in.Reason = "開始釣銭"
	}
	ctx := r.Context()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO cash_entries(cash_account_id, medium, kind, amount, member_id, reason) VALUES ($1,$2,'opening',$3,$4,$5)`,
			in.CashAccountID, in.Medium, in.Amount, s.ID, in.Reason); err != nil {
			return err
		}
		if err := audit(ctx, tx, s, "cash.opening", "cash_account", in.CashAccountID, in); err != nil {
			return err
		}
		if err := publish(ctx, tx, "cash"); err != nil {
			return err
		}
		writeJSON(w, 201, map[string]any{"ok": true})
		return nil
	})
}

// ---------------------------------------------------------------
// 引継ぎ・回収（送付側の申請 → 受取側の確認で確定）
// ---------------------------------------------------------------

// POST /api/v1/staff/cash/transfers (Idempotency-Key 必須) {from_account_id, to_account_id, amount, medium, kind, reason}
func (a *App) handleRequestTransfer(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var in struct {
		FromAccountID string `json:"from_account_id"`
		ToAccountID   string `json:"to_account_id"`
		Amount        int    `json:"amount"`
		Medium        string `json:"medium"`
		Kind          string `json:"kind"`
		Reason        string `json:"reason"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if !isUUID(in.FromAccountID) || !isUUID(in.ToAccountID) || in.FromAccountID == in.ToAccountID {
		return badRequest("移動元と移動先を指定してください")
	}
	if in.Amount <= 0 {
		return badRequest("金額は1円以上にしてください")
	}
	if in.Medium == "" {
		in.Medium = "cash"
	}
	if in.Kind == "" {
		in.Kind = "handover"
	}
	if (in.Medium != "cash" && in.Medium != "voucher") || (in.Kind != "handover" && in.Kind != "collection") {
		return badRequest("種類の指定が正しくありません")
	}
	ctx := r.Context()
	var id string
	err := a.withTx(ctx, func(tx *sql.Tx) error {
		var fromOwner, toOwner sql.NullString
		var fromKind, toKind string
		if err := tx.QueryRowContext(ctx, `SELECT member_id, kind FROM cash_accounts WHERE id=$1 AND active`, in.FromAccountID).Scan(&fromOwner, &fromKind); err != nil {
			return err
		}
		if err := tx.QueryRowContext(ctx, `SELECT member_id, kind FROM cash_accounts WHERE id=$1 AND active`, in.ToAccountID).Scan(&toOwner, &toKind); err != nil {
			return err
		}
		// 自分の財布か、責任者なら任意の保管先から申請できる
		if !s.Has("treasurer", "admin") && !(fromKind == "wallet" && fromOwner.String == s.ID) && fromKind != "register" {
			return forbidden("自分の財布または共用レジからのみ申請できます")
		}
		if toKind == "safe" {
			in.Kind = "collection"
		}
		var bal int
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(sum(amount),0) FROM cash_entries WHERE cash_account_id=$1 AND medium=$2`,
			in.FromAccountID, in.Medium).Scan(&bal); err != nil {
			return err
		}
		var pendingOut int
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(sum(amount),0) FROM cash_transfers WHERE from_account_id=$1 AND medium=$2 AND status='pending'`,
			in.FromAccountID, in.Medium).Scan(&pendingOut); err != nil {
			return err
		}
		if in.Amount > bal-pendingOut {
			return unprocessable("insufficient_balance", "理論残高（%d円、申請中%d円）を超える金額は移動できません", bal, pendingOut)
		}
		if err := tx.QueryRowContext(ctx, `INSERT INTO cash_transfers(kind, from_account_id, to_account_id, medium, amount, reason, requested_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, in.Kind, in.FromAccountID, in.ToAccountID, in.Medium, in.Amount, in.Reason, s.ID).Scan(&id); err != nil {
			return err
		}
		// 受取側に通知
		if toOwner.Valid {
			if err := notify(ctx, tx, toOwner.String, "cash_transfer", "現金の受け取り確認", fmt.Sprintf("%sさんから%d円の引継ぎ申請があります", s.Name, in.Amount), "/staff/cash"); err != nil {
				return err
			}
		} else {
			if _, err := tx.ExecContext(ctx, `INSERT INTO notifications(member_id, kind, title, body, link)
				SELECT DISTINCT member_id, 'cash_transfer', '現金の受け取り確認', $1, '/staff/cash' FROM member_roles WHERE role='treasurer'`,
				fmt.Sprintf("%sさんから%d円の回収申請があります", s.Name, in.Amount)); err != nil {
				return err
			}
		}
		if err := audit(ctx, tx, s, "cash.transfer_request", "cash_transfer", id, in); err != nil {
			return err
		}
		return publish(ctx, tx, "cash")
	})
	if err != nil {
		return err
	}
	writeJSON(w, 201, map[string]any{"id": id})
	return nil
}

// GET /api/v1/staff/cash/transfers?status=pending
func (a *App) handleListTransfers(w http.ResponseWriter, r *http.Request, s *Staff) error {
	status := r.URL.Query().Get("status")
	all := s.Has("treasurer", "admin")
	raw, err := queryRaw(r.Context(), a.DB, `SELECT COALESCE(json_agg(x ORDER BY x.created_at DESC), '[]') FROM (
		SELECT t.id, t.kind, t.medium, t.amount, t.status, t.reason, t.created_at, t.decided_at,
		  t.from_account_id, fa.name AS from_name, t.to_account_id, ta.name AS to_name,
		  rm.name AS requested_by_name, dm.name AS decided_by_name,
		  ( (ta.kind='wallet' AND ta.member_id=$3) OR (ta.kind IN ('safe','register') AND $2) ) AS can_confirm,
		  (t.requested_by=$3) AS can_cancel
		FROM cash_transfers t JOIN cash_accounts fa ON fa.id=t.from_account_id JOIN cash_accounts ta ON ta.id=t.to_account_id
		JOIN members rm ON rm.id=t.requested_by LEFT JOIN members dm ON dm.id=t.decided_by
		WHERE ($1='' OR t.status=$1) AND ($2 OR fa.member_id=$3 OR ta.member_id=$3 OR t.requested_by=$3)
		ORDER BY t.created_at DESC LIMIT 300) x`, status, all, s.ID)
	if err != nil {
		return err
	}
	writeJSON(w, 200, raw)
	return nil
}

// POST /api/v1/staff/cash/transfers/{id}/decide {action: confirm|reject|cancel, reason}
// 確定時に移動元・移動先の明細を同時に作るため、全体の現金総額は変わらない。
func (a *App) handleDecideTransfer(w http.ResponseWriter, r *http.Request, s *Staff) error {
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
		var from, to, medium, status, requestedBy, toKind string
		var toOwner sql.NullString
		var amount int
		if err := tx.QueryRowContext(ctx, `SELECT t.from_account_id, t.to_account_id, t.medium, t.amount, t.status, t.requested_by, ta.kind, ta.member_id
			FROM cash_transfers t JOIN cash_accounts ta ON ta.id=t.to_account_id WHERE t.id=$1 FOR UPDATE OF t`, id).
			Scan(&from, &to, &medium, &amount, &status, &requestedBy, &toKind, &toOwner); err != nil {
			return err
		}
		if status != "pending" {
			return conflict("decided", "この申請は処理済みです")
		}
		canConfirm := (toKind == "wallet" && toOwner.String == s.ID) || (toKind != "wallet" && s.Has("treasurer", "admin"))
		switch in.Action {
		case "confirm":
			if !canConfirm {
				return forbidden("受取側の担当者のみ確認できます")
			}
			if requestedBy == s.ID && toKind != "wallet" && !s.Has("admin") {
				// 自分で申請した回収を自分で確認するのは原則避ける（責任者が一人の場合は管理者権限で可）
				return forbidden("自分の申請は別の責任者が確認してください")
			}
			var bal int
			if err := tx.QueryRowContext(ctx, `SELECT COALESCE(sum(amount),0) FROM cash_entries WHERE cash_account_id=$1 AND medium=$2`, from, medium).Scan(&bal); err != nil {
				return err
			}
			if amount > bal {
				return unprocessable("insufficient_balance", "移動元の理論残高（%d円）が不足しています", bal)
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO cash_entries(cash_account_id, medium, kind, amount, transfer_id, member_id, reason)
				VALUES ($1,$3,'transfer_out',$4,$5,$6,$7), ($2,$3,'transfer_in',$8,$5,$6,$7)`, from, to, medium, -amount, id, s.ID, in.Reason, amount); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE cash_transfers SET status='confirmed', decided_by=$2, decided_at=now(), updated_at=now() WHERE id=$1`, id, s.ID); err != nil {
				return err
			}
			if err := notify(ctx, tx, requestedBy, "cash_transfer", "引継ぎが確定しました", fmt.Sprintf("%d円の移動が%sさんに確認されました", amount, s.Name), "/staff/cash"); err != nil {
				return err
			}
		case "reject":
			if !canConfirm {
				return forbidden("受取側の担当者のみ差し戻せます")
			}
			if err := requireText("差し戻し理由", in.Reason, 200); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE cash_transfers SET status='rejected', decided_by=$2, decided_at=now(), updated_at=now(),
				reason=reason || ' / 差し戻し: ' || $3 WHERE id=$1`, id, s.ID, in.Reason); err != nil {
				return err
			}
			if err := notify(ctx, tx, requestedBy, "cash_transfer", "引継ぎが差し戻されました", in.Reason, "/staff/cash"); err != nil {
				return err
			}
		case "cancel":
			if requestedBy != s.ID && !s.Has("admin") {
				return forbidden("申請者のみ取り下げできます")
			}
			if _, err := tx.ExecContext(ctx, `UPDATE cash_transfers SET status='cancelled', decided_by=$2, decided_at=now(), updated_at=now() WHERE id=$1`, id, s.ID); err != nil {
				return err
			}
		default:
			return badRequest("操作が正しくありません")
		}
		if err := audit(ctx, tx, s, "cash.transfer_"+in.Action, "cash_transfer", id, in); err != nil {
			return err
		}
		if err := publish(ctx, tx, "cash"); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return nil
	})
}

// ---------------------------------------------------------------
// 締め精算
// ---------------------------------------------------------------

// POST /api/v1/treasurer/cash/reconciliations {cash_account_id, medium, actual_balance, counted_by, note}
// 実残高・理論残高・差額・確認者を保存し、差額を調整明細として記録する。
func (a *App) handleReconcile(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var in struct {
		CashAccountID string `json:"cash_account_id"`
		Medium        string `json:"medium"`
		ActualBalance int    `json:"actual_balance"`
		CountedBy     string `json:"counted_by"`
		Note          string `json:"note"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if !isUUID(in.CashAccountID) || in.ActualBalance < 0 {
		return badRequest("保管先と実残高を指定してください")
	}
	if in.Medium == "" {
		in.Medium = "cash"
	}
	if in.CountedBy == "" {
		in.CountedBy = s.ID
	}
	if !isUUID(in.CountedBy) {
		return badRequest("数えた人を指定してください")
	}
	ctx := r.Context()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `SELECT 1 FROM cash_accounts WHERE id=$1 FOR UPDATE`, in.CashAccountID); err != nil {
			return err
		}
		var pending int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM cash_transfers WHERE status='pending' AND (from_account_id=$1 OR to_account_id=$1)`,
			in.CashAccountID).Scan(&pending); err != nil {
			return err
		}
		if pending > 0 {
			return unprocessable("pending_transfers", "未確定の引継ぎが%d件あります。先に確定または取り下げてください", pending)
		}
		var theo int
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(sum(amount),0) FROM cash_entries WHERE cash_account_id=$1 AND medium=$2`,
			in.CashAccountID, in.Medium).Scan(&theo); err != nil {
			return err
		}
		diff := in.ActualBalance - theo
		if diff != 0 && strings.TrimSpace(in.Note) == "" {
			return badRequest("差額（%+d円）があるため、メモを入力してください", diff)
		}
		var id string
		if err := tx.QueryRowContext(ctx, `INSERT INTO cash_reconciliations(cash_account_id, medium, theoretical_balance, actual_balance, difference,
			note, counted_by, confirmed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, in.CashAccountID, in.Medium, theo, in.ActualBalance,
			diff, in.Note, in.CountedBy, s.ID).Scan(&id); err != nil {
			return err
		}
		if diff != 0 {
			if _, err := tx.ExecContext(ctx, `INSERT INTO cash_entries(cash_account_id, medium, kind, amount, reconciliation_id, member_id, reason)
				VALUES ($1,$2,'adjustment',$3,$4,$5,$6)`, in.CashAccountID, in.Medium, diff, id, s.ID, "精算差額: "+in.Note); err != nil {
				return err
			}
		}
		if err := audit(ctx, tx, s, "cash.reconcile", "cash_account", in.CashAccountID, map[string]any{"theoretical": theo, "actual": in.ActualBalance, "difference": diff, "note": in.Note}); err != nil {
			return err
		}
		if err := publish(ctx, tx, "cash"); err != nil {
			return err
		}
		writeJSON(w, 201, map[string]any{"id": id, "theoretical_balance": theo, "actual_balance": in.ActualBalance, "difference": diff})
		return nil
	})
}

func (a *App) handleListReconciliations(w http.ResponseWriter, r *http.Request, s *Staff) error {
	raw, err := queryRaw(r.Context(), a.DB, `SELECT COALESCE(json_agg(x ORDER BY x.created_at DESC), '[]') FROM (
		SELECT rc.id, rc.medium, rc.theoretical_balance, rc.actual_balance, rc.difference, rc.note, rc.created_at,
		  c.name AS account_name, cm.name AS counted_by_name, fm.name AS confirmed_by_name
		FROM cash_reconciliations rc JOIN cash_accounts c ON c.id=rc.cash_account_id
		JOIN members cm ON cm.id=rc.counted_by JOIN members fm ON fm.id=rc.confirmed_by ORDER BY rc.created_at DESC LIMIT 300) x`)
	if err != nil {
		return err
	}
	writeJSON(w, 200, raw)
	return nil
}

// ---------------------------------------------------------------
// 売上集計
// ---------------------------------------------------------------

// GET /api/v1/treasurer/sales?from=&to=&group=day|department|product|hour|cashier[&format=csv]
// 注文数・数量・値引前金額・値引額・入金・返金・未払いを区別する。釣銭や引継ぎは含めない。
func (a *App) handleSales(w http.ResponseWriter, r *http.Request, s *Staff) error {
	from, err := queryDate(r, "from")
	if err != nil {
		return err
	}
	to, err := queryDate(r, "to")
	if err != nil {
		return err
	}
	group := r.URL.Query().Get("group")
	var key, label string
	switch group {
	case "", "day":
		group, key, label = "day", "o.business_day::text", "営業日"
	case "department":
		key, label = "d.name", "部門"
	case "product":
		key, label = "i.product_name || CASE WHEN i.options_label<>'' THEN '（' || i.options_label || '）' ELSE '' END", "商品"
	case "hour":
		key, label = "to_char(o.created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:00')", "時間帯"
	case "cashier":
		key, label = "COALESCE((SELECT m.name FROM payments p JOIN members m ON m.id=p.member_id WHERE p.order_id=o.id AND p.status='completed'), '（未払い）')", "入金担当者"
	default:
		return badRequest("集計単位が正しくありません")
	}
	// 明細単位で集計。返金は注文単位のため、注文の最初の明細の行（商品別なら最初の商品）に1回だけ計上する。
	rows, err := a.DB.QueryContext(r.Context(), `
		WITH base AS (
		  SELECT o.id AS order_id, `+key+` AS k, i.quantity, i.line_total, i.discount, o.payment_status, o.status,
		    row_number() OVER (PARTITION BY o.id ORDER BY i.sort_order, i.id) AS rn
		  FROM orders o JOIN order_items i ON i.order_id=o.id JOIN departments d ON d.id=o.department_id
		  WHERE NOT i.excluded AND (o.status<>'cancelled' OR o.payment_status<>'unpaid')
		)
		SELECT b.k,
		  count(DISTINCT b.order_id) AS orders,
		  sum(b.quantity) AS quantity,
		  sum(b.line_total) AS gross,
		  sum(b.discount) AS discount,
		  sum(CASE WHEN b.payment_status<>'unpaid' THEN b.line_total-b.discount ELSE 0 END) AS paid,
		  sum(CASE WHEN b.payment_status='unpaid' AND b.status='accepted' THEN b.line_total-b.discount ELSE 0 END) AS unpaid,
		  COALESCE(sum(CASE WHEN b.rn=1 THEN (SELECT COALESCE(sum(rf.amount),0) FROM refunds rf WHERE rf.order_id=b.order_id) ELSE 0 END),0) AS refunded
		FROM base b JOIN orders o ON o.id=b.order_id
		WHERE ($1='' OR o.business_day >= $1::date) AND ($2='' OR o.business_day <= $2::date)
		GROUP BY b.k ORDER BY b.k`, from, to)
	if err != nil {
		return err
	}
	defer rows.Close()
	type rowT struct {
		Key      string `json:"key"`
		Orders   int    `json:"orders"`
		Quantity int    `json:"quantity"`
		Gross    int    `json:"gross"`
		Discount int    `json:"discount"`
		Paid     int    `json:"paid"`
		Unpaid   int    `json:"unpaid"`
		Refunded int    `json:"refunded"`
		Net      int    `json:"net"`
	}
	out := []rowT{}
	var tot rowT
	tot.Key = "合計"
	for rows.Next() {
		var x rowT
		if err := rows.Scan(&x.Key, &x.Orders, &x.Quantity, &x.Gross, &x.Discount, &x.Paid, &x.Unpaid, &x.Refunded); err != nil {
			return err
		}
		x.Net = x.Paid - x.Refunded
		out = append(out, x)
		tot.Quantity += x.Quantity
		tot.Gross += x.Gross
		tot.Discount += x.Discount
		tot.Paid += x.Paid
		tot.Unpaid += x.Unpaid
		tot.Refunded += x.Refunded
		tot.Net += x.Net
	}
	if err := rows.Err(); err != nil {
		return err
	}
	// 合計の注文数は行と同じ条件で数える（同じ注文が複数行に出ても1件）
	a.DB.QueryRowContext(r.Context(), `SELECT count(DISTINCT o.id) FROM orders o JOIN order_items i ON i.order_id=o.id
		WHERE NOT i.excluded AND (o.status<>'cancelled' OR o.payment_status<>'unpaid')
		AND ($1='' OR o.business_day >= $1::date) AND ($2='' OR o.business_day <= $2::date)`, from, to).Scan(&tot.Orders)

	if r.URL.Query().Get("format") == "csv" {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="sales_%s.csv"`, group))
		w.Write([]byte("\xEF\xBB\xBF")) // Excel向けBOM
		cw := csv.NewWriter(w)
		cw.Write([]string{label, "注文数", "数量", "値引前金額", "値引額", "入金", "返金", "純売上", "未払い"})
		for _, x := range append(out, tot) {
			cw.Write([]string{x.Key, strconv.Itoa(x.Orders), strconv.Itoa(x.Quantity), strconv.Itoa(x.Gross), strconv.Itoa(x.Discount),
				strconv.Itoa(x.Paid), strconv.Itoa(x.Refunded), strconv.Itoa(x.Net), strconv.Itoa(x.Unpaid)})
		}
		cw.Flush()
		return nil
	}
	writeJSON(w, 200, map[string]any{"group": group, "label": label, "rows": out, "total": tot})
	return nil
}

var _ = json.Marshal
