package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

type itemReq struct {
	VariantID string `json:"variant_id"`
	Quantity  int    `json:"quantity"`
}

type pricedItem struct {
	VariantID    string          `json:"variant_id"`
	ProductID    string          `json:"product_id"`
	ProductName  string          `json:"product_name"`
	OptionsLabel string          `json:"options_label"`
	OptionsJSON  json.RawMessage `json:"options"`
	UnitPrice    int             `json:"unit_price"`
	Quantity     int             `json:"quantity"`
	LineTotal    int             `json:"line_total"`
	NeedsCooking bool            `json:"needs_cooking"`
}

// priceItems はAPI側で価格・販売状態を検証して明細を確定する。
// lock=true のとき対象バリエーションを FOR SHARE でロックし、売り切れ切替との競合でも一貫させる。
func priceItems(ctx context.Context, q queryer, deptID string, reqs []itemReq, public, lock bool, maxQty int) ([]pricedItem, int, error) {
	if len(reqs) == 0 {
		return nil, 0, badRequest("商品を選んでください")
	}
	total := 0
	qty := 0
	merged := map[string]int{}
	var order []string
	for _, it := range reqs {
		if !isUUID(it.VariantID) {
			return nil, 0, badRequest("商品の指定が正しくありません")
		}
		if it.Quantity <= 0 || it.Quantity > 99 {
			return nil, 0, badRequest("数量が正しくありません")
		}
		id := strings.ToLower(it.VariantID)
		if _, ok := merged[id]; !ok {
			order = append(order, id)
		}
		merged[id] += it.Quantity
		qty += it.Quantity
	}
	if maxQty > 0 && qty > maxQty {
		return nil, 0, unprocessable("too_many_items", "1回の注文は合計%d個までです", maxQty)
	}
	lockSQL := ""
	if lock {
		lockSQL = " FOR SHARE OF pv"
	}
	out := make([]pricedItem, 0, len(order))
	for _, id := range order {
		var p pricedItem
		var dept, vis, pvis, status string
		var active, pactive, optsOK bool
		err := q.QueryRowContext(ctx, `SELECT pv.id, p.id, p.name, p.department_id, pv.price, pv.sale_status, pv.visibility, p.visibility,
			pv.active, p.active, p.needs_cooking,
			COALESCE((SELECT string_agg(ov.name, ' / ' ORDER BY og.sort_order, og.name) FROM product_variant_options o
			  JOIN option_values ov ON ov.id=o.value_id JOIN option_groups og ON og.id=ov.group_id WHERE o.variant_id=pv.id), ''),
			COALESCE((SELECT json_agg(json_build_object('group',og.name,'value',ov.name,'value_id',ov.id) ORDER BY og.sort_order, og.name)
			  FROM product_variant_options o JOIN option_values ov ON ov.id=o.value_id JOIN option_groups og ON og.id=ov.group_id
			  WHERE o.variant_id=pv.id), '[]'),
			NOT EXISTS (SELECT 1 FROM product_variant_options o JOIN option_values ov ON ov.id=o.value_id
			  JOIN option_groups og ON og.id=ov.group_id WHERE o.variant_id=pv.id AND (NOT ov.active OR NOT og.active))
			FROM product_variants pv JOIN products p ON p.id=pv.product_id WHERE pv.id=$1`+lockSQL, id).
			Scan(&p.VariantID, &p.ProductID, &p.ProductName, &dept, &p.UnitPrice, &status, &vis, &pvis, &active, &pactive,
				&p.NeedsCooking, &p.OptionsLabel, &p.OptionsJSON, &optsOK)
		if err == sql.ErrNoRows || (err == nil && dept != deptID) {
			return nil, 0, unprocessable("invalid_item", "選択された商品は注文できません")
		}
		if err != nil {
			return nil, 0, err
		}
		name := p.ProductName
		if p.OptionsLabel != "" {
			name += "（" + p.OptionsLabel + "）"
		}
		if !active || !pactive || !optsOK || (public && (vis != "public" || pvis != "public")) {
			return nil, 0, unprocessable("item_unavailable", "%sは現在販売していません", name)
		}
		switch status {
		case "sold_out":
			return nil, 0, unprocessable("sold_out", "%sは売り切れです", name)
		case "stopped":
			return nil, 0, unprocessable("item_stopped", "%sは販売を停止しています", name)
		}
		p.Quantity = merged[id]
		p.LineTotal = p.UnitPrice * p.Quantity
		total += p.LineTotal
		out = append(out, p)
	}
	return out, total, nil
}

// POST /api/v1/public/orders/quote {department_id, items}
func (a *App) handleQuote(w http.ResponseWriter, r *http.Request) error {
	if err := a.rateLimit(r, "quote", 60, 30); err != nil {
		return err
	}
	var in struct {
		DepartmentID string    `json:"department_id"`
		Items        []itemReq `json:"items"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if !isUUID(in.DepartmentID) {
		return badRequest("部門を指定してください")
	}
	ctx := r.Context()
	l, err := a.limits(ctx, a.DB)
	if err != nil {
		return err
	}
	items, total, err := priceItems(ctx, a.DB, in.DepartmentID, in.Items, true, false, l.MaxItemsPerOrder)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"items": items, "subtotal": total})
	return nil
}

func (a *App) nextCallNumber(ctx context.Context, tx *sql.Tx, deptID, day string) (int, error) {
	var n int
	err := tx.QueryRowContext(ctx, `INSERT INTO order_counters(department_id, business_day, last_number) VALUES ($1,$2,1)
		ON CONFLICT (department_id, business_day) DO UPDATE SET last_number = order_counters.last_number + 1
		RETURNING last_number`, deptID, day).Scan(&n)
	return n, err
}

func insertOrderItems(ctx context.Context, tx *sql.Tx, orderID string, items []pricedItem) error {
	for i, it := range items {
		cook := "not_required"
		if it.NeedsCooking {
			cook = "waiting"
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO order_items(order_id, variant_id, product_id, product_name, options_label, options_json,
			unit_price, quantity, line_total, needs_cooking, cook_status, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			orderID, it.VariantID, it.ProductID, it.ProductName, it.OptionsLabel, []byte(it.OptionsJSON), it.UnitPrice, it.Quantity,
			it.LineTotal, it.NeedsCooking, cook, i); err != nil {
			return err
		}
	}
	return nil
}

// POST /api/v1/public/orders  (Idempotency-Key 必須)
// {department_id, items, site_code, channel}
func (a *App) handlePublicCreateOrder(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		DepartmentID string    `json:"department_id"`
		Items        []itemReq `json:"items"`
		SiteCode     string    `json:"site_code"`
		Channel      string    `json:"channel"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if !isUUID(in.DepartmentID) {
		return badRequest("部門を指定してください")
	}
	ctx := r.Context()
	l, err := a.limits(ctx, a.DB)
	if err != nil {
		return err
	}
	if err := a.rateLimit(r, "order", float64(l.OrdersPerMinute), float64(l.OrdersPerMinute)); err != nil {
		return err
	}
	client, err := a.resolveClient(ctx, w, r)
	if err != nil {
		return err
	}
	channel := "web"
	switch in.Channel {
	case "", "web":
	case "appclip", "ios", "android":
		channel = in.Channel
	default:
		return badRequest("注文経路が正しくありません")
	}
	if err := checkBlocked(ctx, a.DB, client.ID, "order"); err != nil {
		return err
	}

	// 現地コードの確認（失敗回数制限つき）
	d, err := a.getDept(ctx, a.DB, in.DepartmentID, false)
	if err != nil {
		return err
	}
	if d.SiteCodeEnabled {
		subject := client.ID
		fails, err := a.countFailures(ctx, a.DB, "site_code", subject, time.Duration(l.SiteCodeFailWindowMin)*time.Minute)
		if err != nil {
			return err
		}
		ipSubject := "ip:" + hashToken("ip", clientIP(r, a.Cfg.TrustProxy))
		ipFails, err := a.countFailures(ctx, a.DB, "site_code", ipSubject, time.Duration(l.SiteCodeFailWindowMin)*time.Minute)
		if err != nil {
			return err
		}
		if fails >= l.SiteCodeFailLimit || ipFails >= l.SiteCodeFailLimit*4 {
			return errf(429, "site_code_locked", "確認コードの入力ミスが続いたため、しばらく注文できません。スタッフにお声がけください")
		}
		if !a.verifySiteCode(d, in.SiteCode, a.Now()) {
			a.recordAttempt(ctx, a.DB, "site_code", subject, false)
			a.recordAttempt(ctx, a.DB, "site_code", ipSubject, false)
			return unprocessable("site_code_invalid", "確認コードが違います。会場の画面に表示されている3桁の数字を入力してください")
		}
		a.recordAttempt(ctx, a.DB, "site_code", subject, true)
	}

	token := randomToken()
	var orderID string
	var callNo, total int
	err = a.withTx(ctx, func(tx *sql.Tx) error {
		// 確定直前に受付可否を再検証（部門行を共有ロック）
		d, err := a.getDept(ctx, tx, in.DepartmentID, true)
		if err != nil {
			return err
		}
		if d.BusinessStatus != "open" {
			return unprocessable("not_open", "現在、注文を受け付けていません")
		}
		if !d.MobileOrderEnabled {
			return unprocessable("mobile_order_off", "現在、スマートフォンからの注文を受け付けていません。店頭でご注文ください")
		}
		if err := checkBlocked(ctx, tx, client.ID, "order"); err != nil {
			return err
		}
		// 未払い注文数の上限（同じ識別の同時注文を直列化するため識別行をロック）
		if _, err := tx.ExecContext(ctx, `SELECT 1 FROM client_identities WHERE id=$1 FOR UPDATE`, client.ID); err != nil {
			return err
		}
		var unpaid int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM orders WHERE client_identity_id=$1 AND status='accepted' AND payment_status='unpaid'`,
			client.ID).Scan(&unpaid); err != nil {
			return err
		}
		if unpaid >= l.MaxUnpaidOrders {
			return unprocessable("too_many_unpaid", "お支払いが済んでいない注文があります。先に店頭でお支払いください")
		}
		items, sub, err := priceItems(ctx, tx, in.DepartmentID, in.Items, true, true, l.MaxItemsPerOrder)
		if err != nil {
			return err
		}
		day := a.today()
		callNo, err = a.nextCallNumber(ctx, tx, in.DepartmentID, day)
		if err != nil {
			return err
		}
		total = sub
		if err := tx.QueryRowContext(ctx, `INSERT INTO orders(department_id, business_day, call_number, channel, client_identity_id,
			access_token_hash, subtotal, total) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id`,
			in.DepartmentID, day, callNo, channel, client.ID, hashToken("order", token), sub).Scan(&orderID); err != nil {
			return err
		}
		if err := insertOrderItems(ctx, tx, orderID, items); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO order_events(order_id, kind, to_state) VALUES ($1,'create','accepted')`, orderID); err != nil {
			return err
		}
		return publish(ctx, tx, "orders:"+in.DepartmentID)
	})
	if err != nil {
		return err
	}
	writeJSON(w, 201, map[string]any{"id": orderID, "call_number": callNo, "total": total, "access_token": token,
		"status_url": a.Cfg.PublicBaseURL + "/o/" + token})
	return nil
}

// orderJSON は注文の詳細（明細・支払・クーポン利用を含む）をJSONで返す。
func orderJSON(ctx context.Context, q queryer, where string, arg any, staffView bool) (json.RawMessage, error) {
	staffCols := ""
	if staffView {
		staffCols = `,
		  o.client_identity_id IS NOT NULL AS has_client_identity,
		  (SELECT name FROM members WHERE id=o.created_by) AS created_by_name,
		  (SELECT name FROM members WHERE id=o.handed_by) AS handed_by_name,
		  o.cancel_reason, o.unpaid_handoff_reason,
		  COALESCE((SELECT json_agg(json_build_object('id',p.id,'amount',p.amount,'cash_received',p.cash_received,
		    'voucher_received',p.voucher_received,'change_given',p.change_given,'created_at',p.created_at,
		    'member_name',(SELECT name FROM members WHERE id=p.member_id),
		    'cash_account_name',(SELECT name FROM cash_accounts WHERE id=p.cash_account_id),
		    'refunded',(SELECT COALESCE(sum(amount),0) FROM refunds WHERE payment_id=p.id)) ORDER BY p.created_at)
		    FROM payments p WHERE p.order_id=o.id AND p.status='completed'), '[]') AS payments,
		  COALESCE((SELECT json_agg(json_build_object('id',rf.id,'amount',rf.amount,'reason',rf.reason,'created_at',rf.created_at,
		    'member_name',(SELECT name FROM members WHERE id=rf.member_id)) ORDER BY rf.created_at)
		    FROM refunds rf WHERE rf.order_id=o.id), '[]') AS refunds,
		  COALESCE((SELECT json_agg(json_build_object('id',e.id,'kind',e.kind,'from',e.from_state,'to',e.to_state,'reason',e.reason,
		    'created_at',e.created_at,'member_name',(SELECT name FROM members WHERE id=e.member_id)) ORDER BY e.id)
		    FROM order_events e WHERE e.order_id=o.id), '[]') AS events`
	}
	return queryRaw(ctx, q, `SELECT row_to_json(x) FROM (
		SELECT o.id, o.department_id, d.name AS department_name, o.business_day, o.call_number, o.channel, o.status,
		  o.payment_status, o.handoff_status, o.subtotal, o.discount, o.total, o.created_at, o.handed_at,
		  COALESCE((SELECT json_agg(json_build_object('id',i.id,'product_name',i.product_name,'options_label',i.options_label,
		    'unit_price',i.unit_price,'quantity',i.quantity,'line_total',i.line_total,'discount',i.discount,
		    'needs_cooking',i.needs_cooking,'cook_status',i.cook_status,'variant_id',i.variant_id,'product_id',i.product_id) ORDER BY i.sort_order)
		    FROM order_items i WHERE i.order_id=o.id), '[]') AS items,
		  COALESCE((SELECT json_agg(json_build_object('id',cr.id,'coupon_no',ic.public_no,'name',ic.snapshot->>'name',
		    'persons',cr.persons,'discount',cr.discount,'status',cr.status,'forfeited_persons',cr.forfeited_persons))
		    FROM coupon_redemptions cr JOIN issued_coupons ic ON ic.id=cr.issued_coupon_id WHERE cr.order_id=o.id), '[]') AS coupons,
		  (o.status='accepted' AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.cook_status IN ('waiting','cooking'))
		    AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.cook_status <> 'cancelled')) AS ready
		  `+staffCols+`
		FROM orders o JOIN departments d ON d.id=o.department_id WHERE `+where+`) x`, arg)
}

func (a *App) orderIDByToken(ctx context.Context, token string) (string, error) {
	var id string
	err := a.DB.QueryRowContext(ctx, `SELECT id FROM orders WHERE access_token_hash=$1`, hashToken("order", token)).Scan(&id)
	if err == sql.ErrNoRows {
		return "", notFound("注文")
	}
	return id, err
}

// GET /api/v1/public/orders/by-token/{token}
func (a *App) handlePublicGetOrder(w http.ResponseWriter, r *http.Request) error {
	if err := a.rateLimit(r, "order_view", 120, 60); err != nil {
		return err
	}
	id, err := a.orderIDByToken(r.Context(), r.PathValue("token"))
	if err != nil {
		return err
	}
	raw, err := orderJSON(r.Context(), a.DB, "o.id=$1", id, false)
	if err != nil {
		return err
	}
	writeJSON(w, 200, raw)
	return nil
}

// POST /api/v1/public/orders/by-token/{token}/cancel
// 来場者は調理開始前・未払いの注文のみ取消できる（仮案）。
func (a *App) handlePublicCancelOrder(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	id, err := a.orderIDByToken(ctx, r.PathValue("token"))
	if err != nil {
		return err
	}
	return a.withTx(ctx, func(tx *sql.Tx) error {
		var status, pay, dept string
		if err := tx.QueryRowContext(ctx, `SELECT status, payment_status, department_id FROM orders WHERE id=$1 FOR UPDATE`, id).Scan(&status, &pay, &dept); err != nil {
			return err
		}
		if status != "accepted" {
			return conflict("not_cancellable", "この注文は取り消せません")
		}
		if pay != "unpaid" {
			return conflict("paid", "お支払い済みの注文はスタッフにお申し出ください")
		}
		var started bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM order_items WHERE order_id=$1 AND cook_status IN ('cooking','cooked'))`, id).Scan(&started); err != nil {
			return err
		}
		if started {
			return conflict("cooking_started", "調理が始まっているため、取消はスタッフにお申し出ください")
		}
		if err := cancelOrderTx(ctx, tx, id, nil, "来場者による取消"); err != nil {
			return err
		}
		if err := publish(ctx, tx, "orders:"+dept); err != nil {
			return err
		}
		raw, err := orderJSON(ctx, tx, "o.id=$1", id, false)
		if err != nil {
			return err
		}
		writeJSON(w, 200, raw)
		return nil
	})
}

func cancelOrderTx(ctx context.Context, tx *sql.Tx, orderID string, s *Staff, reason string) error {
	var memberID any
	if s != nil {
		memberID = s.ID
	}
	if _, err := tx.ExecContext(ctx, `UPDATE orders SET status='cancelled', cancelled_by=$2, cancel_reason=$3, updated_at=now() WHERE id=$1`,
		orderID, memberID, reason); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE order_items SET cook_status='cancelled', updated_at=now() WHERE order_id=$1 AND cook_status<>'cancelled'`, orderID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO order_events(order_id, kind, from_state, to_state, member_id, reason) VALUES ($1,'cancel','accepted','cancelled',$2,$3)`,
		orderID, memberID, reason)
	return err
}

// ---------------------------------------------------------------
// スタッフ
// ---------------------------------------------------------------

// POST /api/v1/staff/orders (Idempotency-Key 必須) {department_id, items}
func (a *App) handleStaffCreateOrder(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var in struct {
		DepartmentID string    `json:"department_id"`
		Items        []itemReq `json:"items"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if !isUUID(in.DepartmentID) {
		return badRequest("部門を指定してください")
	}
	ctx := r.Context()
	var orderID string
	err := a.withTx(ctx, func(tx *sql.Tx) error {
		d, err := a.getDept(ctx, tx, in.DepartmentID, true)
		if err != nil {
			return err
		}
		if d.BusinessStatus != "open" {
			return unprocessable("not_open", "部門が営業中ではありません（現在：%s）", statusLabel(d.BusinessStatus))
		}
		items, sub, err := priceItems(ctx, tx, in.DepartmentID, in.Items, false, true, 0)
		if err != nil {
			return err
		}
		day := a.today()
		callNo, err := a.nextCallNumber(ctx, tx, in.DepartmentID, day)
		if err != nil {
			return err
		}
		if err := tx.QueryRowContext(ctx, `INSERT INTO orders(department_id, business_day, call_number, channel, subtotal, total, created_by)
			VALUES ($1,$2,$3,'staff',$4,$4,$5) RETURNING id`, in.DepartmentID, day, callNo, sub, s.ID).Scan(&orderID); err != nil {
			return err
		}
		if err := insertOrderItems(ctx, tx, orderID, items); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO order_events(order_id, kind, to_state, member_id) VALUES ($1,'create','accepted',$2)`, orderID, s.ID); err != nil {
			return err
		}
		return publish(ctx, tx, "orders:"+in.DepartmentID)
	})
	if err != nil {
		return err
	}
	raw, err := orderJSON(ctx, a.DB, "o.id=$1", orderID, true)
	if err != nil {
		return err
	}
	writeJSON(w, 201, raw)
	return nil
}

func statusLabel(s string) string {
	switch s {
	case "before":
		return "営業前"
	case "open":
		return "営業中"
	case "paused":
		return "一時停止"
	case "closed":
		return "営業終了"
	}
	return s
}

// GET /api/v1/staff/orders?department_id=&day=&filter=active|unpaid|ready|all&call_number=
func (a *App) handleStaffListOrders(w http.ResponseWriter, r *http.Request, s *Staff) error {
	q := r.URL.Query()
	dept := q.Get("department_id")
	if !isUUID(dept) {
		return badRequest("部門を指定してください")
	}
	day, err := queryDate(r, "day")
	if err != nil {
		return err
	}
	if day == "" {
		day = a.today()
	}
	filter := q.Get("filter")
	cond := ""
	switch filter {
	case "", "active":
		cond = " AND o.status='accepted'"
	case "unpaid":
		cond = " AND o.status='accepted' AND o.payment_status='unpaid'"
	case "ready":
		cond = ` AND o.status='accepted' AND o.handoff_status='pending'
		  AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.cook_status IN ('waiting','cooking'))
		  AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.cook_status<>'cancelled')`
	case "all":
	default:
		return badRequest("filter が正しくありません")
	}
	callNo := queryInt(r, "call_number", 0)
	l, err := a.limits(r.Context(), a.DB)
	if err != nil {
		return err
	}
	raw, err := queryRaw(r.Context(), a.DB, `SELECT COALESCE(json_agg(x ORDER BY x.call_number DESC), '[]') FROM (
		SELECT o.id, o.call_number, o.channel, o.status, o.payment_status, o.handoff_status, o.subtotal, o.discount, o.total, o.created_at,
		  EXTRACT(EPOCH FROM now()-o.created_at)::int AS elapsed_sec,
		  (o.payment_status='unpaid' AND o.created_at < now() - make_interval(mins => $4)) AS unpaid_warning,
		  COALESCE((SELECT json_agg(json_build_object('id',i.id,'product_name',i.product_name,'options_label',i.options_label,
		    'quantity',i.quantity,'line_total',i.line_total,'cook_status',i.cook_status) ORDER BY i.sort_order)
		    FROM order_items i WHERE i.order_id=o.id), '[]') AS items,
		  (o.status='accepted' AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.cook_status IN ('waiting','cooking'))
		    AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.cook_status <> 'cancelled')) AS ready
		FROM orders o WHERE o.department_id=$1 AND o.business_day=$2`+cond+` AND ($3=0 OR o.call_number=$3)
		ORDER BY o.call_number DESC LIMIT 500) x`, dept, day, callNo, l.UnpaidWarnMinutes)
	if err != nil {
		return err
	}
	writeJSON(w, 200, raw)
	return nil
}

// GET /api/v1/staff/orders/{id}
func (a *App) handleStaffGetOrder(w http.ResponseWriter, r *http.Request, s *Staff) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	raw, err := orderJSON(r.Context(), a.DB, "o.id=$1", id, true)
	if err != nil {
		return err
	}
	writeJSON(w, 200, raw)
	return nil
}

// POST /api/v1/staff/orders/{id}/cancel {reason}
// 取消は返金と分離する。支払済み注文の取消は会計責任者のみ（返金は別操作）。
func (a *App) handleStaffCancelOrder(w http.ResponseWriter, r *http.Request, s *Staff) error {
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
	if err := requireText("取消理由", in.Reason, 200); err != nil {
		return err
	}
	ctx := r.Context()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		var status, pay, handoff, dept string
		if err := tx.QueryRowContext(ctx, `SELECT status, payment_status, handoff_status, department_id FROM orders WHERE id=$1 FOR UPDATE`, id).
			Scan(&status, &pay, &handoff, &dept); err != nil {
			return err
		}
		if status != "accepted" {
			return conflict("not_cancellable", "この注文は取り消せない状態です")
		}
		if pay != "unpaid" && !s.Has("treasurer", "admin") {
			return forbidden("支払済み注文の取消は会計責任者のみ可能です")
		}
		if err := cancelOrderTx(ctx, tx, id, s, in.Reason); err != nil {
			return err
		}
		if err := audit(ctx, tx, s, "order.cancel", "order", id, map[string]any{"reason": in.Reason, "payment_status": pay}); err != nil {
			return err
		}
		if err := publish(ctx, tx, "orders:"+dept); err != nil {
			return err
		}
		raw, err := orderJSON(ctx, tx, "o.id=$1", id, true)
		if err != nil {
			return err
		}
		writeJSON(w, 200, raw)
		return nil
	})
}

// POST /api/v1/staff/orders/{id}/items/{item}/cancel {reason}
// 未払い注文の明細を取り消す（数量の途中分割は初期対象外）。
func (a *App) handleCancelOrderItem(w http.ResponseWriter, r *http.Request, s *Staff) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	itemID, err := pathID(r, "item")
	if err != nil {
		return err
	}
	var in struct {
		Reason string `json:"reason"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if err := requireText("理由", in.Reason, 200); err != nil {
		return err
	}
	ctx := r.Context()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		var status, pay, dept string
		if err := tx.QueryRowContext(ctx, `SELECT status, payment_status, department_id FROM orders WHERE id=$1 FOR UPDATE`, id).Scan(&status, &pay, &dept); err != nil {
			return err
		}
		if status != "accepted" || pay != "unpaid" {
			return conflict("not_editable", "支払前の注文のみ明細を取り消せます（支払後は返金で対応）")
		}
		var cook string
		var line int
		if err := tx.QueryRowContext(ctx, `SELECT cook_status, line_total FROM order_items WHERE id=$1 AND order_id=$2 FOR UPDATE`, itemID, id).Scan(&cook, &line); err != nil {
			return err
		}
		if cook == "cancelled" {
			return conflict("already_cancelled", "既に取り消されています")
		}
		if _, err := tx.ExecContext(ctx, `UPDATE order_items SET cook_status='cancelled', excluded=true, updated_at=now() WHERE id=$1`, itemID); err != nil {
			return err
		}
		var remaining int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM order_items WHERE order_id=$1 AND cook_status<>'cancelled'`, id).Scan(&remaining); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE orders SET subtotal=subtotal-$2, total=total-$2, updated_at=now() WHERE id=$1`, id, line); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO order_events(order_id, item_id, kind, from_state, to_state, member_id, reason)
			VALUES ($1,$2,'item_cancel',$3,'cancelled',$4,$5)`, id, itemID, cook, s.ID, in.Reason); err != nil {
			return err
		}
		if remaining == 0 {
			if err := cancelOrderTx(ctx, tx, id, s, "全明細取消: "+in.Reason); err != nil {
				return err
			}
		}
		if err := audit(ctx, tx, s, "order.item_cancel", "order", id, map[string]any{"item_id": itemID, "reason": in.Reason}); err != nil {
			return err
		}
		if err := publish(ctx, tx, "orders:"+dept); err != nil {
			return err
		}
		raw, err := orderJSON(ctx, tx, "o.id=$1", id, true)
		if err != nil {
			return err
		}
		writeJSON(w, 200, raw)
		return nil
	})
}

// ---------------------------------------------------------------
// キッチン
// ---------------------------------------------------------------

// GET /api/v1/staff/kitchen?department_id=
func (a *App) handleKitchen(w http.ResponseWriter, r *http.Request, s *Staff) error {
	dept := r.URL.Query().Get("department_id")
	if !isUUID(dept) {
		return badRequest("部門を指定してください")
	}
	l, err := a.limits(r.Context(), a.DB)
	if err != nil {
		return err
	}
	raw, err := queryRaw(r.Context(), a.DB, `SELECT COALESCE(json_agg(x ORDER BY x.created_at), '[]') FROM (
		SELECT o.id, o.call_number, o.payment_status, o.status, o.channel, o.created_at,
		  EXTRACT(EPOCH FROM now()-o.created_at)::int AS elapsed_sec,
		  (o.created_at < now() - make_interval(mins => $3)) AS long_wait,
		  (o.payment_status='unpaid' AND o.created_at < now() - make_interval(mins => $4)) AS unpaid_warning,
		  COALESCE((SELECT json_agg(json_build_object('id',i.id,'product_name',i.product_name,'options_label',i.options_label,
		    'quantity',i.quantity,'cook_status',i.cook_status,'updated_at',i.updated_at) ORDER BY i.sort_order)
		    FROM order_items i WHERE i.order_id=o.id AND i.needs_cooking), '[]') AS items
		FROM orders o WHERE o.department_id=$1 AND o.business_day=$2 AND o.handoff_status='pending'
		  AND (o.status='accepted' OR (o.status='cancelled' AND o.updated_at > now() - interval '10 minutes'))
		  AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.needs_cooking)) x`,
		dept, a.today(), l.CookingWarnMinutes, l.UnpaidWarnMinutes)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"orders": raw, "server_time": a.Now()})
	return nil
}

var cookTransitions = map[string][]string{
	"waiting": {"cooking", "cooked"},
	"cooking": {"cooked", "waiting"},
	"cooked":  {"cooking"},
}

// POST /api/v1/staff/order-items/{id}/cook {from, to, reason}
// from を必須にして、別端末で既に変わっていたら 409 を返す（二重タップ・同時操作の防止）。
func (a *App) handleCookItem(w http.ResponseWriter, r *http.Request, s *Staff) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		From   string `json:"from"`
		To     string `json:"to"`
		Reason string `json:"reason"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	allowed := false
	for _, t := range cookTransitions[in.From] {
		if t == in.To {
			allowed = true
		}
	}
	if !allowed {
		return badRequest("この状態変更はできません")
	}
	ctx := r.Context()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		var orderID, dept, ostatus, handoff string
		if err := tx.QueryRowContext(ctx, `SELECT o.id, o.department_id, o.status, o.handoff_status FROM order_items i JOIN orders o ON o.id=i.order_id
			WHERE i.id=$1 FOR UPDATE OF o`, id).Scan(&orderID, &dept, &ostatus, &handoff); err != nil {
			return err
		}
		if ostatus != "accepted" || handoff != "pending" {
			return conflict("order_closed", "取消済みまたは受渡済みの注文です")
		}
		var needs bool
		if err := tx.QueryRowContext(ctx, `SELECT needs_cooking FROM order_items WHERE id=$1`, id).Scan(&needs); err != nil {
			return err
		}
		if !needs {
			return badRequest("この商品は調理不要です")
		}
		res, err := tx.ExecContext(ctx, `UPDATE order_items SET cook_status=$3, updated_at=now() WHERE id=$1 AND cook_status=$2`, id, in.From, in.To)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return conflict("state_changed", "他の端末で状態が変更されています。画面を更新してください")
		}
		kind := "cook"
		if (in.From == "cooked") || (in.From == "cooking" && in.To == "waiting") {
			kind = "cook_correction"
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO order_events(order_id, item_id, kind, from_state, to_state, member_id, reason)
			VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''))`, orderID, id, kind, in.From, in.To, s.ID, in.Reason); err != nil {
			return err
		}
		if err := publish(ctx, tx, "orders:"+dept); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"ok": true, "cook_status": in.To})
		return nil
	})
}

// ---------------------------------------------------------------
// 受け渡し
// ---------------------------------------------------------------

// POST /api/v1/staff/orders/{id}/handoff {unpaid_reason}
// 全有効明細が調理済み（または調理不要）かつ支払済みで受け渡し可能。
// 未払い受渡は会計責任者権限と理由が必須（例外運用）。
func (a *App) handleHandoff(w http.ResponseWriter, r *http.Request, s *Staff) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		UnpaidReason string `json:"unpaid_reason"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		var status, pay, handoff, dept string
		if err := tx.QueryRowContext(ctx, `SELECT status, payment_status, handoff_status, department_id FROM orders WHERE id=$1 FOR UPDATE`, id).
			Scan(&status, &pay, &handoff, &dept); err != nil {
			return err
		}
		if status != "accepted" || handoff != "pending" {
			return conflict("not_handable", "受け渡しできない状態です")
		}
		var pending int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM order_items WHERE order_id=$1 AND cook_status IN ('waiting','cooking')`, id).Scan(&pending); err != nil {
			return err
		}
		if pending > 0 {
			return conflict("not_ready", "調理が終わっていない商品があります")
		}
		if pay == "unpaid" {
			if !s.Has("treasurer", "admin") {
				return conflict("unpaid", "未払いの注文です。先に会計してください")
			}
			if err := requireText("未払い受渡の理由", in.UnpaidReason, 200); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE orders SET handoff_status='handed', status='completed', handed_by=$2, handed_at=now(),
			unpaid_handoff_reason=NULLIF($3,''), updated_at=now() WHERE id=$1`, id, s.ID, in.UnpaidReason); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO order_events(order_id, kind, from_state, to_state, member_id, reason)
			VALUES ($1,'handoff','pending','handed',$2,NULLIF($3,''))`, id, s.ID, in.UnpaidReason); err != nil {
			return err
		}
		if pay == "unpaid" {
			if err := audit(ctx, tx, s, "order.unpaid_handoff", "order", id, in); err != nil {
				return err
			}
		}
		if err := publish(ctx, tx, "orders:"+dept); err != nil {
			return err
		}
		raw, err := orderJSON(ctx, tx, "o.id=$1", id, true)
		if err != nil {
			return err
		}
		writeJSON(w, 200, raw)
		return nil
	})
}

// POST /api/v1/staff/orders/{id}/handoff/revert {reason} — 誤った受渡操作の訂正
func (a *App) handleHandoffRevert(w http.ResponseWriter, r *http.Request, s *Staff) error {
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
	if err := requireText("理由", in.Reason, 200); err != nil {
		return err
	}
	ctx := r.Context()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		var handoff, dept string
		if err := tx.QueryRowContext(ctx, `SELECT handoff_status, department_id FROM orders WHERE id=$1 FOR UPDATE`, id).Scan(&handoff, &dept); err != nil {
			return err
		}
		if handoff != "handed" {
			return conflict("not_handed", "受渡済みではありません")
		}
		if _, err := tx.ExecContext(ctx, `UPDATE orders SET handoff_status='pending', status='accepted', handed_by=NULL, handed_at=NULL,
			updated_at=now() WHERE id=$1`, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO order_events(order_id, kind, from_state, to_state, member_id, reason)
			VALUES ($1,'handoff_correction','handed','pending',$2,$3)`, id, s.ID, in.Reason); err != nil {
			return err
		}
		if err := audit(ctx, tx, s, "order.handoff_revert", "order", id, in); err != nil {
			return err
		}
		if err := publish(ctx, tx, "orders:"+dept); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return nil
	})
}

// ---------------------------------------------------------------
// 公開ディスプレイ（呼出番号のみ。氏名・トークンは出さない）
// ---------------------------------------------------------------

// GET /api/v1/public/departments/{id}/board
func (a *App) handleBoard(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	d, err := a.getDept(ctx, a.DB, id, false)
	if err != nil {
		return err
	}
	var board struct {
		Cooking []int `json:"cooking"`
		Ready   []int `json:"ready"`
	}
	err = queryJSON(ctx, a.DB, &board, `SELECT json_build_object(
		'cooking', COALESCE((SELECT json_agg(call_number ORDER BY call_number) FROM orders o WHERE o.department_id=$1 AND o.business_day=$2
		  AND o.status='accepted' AND o.handoff_status='pending'
		  AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.cook_status IN ('waiting','cooking'))), '[]'),
		'ready', COALESCE((SELECT json_agg(call_number ORDER BY call_number) FROM orders o WHERE o.department_id=$1 AND o.business_day=$2
		  AND o.status='accepted' AND o.handoff_status='pending'
		  AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.cook_status IN ('waiting','cooking'))
		  AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.cook_status<>'cancelled')), '[]'))`, id, a.today())
	if err != nil {
		return err
	}
	if board.Cooking == nil {
		board.Cooking = []int{}
	}
	if board.Ready == nil {
		board.Ready = []int{}
	}
	writeJSON(w, 200, map[string]any{
		"department": map[string]any{"id": d.ID, "name": d.Name, "business_status": d.BusinessStatus,
			"mobile_order_enabled": d.MobileOrderEnabled, "site_code_enabled": d.SiteCodeEnabled, "notice": d.Notice},
		"cooking": board.Cooking, "ready": board.Ready, "server_time": a.Now(),
	})
	return nil
}
