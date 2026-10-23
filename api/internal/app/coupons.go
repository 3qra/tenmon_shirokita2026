package app

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"sort"
	"strings"
	"time"
)

// couponSnapshot は発券時に固定される条件。定義を後から変えても発券済みには遡及しない。
type couponSnapshot struct {
	Name               string     `json:"name"`
	Description        string     `json:"description"`
	DiscountType       string     `json:"discount_type"`  // fixed / percent
	DiscountValue      int        `json:"discount_value"` // 円 or ％
	Scope              string     `json:"scope"`          // order / items
	TargetDepartmentID string     `json:"target_department_id,omitempty"`
	TargetProductIDs   []string   `json:"target_product_ids"`
	TargetVariantIDs   []string   `json:"target_variant_ids"`
	ItemsPerPerson     int        `json:"items_per_person"`
	Allocation         string     `json:"allocation"`
	MaxDiscount        *int       `json:"max_discount,omitempty"`
	HolderMode         string     `json:"holder_mode"`
	Splittable         bool       `json:"splittable"`
	Combinable         bool       `json:"combinable"`
	ValidFrom          *time.Time `json:"valid_from,omitempty"`
	ValidUntil         *time.Time `json:"valid_until,omitempty"`
}

func loadCouponSnapshot(ctx context.Context, q queryer, defID string) (*couponSnapshot, error) {
	var s couponSnapshot
	var maxD sql.NullInt64
	var dept sql.NullString
	var from, until sql.NullTime
	err := q.QueryRowContext(ctx, `SELECT name, description, discount_type, discount_value, scope, target_department_id,
		items_per_person, allocation, max_discount, holder_mode, splittable, combinable, valid_from, valid_until
		FROM coupon_definitions WHERE id=$1`, defID).Scan(&s.Name, &s.Description, &s.DiscountType, &s.DiscountValue, &s.Scope,
		&dept, &s.ItemsPerPerson, &s.Allocation, &maxD, &s.HolderMode, &s.Splittable, &s.Combinable, &from, &until)
	if err == sql.ErrNoRows {
		return nil, notFound("クーポン定義")
	}
	if err != nil {
		return nil, err
	}
	if dept.Valid {
		s.TargetDepartmentID = dept.String
	}
	if maxD.Valid {
		v := int(maxD.Int64)
		s.MaxDiscount = &v
	}
	if from.Valid {
		s.ValidFrom = &from.Time
	}
	if until.Valid {
		s.ValidUntil = &until.Time
	}
	s.TargetProductIDs = []string{}
	s.TargetVariantIDs = []string{}
	rows, err := q.QueryContext(ctx, `SELECT product_id, variant_id FROM coupon_targets WHERE definition_id=$1`, defID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var p, v sql.NullString
		if err := rows.Scan(&p, &v); err != nil {
			return nil, err
		}
		if p.Valid {
			s.TargetProductIDs = append(s.TargetProductIDs, p.String)
		}
		if v.Valid {
			s.TargetVariantIDs = append(s.TargetVariantIDs, v.String)
		}
	}
	return &s, rows.Err()
}

// ---------------------------------------------------------------
// 割引計算
// ---------------------------------------------------------------

type calcItem struct {
	ID        string
	ProductID string
	VariantID string
	UnitPrice int
	Quantity  int
	Discount  int // 既に適用済みの割引
}

type couponUse struct {
	Token   string `json:"token"`
	Persons int    `json:"persons"`
}

type couponLine struct {
	IssuedID         string         `json:"issued_coupon_id"`
	PublicNo         string         `json:"coupon_no"`
	Name             string         `json:"name"`
	Persons          int            `json:"persons"`
	Discount         int            `json:"discount"`
	ForfeitedPersons int            `json:"forfeited_persons"`
	ItemDiscounts    map[string]int `json:"-"`
	Note             string         `json:"note,omitempty"`
}

type couponState struct {
	ID        string
	PublicNo  string
	Status    string
	Remaining int
	Total     int
	Snap      couponSnapshot
	ValidFrom *time.Time
	Until     *time.Time
}

func loadIssuedByToken(ctx context.Context, q queryer, token string, lock bool) (*couponState, error) {
	lockSQL := ""
	if lock {
		lockSQL = " FOR UPDATE"
	}
	var c couponState
	var snap []byte
	var from, until sql.NullTime
	err := q.QueryRowContext(ctx, `SELECT id, public_no, status, persons_remaining, persons_total, snapshot, valid_from, valid_until
		FROM issued_coupons WHERE token_hash=$1`+lockSQL, hashToken("coupon", token)).
		Scan(&c.ID, &c.PublicNo, &c.Status, &c.Remaining, &c.Total, &snap, &from, &until)
	if err == sql.ErrNoRows {
		return nil, notFound("クーポン")
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(snap, &c.Snap); err != nil {
		return nil, err
	}
	if from.Valid {
		c.ValidFrom = &from.Time
	}
	if until.Valid {
		c.Until = &until.Time
	}
	return &c, nil
}

func (c *couponState) usableError(now time.Time) error {
	switch c.Status {
	case "used":
		return unprocessable("coupon_used", "このクーポンは使用済みです")
	case "revoked":
		return unprocessable("coupon_revoked", "このクーポンは失効しています")
	}
	if c.Remaining <= 0 {
		return unprocessable("coupon_used", "このクーポンは使用済みです")
	}
	if c.ValidFrom != nil && now.Before(*c.ValidFrom) {
		return unprocessable("coupon_not_yet", "このクーポンは%sから利用できます", c.ValidFrom.In(jst).Format("1/2 15:04"))
	}
	if c.Until != nil && !now.Before(*c.Until) {
		return unprocessable("coupon_expired", "このクーポンは有効期限切れです")
	}
	return nil
}

func (s *couponSnapshot) targets(it calcItem) bool {
	if len(s.TargetProductIDs) == 0 && len(s.TargetVariantIDs) == 0 {
		return true
	}
	for _, p := range s.TargetProductIDs {
		if p == it.ProductID {
			return true
		}
	}
	for _, v := range s.TargetVariantIDs {
		if v == it.VariantID {
			return true
		}
	}
	return false
}

// computeDiscount は1枚のクーポンを items に適用した割引額を求める（items の Discount を更新する）。
// 定率は1円未満切捨て。割引は対象金額を超えない。割当順はクーポンの設定に従う（未定義の自動割当はしない）。
func computeDiscount(snap *couponSnapshot, deptID string, items []calcItem, persons int) (int, map[string]int, error) {
	if snap.TargetDepartmentID != "" && snap.TargetDepartmentID != deptID {
		return 0, nil, unprocessable("coupon_not_applicable", "このクーポンはこの部門では使えません")
	}
	per := map[string]int{}
	total := 0
	capLeft := -1
	if snap.MaxDiscount != nil {
		capLeft = *snap.MaxDiscount
	}
	take := func(itemIdx int, amount int) int {
		rem := items[itemIdx].UnitPrice*items[itemIdx].Quantity - items[itemIdx].Discount
		if amount > rem {
			amount = rem
		}
		if capLeft >= 0 && amount > capLeft {
			amount = capLeft
		}
		if amount <= 0 {
			return 0
		}
		items[itemIdx].Discount += amount
		per[items[itemIdx].ID] += amount
		total += amount
		if capLeft >= 0 {
			capLeft -= amount
		}
		return amount
	}

	switch snap.Scope {
	case "items":
		// 対象商品を1点単位に展開し、割当順で persons*items_per_person 点まで割り引く
		type unit struct {
			idx   int
			price int
		}
		var units []unit
		for i, it := range items {
			if !snap.targets(it) {
				continue
			}
			for q := 0; q < it.Quantity; q++ {
				units = append(units, unit{i, it.UnitPrice})
			}
		}
		if len(units) == 0 {
			return 0, nil, unprocessable("coupon_no_target", "このクーポンの対象商品が注文に含まれていません")
		}
		sort.SliceStable(units, func(a, b int) bool {
			if snap.Allocation == "lowest_price_first" {
				return units[a].price < units[b].price
			}
			return units[a].price > units[b].price
		})
		limit := persons * snap.ItemsPerPerson
		if limit > len(units) {
			limit = len(units)
		}
		for _, u := range units[:limit] {
			var amt int
			if snap.DiscountType == "fixed" {
				amt = snap.DiscountValue
			} else {
				amt = u.price * snap.DiscountValue / 100
			}
			take(u.idx, amt)
		}
	case "order":
		remaining := 0
		for _, it := range items {
			if snap.targets(it) {
				remaining += it.UnitPrice*it.Quantity - it.Discount
			}
		}
		if remaining <= 0 {
			return 0, nil, unprocessable("coupon_no_target", "このクーポンを適用できる金額がありません")
		}
		var want int
		if snap.DiscountType == "fixed" {
			want = snap.DiscountValue * persons
		} else {
			want = remaining * snap.DiscountValue / 100
		}
		if capLeft >= 0 && want > capLeft {
			want = capLeft
		}
		// 注文全体の割引は明細順に配分して記録する（売上集計の整合用）
		for i, it := range items {
			if want <= 0 {
				break
			}
			if !snap.targets(it) {
				continue
			}
			want -= take(i, want)
		}
	default:
		return 0, nil, badRequest("クーポンの適用範囲が不明です")
	}
	return total, per, nil
}

// evalCoupons は複数クーポンの割引を見積もる。lock=true なら発券クーポンを行ロックする（会計確定用）。
func (a *App) evalCoupons(ctx context.Context, q queryer, deptID string, items []calcItem, uses []couponUse, lock bool) ([]couponLine, []*couponState, int, error) {
	if len(uses) == 0 {
		return nil, nil, 0, nil
	}
	seen := map[string]bool{}
	var lines []couponLine
	var states []*couponState
	sum := 0
	now := a.Now()
	for _, u := range uses {
		c, err := loadIssuedByToken(ctx, q, trimTokenURL(u.Token), lock)
		if err != nil {
			return nil, nil, 0, err
		}
		if seen[c.ID] {
			return nil, nil, 0, badRequest("同じクーポンが重複しています")
		}
		seen[c.ID] = true
		if err := c.usableError(now); err != nil {
			return nil, nil, 0, err
		}
		if u.Persons <= 0 || u.Persons > c.Remaining {
			return nil, nil, 0, unprocessable("coupon_persons", "クーポン%sの利用人数は1〜%d人で指定してください", c.PublicNo, c.Remaining)
		}
		if len(uses) > 1 && !c.Snap.Combinable {
			return nil, nil, 0, unprocessable("coupon_not_combinable", "クーポン%sは他のクーポンと併用できません", c.PublicNo)
		}
		d, per, err := computeDiscount(&c.Snap, deptID, items, u.Persons)
		if err != nil {
			return nil, nil, 0, err
		}
		line := couponLine{IssuedID: c.ID, PublicNo: c.PublicNo, Name: c.Snap.Name, Persons: u.Persons, Discount: d, ItemDiscounts: per}
		if !c.Snap.Splittable && u.Persons < c.Remaining {
			line.ForfeitedPersons = c.Remaining - u.Persons
			line.Note = fmt.Sprintf("分割利用できないクーポンのため、残り%d人分は失効します", line.ForfeitedPersons)
		}
		sum += d
		lines = append(lines, line)
		states = append(states, c)
	}
	return lines, states, sum, nil
}

func loadCalcItems(ctx context.Context, q queryer, orderID string) ([]calcItem, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, product_id, variant_id, unit_price, quantity FROM order_items
		WHERE order_id=$1 AND cook_status<>'cancelled' ORDER BY sort_order`, orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []calcItem
	for rows.Next() {
		var it calcItem
		if err := rows.Scan(&it.ID, &it.ProductID, &it.VariantID, &it.UnitPrice, &it.Quantity); err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------
// スタッフ：クーポン読取・見積（消費しない）
// ---------------------------------------------------------------

// GET /api/v1/staff/coupons/verify/{token}
func (a *App) handleVerifyCoupon(w http.ResponseWriter, r *http.Request, s *Staff) error {
	if err := a.rateLimit(r, "coupon_verify", 120, 60); err != nil {
		return err
	}
	c, err := loadIssuedByToken(r.Context(), a.DB, trimTokenURL(r.PathValue("token")), false)
	if err != nil {
		return err
	}
	usable := c.usableError(a.Now())
	resp := map[string]any{
		"id": c.ID, "coupon_no": c.PublicNo, "status": c.Status, "persons_total": c.Total, "persons_remaining": c.Remaining,
		"conditions": c.Snap, "usable": usable == nil, "summary": couponSummary(&c.Snap),
	}
	if usable != nil {
		resp["reason"] = toAPIError(usable).Message
	}
	writeJSON(w, 200, resp)
	return nil
}

func couponSummary(s *couponSnapshot) string {
	var b strings.Builder
	if s.Scope == "order" {
		b.WriteString("お会計から")
	} else {
		fmt.Fprintf(&b, "対象商品%d点/人まで", s.ItemsPerPerson)
	}
	if s.DiscountType == "fixed" {
		if s.Scope == "order" {
			fmt.Fprintf(&b, "1人あたり%d円引き", s.DiscountValue)
		} else {
			fmt.Fprintf(&b, "1点%d円引き", s.DiscountValue)
		}
	} else {
		fmt.Fprintf(&b, "%d%%引き", s.DiscountValue)
	}
	if s.MaxDiscount != nil {
		fmt.Fprintf(&b, "（上限%d円）", *s.MaxDiscount)
	}
	if !s.Combinable {
		b.WriteString("・併用不可")
	}
	if !s.Splittable {
		b.WriteString("・分割利用不可")
	}
	return b.String()
}

// POST /api/v1/staff/orders/{id}/quote {coupons:[{token, persons}]}
// 割引後金額を表示するための見積。クーポンは消費しない。
func (a *App) handleOrderPaymentQuote(w http.ResponseWriter, r *http.Request, s *Staff) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Coupons []couponUse `json:"coupons"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	var dept string
	var subtotal int
	if err := a.DB.QueryRowContext(ctx, `SELECT department_id, subtotal FROM orders WHERE id=$1`, id).Scan(&dept, &subtotal); err != nil {
		return err
	}
	items, err := loadCalcItems(ctx, a.DB, id)
	if err != nil {
		return err
	}
	lines, _, discount, err := a.evalCoupons(ctx, a.DB, dept, items, in.Coupons, false)
	if err != nil {
		return err
	}
	if lines == nil {
		lines = []couponLine{}
	}
	writeJSON(w, 200, map[string]any{"subtotal": subtotal, "discount": discount, "total": subtotal - discount, "coupons": lines})
	return nil
}

// ---------------------------------------------------------------
// 会計（入金確定）
// ---------------------------------------------------------------

// POST /api/v1/staff/orders/{id}/payment (Idempotency-Key 必須)
// {cash_received, voucher_received, coupons:[{token,persons}], expected_total, cash_account_id}
// クーポン消費・入金・現金明細を同一トランザクションで確定する。失敗すればクーポン消費も残らない。
func (a *App) handlePayment(w http.ResponseWriter, r *http.Request, s *Staff) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		CashReceived    int         `json:"cash_received"`
		VoucherReceived int         `json:"voucher_received"`
		Coupons         []couponUse `json:"coupons"`
		ExpectedTotal   *int        `json:"expected_total"`
		CashAccountID   string      `json:"cash_account_id"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if in.CashReceived < 0 || in.VoucherReceived < 0 {
		return badRequest("受領額が正しくありません")
	}
	ctx := r.Context()
	allowVoucherChange, err := a.voucherChangeAllowed(ctx)
	if err != nil {
		return err
	}
	var result json.RawMessage
	err = a.withTx(ctx, func(tx *sql.Tx) error {
		var status, pay, dept string
		var subtotal int
		if err := tx.QueryRowContext(ctx, `SELECT status, payment_status, department_id, subtotal FROM orders WHERE id=$1 FOR UPDATE`, id).
			Scan(&status, &pay, &dept, &subtotal); err != nil {
			return err
		}
		if status == "cancelled" {
			return conflict("cancelled", "取消済みの注文です")
		}
		if pay != "unpaid" {
			return conflict("already_paid", "既に会計済みです")
		}
		items, err := loadCalcItems(ctx, tx, id)
		if err != nil {
			return err
		}
		lines, states, discount, err := a.evalCoupons(ctx, tx, dept, items, in.Coupons, true)
		if err != nil {
			return err
		}
		total := subtotal - discount
		if in.ExpectedTotal != nil && *in.ExpectedTotal != total {
			return conflict("total_changed", "金額が変わりました（%d円）。もう一度確認してください", total)
		}
		received := in.CashReceived + in.VoucherReceived
		if received < total {
			return unprocessable("insufficient", "預かり金額が不足しています（あと%d円）", total-received)
		}
		change := received - total
		if change > in.CashReceived && !allowVoucherChange {
			return unprocessable("voucher_change", "金券にはお釣りを出せません。現金の預かり額を確認してください")
		}
		// 保管先：指定がなければ自分の財布
		var account sql.NullString
		if total > 0 || in.CashReceived > 0 || in.VoucherReceived > 0 {
			acc, err := a.resolveCashAccount(ctx, tx, s, in.CashAccountID)
			if err != nil {
				return err
			}
			account = sql.NullString{String: acc, Valid: true}
		}
		var paymentID string
		if err := tx.QueryRowContext(ctx, `INSERT INTO payments(order_id, amount, cash_received, voucher_received, change_given, cash_account_id, member_id)
			VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, id, total, in.CashReceived, in.VoucherReceived, change, account, s.ID).Scan(&paymentID); err != nil {
			return err
		}
		// 現金・金券の明細（お釣りは現金から出す）
		// お釣りは常に現金から出す（金券へのお釣りを許可した場合は現金明細がマイナスになる）
		cashNet := in.CashReceived - change
		voucherNet := in.VoucherReceived
		if cashNet != 0 {
			if _, err := tx.ExecContext(ctx, `INSERT INTO cash_entries(cash_account_id, medium, kind, amount, payment_id, member_id)
				VALUES ($1,'cash','sale',$2,$3,$4)`, account.String, cashNet, paymentID, s.ID); err != nil {
				return err
			}
		}
		if voucherNet != 0 {
			if _, err := tx.ExecContext(ctx, `INSERT INTO cash_entries(cash_account_id, medium, kind, amount, payment_id, member_id)
				VALUES ($1,'voucher','sale',$2,$3,$4)`, account.String, voucherNet, paymentID, s.ID); err != nil {
				return err
			}
		}
		// クーポン消費
		for i, ln := range lines {
			consume := ln.Persons + ln.ForfeitedPersons
			newRemain := states[i].Remaining - consume
			newStatus := "active"
			if newRemain == 0 {
				newStatus = "used"
			}
			res, err := tx.ExecContext(ctx, `UPDATE issued_coupons SET persons_remaining=$2, status=$3, updated_at=now()
				WHERE id=$1 AND persons_remaining=$4 AND status='active'`, ln.IssuedID, newRemain, newStatus, states[i].Remaining)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n == 0 {
				return conflict("coupon_changed", "クーポンの状態が変わりました。読み取り直してください")
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO coupon_redemptions(issued_coupon_id, order_id, payment_id, persons, discount, forfeited_persons, member_id)
				VALUES ($1,$2,$3,$4,$5,$6,$7)`, ln.IssuedID, id, paymentID, ln.Persons, ln.Discount, ln.ForfeitedPersons, s.ID); err != nil {
				return err
			}
		}
		for _, it := range items {
			if it.Discount > 0 {
				if _, err := tx.ExecContext(ctx, `UPDATE order_items SET discount=$2, updated_at=now() WHERE id=$1`, it.ID, it.Discount); err != nil {
					return err
				}
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE orders SET discount=$2, total=$3, payment_status='paid', updated_at=now() WHERE id=$1`,
			id, discount, total); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO order_events(order_id, kind, from_state, to_state, member_id) VALUES ($1,'payment','unpaid','paid',$2)`, id, s.ID); err != nil {
			return err
		}
		if err := publish(ctx, tx, "orders:"+dept, "cash"); err != nil {
			return err
		}
		raw, err := orderJSON(ctx, tx, "o.id=$1", id, true)
		if err != nil {
			return err
		}
		result = raw
		return nil
	})
	if err != nil {
		return err
	}
	writeJSON(w, 200, result)
	return nil
}

func (a *App) voucherChangeAllowed(ctx context.Context) (bool, error) {
	var raw []byte
	err := a.DB.QueryRowContext(ctx, `SELECT value FROM settings WHERE key='voucher_change_allowed'`).Scan(&raw)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var v bool
	_ = json.Unmarshal(raw, &v)
	return v, nil
}

// resolveCashAccount は入金・返金先の保管先を決める。他人の財布は指定できない。
func (a *App) resolveCashAccount(ctx context.Context, tx *sql.Tx, s *Staff, requested string) (string, error) {
	if requested != "" {
		if !isUUID(requested) {
			return "", badRequest("保管先が正しくありません")
		}
		var kind string
		var owner sql.NullString
		var active bool
		if err := tx.QueryRowContext(ctx, `SELECT kind, member_id, active FROM cash_accounts WHERE id=$1`, requested).Scan(&kind, &owner, &active); err != nil {
			if err == sql.ErrNoRows {
				return "", badRequest("保管先が見つかりません")
			}
			return "", err
		}
		if !active {
			return "", badRequest("この保管先は無効です")
		}
		if kind == "wallet" && owner.String != s.ID {
			return "", forbidden("他の部員の財布には入金できません")
		}
		if kind == "safe" && !s.Has("treasurer", "admin") {
			return "", forbidden("金庫への直接入金は会計責任者のみ可能です")
		}
		return requested, nil
	}
	var id string
	err := tx.QueryRowContext(ctx, `SELECT id FROM cash_accounts WHERE member_id=$1 AND kind='wallet' AND active`, s.ID).Scan(&id)
	if err == sql.ErrNoRows {
		return "", unprocessable("no_wallet", "あなたの財布（保管先）が登録されていません。管理者に作成を依頼するか、保管先を選んでください")
	}
	return id, err
}

// ---------------------------------------------------------------
// 返金（会計責任者）
// ---------------------------------------------------------------

// POST /api/v1/staff/orders/{id}/refund (Idempotency-Key 必須)
// {amount, reason, cash_account_id, cancel_order, restore_coupons}
func (a *App) handleRefund(w http.ResponseWriter, r *http.Request, s *Staff) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Amount         int    `json:"amount"`
		Reason         string `json:"reason"`
		CashAccountID  string `json:"cash_account_id"`
		CancelOrder    bool   `json:"cancel_order"`
		RestoreCoupons bool   `json:"restore_coupons"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if err := requireText("返金理由", in.Reason, 200); err != nil {
		return err
	}
	if in.Amount <= 0 {
		return badRequest("返金額は1円以上で指定してください")
	}
	ctx := r.Context()
	var result json.RawMessage
	err = a.withTx(ctx, func(tx *sql.Tx) error {
		var status, pay, dept string
		if err := tx.QueryRowContext(ctx, `SELECT status, payment_status, department_id FROM orders WHERE id=$1 FOR UPDATE`, id).Scan(&status, &pay, &dept); err != nil {
			return err
		}
		if pay == "unpaid" {
			return conflict("unpaid", "未払いの注文は返金できません")
		}
		var paymentID string
		var paid, refunded int
		if err := tx.QueryRowContext(ctx, `SELECT p.id, p.amount, COALESCE((SELECT sum(amount) FROM refunds WHERE payment_id=p.id),0)
			FROM payments p WHERE p.order_id=$1 AND p.status='completed'`, id).Scan(&paymentID, &paid, &refunded); err != nil {
			return err
		}
		if refunded+in.Amount > paid {
			return unprocessable("refund_exceeds", "返金額が入金額を超えます（返金可能：%d円）", paid-refunded)
		}
		account, err := a.resolveCashAccount(ctx, tx, s, in.CashAccountID)
		if err != nil {
			return err
		}
		var refundID string
		if err := tx.QueryRowContext(ctx, `INSERT INTO refunds(payment_id, order_id, amount, cash_account_id, member_id, reason)
			VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, paymentID, id, in.Amount, account, s.ID, in.Reason).Scan(&refundID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO cash_entries(cash_account_id, medium, kind, amount, refund_id, member_id, reason)
			VALUES ($1,'cash','refund',$2,$3,$4,$5)`, account, -in.Amount, refundID, s.ID, in.Reason); err != nil {
			return err
		}
		newPay := "partially_refunded"
		if refunded+in.Amount == paid {
			newPay = "refunded"
		}
		if _, err := tx.ExecContext(ctx, `UPDATE orders SET payment_status=$2, updated_at=now() WHERE id=$1`, id, newPay); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO order_events(order_id, kind, from_state, to_state, member_id, reason)
			VALUES ($1,'refund',$2,$3,$4,$5)`, id, pay, newPay, s.ID, fmt.Sprintf("%d円: %s", in.Amount, in.Reason)); err != nil {
			return err
		}
		if in.CancelOrder && status == "accepted" {
			if err := cancelOrderTx(ctx, tx, id, s, in.Reason); err != nil {
				return err
			}
		}
		if in.RestoreCoupons {
			if newPay != "refunded" {
				return unprocessable("partial_refund_restore", "クーポンの復元は全額返金のときのみ選べます")
			}
			if err := restoreCoupons(ctx, tx, id, s, "返金に伴う復元: "+in.Reason); err != nil {
				return err
			}
		}
		if err := audit(ctx, tx, s, "order.refund", "order", id, in); err != nil {
			return err
		}
		if err := publish(ctx, tx, "orders:"+dept, "cash"); err != nil {
			return err
		}
		result, err = orderJSON(ctx, tx, "o.id=$1", id, true)
		return err
	})
	if err != nil {
		return err
	}
	writeJSON(w, 200, result)
	return nil
}

// restoreCoupons は利用を「取消」として記録し、残人数を戻す（履歴は削除しない）。
func restoreCoupons(ctx context.Context, tx *sql.Tx, orderID string, s *Staff, reason string) error {
	rows, err := tx.QueryContext(ctx, `SELECT id, issued_coupon_id, persons + forfeited_persons FROM coupon_redemptions
		WHERE order_id=$1 AND status='applied' FOR UPDATE`, orderID)
	if err != nil {
		return err
	}
	type red struct {
		id, coupon string
		n          int
	}
	var reds []red
	for rows.Next() {
		var x red
		if err := rows.Scan(&x.id, &x.coupon, &x.n); err != nil {
			rows.Close()
			return err
		}
		reds = append(reds, x)
	}
	rows.Close()
	for _, x := range reds {
		if _, err := tx.ExecContext(ctx, `UPDATE coupon_redemptions SET status='reversed', reversed_by=$2, reversed_at=now(), reverse_reason=$3 WHERE id=$1`,
			x.id, s.ID, reason); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE issued_coupons SET persons_remaining=persons_remaining+$2,
			status=CASE WHEN status='revoked' THEN status ELSE 'active' END, updated_at=now() WHERE id=$1`, x.coupon, x.n); err != nil {
			return err
		}
	}
	return nil
}

// ---------------------------------------------------------------
// クーポン定義・発券（管理）
// ---------------------------------------------------------------

type couponDefInput struct {
	Name               string     `json:"name"`
	Description        string     `json:"description"`
	DiscountType       string     `json:"discount_type"`
	DiscountValue      int        `json:"discount_value"`
	Scope              string     `json:"scope"`
	TargetDepartmentID string     `json:"target_department_id"`
	TargetProductIDs   []string   `json:"target_product_ids"`
	TargetVariantIDs   []string   `json:"target_variant_ids"`
	ItemsPerPerson     int        `json:"items_per_person"`
	Allocation         string     `json:"allocation"`
	MaxDiscount        *int       `json:"max_discount"`
	HolderMode         string     `json:"holder_mode"`
	Splittable         bool       `json:"splittable"`
	Combinable         bool       `json:"combinable"`
	ValidFrom          *time.Time `json:"valid_from"`
	ValidUntil         *time.Time `json:"valid_until"`
	MaxIssues          *int       `json:"max_issues"`
	AutoIssue          string     `json:"auto_issue"`
	Active             *bool      `json:"active"`
}

func (in *couponDefInput) validate() error {
	if err := requireText("クーポン名", in.Name, 50); err != nil {
		return err
	}
	if in.DiscountType != "fixed" && in.DiscountType != "percent" {
		return badRequest("割引の種類（定額／定率）を選んでください")
	}
	if in.DiscountValue <= 0 || (in.DiscountType == "percent" && in.DiscountValue > 100) {
		return badRequest("割引額（率）が正しくありません")
	}
	if in.Scope != "order" && in.Scope != "items" {
		return badRequest("適用範囲（注文全体／特定商品）を選んでください")
	}
	if in.Scope == "items" && len(in.TargetProductIDs)+len(in.TargetVariantIDs) == 0 {
		return badRequest("特定商品が対象の場合は対象商品を選んでください")
	}
	if in.ItemsPerPerson == 0 {
		in.ItemsPerPerson = 1
	}
	if in.Allocation == "" {
		in.Allocation = "highest_price_first"
	}
	if in.HolderMode == "" {
		in.HolderMode = "per_person"
	}
	if in.AutoIssue == "" {
		in.AutoIssue = "none"
	}
	if in.Allocation != "highest_price_first" && in.Allocation != "lowest_price_first" {
		return badRequest("割当順の指定が正しくありません")
	}
	if in.HolderMode != "per_person" && in.HolderMode != "group" {
		return badRequest("発券単位の指定が正しくありません")
	}
	if in.AutoIssue != "none" && in.AutoIssue != "screening_attended" {
		return badRequest("自動発券の指定が正しくありません")
	}
	if in.ItemsPerPerson < 1 || (in.MaxDiscount != nil && *in.MaxDiscount < 1) || (in.MaxIssues != nil && *in.MaxIssues < 1) {
		return badRequest("点数・上限の指定が正しくありません")
	}
	if in.ValidFrom != nil && in.ValidUntil != nil && !in.ValidUntil.After(*in.ValidFrom) {
		return badRequest("有効期限は開始より後にしてください")
	}
	for _, id := range append(append([]string{}, in.TargetProductIDs...), in.TargetVariantIDs...) {
		if !isUUID(id) {
			return badRequest("対象商品の指定が正しくありません")
		}
	}
	if in.TargetDepartmentID != "" && !isUUID(in.TargetDepartmentID) {
		return badRequest("対象部門の指定が正しくありません")
	}
	return nil
}

func (a *App) handleListCouponDefs(w http.ResponseWriter, r *http.Request, s *Staff) error {
	raw, err := queryRaw(r.Context(), a.DB, `SELECT COALESCE(json_agg(x ORDER BY x.created_at DESC), '[]') FROM (
		SELECT d.*,
		  COALESCE((SELECT json_agg(product_id) FROM coupon_targets WHERE definition_id=d.id AND product_id IS NOT NULL), '[]') AS target_product_ids,
		  COALESCE((SELECT json_agg(variant_id) FROM coupon_targets WHERE definition_id=d.id AND variant_id IS NOT NULL), '[]') AS target_variant_ids,
		  (SELECT count(*) FROM issued_coupons WHERE definition_id=d.id) AS issued_count,
		  (SELECT COALESCE(sum(cr.persons),0) FROM coupon_redemptions cr JOIN issued_coupons ic ON ic.id=cr.issued_coupon_id
		     WHERE ic.definition_id=d.id AND cr.status='applied') AS used_persons
		FROM coupon_definitions d) x`)
	if err != nil {
		return err
	}
	writeJSON(w, 200, raw)
	return nil
}

func (a *App) saveCouponTargets(ctx context.Context, tx *sql.Tx, defID string, in *couponDefInput) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM coupon_targets WHERE definition_id=$1`, defID); err != nil {
		return err
	}
	for _, p := range in.TargetProductIDs {
		if _, err := tx.ExecContext(ctx, `INSERT INTO coupon_targets(definition_id, product_id) VALUES ($1,$2)`, defID, p); err != nil {
			return err
		}
	}
	for _, v := range in.TargetVariantIDs {
		if _, err := tx.ExecContext(ctx, `INSERT INTO coupon_targets(definition_id, variant_id) VALUES ($1,$2)`, defID, v); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) handleCreateCouponDef(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var in couponDefInput
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if err := in.validate(); err != nil {
		return err
	}
	ctx := r.Context()
	var id string
	err := a.withTx(ctx, func(tx *sql.Tx) error {
		active := true
		if in.Active != nil {
			active = *in.Active
		}
		if err := tx.QueryRowContext(ctx, `INSERT INTO coupon_definitions(name, description, discount_type, discount_value, scope,
			target_department_id, items_per_person, allocation, max_discount, holder_mode, splittable, combinable,
			valid_from, valid_until, max_issues, auto_issue, active, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
			in.Name, in.Description, in.DiscountType, in.DiscountValue, in.Scope, nullStr(in.TargetDepartmentID), in.ItemsPerPerson,
			in.Allocation, in.MaxDiscount, in.HolderMode, in.Splittable, in.Combinable, in.ValidFrom, in.ValidUntil, in.MaxIssues,
			in.AutoIssue, active, s.ID).Scan(&id); err != nil {
			return err
		}
		if err := a.saveCouponTargets(ctx, tx, id, &in); err != nil {
			return err
		}
		return audit(ctx, tx, s, "coupon_definition.create", "coupon_definition", id, in)
	})
	if err != nil {
		return err
	}
	writeJSON(w, 201, map[string]any{"id": id})
	return nil
}

// PUT /api/v1/admin/coupon-definitions/{id} — 発券済みクーポンには遡及しない
func (a *App) handleUpdateCouponDef(w http.ResponseWriter, r *http.Request, s *Staff) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in couponDefInput
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if err := in.validate(); err != nil {
		return err
	}
	ctx := r.Context()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE coupon_definitions SET name=$2, description=$3, discount_type=$4, discount_value=$5,
			scope=$6, target_department_id=$7, items_per_person=$8, allocation=$9, max_discount=$10, holder_mode=$11, splittable=$12,
			combinable=$13, valid_from=$14, valid_until=$15, max_issues=$16, auto_issue=$17, active=COALESCE($18,active), updated_at=now()
			WHERE id=$1`, id, in.Name, in.Description, in.DiscountType, in.DiscountValue, in.Scope, nullStr(in.TargetDepartmentID),
			in.ItemsPerPerson, in.Allocation, in.MaxDiscount, in.HolderMode, in.Splittable, in.Combinable, in.ValidFrom, in.ValidUntil,
			in.MaxIssues, in.AutoIssue, in.Active)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return notFound("クーポン定義")
		}
		if err := a.saveCouponTargets(ctx, tx, id, &in); err != nil {
			return err
		}
		if err := audit(ctx, tx, s, "coupon_definition.update", "coupon_definition", id, in); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return nil
	})
}

func couponPublicNo() string {
	const alphabet = "ACDEFGHJKLMNPQRTUVWXY34679"
	b := make([]byte, 6)
	for i := range b {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
		b[i] = alphabet[n.Int64()]
	}
	return "C-" + string(b)
}

type issueSource struct {
	Kind          string
	ReservationID string
	TicketID      string
}

// issueCoupon は定義の条件をスナップショットとして固定し、発券する。
// 返り値の token はQR表示用。DBにはハッシュのみ保存し、再表示は deriveToken で行う。
func (a *App) issueCoupon(ctx context.Context, tx *sql.Tx, defID string, persons int, src issueSource, s *Staff) (string, error) {
	var maxIssues sql.NullInt64
	var active bool
	if err := tx.QueryRowContext(ctx, `SELECT max_issues, active FROM coupon_definitions WHERE id=$1 FOR UPDATE`, defID).Scan(&maxIssues, &active); err != nil {
		if err == sql.ErrNoRows {
			return "", notFound("クーポン定義")
		}
		return "", err
	}
	if !active {
		return "", unprocessable("coupon_inactive", "このクーポン定義は無効です")
	}
	if maxIssues.Valid {
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM issued_coupons WHERE definition_id=$1`, defID).Scan(&n); err != nil {
			return "", err
		}
		if int64(n) >= maxIssues.Int64 {
			return "", unprocessable("coupon_issue_limit", "発行枚数の上限に達しています")
		}
	}
	snap, err := loadCouponSnapshot(ctx, tx, defID)
	if err != nil {
		return "", err
	}
	b, _ := json.Marshal(snap)
	var issuedBy any
	if s != nil {
		issuedBy = s.ID
	}
	var id string
	// IDを先に決めてトークンを導出する
	if err := tx.QueryRowContext(ctx, `SELECT gen_random_uuid()`).Scan(&id); err != nil {
		return "", err
	}
	token := a.deriveToken("coupon", id)
	// ON CONFLICT DO NOTHING でトランザクションを中断させずに、公開番号の衝突と自動発券の重複を判定する
	for attempt := 0; attempt < 8; attempt++ {
		var got string
		err = tx.QueryRowContext(ctx, `INSERT INTO issued_coupons(id, definition_id, public_no, token_hash, snapshot, persons_total, persons_remaining,
			valid_from, valid_until, source_kind, source_reservation_id, source_ticket_id, issued_by)
			VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING id`, id, defID, couponPublicNo(),
			hashToken("coupon", token), b, persons, snap.ValidFrom, snap.ValidUntil, src.Kind, nullStr(src.ReservationID),
			nullStr(src.TicketID), issuedBy).Scan(&got)
		if err == nil {
			return id, nil
		}
		if err != sql.ErrNoRows {
			return "", err
		}
		if src.Kind == "auto_screening" {
			var dup bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM issued_coupons WHERE definition_id=$1 AND source_kind='auto_screening'
				AND (($2::uuid IS NOT NULL AND source_ticket_id=$2::uuid) OR ($2::uuid IS NULL AND source_ticket_id IS NULL AND source_reservation_id=$3::uuid)))`,
				defID, nullStr(src.TicketID), nullStr(src.ReservationID)).Scan(&dup); err != nil {
				return "", err
			}
			if dup {
				return "", errDuplicateIssue
			}
		}
	}
	return "", conflict("retry", "発券に失敗しました。もう一度お試しください")
}

var errDuplicateIssue = conflict("duplicate_issue", "既に発券済みです")

// POST /api/v1/admin/coupon-definitions/{id}/issue {persons, count}
func (a *App) handleManualIssue(w http.ResponseWriter, r *http.Request, s *Staff) error {
	defID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Persons int `json:"persons"`
		Count   int `json:"count"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if in.Persons <= 0 {
		in.Persons = 1
	}
	if in.Count <= 0 {
		in.Count = 1
	}
	if in.Count > 200 || in.Persons > 50 {
		return badRequest("一度に発行できるのは200枚・50人分までです")
	}
	ctx := r.Context()
	var issued []map[string]any
	err = a.withTx(ctx, func(tx *sql.Tx) error {
		for i := 0; i < in.Count; i++ {
			id, err := a.issueCoupon(ctx, tx, defID, in.Persons, issueSource{Kind: "manual"}, s)
			if err != nil {
				return err
			}
			var no string
			if err := tx.QueryRowContext(ctx, `SELECT public_no FROM issued_coupons WHERE id=$1`, id).Scan(&no); err != nil {
				return err
			}
			tok := a.deriveToken("coupon", id)
			issued = append(issued, map[string]any{"id": id, "coupon_no": no, "token": tok, "url": a.Cfg.PublicBaseURL + "/c/" + tok})
		}
		return audit(ctx, tx, s, "coupon.issue_manual", "coupon_definition", defID, in)
	})
	if err != nil {
		return err
	}
	writeJSON(w, 201, map[string]any{"issued": issued})
	return nil
}

// GET /api/v1/admin/issued-coupons?definition_id=
func (a *App) handleListIssued(w http.ResponseWriter, r *http.Request, s *Staff) error {
	def := r.URL.Query().Get("definition_id")
	if def != "" && !isUUID(def) {
		return badRequest("定義IDが正しくありません")
	}
	raw, err := queryRaw(r.Context(), a.DB, `SELECT COALESCE(json_agg(x ORDER BY x.created_at DESC), '[]') FROM (
		SELECT ic.id, ic.public_no, ic.definition_id, ic.snapshot->>'name' AS name, ic.persons_total, ic.persons_remaining, ic.status,
		  ic.valid_from, ic.valid_until, ic.source_kind, ic.created_at, ic.revoke_reason,
		  (SELECT public_no FROM reservations WHERE id=ic.source_reservation_id) AS reservation_no
		FROM issued_coupons ic WHERE ($1='' OR ic.definition_id::text=$1) ORDER BY ic.created_at DESC LIMIT 1000) x`, def)
	if err != nil {
		return err
	}
	writeJSON(w, 200, raw)
	return nil
}

// POST /api/v1/admin/issued-coupons/{id}/revoke {reason}
func (a *App) handleRevokeCoupon(w http.ResponseWriter, r *http.Request, s *Staff) error {
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
		res, err := tx.ExecContext(ctx, `UPDATE issued_coupons SET status='revoked', revoked_by=$2, revoke_reason=$3, updated_at=now()
			WHERE id=$1 AND status='active'`, id, s.ID, in.Reason)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return conflict("not_active", "有効なクーポンではありません")
		}
		if err := audit(ctx, tx, s, "coupon.revoke", "issued_coupon", id, in); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return nil
	})
}

// POST /api/v1/staff/redemptions/{id}/reverse {reason} — 利用取消（残人数を復元、履歴は残す）
func (a *App) handleReverseRedemption(w http.ResponseWriter, r *http.Request, s *Staff) error {
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
		var coupon, orderID, ostatus, pay string
		var n int
		err := tx.QueryRowContext(ctx, `SELECT cr.issued_coupon_id, cr.persons+cr.forfeited_persons, o.id, o.status, o.payment_status
			FROM coupon_redemptions cr JOIN orders o ON o.id=cr.order_id WHERE cr.id=$1 AND cr.status='applied' FOR UPDATE OF cr, o`, id).
			Scan(&coupon, &n, &orderID, &ostatus, &pay)
		if err == sql.ErrNoRows {
			return conflict("not_applied", "取り消せる利用記録ではありません")
		}
		if err != nil {
			return err
		}
		// 割引後の金額で支払いが成立している注文のまま復元すると二重に割引できてしまうため、
		// 全額返金済みまたは未払いで取消済みの注文に限る。
		if pay != "refunded" && !(ostatus == "cancelled" && pay == "unpaid") {
			return unprocessable("order_still_paid", "クーポンを戻すには、先にその注文を全額返金してください")
		}
		if _, err := tx.ExecContext(ctx, `UPDATE coupon_redemptions SET status='reversed', reversed_by=$2, reversed_at=now(), reverse_reason=$3 WHERE id=$1`, id, s.ID, in.Reason); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE issued_coupons SET persons_remaining=persons_remaining+$2,
			status=CASE WHEN status='revoked' THEN status ELSE 'active' END, updated_at=now() WHERE id=$1`, coupon, n); err != nil {
			return err
		}
		if err := audit(ctx, tx, s, "coupon.redemption_reverse", "coupon_redemption", id, in); err != nil {
			return err
		}
		if err := publish(ctx, tx, "orders"); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return nil
	})
}

// ---------------------------------------------------------------
// 来場者：クーポン表示
// ---------------------------------------------------------------

func issuedCouponJSON(ctx context.Context, q queryer, where string, arg any) (json.RawMessage, error) {
	return queryRaw(ctx, q, `SELECT COALESCE(json_agg(x ORDER BY x.created_at), '[]') FROM (
		SELECT ic.id, ic.public_no AS coupon_no, ic.snapshot->>'name' AS name, ic.snapshot->>'description' AS description,
		  ic.snapshot AS conditions, ic.persons_total, ic.persons_remaining, ic.status, ic.valid_from, ic.valid_until, ic.created_at
		FROM issued_coupons ic WHERE `+where+`) x`, arg)
}

// GET /api/v1/public/coupons/by-token/{token}
func (a *App) handlePublicCoupon(w http.ResponseWriter, r *http.Request) error {
	if err := a.rateLimit(r, "coupon_view", 60, 30); err != nil {
		return err
	}
	token := strings.TrimSpace(r.PathValue("token"))
	raw, err := issuedCouponJSON(r.Context(), a.DB, "ic.token_hash=$1", hashToken("coupon", token))
	if err != nil {
		return err
	}
	var list []map[string]any
	_ = json.Unmarshal(raw, &list)
	if len(list) == 0 {
		return notFound("クーポン")
	}
	c := list[0]
	var snap couponSnapshot
	b, _ := json.Marshal(c["conditions"])
	_ = json.Unmarshal(b, &snap)
	c["summary"] = couponSummary(&snap)
	c["token"] = token
	writeJSON(w, 200, c)
	return nil
}
