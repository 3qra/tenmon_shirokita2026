package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// seatSymbol は確保済み人数と定員から空席記号を決める（整数演算で浮動小数誤差を避ける）。
func seatSymbol(taken, capacity, thresholdPct int) string {
	if taken >= capacity {
		return "×"
	}
	if taken*100 >= capacity*thresholdPct {
		return "△"
	}
	return "○"
}

type screeningRow struct {
	ID              string     `json:"id"`
	DepartmentID    string     `json:"department_id"`
	Title           string     `json:"title"`
	BusinessDay     string     `json:"business_day"`
	StartsAt        time.Time  `json:"starts_at"`
	EndsAt          time.Time  `json:"ends_at"`
	Capacity        int        `json:"capacity"`
	ReserveQuota    *int       `json:"reserve_quota"`
	ReservedCount   int        `json:"reserved_count"`
	WalkinCount     int        `json:"walkin_count"`
	BookingOpensAt  *time.Time `json:"booking_opens_at"`
	BookingClosesAt *time.Time `json:"booking_closes_at"`
	Visibility      string     `json:"visibility"`
	BookingStatus   string     `json:"booking_status"`
	RunStatus       string     `json:"run_status"`
	ManuallyEdited  bool       `json:"manually_edited"`
	CancelReason    *string    `json:"cancel_reason,omitempty"`
	AdmittedCount   int        `json:"admitted_count"`
	// 計算値
	Taken            int    `json:"taken"`
	Symbol           string `json:"symbol"`
	StatusText       string `json:"status_text"`
	AdvanceAvailable int    `json:"advance_available"`
	WalkinAvailable  int    `json:"walkin_available"`
	AdvanceOpen      bool   `json:"advance_open"`
}

const screeningCols = `s.id, s.department_id, s.title, s.business_day::text, s.starts_at, s.ends_at, s.capacity, s.reserve_quota,
	s.reserved_count, s.walkin_count, s.booking_opens_at, s.booking_closes_at, s.visibility, s.booking_status, s.run_status,
	s.manually_edited, s.cancel_reason,
	(SELECT count(*) FROM admission_tickets t WHERE t.screening_id=s.id AND t.admitted_at IS NOT NULL AND t.status='valid')`

func scanScreening(row interface{ Scan(...any) error }) (*screeningRow, error) {
	var s screeningRow
	var rq sql.NullInt64
	var bo, bc sql.NullTime
	var cr sql.NullString
	if err := row.Scan(&s.ID, &s.DepartmentID, &s.Title, &s.BusinessDay, &s.StartsAt, &s.EndsAt, &s.Capacity, &rq,
		&s.ReservedCount, &s.WalkinCount, &bo, &bc, &s.Visibility, &s.BookingStatus, &s.RunStatus, &s.ManuallyEdited, &cr,
		&s.AdmittedCount); err != nil {
		return nil, err
	}
	if rq.Valid {
		v := int(rq.Int64)
		s.ReserveQuota = &v
	}
	if bo.Valid {
		s.BookingOpensAt = &bo.Time
	}
	if bc.Valid {
		s.BookingClosesAt = &bc.Time
	}
	if cr.Valid {
		s.CancelReason = &cr.String
	}
	return &s, nil
}

func (s *screeningRow) compute(now time.Time, thresholdPct int) {
	s.Taken = s.ReservedCount + s.WalkinCount
	s.Symbol = seatSymbol(s.Taken, s.Capacity, thresholdPct)
	free := s.Capacity - s.Taken
	s.WalkinAvailable = free
	s.AdvanceAvailable = free
	if s.ReserveQuota != nil && *s.ReserveQuota-s.ReservedCount < free {
		s.AdvanceAvailable = *s.ReserveQuota - s.ReservedCount
	}
	if s.AdvanceAvailable < 0 {
		s.AdvanceAvailable = 0
	}
	s.AdvanceOpen = s.RunStatus == "scheduled" && s.BookingStatus == "open" &&
		(s.BookingOpensAt == nil || !now.Before(*s.BookingOpensAt)) &&
		(s.BookingClosesAt == nil || now.Before(*s.BookingClosesAt)) && now.Before(s.StartsAt)
	switch {
	case s.RunStatus == "cancelled":
		s.StatusText = "上映中止"
	case s.RunStatus == "finished":
		s.StatusText = "上映終了"
	case s.RunStatus == "running":
		s.StatusText = "上映中"
	case s.BookingStatus == "paused":
		s.StatusText = "受付停止中"
	case s.BookingStatus == "closed":
		s.StatusText = "受付終了"
	case s.BookingOpensAt != nil && now.Before(*s.BookingOpensAt):
		s.StatusText = "受付開始前"
	case s.BookingClosesAt != nil && !now.Before(*s.BookingClosesAt):
		s.StatusText = "事前予約終了"
	default:
		s.StatusText = ""
	}
}

func (a *App) getScreening(ctx context.Context, q queryer, id string, lock bool) (*screeningRow, error) {
	query := `SELECT ` + screeningCols + ` FROM screenings s WHERE s.id=$1`
	if lock {
		query += ` FOR UPDATE`
	}
	s, err := scanScreening(q.QueryRowContext(ctx, query, id))
	if err == sql.ErrNoRows {
		return nil, notFound("上映")
	}
	return s, err
}

func (a *App) listScreenings(ctx context.Context, day string, publicOnly bool) ([]*screeningRow, error) {
	cond := "($1='' OR s.business_day::text=$1)"
	if publicOnly {
		cond += " AND s.visibility='public' AND s.ends_at > now()"
	}
	rows, err := a.DB.QueryContext(ctx, `SELECT `+screeningCols+` FROM screenings s WHERE `+cond+` ORDER BY s.starts_at`, day)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	l, err := a.limits(ctx, a.DB)
	if err != nil {
		return nil, err
	}
	now := a.Now()
	out := []*screeningRow{}
	for rows.Next() {
		s, err := scanScreening(rows)
		if err != nil {
			return nil, err
		}
		s.compute(now, l.SeatThresholdPercent)
		out = append(out, s)
	}
	return out, rows.Err()
}

// GET /api/v1/public/screenings?day=
func (a *App) handlePublicScreenings(w http.ResponseWriter, r *http.Request) error {
	day, err := queryDate(r, "day")
	if err != nil {
		return err
	}
	list, err := a.listScreenings(r.Context(), day, true)
	if err != nil {
		return err
	}
	// 来場者には定員の内訳ではなく記号と状態を返す
	type pub struct {
		ID               string    `json:"id"`
		Title            string    `json:"title"`
		BusinessDay      string    `json:"business_day"`
		StartsAt         time.Time `json:"starts_at"`
		EndsAt           time.Time `json:"ends_at"`
		Symbol           string    `json:"symbol"`
		StatusText       string    `json:"status_text"`
		AdvanceOpen      bool      `json:"advance_open"`
		AdvanceAvailable bool      `json:"advance_available"`
		WalkinAvailable  bool      `json:"walkin_available"`
		RunStatus        string    `json:"run_status"`
	}
	out := []pub{}
	for _, s := range list {
		out = append(out, pub{s.ID, s.Title, s.BusinessDay, s.StartsAt, s.EndsAt, s.Symbol, s.StatusText, s.AdvanceOpen,
			s.AdvanceAvailable > 0, s.WalkinAvailable > 0 && s.RunStatus == "scheduled", s.RunStatus})
	}
	writeJSON(w, 200, map[string]any{"screenings": out, "server_time": a.Now()})
	return nil
}

// GET /api/v1/public/screenings/{id}
func (a *App) handlePublicScreening(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	s, err := a.getScreening(ctx, a.DB, id, false)
	if err != nil {
		return err
	}
	if s.Visibility != "public" {
		return notFound("上映")
	}
	l, err := a.limits(ctx, a.DB)
	if err != nil {
		return err
	}
	s.compute(a.Now(), l.SeatThresholdPercent)
	maxParty := l.MaxPartySize
	if s.AdvanceAvailable < maxParty {
		maxParty = s.AdvanceAvailable
	}
	writeJSON(w, 200, map[string]any{
		"id": s.ID, "title": s.Title, "business_day": s.BusinessDay, "starts_at": s.StartsAt, "ends_at": s.EndsAt,
		"symbol": s.Symbol, "status_text": s.StatusText, "advance_open": s.AdvanceOpen, "advance_available": s.AdvanceAvailable > 0,
		"walkin_available": s.WalkinAvailable > 0 && s.RunStatus == "scheduled", "max_party_size": maxParty, "run_status": s.RunStatus,
	})
	return nil
}

// GET /api/v1/staff/screenings?day=
func (a *App) handleStaffScreenings(w http.ResponseWriter, r *http.Request, st *Staff) error {
	day, err := queryDate(r, "day")
	if err != nil {
		return err
	}
	if day == "" && r.URL.Query().Get("all") != "1" {
		day = a.today()
	}
	list, err := a.listScreenings(r.Context(), day, false)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"screenings": list, "server_time": a.Now()})
	return nil
}

// ---------------------------------------------------------------
// 予約・当日受付
// ---------------------------------------------------------------

func (a *App) nextReservationNo(ctx context.Context, tx *sql.Tx, day string) (string, error) {
	var n int
	if err := tx.QueryRowContext(ctx, `INSERT INTO reservation_counters(business_day, last_number) VALUES ($1,1)
		ON CONFLICT (business_day) DO UPDATE SET last_number=reservation_counters.last_number+1 RETURNING last_number`, day).Scan(&n); err != nil {
		return "", err
	}
	t, _ := time.Parse("2006-01-02", day)
	return fmt.Sprintf("%02d-%03d", t.Day(), n), nil
}

type reservationResult struct {
	ID          string `json:"id"`
	PublicNo    string `json:"reservation_no"`
	AccessToken string `json:"access_token,omitempty"`
	URL         string `json:"url,omitempty"`
}

// createReservationTx は定員を行ロックで確認して予約と人数分の入場チケットを作る。
func (a *App) createReservationTx(ctx context.Context, tx *sql.Tx, screeningID, kind, name string, party int,
	clientID string, staff *Staff, withToken bool) (*reservationResult, error) {
	s, err := a.getScreening(ctx, tx, screeningID, true)
	if err != nil {
		return nil, err
	}
	now := a.Now()
	l, err := a.limits(ctx, tx)
	if err != nil {
		return nil, err
	}
	s.compute(now, l.SeatThresholdPercent)
	if s.RunStatus == "cancelled" {
		return nil, unprocessable("screening_cancelled", "この上映は中止になりました")
	}
	if kind == "advance" {
		if s.Visibility != "public" || !s.AdvanceOpen {
			msg := s.StatusText
			if msg == "" {
				msg = "受付できません"
			}
			return nil, unprocessable("booking_closed", "この上映は現在予約できません（%s）", msg)
		}
		if party > s.AdvanceAvailable {
			if s.AdvanceAvailable == 0 {
				return nil, unprocessable("full", "満席のため予約できません")
			}
			return nil, unprocessable("not_enough_seats", "残り%d人分のため、%d人では予約できません", s.AdvanceAvailable, party)
		}
	} else {
		if s.RunStatus == "finished" {
			return nil, unprocessable("finished", "この上映は終了しています")
		}
		if party > s.WalkinAvailable {
			return nil, unprocessable("not_enough_seats", "残り%d人分のため受付できません", s.WalkinAvailable)
		}
	}
	no, err := a.nextReservationNo(ctx, tx, s.BusinessDay)
	if err != nil {
		return nil, err
	}
	res := &reservationResult{PublicNo: no}
	var tokenHash any
	if withToken {
		res.AccessToken = randomToken()
		res.URL = a.Cfg.PublicBaseURL + "/r/" + res.AccessToken
		tokenHash = hashToken("reservation", res.AccessToken)
	}
	var createdBy any
	if staff != nil {
		createdBy = staff.ID
	}
	if err := tx.QueryRowContext(ctx, `INSERT INTO reservations(screening_id, public_no, kind, name, party_size, access_token_hash,
		client_identity_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, screeningID, no, kind, strings.TrimSpace(name),
		party, tokenHash, nullStr(clientID), createdBy).Scan(&res.ID); err != nil {
		return nil, err
	}
	col := "reserved_count"
	if kind == "walkin" {
		col = "walkin_count"
	}
	if _, err := tx.ExecContext(ctx, `UPDATE screenings SET `+col+`=`+col+`+$2, updated_at=now() WHERE id=$1`, screeningID, party); err != nil {
		return nil, err
	}
	for i := 1; i <= party; i++ {
		var tid string
		if err := tx.QueryRowContext(ctx, `SELECT gen_random_uuid()`).Scan(&tid); err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO admission_tickets(id, reservation_id, screening_id, seq, public_no, entry_token_hash)
			VALUES ($1,$2,$3,$4,$5,$6)`, tid, res.ID, screeningID, i, fmt.Sprintf("%s-%d", no, i), hashToken("entry", a.deriveToken("entry", tid))); err != nil {
			return nil, err
		}
	}
	if err := publish(ctx, tx, "screenings"); err != nil {
		return nil, err
	}
	return res, nil
}

// POST /api/v1/public/reservations (Idempotency-Key 必須) {screening_id, name, party_size}
func (a *App) handlePublicCreateReservation(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		ScreeningID string `json:"screening_id"`
		Name        string `json:"name"`
		PartySize   int    `json:"party_size"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if !isUUID(in.ScreeningID) {
		return badRequest("上映を選んでください")
	}
	if err := requireText("お名前", in.Name, 30); err != nil {
		return err
	}
	ctx := r.Context()
	l, err := a.limits(ctx, a.DB)
	if err != nil {
		return err
	}
	if err := a.rateLimit(r, "reservation", float64(l.ReservationsPerMinute), float64(l.ReservationsPerMinute)); err != nil {
		return err
	}
	if in.PartySize < 1 || in.PartySize > l.MaxPartySize {
		return badRequest("人数は1〜%d人で指定してください", l.MaxPartySize)
	}
	client, err := a.resolveClient(ctx, w, r)
	if err != nil {
		return err
	}
	var res *reservationResult
	err = a.withTx(ctx, func(tx *sql.Tx) error {
		if err := checkBlocked(ctx, tx, client.ID, "reservation"); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `SELECT 1 FROM client_identities WHERE id=$1 FOR UPDATE`, client.ID); err != nil {
			return err
		}
		var future int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM reservations rv JOIN screenings s ON s.id=rv.screening_id
			WHERE rv.client_identity_id=$1 AND rv.status='confirmed' AND s.ends_at > now() AND s.run_status IN ('scheduled','running')`,
			client.ID).Scan(&future); err != nil {
			return err
		}
		if future >= l.MaxFutureReservations {
			return unprocessable("too_many_reservations", "お一人が同時に持てる予約は%d件までです", l.MaxFutureReservations)
		}
		var deptStatus string
		if err := tx.QueryRowContext(ctx, `SELECT d.business_status FROM screenings s JOIN departments d ON d.id=s.department_id
			WHERE s.id=$1 FOR SHARE OF d`, in.ScreeningID).Scan(&deptStatus); err != nil {
			if err == sql.ErrNoRows {
				return notFound("上映")
			}
			return err
		}
		if deptStatus == "paused" || deptStatus == "closed" {
			return unprocessable("not_open", "現在、予約を受け付けていません")
		}
		res, err = a.createReservationTx(ctx, tx, in.ScreeningID, "advance", in.Name, in.PartySize, client.ID, nil, true)
		return err
	})
	if err != nil {
		return err
	}
	writeJSON(w, 201, res)
	return nil
}

// reservationDetail は予約・上映・チケット（QR用トークン付き）・発券済みクーポンを返す。
func (a *App) reservationDetail(ctx context.Context, q queryer, reservationID string, includeTokens bool) (map[string]any, error) {
	var out map[string]any
	if err := queryJSON(ctx, q, &out, `SELECT row_to_json(x) FROM (
		SELECT rv.id, rv.public_no AS reservation_no, rv.kind, rv.name, rv.party_size, rv.status, rv.cancel_reason, rv.created_at, rv.cancelled_at,
		  json_build_object('id',s.id,'title',s.title,'starts_at',s.starts_at,'ends_at',s.ends_at,'run_status',s.run_status,
		    'business_day',s.business_day,'cancel_reason',s.cancel_reason) AS screening,
		  COALESCE((SELECT json_agg(json_build_object('id',t.id,'seq',t.seq,'ticket_no',t.public_no,'status',t.status,'admitted_at',t.admitted_at,'v',t.token_version)
		    ORDER BY t.seq) FROM admission_tickets t WHERE t.reservation_id=rv.id), '[]') AS tickets,
		  COALESCE((SELECT json_agg(json_build_object('id',ic.id,'coupon_no',ic.public_no,'name',ic.snapshot->>'name',
		    'persons_total',ic.persons_total,'persons_remaining',ic.persons_remaining,'status',ic.status,'valid_until',ic.valid_until,'v',ic.token_version)
		    ORDER BY ic.created_at) FROM issued_coupons ic WHERE ic.source_reservation_id=rv.id), '[]') AS coupons
		FROM reservations rv JOIN screenings s ON s.id=rv.screening_id WHERE rv.id=$1) x`, reservationID); err != nil {
		return nil, err
	}
	if out == nil {
		return nil, notFound("予約")
	}
	if !includeTokens {
		for _, key := range []string{"tickets", "coupons"} {
			if list, ok := out[key].([]any); ok {
				for _, x := range list {
					delete(x.(map[string]any), "v")
				}
			}
		}
	}
	if includeTokens {
		if tickets, ok := out["tickets"].([]any); ok {
			for _, t := range tickets {
				m := t.(map[string]any)
				v, _ := m["v"].(float64)
				m["entry_token"] = a.entryToken(m["id"].(string), int(v))
				delete(m, "v")
			}
		}
		if coupons, ok := out["coupons"].([]any); ok {
			for _, c := range coupons {
				m := c.(map[string]any)
				v, _ := m["v"].(float64)
				m["token"] = a.couponToken(m["id"].(string), int(v))
				delete(m, "v")
			}
		}
	}
	return out, nil
}

func (a *App) reservationIDByToken(ctx context.Context, q queryer, token string, lock bool) (string, error) {
	query := `SELECT id FROM reservations WHERE access_token_hash=$1`
	if lock {
		query += ` FOR UPDATE`
	}
	var id string
	err := q.QueryRowContext(ctx, query, hashToken("reservation", token)).Scan(&id)
	if err == sql.ErrNoRows {
		return "", notFound("予約")
	}
	return id, err
}

// GET /api/v1/public/reservations/by-token/{token}
func (a *App) handlePublicGetReservation(w http.ResponseWriter, r *http.Request) error {
	if err := a.rateLimit(r, "reservation_view", 120, 60); err != nil {
		return err
	}
	ctx := r.Context()
	id, err := a.reservationIDByToken(ctx, a.DB, r.PathValue("token"), false)
	if err != nil {
		return err
	}
	d, err := a.reservationDetail(ctx, a.DB, id, true)
	if err != nil {
		return err
	}
	d["wallet_enabled"] = a.walletEnabled()
	writeJSON(w, 200, d)
	return nil
}

// POST /api/v1/public/reservations/by-token/{token}/cancel
// 本人取消：入場前・締切前のみ。席を解放し、履歴は残す。
func (a *App) handlePublicCancelReservation(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	l, err := a.limits(ctx, a.DB)
	if err != nil {
		return err
	}
	return a.withTx(ctx, func(tx *sql.Tx) error {
		id, err := a.reservationIDByToken(ctx, tx, r.PathValue("token"), false)
		if err != nil {
			return err
		}
		var screeningID string
		var startsAt time.Time
		if err := tx.QueryRowContext(ctx, `SELECT s.id, s.starts_at FROM reservations rv JOIN screenings s ON s.id=rv.screening_id WHERE rv.id=$1`, id).
			Scan(&screeningID, &startsAt); err != nil {
			return err
		}
		if !a.Now().Before(startsAt.Add(-time.Duration(l.VisitorCancelBeforeMin) * time.Minute)) {
			return unprocessable("cancel_deadline", "取消の締切を過ぎています。会場のスタッフにお申し出ください")
		}
		if err := a.cancelReservationTx(ctx, tx, id, screeningID, "cancelled_self", nil, "本人による取消"); err != nil {
			return err
		}
		d, err := a.reservationDetail(ctx, tx, id, true)
		if err != nil {
			return err
		}
		writeJSON(w, 200, d)
		return nil
	})
}

// cancelReservationTx は上映行→予約行の順でロックし、入場済みチケットがあれば取り消さない。
func (a *App) cancelReservationTx(ctx context.Context, tx *sql.Tx, id, screeningID, status string, s *Staff, reason string) error {
	if _, err := tx.ExecContext(ctx, `SELECT 1 FROM screenings WHERE id=$1 FOR UPDATE`, screeningID); err != nil {
		return err
	}
	var cur, kind string
	var party int
	if err := tx.QueryRowContext(ctx, `SELECT status, kind, party_size FROM reservations WHERE id=$1 FOR UPDATE`, id).Scan(&cur, &kind, &party); err != nil {
		return err
	}
	if cur != "confirmed" {
		return conflict("already_cancelled", "この予約は既に取り消されています")
	}
	var admitted int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM admission_tickets WHERE reservation_id=$1 AND admitted_at IS NOT NULL`, id).Scan(&admitted); err != nil {
		return err
	}
	if admitted > 0 && status != "cancelled_screening" {
		return conflict("already_admitted", "入場済みのチケットがあるため取り消せません")
	}
	var by any
	if s != nil {
		by = s.ID
	}
	if _, err := tx.ExecContext(ctx, `UPDATE reservations SET status=$2, cancelled_by=$3, cancel_reason=$4, cancelled_at=now(), updated_at=now() WHERE id=$1`,
		id, status, by, reason); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE admission_tickets SET status='void', updated_at=now() WHERE reservation_id=$1 AND admitted_at IS NULL`, id); err != nil {
		return err
	}
	if status != "cancelled_screening" {
		col := "reserved_count"
		if kind == "walkin" {
			col = "walkin_count"
		}
		if _, err := tx.ExecContext(ctx, `UPDATE screenings SET `+col+`=`+col+`-$2, updated_at=now() WHERE id=$1`, screeningID, party); err != nil {
			return err
		}
	}
	return publish(ctx, tx, "screenings")
}

// POST /api/v1/staff/walkins (Idempotency-Key 必須) {screening_id, party_size, name, admit_now}
func (a *App) handleWalkin(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var in struct {
		ScreeningID string `json:"screening_id"`
		PartySize   int    `json:"party_size"`
		Name        string `json:"name"`
		AdmitNow    bool   `json:"admit_now"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if !isUUID(in.ScreeningID) {
		return badRequest("上映を選んでください")
	}
	if in.PartySize < 1 || in.PartySize > 50 {
		return badRequest("人数が正しくありません")
	}
	ctx := r.Context()
	var out map[string]any
	err := a.withTx(ctx, func(tx *sql.Tx) error {
		res, err := a.createReservationTx(ctx, tx, in.ScreeningID, "walkin", in.Name, in.PartySize, "", s, true)
		if err != nil {
			return err
		}
		if in.AdmitNow {
			if _, err := tx.ExecContext(ctx, `UPDATE admission_tickets SET admitted_at=now(), admitted_by=$2, updated_at=now() WHERE reservation_id=$1`, res.ID, s.ID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO checkin_events(ticket_id, kind, detail, member_id)
				SELECT id, 'checkin', '当日受付と同時に入場', $2 FROM admission_tickets WHERE reservation_id=$1`, res.ID, s.ID); err != nil {
				return err
			}
		}
		out, err = a.reservationDetail(ctx, tx, res.ID, true)
		if err != nil {
			return err
		}
		out["access_token"] = res.AccessToken
		out["url"] = res.URL
		return nil
	})
	if err != nil {
		return err
	}
	writeJSON(w, 201, out)
	return nil
}

// GET /api/v1/staff/reservations?screening_id=&q=
func (a *App) handleStaffReservations(w http.ResponseWriter, r *http.Request, s *Staff) error {
	sid := r.URL.Query().Get("screening_id")
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if sid != "" && !isUUID(sid) {
		return badRequest("上映IDが正しくありません")
	}
	if sid == "" && q == "" {
		return badRequest("上映または検索語を指定してください")
	}
	raw, err := queryRaw(r.Context(), a.DB, `SELECT COALESCE(json_agg(x ORDER BY x.created_at), '[]') FROM (
		SELECT rv.id, rv.public_no AS reservation_no, rv.kind, rv.name, rv.party_size, rv.status, rv.created_at, rv.cancel_reason,
		  s.id AS screening_id, s.title, s.starts_at, rv.client_identity_id IS NOT NULL AS has_client_identity,
		  (SELECT count(*) FROM admission_tickets t WHERE t.reservation_id=rv.id AND t.admitted_at IS NOT NULL) AS admitted,
		  COALESCE((SELECT json_agg(json_build_object('id',t.id,'ticket_no',t.public_no,'status',t.status,'admitted_at',t.admitted_at) ORDER BY t.seq)
		    FROM admission_tickets t WHERE t.reservation_id=rv.id), '[]') AS tickets
		FROM reservations rv JOIN screenings s ON s.id=rv.screening_id
		WHERE ($1='' OR rv.screening_id::text=$1)
		  AND ($2='' OR rv.public_no ILIKE '%' || $2 || '%' OR rv.name ILIKE '%' || $2 || '%'
		       OR EXISTS (SELECT 1 FROM admission_tickets t WHERE t.reservation_id=rv.id AND t.public_no=$2))
		ORDER BY rv.created_at LIMIT 300) x`, sid, q)
	if err != nil {
		return err
	}
	writeJSON(w, 200, raw)
	return nil
}

// GET /api/v1/staff/reservations/{id}
func (a *App) handleStaffReservation(w http.ResponseWriter, r *http.Request, s *Staff) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	d, err := a.reservationDetail(r.Context(), a.DB, id, false)
	if err != nil {
		return err
	}
	writeJSON(w, 200, d)
	return nil
}

// POST /api/v1/staff/reservations/{id}/cancel {reason}
func (a *App) handleStaffCancelReservation(w http.ResponseWriter, r *http.Request, s *Staff) error {
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
		var sid string
		if err := tx.QueryRowContext(ctx, `SELECT screening_id FROM reservations WHERE id=$1`, id).Scan(&sid); err != nil {
			return err
		}
		if err := a.cancelReservationTx(ctx, tx, id, sid, "cancelled_staff", s, in.Reason); err != nil {
			return err
		}
		if err := audit(ctx, tx, s, "reservation.cancel", "reservation", id, in); err != nil {
			return err
		}
		d, err := a.reservationDetail(ctx, tx, id, false)
		if err != nil {
			return err
		}
		writeJSON(w, 200, d)
		return nil
	})
}

// POST /api/v1/staff/reservations/{id}/reissue-link {reason} — URL紛失時の再発行（旧URL・旧QRは無効）
func (a *App) handleReissueReservationLink(w http.ResponseWriter, r *http.Request, s *Staff) error {
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
	if err := requireText("理由（本人確認の方法など）", in.Reason, 200); err != nil {
		return err
	}
	ctx := r.Context()
	token := randomToken()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE reservations SET access_token_hash=$2, updated_at=now() WHERE id=$1`, id, hashToken("reservation", token))
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return notFound("予約")
		}
		// 入場QR・発券済みクーポンQRも旧URLから見えていたため作り直す
		trows, err := tx.QueryContext(ctx, `UPDATE admission_tickets SET token_version=token_version+1, updated_at=now()
			WHERE reservation_id=$1 RETURNING id, token_version`, id)
		if err != nil {
			return err
		}
		type tv struct {
			id string
			v  int
		}
		var tickets []tv
		for trows.Next() {
			var x tv
			if err := trows.Scan(&x.id, &x.v); err != nil {
				trows.Close()
				return err
			}
			tickets = append(tickets, x)
		}
		trows.Close()
		for _, x := range tickets {
			if _, err := tx.ExecContext(ctx, `UPDATE admission_tickets SET entry_token_hash=$2 WHERE id=$1`, x.id, hashToken("entry", a.entryToken(x.id, x.v))); err != nil {
				return err
			}
		}
		crows, err := tx.QueryContext(ctx, `UPDATE issued_coupons SET token_version=token_version+1, updated_at=now()
			WHERE source_reservation_id=$1 RETURNING id, token_version`, id)
		if err != nil {
			return err
		}
		var coupons []tv
		for crows.Next() {
			var x tv
			if err := crows.Scan(&x.id, &x.v); err != nil {
				crows.Close()
				return err
			}
			coupons = append(coupons, x)
		}
		crows.Close()
		for _, x := range coupons {
			if _, err := tx.ExecContext(ctx, `UPDATE issued_coupons SET token_hash=$2 WHERE id=$1`, x.id, hashToken("coupon", a.couponToken(x.id, x.v))); err != nil {
				return err
			}
		}
		if err := audit(ctx, tx, s, "reservation.reissue_link", "reservation", id, in); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"access_token": token, "url": a.Cfg.PublicBaseURL + "/r/" + token})
		return nil
	})
}

// ---------------------------------------------------------------
// QRチェックイン
// ---------------------------------------------------------------

type checkinResult struct {
	Result      string         `json:"result"` // admitted / already_admitted / cancelled / wrong_screening / screening_cancelled / not_found / void
	Message     string         `json:"message"`
	Ticket      map[string]any `json:"ticket,omitempty"`
	Reservation map[string]any `json:"reservation,omitempty"`
}

func (a *App) ticketInfo(ctx context.Context, q queryer, where string, arg any, lock bool) (map[string]any, error) {
	lockSQL := ""
	if lock {
		lockSQL = " FOR UPDATE OF t"
	}
	var id, no, status, rvStatus, rvNo, rvName, sid, title, run string
	var admittedAt sql.NullTime
	var starts time.Time
	var party, seq int
	err := q.QueryRowContext(ctx, `SELECT t.id, t.public_no, t.seq, t.status, t.admitted_at, rv.status, rv.public_no, rv.name, rv.party_size,
		s.id, s.title, s.starts_at, s.run_status
		FROM admission_tickets t JOIN reservations rv ON rv.id=t.reservation_id JOIN screenings s ON s.id=t.screening_id WHERE `+where+lockSQL, arg).
		Scan(&id, &no, &seq, &status, &admittedAt, &rvStatus, &rvNo, &rvName, &party, &sid, &title, &starts, &run)
	if err != nil {
		return nil, err
	}
	m := map[string]any{"id": id, "ticket_no": no, "seq": seq, "status": status, "reservation_status": rvStatus,
		"reservation_no": rvNo, "name": rvName, "party_size": party, "screening_id": sid, "title": title, "starts_at": starts, "run_status": run}
	if admittedAt.Valid {
		m["admitted_at"] = admittedAt.Time
	}
	return m, nil
}

func classifyTicket(t map[string]any, expectedScreening string) (string, string) {
	switch {
	case t["run_status"] == "cancelled":
		return "screening_cancelled", "この上映は中止されています"
	case t["reservation_status"] != "confirmed" || t["status"] == "void":
		return "cancelled", "取消済みのチケットです"
	case expectedScreening != "" && t["screening_id"] != expectedScreening:
		return "wrong_screening", "別の上映回のチケットです"
	case t["admitted_at"] != nil:
		return "already_admitted", "既に入場済みのチケットです"
	case t["run_status"] == "finished":
		return "finished", "上映は終了しています"
	}
	return "ok", "入場できます"
}

// POST /api/v1/staff/checkin/verify {token | ticket_no, screening_id} — 読み取って状態を表示（入場は確定しない）
func (a *App) handleCheckinVerify(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var in struct {
		Token       string `json:"token"`
		TicketNo    string `json:"ticket_no"`
		ScreeningID string `json:"screening_id"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if err := a.rateLimit(r, "checkin", 240, 60); err != nil {
		return err
	}
	where, arg := ticketLookup(in.Token, in.TicketNo)
	t, err := a.ticketInfo(r.Context(), a.DB, where, arg, false)
	if err == sql.ErrNoRows {
		writeJSON(w, 200, checkinResult{Result: "not_found", Message: "チケットが見つかりません"})
		return nil
	}
	if err != nil {
		return err
	}
	res, msg := classifyTicket(t, in.ScreeningID)
	writeJSON(w, 200, checkinResult{Result: res, Message: msg, Ticket: t})
	return nil
}

func ticketLookup(token, ticketNo string) (string, any) {
	token = trimTokenURL(token) // QRに「URL形式」で入っている場合も受け付ける
	if token != "" {
		return "t.entry_token_hash=$1", hashToken("entry", token)
	}
	return "t.public_no=$1", strings.TrimSpace(ticketNo)
}

// POST /api/v1/staff/checkin (Idempotency-Key 必須) {token | ticket_no, screening_id}
// 同じチケットは同時読取でも一度だけ入場成立（行ロック＋ admitted_at IS NULL 条件）。
func (a *App) handleCheckin(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var in struct {
		Token       string `json:"token"`
		TicketNo    string `json:"ticket_no"`
		ScreeningID string `json:"screening_id"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	where, arg := ticketLookup(in.Token, in.TicketNo)
	var out checkinResult
	err := a.withTx(ctx, func(tx *sql.Tx) error {
		t, err := a.ticketInfo(ctx, tx, where, arg, true)
		if err == sql.ErrNoRows {
			out = checkinResult{Result: "not_found", Message: "チケットが見つかりません"}
			return nil
		}
		if err != nil {
			return err
		}
		res, msg := classifyTicket(t, in.ScreeningID)
		if res != "ok" {
			out = checkinResult{Result: res, Message: msg, Ticket: t}
			_, err := tx.ExecContext(ctx, `INSERT INTO checkin_events(ticket_id, kind, detail, member_id) VALUES ($1,'rejected',$2,$3)`, t["id"], res, s.ID)
			return err
		}
		upd, err := tx.ExecContext(ctx, `UPDATE admission_tickets SET admitted_at=now(), admitted_by=$2, updated_at=now()
			WHERE id=$1 AND admitted_at IS NULL AND status='valid'`, t["id"], s.ID)
		if err != nil {
			return err
		}
		if n, _ := upd.RowsAffected(); n == 0 {
			out = checkinResult{Result: "already_admitted", Message: "既に入場済みのチケットです", Ticket: t}
			return nil
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO checkin_events(ticket_id, kind, member_id) VALUES ($1,'checkin',$2)`, t["id"], s.ID); err != nil {
			return err
		}
		t["admitted_at"] = a.Now()
		out = checkinResult{Result: "admitted", Message: "入場を確定しました", Ticket: t}
		return publish(ctx, tx, "screenings")
	})
	if err != nil {
		return err
	}
	writeJSON(w, 200, out)
	return nil
}

// POST /api/v1/staff/tickets/{id}/revert {reason} — 権限付き入場取消
func (a *App) handleCheckinRevert(w http.ResponseWriter, r *http.Request, s *Staff) error {
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
		res, err := tx.ExecContext(ctx, `UPDATE admission_tickets SET admitted_at=NULL, admitted_by=NULL, updated_at=now() WHERE id=$1 AND admitted_at IS NOT NULL`, id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return conflict("not_admitted", "入場済みではありません")
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO checkin_events(ticket_id, kind, detail, member_id) VALUES ($1,'revert',$2,$3)`, id, in.Reason, s.ID); err != nil {
			return err
		}
		if err := audit(ctx, tx, s, "ticket.checkin_revert", "admission_ticket", id, in); err != nil {
			return err
		}
		if err := publish(ctx, tx, "screenings"); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return nil
	})
}

// ---------------------------------------------------------------
// 上映枠の管理・自動生成
// ---------------------------------------------------------------

type ruleInput struct {
	DepartmentID           string `json:"department_id"`
	BusinessDay            string `json:"business_day"`
	Title                  string `json:"title"`
	WindowStart            string `json:"window_start"` // "10:00"
	WindowEnd              string `json:"window_end"`   // "16:00"
	IntervalMin            int    `json:"interval_min"`
	DurationMin            int    `json:"duration_min"`
	TurnoverMin            int    `json:"turnover_min"`
	Capacity               int    `json:"capacity"`
	ReserveQuota           *int   `json:"reserve_quota"`
	BookingOpensBeforeMin  *int   `json:"booking_opens_before_min"`
	BookingClosesBeforeMin int    `json:"booking_closes_before_min"`
}

type plannedSlot struct {
	StartsAt time.Time `json:"starts_at"`
	EndsAt   time.Time `json:"ends_at"`
	Conflict string    `json:"conflict,omitempty"` // 既存枠と重複する場合の理由（作成しない）
}

func (in *ruleInput) plan() ([]plannedSlot, error) {
	if !isUUID(in.DepartmentID) {
		return nil, badRequest("部門を指定してください")
	}
	day, err := time.ParseInLocation("2006-01-02", in.BusinessDay, jst)
	if err != nil {
		return nil, badRequest("営業日を指定してください")
	}
	if err := requireText("タイトル", in.Title, 50); err != nil {
		return nil, err
	}
	ws, err1 := time.Parse("15:04", in.WindowStart)
	we, err2 := time.Parse("15:04", in.WindowEnd)
	if err1 != nil || err2 != nil || !we.After(ws) {
		return nil, badRequest("時間帯（開始・終了）を正しく指定してください")
	}
	if in.IntervalMin == 0 {
		in.IntervalMin = 15 // 既定値：開始間隔15分
	}
	if in.IntervalMin < 5 || in.DurationMin < 1 || in.TurnoverMin < 0 {
		return nil, badRequest("開始間隔・上映時間・入替時間が正しくありません")
	}
	if in.DurationMin+in.TurnoverMin > in.IntervalMin {
		return nil, badRequest("上映時間（%d分）＋入替時間（%d分）が開始間隔（%d分）を超えるため、上映が重なります", in.DurationMin, in.TurnoverMin, in.IntervalMin)
	}
	if in.Capacity < 1 || in.Capacity > 500 {
		return nil, badRequest("定員が正しくありません")
	}
	if in.ReserveQuota != nil && (*in.ReserveQuota < 0 || *in.ReserveQuota > in.Capacity) {
		return nil, badRequest("事前予約枠は0〜定員の範囲で指定してください")
	}
	start := time.Date(day.Year(), day.Month(), day.Day(), ws.Hour(), ws.Minute(), 0, 0, jst)
	end := time.Date(day.Year(), day.Month(), day.Day(), we.Hour(), we.Minute(), 0, 0, jst)
	var out []plannedSlot
	for t := start; !t.Add(time.Duration(in.DurationMin) * time.Minute).After(end); t = t.Add(time.Duration(in.IntervalMin) * time.Minute) {
		out = append(out, plannedSlot{StartsAt: t, EndsAt: t.Add(time.Duration(in.DurationMin) * time.Minute)})
		if len(out) > 300 {
			return nil, badRequest("生成される枠が多すぎます")
		}
	}
	return out, nil
}

func (a *App) markConflicts(ctx context.Context, q queryer, deptID string, slots []plannedSlot, turnover int) error {
	for i := range slots {
		occ := slots[i].EndsAt.Add(time.Duration(turnover) * time.Minute)
		var title sql.NullString
		var st sql.NullTime
		err := q.QueryRowContext(ctx, `SELECT title, starts_at FROM screenings WHERE department_id=$1 AND run_status<>'cancelled'
			AND tstzrange(starts_at, occupied_until) && tstzrange($2, $3) LIMIT 1`, deptID, slots[i].StartsAt, occ).Scan(&title, &st)
		if err == sql.ErrNoRows {
			continue
		}
		if err != nil {
			return err
		}
		slots[i].Conflict = fmt.Sprintf("既存の枠（%s %s）と重複", st.Time.In(jst).Format("15:04"), title.String)
	}
	return nil
}

// POST /api/v1/admin/screening-rules/preview — 生成前プレビュー（DBは変更しない）
func (a *App) handleRulePreview(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var in ruleInput
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	slots, err := in.plan()
	if err != nil {
		return err
	}
	if err := a.markConflicts(r.Context(), a.DB, in.DepartmentID, slots, in.TurnoverMin); err != nil {
		return err
	}
	n := 0
	for _, sl := range slots {
		if sl.Conflict == "" {
			n++
		}
	}
	writeJSON(w, 200, map[string]any{"slots": slots, "will_create": n, "rule": in})
	return nil
}

// POST /api/v1/admin/screening-rules — 生成。既存枠（予約済み・手動変更済みを含む）は削除・上書きしない。
func (a *App) handleRuleGenerate(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var in ruleInput
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	slots, err := in.plan()
	if err != nil {
		return err
	}
	ctx := r.Context()
	created := 0
	skipped := 0
	err = a.withTx(ctx, func(tx *sql.Tx) error {
		// 同じ部門の生成処理を直列化
		if _, err := tx.ExecContext(ctx, `SELECT 1 FROM departments WHERE id=$1 FOR UPDATE`, in.DepartmentID); err != nil {
			return err
		}
		if err := a.markConflicts(ctx, tx, in.DepartmentID, slots, in.TurnoverMin); err != nil {
			return err
		}
		var ruleID string
		if err := tx.QueryRowContext(ctx, `INSERT INTO screening_rules(department_id, business_day, title, window_start, window_end, interval_min,
			duration_min, turnover_min, capacity, reserve_quota, booking_opens_before_min, booking_closes_before_min, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, in.DepartmentID, in.BusinessDay, in.Title, in.WindowStart,
			in.WindowEnd, in.IntervalMin, in.DurationMin, in.TurnoverMin, in.Capacity, in.ReserveQuota, in.BookingOpensBeforeMin,
			in.BookingClosesBeforeMin, s.ID).Scan(&ruleID); err != nil {
			return err
		}
		for _, sl := range slots {
			if sl.Conflict != "" {
				skipped++
				continue
			}
			var opens any
			if in.BookingOpensBeforeMin != nil {
				opens = sl.StartsAt.Add(-time.Duration(*in.BookingOpensBeforeMin) * time.Minute)
			}
			closes := sl.StartsAt.Add(-time.Duration(in.BookingClosesBeforeMin) * time.Minute)
			if _, err := tx.ExecContext(ctx, `INSERT INTO screenings(department_id, rule_id, title, business_day, starts_at, ends_at, occupied_until,
				capacity, reserve_quota, booking_opens_at, booking_closes_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
				in.DepartmentID, ruleID, in.Title, in.BusinessDay, sl.StartsAt, sl.EndsAt,
				sl.EndsAt.Add(time.Duration(in.TurnoverMin)*time.Minute), in.Capacity, in.ReserveQuota, opens, closes); err != nil {
				return err
			}
			created++
		}
		if err := audit(ctx, tx, s, "screening.generate", "screening_rule", ruleID, map[string]any{"rule": in, "created": created, "skipped": skipped}); err != nil {
			return err
		}
		return publish(ctx, tx, "screenings")
	})
	if err != nil {
		return err
	}
	writeJSON(w, 201, map[string]any{"created": created, "skipped": skipped})
	return nil
}

// POST /api/v1/admin/screenings — 例外枠を手動で作成
func (a *App) handleCreateScreening(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var in struct {
		DepartmentID    string     `json:"department_id"`
		Title           string     `json:"title"`
		StartsAt        time.Time  `json:"starts_at"`
		DurationMin     int        `json:"duration_min"`
		TurnoverMin     int        `json:"turnover_min"`
		Capacity        int        `json:"capacity"`
		ReserveQuota    *int       `json:"reserve_quota"`
		BookingOpensAt  *time.Time `json:"booking_opens_at"`
		BookingClosesAt *time.Time `json:"booking_closes_at"`
		Visibility      string     `json:"visibility"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if !isUUID(in.DepartmentID) {
		return badRequest("部門を指定してください")
	}
	if err := requireText("タイトル", in.Title, 50); err != nil {
		return err
	}
	if in.StartsAt.IsZero() {
		return badRequest("開始日時を指定してください")
	}
	if in.DurationMin < 1 || in.Capacity < 1 || in.TurnoverMin < 0 {
		return badRequest("上映時間・定員を正しく指定してください")
	}
	if in.Visibility == "" {
		in.Visibility = "public"
	}
	if in.Visibility != "public" && in.Visibility != "hidden" {
		return badRequest("公開状態が正しくありません")
	}
	if in.ReserveQuota != nil && (*in.ReserveQuota < 0 || *in.ReserveQuota > in.Capacity) {
		return badRequest("事前予約枠は0〜定員の範囲で指定してください")
	}
	ends := in.StartsAt.Add(time.Duration(in.DurationMin) * time.Minute)
	ctx := r.Context()
	var id string
	err := a.withTx(ctx, func(tx *sql.Tx) error {
		closes := in.BookingClosesAt
		if closes == nil {
			closes = &in.StartsAt
		}
		if err := tx.QueryRowContext(ctx, `INSERT INTO screenings(department_id, title, business_day, starts_at, ends_at, occupied_until, capacity,
			reserve_quota, booking_opens_at, booking_closes_at, visibility, manually_edited)
			VALUES ($1,$2,($3 AT TIME ZONE 'Asia/Tokyo')::date,$3,$4,$5,$6,$7,$8,$9,$10,true) RETURNING id`,
			in.DepartmentID, in.Title, in.StartsAt, ends, ends.Add(time.Duration(in.TurnoverMin)*time.Minute), in.Capacity,
			in.ReserveQuota, in.BookingOpensAt, closes, in.Visibility).Scan(&id); err != nil {
			return err
		}
		if err := audit(ctx, tx, s, "screening.create", "screening", id, in); err != nil {
			return err
		}
		return publish(ctx, tx, "screenings")
	})
	if err != nil {
		return err
	}
	writeJSON(w, 201, map[string]any{"id": id})
	return nil
}

// PATCH /api/v1/admin/screenings/{id}
// 公開／受付／開催の状態は独立。確保済み人数を下回る定員変更は不可。
func (a *App) handleUpdateScreening(w http.ResponseWriter, r *http.Request, s *Staff) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Title           *string    `json:"title"`
		Capacity        *int       `json:"capacity"`
		ReserveQuota    *int       `json:"reserve_quota"`
		ClearQuota      bool       `json:"clear_reserve_quota"`
		Visibility      *string    `json:"visibility"`
		BookingStatus   *string    `json:"booking_status"`
		RunStatus       *string    `json:"run_status"`
		BookingOpensAt  *time.Time `json:"booking_opens_at"`
		BookingClosesAt *time.Time `json:"booking_closes_at"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if in.RunStatus != nil && *in.RunStatus == "cancelled" {
		return badRequest("上映中止は専用の操作で行ってください")
	}
	if in.Visibility != nil && *in.Visibility != "public" && *in.Visibility != "hidden" {
		return badRequest("公開状態が正しくありません")
	}
	if in.BookingStatus != nil && *in.BookingStatus != "open" && *in.BookingStatus != "paused" && *in.BookingStatus != "closed" {
		return badRequest("受付状態が正しくありません")
	}
	if in.Title != nil {
		if err := requireText("タイトル", *in.Title, 50); err != nil {
			return err
		}
	}
	ctx := r.Context()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		cur, err := a.getScreening(ctx, tx, id, true)
		if err != nil {
			return err
		}
		if cur.RunStatus == "cancelled" {
			return conflict("cancelled", "中止済みの上映は変更できません")
		}
		if in.RunStatus != nil && *in.RunStatus != cur.RunStatus {
			order := map[string]int{"scheduled": 0, "running": 1, "finished": 2}
			to, ok := order[*in.RunStatus]
			if !ok {
				return badRequest("開催状態が正しくありません")
			}
			if to < order[cur.RunStatus] {
				return unprocessable("invalid_transition", "開催状態を戻すことはできません")
			}
		}
		taken := cur.ReservedCount + cur.WalkinCount
		if in.Capacity != nil && *in.Capacity < taken {
			return unprocessable("capacity_below_taken", "既に%d人分確保されているため、定員を%d人にはできません", taken, *in.Capacity)
		}
		if in.ReserveQuota != nil && *in.ReserveQuota < cur.ReservedCount {
			return unprocessable("quota_below_reserved", "既に%d人が予約しているため、予約枠を%d人にはできません", cur.ReservedCount, *in.ReserveQuota)
		}
		quotaSQL := "COALESCE($4, reserve_quota)"
		if in.ClearQuota {
			quotaSQL = "NULL"
		}
		if _, err := tx.ExecContext(ctx, `UPDATE screenings SET title=COALESCE($2,title), capacity=COALESCE($3,capacity), reserve_quota=`+quotaSQL+`,
			visibility=COALESCE($5,visibility), booking_status=COALESCE($6,booking_status), run_status=COALESCE($7,run_status),
			booking_opens_at=COALESCE($8,booking_opens_at), booking_closes_at=COALESCE($9,booking_closes_at),
			manually_edited=true, updated_at=now() WHERE id=$1`, id, in.Title, in.Capacity, in.ReserveQuota, in.Visibility, in.BookingStatus,
			in.RunStatus, in.BookingOpensAt, in.BookingClosesAt); err != nil {
			return err
		}
		if err := audit(ctx, tx, s, "screening.update", "screening", id, in); err != nil {
			return err
		}
		if err := publish(ctx, tx, "screenings"); err != nil {
			return err
		}
		if in.RunStatus != nil && *in.RunStatus == "finished" {
			if _, err := a.issueScreeningCoupons(ctx, tx, id); err != nil {
				return err
			}
		}
		updated, err := a.getScreening(ctx, tx, id, false)
		if err != nil {
			return err
		}
		l, err := a.limits(ctx, tx)
		if err != nil {
			return err
		}
		updated.compute(a.Now(), l.SeatThresholdPercent)
		writeJSON(w, 200, updated)
		return nil
	})
}

// POST /api/v1/admin/screenings/{id}/cancel {reason} — 上映中止（予約は「上映中止に伴う取消」として履歴を残す）
func (a *App) handleCancelScreening(w http.ResponseWriter, r *http.Request, s *Staff) error {
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
	if err := requireText("中止理由", in.Reason, 200); err != nil {
		return err
	}
	ctx := r.Context()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		cur, err := a.getScreening(ctx, tx, id, true)
		if err != nil {
			return err
		}
		if cur.RunStatus == "cancelled" {
			return conflict("cancelled", "既に中止されています")
		}
		if _, err := tx.ExecContext(ctx, `UPDATE screenings SET run_status='cancelled', booking_status='closed', cancel_reason=$2,
			updated_at=now() WHERE id=$1`, id, in.Reason); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `UPDATE reservations SET status='cancelled_screening', cancel_reason=$2, cancelled_by=$3,
			cancelled_at=now(), updated_at=now() WHERE screening_id=$1 AND status='confirmed'`, id, in.Reason, s.ID)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if err := audit(ctx, tx, s, "screening.cancel", "screening", id, map[string]any{"reason": in.Reason, "reservations": n}); err != nil {
			return err
		}
		if err := publish(ctx, tx, "screenings"); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"ok": true, "affected_reservations": n})
		return nil
	})
}

// issueScreeningCoupons は上映終了後、入場記録のあるチケットを対象に自動発券する（重複は制約で防止）。
func (a *App) issueScreeningCoupons(ctx context.Context, tx *sql.Tx, screeningID string) (int, error) {
	var issuedAt sql.NullTime
	if err := tx.QueryRowContext(ctx, `SELECT coupons_issued_at FROM screenings WHERE id=$1 FOR UPDATE`, screeningID).Scan(&issuedAt); err != nil {
		return 0, err
	}
	if issuedAt.Valid {
		return 0, nil
	}
	type def struct{ id, mode string }
	rows, err := tx.QueryContext(ctx, `SELECT id, holder_mode FROM coupon_definitions WHERE auto_issue='screening_attended' AND active
		AND (valid_until IS NULL OR valid_until > now())`)
	if err != nil {
		return 0, err
	}
	var defs []def
	for rows.Next() {
		var d def
		if err := rows.Scan(&d.id, &d.mode); err != nil {
			rows.Close()
			return 0, err
		}
		defs = append(defs, d)
	}
	rows.Close()
	type adm struct {
		resID    string
		ticketID string
	}
	trows, err := tx.QueryContext(ctx, `SELECT t.reservation_id, t.id FROM admission_tickets t JOIN reservations rv ON rv.id=t.reservation_id
		WHERE t.screening_id=$1 AND t.admitted_at IS NOT NULL AND t.status='valid' AND rv.status='confirmed' ORDER BY t.reservation_id, t.seq`, screeningID)
	if err != nil {
		return 0, err
	}
	var adms []adm
	for trows.Next() {
		var x adm
		if err := trows.Scan(&x.resID, &x.ticketID); err != nil {
			trows.Close()
			return 0, err
		}
		adms = append(adms, x)
	}
	trows.Close()
	count := 0
	for _, d := range defs {
		if d.mode == "per_person" {
			for _, x := range adms {
				_, err := a.issueCoupon(ctx, tx, d.id, 1, issueSource{Kind: "auto_screening", ReservationID: x.resID, TicketID: x.ticketID}, nil)
				if err == errDuplicateIssue {
					continue
				}
				if ae := toAPIError(err); ae != nil && ae.Code == "coupon_issue_limit" {
					break
				}
				if err != nil {
					return count, err
				}
				count++
			}
		} else {
			per := map[string]int{}
			var order []string
			for _, x := range adms {
				if per[x.resID] == 0 {
					order = append(order, x.resID)
				}
				per[x.resID]++
			}
			for _, rid := range order {
				_, err := a.issueCoupon(ctx, tx, d.id, per[rid], issueSource{Kind: "auto_screening", ReservationID: rid}, nil)
				if err == errDuplicateIssue {
					continue
				}
				if ae := toAPIError(err); ae != nil && ae.Code == "coupon_issue_limit" {
					break
				}
				if err != nil {
					return count, err
				}
				count++
			}
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE screenings SET coupons_issued_at=now() WHERE id=$1`, screeningID); err != nil {
		return count, err
	}
	return count, nil
}

// GET /api/v1/public/screening-board — 公開表示用（次の上映・空席）
func (a *App) handleScreeningBoard(w http.ResponseWriter, r *http.Request) error {
	list, err := a.listScreenings(r.Context(), a.today(), true)
	if err != nil {
		return err
	}
	var out []map[string]any
	for _, s := range list {
		if s.RunStatus == "finished" {
			continue
		}
		out = append(out, map[string]any{"id": s.ID, "title": s.Title, "starts_at": s.StartsAt, "ends_at": s.EndsAt,
			"symbol": s.Symbol, "status_text": s.StatusText, "run_status": s.RunStatus,
			"advance_open": s.AdvanceOpen && s.AdvanceAvailable > 0, "walkin_available": s.WalkinAvailable > 0 && s.RunStatus == "scheduled"})
		if len(out) >= 12 {
			break
		}
	}
	if out == nil {
		out = []map[string]any{}
	}
	writeJSON(w, 200, map[string]any{"screenings": out, "server_time": a.Now()})
	return nil
}

var _ = json.Marshal
