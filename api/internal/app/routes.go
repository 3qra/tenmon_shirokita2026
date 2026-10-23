package app

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"slices"
)

var (
	roleAdmin     = []string{"admin"}
	roleCashier   = []string{"cashier", "treasurer", "admin"}
	roleKitchen   = []string{"kitchen", "cashier", "admin"}
	roleReception = []string{"reception", "admin"}
	roleTreasurer = []string{"treasurer", "admin"}
	roleDisplay   = []string{"display", "admin"}
	roleCashView  = []string{"cashier", "treasurer", "admin"}
	anyStaff      = []string{}
	ordersView    = []string{"cashier", "kitchen", "treasurer", "admin"}
)

func (a *App) routes(mux *http.ServeMux) {
	h := func(f func(w http.ResponseWriter, r *http.Request) error) http.Handler { return handler(f) }
	st := a.staffOnly

	mux.Handle("GET /healthz", h(func(w http.ResponseWriter, r *http.Request) error {
		if err := a.DB.PingContext(r.Context()); err != nil {
			writeJSON(w, 503, map[string]any{"ok": false, "db": err.Error()})
			return nil
		}
		writeJSON(w, 200, map[string]any{"ok": true, "time": a.Now()})
		return nil
	}))

	// ---- 共通 ----
	mux.Handle("GET /api/v1/events", h(a.handleEvents))
	mux.Handle("GET /api/v1/business-days", h(a.handleListBusinessDays))

	// ---- 認証 ----
	mux.Handle("POST /api/v1/auth/login", h(a.handleLogin))
	mux.Handle("POST /api/v1/auth/logout", h(a.handleLogout))
	mux.Handle("GET /api/v1/auth/me", st(anyStaff, a.handleMe))
	mux.Handle("POST /api/v1/auth/password", st(anyStaff, a.handleChangePassword))

	// ---- 来場者（公開） ----
	mux.Handle("GET /api/v1/public/departments", h(a.handlePublicDepartments))
	mux.Handle("GET /api/v1/public/departments/{id}/products", h(a.handlePublicProducts))
	mux.Handle("GET /api/v1/public/departments/{id}/board", h(a.handleBoard))
	mux.Handle("POST /api/v1/public/orders/quote", h(a.handleQuote))
	mux.Handle("POST /api/v1/public/orders", a.idempotent("public_order", h(a.handlePublicCreateOrder)))
	mux.Handle("GET /api/v1/public/orders/by-token/{token}", h(a.handlePublicGetOrder))
	mux.Handle("POST /api/v1/public/orders/by-token/{token}/cancel", h(a.handlePublicCancelOrder))
	mux.Handle("GET /api/v1/public/screenings", h(a.handlePublicScreenings))
	mux.Handle("GET /api/v1/public/screenings/{id}", h(a.handlePublicScreening))
	mux.Handle("GET /api/v1/public/screening-board", h(a.handleScreeningBoard))
	mux.Handle("POST /api/v1/public/reservations", a.idempotent("public_reservation", h(a.handlePublicCreateReservation)))
	mux.Handle("GET /api/v1/public/reservations/by-token/{token}", h(a.handlePublicGetReservation))
	mux.Handle("POST /api/v1/public/reservations/by-token/{token}/cancel", h(a.handlePublicCancelReservation))
	mux.Handle("GET /api/v1/public/reservations/by-token/{token}/tickets/{seq}/wallet", h(a.handleWalletPass))
	mux.Handle("GET /api/v1/public/coupons/by-token/{token}", h(a.handlePublicCoupon))

	// ---- 表示端末 ----
	mux.Handle("GET /api/v1/display/departments/{id}/site-code", st(roleDisplay, a.handleDisplaySiteCode))
	mux.Handle("POST /api/v1/display/heartbeat", st(roleDisplay, a.handleDisplayHeartbeat))

	// ---- スタッフ：注文・会計・キッチン ----
	mux.Handle("GET /api/v1/staff/departments", st(anyStaff, a.handleStaffDepartments))
	mux.Handle("GET /api/v1/staff/departments/{id}/products", st(anyStaff, a.handleStaffProducts))
	mux.Handle("PATCH /api/v1/staff/variants/{id}", st(roleCashier, a.handleUpdateVariant))
	mux.Handle("POST /api/v1/staff/orders", a.staffIdem("staff_order", roleCashier, a.handleStaffCreateOrder))
	mux.Handle("GET /api/v1/staff/orders", st(ordersView, a.handleStaffListOrders))
	mux.Handle("GET /api/v1/staff/orders/{id}", st(ordersView, a.handleStaffGetOrder))
	mux.Handle("POST /api/v1/staff/orders/{id}/cancel", st(roleCashier, a.handleStaffCancelOrder))
	mux.Handle("POST /api/v1/staff/orders/{id}/items/{item}/cancel", st(roleCashier, a.handleCancelOrderItem))
	mux.Handle("POST /api/v1/staff/orders/{id}/quote", st(roleCashier, a.handleOrderPaymentQuote))
	mux.Handle("POST /api/v1/staff/orders/{id}/payment", a.staffIdem("payment", roleCashier, a.handlePayment))
	mux.Handle("POST /api/v1/staff/orders/{id}/refund", a.staffIdem("refund", roleTreasurer, a.handleRefund))
	mux.Handle("POST /api/v1/staff/orders/{id}/handoff", st(roleCashier, a.handleHandoff))
	mux.Handle("POST /api/v1/staff/orders/{id}/handoff/revert", st(roleCashier, a.handleHandoffRevert))
	mux.Handle("GET /api/v1/staff/kitchen", st(roleKitchen, a.handleKitchen))
	mux.Handle("POST /api/v1/staff/order-items/{id}/cook", st(roleKitchen, a.handleCookItem))
	mux.Handle("GET /api/v1/staff/coupons/verify/{token}", st(roleCashier, a.handleVerifyCoupon))
	mux.Handle("POST /api/v1/staff/redemptions/{id}/reverse", st(roleTreasurer, a.handleReverseRedemption))

	// ---- スタッフ：プラネ受付 ----
	mux.Handle("GET /api/v1/staff/screenings", st(anyStaff, a.handleStaffScreenings))
	mux.Handle("POST /api/v1/staff/walkins", a.staffIdem("walkin", roleReception, a.handleWalkin))
	mux.Handle("GET /api/v1/staff/reservations", st(roleReception, a.handleStaffReservations))
	mux.Handle("GET /api/v1/staff/reservations/{id}", st(roleReception, a.handleStaffReservation))
	mux.Handle("POST /api/v1/staff/reservations/{id}/cancel", st(roleReception, a.handleStaffCancelReservation))
	mux.Handle("POST /api/v1/staff/reservations/{id}/reissue-link", st(roleReception, a.handleReissueReservationLink))
	mux.Handle("POST /api/v1/staff/checkin/verify", st(roleReception, a.handleCheckinVerify))
	mux.Handle("POST /api/v1/staff/checkin", a.staffIdem("checkin", roleReception, a.handleCheckin))
	mux.Handle("POST /api/v1/staff/tickets/{id}/revert", st(roleAdmin, a.handleCheckinRevert))

	// ---- スタッフ：現金 ----
	mux.Handle("GET /api/v1/staff/cash/accounts", st(roleCashView, a.handleCashAccounts))
	mux.Handle("GET /api/v1/staff/cash/accounts/{id}/entries", st(roleCashView, a.handleCashEntries))
	mux.Handle("POST /api/v1/staff/cash/transfers", a.staffIdem("cash_transfer", roleCashView, a.handleRequestTransfer))
	mux.Handle("GET /api/v1/staff/cash/transfers", st(roleCashView, a.handleListTransfers))
	mux.Handle("GET /api/v1/staff/cash/destinations", st(roleCashView, a.handleCashDestinations))
	mux.Handle("POST /api/v1/staff/cash/transfers/{id}/decide", st(roleCashView, a.handleDecideTransfer))

	// ---- 会計責任者 ----
	mux.Handle("POST /api/v1/treasurer/cash/opening", a.staffIdem("cash_opening", roleTreasurer, a.handleOpeningCash))
	mux.Handle("POST /api/v1/treasurer/cash/reconciliations", a.staffIdem("reconcile", roleTreasurer, a.handleReconcile))
	mux.Handle("GET /api/v1/treasurer/cash/reconciliations", st(roleTreasurer, a.handleListReconciliations))
	mux.Handle("GET /api/v1/treasurer/sales", st(roleTreasurer, a.handleSales))

	// ---- シフト・通知 ----
	mux.Handle("GET /api/v1/staff/shifts", st(anyStaff, a.handleShifts))
	mux.Handle("PUT /api/v1/staff/shift-slots/{id}/request", st(anyStaff, a.handleShiftRequest))
	mux.Handle("GET /api/v1/staff/shift-exchanges", st(anyStaff, a.handleListExchanges))
	mux.Handle("POST /api/v1/staff/shift-exchanges", st(anyStaff, a.handleRequestExchange))
	mux.Handle("POST /api/v1/staff/shift-exchanges/{id}/respond", st(anyStaff, a.exchangeActions([]string{"accept", "decline", "cancel"})))
	mux.Handle("GET /api/v1/staff/members/directory", st(anyStaff, a.handleMemberDirectory))
	mux.Handle("GET /api/v1/staff/notifications", st(anyStaff, a.handleListNotifications))
	mux.Handle("POST /api/v1/staff/notifications/read", st(anyStaff, a.handleReadNotifications))

	// ---- 管理 ----
	mux.Handle("GET /api/v1/admin/settings/limits", st(roleAdmin, a.handleGetLimits))
	mux.Handle("PUT /api/v1/admin/settings/limits", st(roleAdmin, a.handlePutLimits))
	mux.Handle("GET /api/v1/admin/settings/voucher-change", st(roleAdmin, a.handleGetVoucherChange))
	mux.Handle("PUT /api/v1/admin/settings/voucher-change", st(roleAdmin, a.handlePutVoucherChange))
	mux.Handle("PUT /api/v1/admin/business-days", st(roleAdmin, a.handlePutBusinessDays))
	mux.Handle("POST /api/v1/admin/departments", st(roleAdmin, a.handleCreateDepartment))
	mux.Handle("PATCH /api/v1/admin/departments/{id}", st(roleAdmin, a.handleUpdateDepartment))
	mux.Handle("GET /api/v1/admin/displays", st(roleAdmin, a.handleDisplayStatus))
	mux.Handle("POST /api/v1/admin/products", st(roleAdmin, a.handleCreateProduct))
	mux.Handle("PATCH /api/v1/admin/products/{id}", st(roleAdmin, a.handleUpdateProduct))
	mux.Handle("POST /api/v1/admin/products/{id}/option-groups", st(roleAdmin, a.handleAddOptionGroup))
	mux.Handle("POST /api/v1/admin/option-groups/{id}/values", st(roleAdmin, a.handleAddOptionValue))
	mux.Handle("PATCH /api/v1/admin/option-groups/{id}", st(roleAdmin, a.handleUpdateOption("option_groups")))
	mux.Handle("PATCH /api/v1/admin/option-values/{id}", st(roleAdmin, a.handleUpdateOption("option_values")))
	mux.Handle("GET /api/v1/admin/members", st(roleAdmin, a.handleListMembers))
	mux.Handle("POST /api/v1/admin/members", st(roleAdmin, a.handleCreateMember))
	mux.Handle("PATCH /api/v1/admin/members/{id}", st(roleAdmin, a.handleUpdateMember))
	mux.Handle("POST /api/v1/admin/cash/accounts", st(roleAdmin, a.handleCreateCashAccount))
	mux.Handle("PATCH /api/v1/admin/cash/accounts/{id}", st(roleAdmin, a.handleUpdateCashAccount))
	mux.Handle("POST /api/v1/admin/screening-rules/preview", st(roleAdmin, a.handleRulePreview))
	mux.Handle("POST /api/v1/admin/screening-rules", st(roleAdmin, a.handleRuleGenerate))
	mux.Handle("POST /api/v1/admin/screenings", st(roleAdmin, a.handleCreateScreening))
	mux.Handle("PATCH /api/v1/admin/screenings/{id}", st(roleAdmin, a.handleUpdateScreening))
	mux.Handle("POST /api/v1/admin/screenings/{id}/cancel", st(roleAdmin, a.handleCancelScreening))
	mux.Handle("GET /api/v1/admin/coupon-definitions", st(roleAdmin, a.handleListCouponDefs))
	mux.Handle("POST /api/v1/admin/coupon-definitions", st(roleAdmin, a.handleCreateCouponDef))
	mux.Handle("PUT /api/v1/admin/coupon-definitions/{id}", st(roleAdmin, a.handleUpdateCouponDef))
	mux.Handle("POST /api/v1/admin/coupon-definitions/{id}/issue", st(roleAdmin, a.handleManualIssue))
	mux.Handle("GET /api/v1/admin/issued-coupons", st(roleAdmin, a.handleListIssued))
	mux.Handle("POST /api/v1/admin/issued-coupons/{id}/revoke", st(roleAdmin, a.handleRevokeCoupon))
	mux.Handle("GET /api/v1/admin/blocks", st(roleAdmin, a.handleListBlocks))
	mux.Handle("POST /api/v1/admin/blocks", st(roleAdmin, a.handleCreateBlock))
	mux.Handle("POST /api/v1/admin/blocks/{id}/lift", st(roleAdmin, a.handleLiftBlock))
	mux.Handle("POST /api/v1/admin/shift-slots", st(roleAdmin, a.handleCreateShiftSlot))
	mux.Handle("PATCH /api/v1/admin/shift-slots/{id}", st(roleAdmin, a.handleUpdateShiftSlot))
	mux.Handle("POST /api/v1/admin/shift-slots/{id}/assignments", st(roleAdmin, a.handleAssignShift))
	mux.Handle("POST /api/v1/admin/shift-assignments/{id}/remove", st(roleAdmin, a.handleRemoveAssignment))
	mux.Handle("POST /api/v1/admin/shift-exchanges/{id}/decide", st(roleAdmin, a.exchangeActions([]string{"approve", "reject"})))
	mux.Handle("GET /api/v1/admin/audit-logs", st(roleAdmin, a.handleAuditLogs))

	mux.Handle("/api/", h(func(w http.ResponseWriter, r *http.Request) error { return notFound("API") }))
}

// PUT /api/v1/admin/settings/voucher-change {allowed}
func (a *App) handlePutVoucherChange(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var in struct {
		Allowed bool `json:"allowed"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	v := "false"
	if in.Allowed {
		v = "true"
	}
	err := a.withTx(r.Context(), func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(r.Context(), `INSERT INTO settings(key, value) VALUES ('voucher_change_allowed',$1)
			ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, v); err != nil {
			return err
		}
		return audit(r.Context(), tx, s, "settings.voucher_change", "settings", "voucher_change_allowed", in)
	})
	if err != nil {
		return err
	}
	writeJSON(w, 200, in)
	return nil
}

// GET /api/v1/admin/settings/voucher-change
func (a *App) handleGetVoucherChange(w http.ResponseWriter, r *http.Request, s *Staff) error {
	v, err := a.voucherChangeAllowed(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"allowed": v})
	return nil
}

// exchangeActions は交代申請の操作を経路ごとに制限する（本人用と管理者用を分ける）。
func (a *App) exchangeActions(allowed []string) func(w http.ResponseWriter, r *http.Request, s *Staff) error {
	return func(w http.ResponseWriter, r *http.Request, s *Staff) error {
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			return badRequest("リクエストを読み取れません")
		}
		var peek struct {
			Action string `json:"action"`
		}
		_ = json.Unmarshal(body, &peek)
		if !slices.Contains(allowed, peek.Action) {
			return badRequest("この画面ではその操作はできません")
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		return a.handleRespondExchange(w, r, s)
	}
}
