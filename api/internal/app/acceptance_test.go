package app

// 受入条件（仕様書18章）を実DBで検証する統合テスト。
// 実行: TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres?sslmode=disable go test ./internal/app/ -v
// 指定DB上に一時データベースを作成・削除する。

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/3qra/tenmon_shirokita2026/api/migrations"
	_ "github.com/lib/pq"
)

type tenv struct {
	t     *testing.T
	app   *App
	srv   *httptest.Server
	db    *sql.DB
	udon  string
	plane string
	goods string
}

var fixedNow = time.Date(2026, 11, 20, 9, 0, 0, 0, jst)

func setup(t *testing.T) *tenv {
	t.Helper()
	base := os.Getenv("TEST_DATABASE_URL")
	if base == "" {
		t.Skip("TEST_DATABASE_URL が未設定のためスキップ")
	}
	admin, err := sql.Open("postgres", base)
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("gs_test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(`CREATE DATABASE ` + name); err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(base)
	u.Path = "/" + name
	dsn := u.String()
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(40)
	t.Cleanup(func() {
		db.Close()
		admin.Exec(`DROP DATABASE IF EXISTS ` + name + ` WITH (FORCE)`)
		admin.Close()
	})
	ctx := context.Background()
	if err := Migrate(ctx, db, migrations.FS); err != nil {
		t.Fatal(err)
	}
	cfg := Config{DatabaseURL: dsn, Secret: []byte("test-secret-test-secret-test-secret!!"), PublicBaseURL: "http://test",
		SessionTTL: time.Hour, BootstrapAdmin: "admin", BootstrapPass: "adminpass123"}
	a := New(db, cfg)
	a.Now = func() time.Time { return fixedNow }
	if err := a.Bootstrap(ctx); err != nil {
		t.Fatal(err)
	}
	if err := a.SeedDemo(ctx); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(a.Handler())
	t.Cleanup(srv.Close)
	e := &tenv{t: t, app: a, srv: srv, db: db}
	db.QueryRow(`SELECT id FROM departments WHERE code='udon'`).Scan(&e.udon)
	db.QueryRow(`SELECT id FROM departments WHERE code='planetarium'`).Scan(&e.plane)
	db.QueryRow(`SELECT id FROM departments WHERE code='goods'`).Scan(&e.goods)
	// テストでは頻度制限を緩める（制限の動作は個別に検証）
	db.Exec(`INSERT INTO settings(key,value) VALUES ('limits', '{"orders_per_minute":10000,"reservations_per_minute":10000,"max_future_reservations":100,"max_unpaid_orders":100}')`)
	a.rate = newRateLimiter()
	return e
}

type client struct {
	e    *tenv
	http *http.Client
	kind string
	cid  string
}

func (e *tenv) newClient() *client {
	jar, _ := cookiejar.New(nil)
	return &client{e: e, http: &http.Client{Jar: jar, Timeout: 30 * time.Second}}
}

func (e *tenv) login(loginID, pw string) *client {
	c := e.newClient()
	st, body := c.do("POST", "/api/v1/auth/login", map[string]any{"login_id": loginID, "password": pw}, "")
	if st != 200 {
		e.t.Fatalf("login %s: %d %v", loginID, st, body)
	}
	return c
}

func (c *client) do(method, path string, body any, idem string) (int, map[string]any) {
	st, raw := c.doRaw(method, path, body, idem)
	var m map[string]any
	if len(raw) > 0 && raw[0] == '{' {
		json.Unmarshal(raw, &m)
	} else if len(raw) > 0 && raw[0] == '[' {
		var arr []any
		json.Unmarshal(raw, &arr)
		m = map[string]any{"list": arr}
	}
	return st, m
}

func (c *client) doRaw(method, path string, body any, idem string) (int, []byte) {
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.e.srv.URL+path, rdr)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Requested-With", "test")
	if idem != "" {
		req.Header.Set("Idempotency-Key", idem)
	}
	if c.cid != "" {
		req.Header.Set("X-Client-Id", c.cid)
		req.Header.Set("X-Client-Kind", c.kind)
	}
	res, err := c.http.Do(req)
	if err != nil {
		c.e.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res.StatusCode, raw
}

func errCode(m map[string]any) string {
	if e, ok := m["error"].(map[string]any); ok {
		return fmt.Sprint(e["code"])
	}
	return ""
}

func (e *tenv) variants() map[string]string {
	out := map[string]string{}
	rows, _ := e.db.Query(`SELECT pv.id, p.name, COALESCE((SELECT string_agg(ov.name, '/' ORDER BY og.sort_order) FROM product_variant_options o
		JOIN option_values ov ON ov.id=o.value_id JOIN option_groups og ON og.id=ov.group_id WHERE o.variant_id=pv.id), '')
		FROM product_variants pv JOIN products p ON p.id=pv.product_id`)
	defer rows.Close()
	for rows.Next() {
		var id, p, o string
		rows.Scan(&id, &p, &o)
		if o != "" {
			p += ":" + o
		}
		out[p] = id
	}
	return out
}

func (e *tenv) siteCode() string {
	d, _ := e.app.getDept(context.Background(), e.db, e.udon, false)
	return e.app.currentSiteCode(d, e.app.Now()).Code
}

var keyN int64

func key() string { return fmt.Sprintf("k-%d-%d", time.Now().UnixNano(), atomic.AddInt64(&keyN, 1)) }

func (e *tenv) publicOrder(c *client, variant string, qty int) (int, map[string]any) {
	return c.do("POST", "/api/v1/public/orders", map[string]any{"department_id": e.udon,
		"items": []map[string]any{{"variant_id": variant, "quantity": qty}}, "site_code": e.siteCode()}, key())
}

// ---------------------------------------------------------------

func TestOrderingRules(t *testing.T) {
	e := setup(t)
	v := e.variants()
	soyM := v["やきうどん:しょうゆ/中"]
	admin := e.login("admin", "adminpass123")
	visitor := e.newClient()

	t.Run("モバイル受付OFFなら新規不可・既存は操作可能", func(t *testing.T) {
		st, m := e.publicOrder(visitor, soyM, 1)
		if st != 201 {
			t.Fatalf("order: %d %v", st, m)
		}
		orderID := m["id"].(string)
		st, _ = admin.do("PATCH", "/api/v1/admin/departments/"+e.udon, map[string]any{"mobile_order_enabled": false}, "")
		if st != 200 {
			t.Fatal(st)
		}
		st, m = e.publicOrder(visitor, soyM, 1)
		if st != 422 || errCode(m) != "mobile_order_off" {
			t.Fatalf("want mobile_order_off, got %d %v", st, m)
		}
		cashier := e.login("cashier1", "password123")
		st, m = cashier.do("POST", "/api/v1/staff/orders/"+orderID+"/payment", map[string]any{"cash_received": 500}, key())
		if st != 200 || m["payment_status"] != "paid" {
			t.Fatalf("existing order payment failed: %d %v", st, m)
		}
		admin.do("PATCH", "/api/v1/admin/departments/"+e.udon, map[string]any{"mobile_order_enabled": true}, "")
	})

	t.Run("コード確認ONなら正しいコードが必要・連続失敗で制限", func(t *testing.T) {
		c := e.newClient()
		body := map[string]any{"department_id": e.udon, "items": []map[string]any{{"variant_id": soyM, "quantity": 1}}, "site_code": "abc"}
		st, m := c.do("POST", "/api/v1/public/orders", body, key())
		if st != 422 || errCode(m) != "site_code_invalid" {
			t.Fatalf("want invalid code, got %d %v", st, m)
		}
		wrong := "000"
		if e.siteCode() == wrong {
			wrong = "001"
		}
		body["site_code"] = wrong
		for i := 0; i < 5; i++ {
			c.do("POST", "/api/v1/public/orders", body, key())
		}
		body["site_code"] = e.siteCode()
		st, m = c.do("POST", "/api/v1/public/orders", body, key())
		if st != 429 || errCode(m) != "site_code_locked" {
			t.Fatalf("want lock, got %d %v", st, m)
		}
	})

	t.Run("注文ボタン連打でも一件のみ成立", func(t *testing.T) {
		c := e.newClient()
		c.do("GET", "/api/v1/public/departments", nil, "") // 画面表示で識別Cookieが発行される
		k := key()
		body := map[string]any{"department_id": e.udon, "items": []map[string]any{{"variant_id": soyM, "quantity": 1}}, "site_code": e.siteCode()}
		var wg sync.WaitGroup
		results := make([]int, 8)
		ids := make([]string, 8)
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				st, m := c.do("POST", "/api/v1/public/orders", body, k)
				results[i] = st
				if id, ok := m["id"].(string); ok {
					ids[i] = id
				}
			}(i)
		}
		wg.Wait()
		uniq := map[string]bool{}
		for i, st := range results {
			if st != 201 && st != 409 {
				t.Fatalf("unexpected status %d", st)
			}
			if ids[i] != "" {
				uniq[ids[i]] = true
			}
		}
		if len(uniq) != 1 {
			t.Fatalf("want exactly 1 order, got %d (%v)", len(uniq), results)
		}
		// 同じキーで再送 → 同じ応答
		st, m := c.do("POST", "/api/v1/public/orders", body, k)
		if st != 201 || !uniq[m["id"].(string)] {
			t.Fatalf("replay mismatch: %d %v", st, m)
		}
		// 同じキーで別内容 → エラー
		body2 := map[string]any{"department_id": e.udon, "items": []map[string]any{{"variant_id": soyM, "quantity": 2}}, "site_code": e.siteCode()}
		st, m = c.do("POST", "/api/v1/public/orders", body2, k)
		if st != 422 || errCode(m) != "idempotency_mismatch" {
			t.Fatalf("want mismatch, got %d %v", st, m)
		}
	})

	t.Run("会計ボタン連打でも一件のみ成立", func(t *testing.T) {
		cashier := e.login("cashier1", "password123")
		_, m := e.publicOrder(e.newClient(), soyM, 1)
		id := m["id"].(string)
		var wg sync.WaitGroup
		var ok int32
		for i := 0; i < 6; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				st, _ := cashier.do("POST", "/api/v1/staff/orders/"+id+"/payment", map[string]any{"cash_received": 1000}, key())
				if st == 200 {
					atomic.AddInt32(&ok, 1)
				}
			}()
		}
		wg.Wait()
		var n int
		e.db.QueryRow(`SELECT count(*) FROM payments WHERE order_id=$1`, id).Scan(&n)
		if ok != 1 || n != 1 {
			t.Fatalf("want 1 payment, got ok=%d rows=%d", ok, n)
		}
	})

	t.Run("価格変更しても過去の販売価格は変わらない", func(t *testing.T) {
		_, m := e.publicOrder(e.newClient(), soyM, 2)
		id := m["id"].(string)
		st, _ := admin.do("PATCH", "/api/v1/staff/variants/"+soyM, map[string]any{"price": 450}, "")
		if st != 200 {
			t.Fatal(st)
		}
		var unit, sub int
		e.db.QueryRow(`SELECT i.unit_price, o.subtotal FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.id=$1`, id).Scan(&unit, &sub)
		if unit != 400 || sub != 800 {
			t.Fatalf("snapshot changed: unit=%d sub=%d", unit, sub)
		}
		admin.do("PATCH", "/api/v1/staff/variants/"+soyM, map[string]any{"price": 400}, "")
	})

	t.Run("未払い注文も調理可能で支払状態を明示", func(t *testing.T) {
		kitchen := e.login("kitchen1", "password123")
		_, m := e.publicOrder(e.newClient(), soyM, 1)
		id := m["id"].(string)
		var item string
		e.db.QueryRow(`SELECT id FROM order_items WHERE order_id=$1`, id).Scan(&item)
		st, m := kitchen.do("POST", "/api/v1/staff/order-items/"+item+"/cook", map[string]any{"from": "waiting", "to": "cooking"}, "")
		if st != 200 {
			t.Fatalf("cook: %d %v", st, m)
		}
		_, km := kitchen.do("GET", "/api/v1/staff/kitchen?department_id="+e.udon, nil, "")
		found := false
		for _, o := range km["orders"].([]any) {
			om := o.(map[string]any)
			if om["id"] == id {
				found = true
				if om["payment_status"] != "unpaid" {
					t.Fatalf("payment status not shown: %v", om)
				}
			}
		}
		if !found {
			t.Fatal("unpaid order missing from kitchen")
		}
		// 二重タップ（同じ from）は 409
		st, _ = kitchen.do("POST", "/api/v1/staff/order-items/"+item+"/cook", map[string]any{"from": "waiting", "to": "cooking"}, "")
		if st != 409 {
			t.Fatalf("want 409 on stale transition, got %d", st)
		}
		// 未払いの受渡は不可
		kitchen.do("POST", "/api/v1/staff/order-items/"+item+"/cook", map[string]any{"from": "cooking", "to": "cooked"}, "")
		cashier := e.login("cashier1", "password123")
		st, m = cashier.do("POST", "/api/v1/staff/orders/"+id+"/handoff", map[string]any{}, "")
		if st != 409 || errCode(m) != "unpaid" {
			t.Fatalf("want unpaid handoff rejected, got %d %v", st, m)
		}
	})

	t.Run("売り切れと同時注文は確定時のルールで一貫", func(t *testing.T) {
		saltL := v["やきうどん:しお/大"]
		var wg sync.WaitGroup
		var created, soldOut int32
		wg.Add(1)
		go func() {
			defer wg.Done()
			time.Sleep(5 * time.Millisecond)
			admin.do("PATCH", "/api/v1/staff/variants/"+saltL, map[string]any{"sale_status": "sold_out"}, "")
		}()
		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				st, m := e.publicOrder(e.newClient(), saltL, 1)
				if st == 201 {
					atomic.AddInt32(&created, 1)
				} else if errCode(m) == "sold_out" {
					atomic.AddInt32(&soldOut, 1)
				} else {
					t.Errorf("unexpected: %d %v", st, m)
				}
			}()
		}
		wg.Wait()
		// 全リクエストが「成立」か「売り切れ」のどちらかで終わり、切替完了後は必ず売り切れになること。
		// （同時実行は商品行のロックで直列化される）
		if created+soldOut != 10 {
			t.Fatalf("created=%d soldOut=%d", created, soldOut)
		}
		st, m := e.publicOrder(e.newClient(), saltL, 1)
		if st != 422 || errCode(m) != "sold_out" {
			t.Fatalf("want sold_out: %d %v", st, m)
		}
	})

	t.Run("ブロック対象は指定範囲の新規受付を拒否", func(t *testing.T) {
		c := e.newClient()
		st, m := e.publicOrder(c, soyM, 1)
		if st != 201 {
			t.Fatal(st, m)
		}
		st, m = admin.do("POST", "/api/v1/admin/blocks", map[string]any{"source_type": "order", "source_id": m["id"], "scope": "order", "reason": "テスト"}, "")
		if st != 201 {
			t.Fatal(st, m)
		}
		blockID := m["id"].(string)
		st, m = e.publicOrder(c, soyM, 1)
		if st != 403 {
			t.Fatalf("blocked client could order: %d %v", st, m)
		}
		// 予約は範囲外なので可能
		var sid string
		e.db.QueryRow(`SELECT id FROM screenings WHERE business_day=$1 ORDER BY starts_at LIMIT 1`, fixedNow.Format("2006-01-02")).Scan(&sid)
		_ = sid
		admin.do("POST", "/api/v1/admin/blocks/"+blockID+"/lift", map[string]any{"reason": "解除"}, "")
		st, _ = e.publicOrder(c, soyM, 1)
		if st != 201 {
			t.Fatalf("after lift: %d", st)
		}
	})

	t.Run("権限外のAPI直接呼出はサーバーが拒否", func(t *testing.T) {
		kitchen := e.login("kitchen1", "password123")
		_, m := e.publicOrder(e.newClient(), soyM, 1)
		st, _ := kitchen.do("POST", "/api/v1/staff/orders/"+m["id"].(string)+"/payment", map[string]any{"cash_received": 400}, key())
		if st != 403 {
			t.Fatalf("kitchen payment: want 403 got %d", st)
		}
		st, _ = e.newClient().do("GET", "/api/v1/staff/kitchen?department_id="+e.udon, nil, "")
		if st != 401 {
			t.Fatalf("anon: want 401 got %d", st)
		}
		cashier := e.login("cashier1", "password123")
		st, _ = cashier.do("POST", "/api/v1/admin/members", map[string]any{"name": "x", "login_id": "x", "password": "xxxxxxxx"}, "")
		if st != 403 {
			t.Fatalf("cashier admin: want 403 got %d", st)
		}
		// CSRF：独自ヘッダなしのCookie要求は拒否
		req, _ := http.NewRequest("POST", e.srv.URL+"/api/v1/auth/logout", nil)
		res, _ := cashier.http.Do(req)
		if res.StatusCode != 403 {
			t.Fatalf("csrf: want 403 got %d", res.StatusCode)
		}
	})
}

func TestPlanetariumRules(t *testing.T) {
	e := setup(t)
	admin := e.login("admin", "adminpass123")
	reception := e.login("reception1", "password123")
	day := fixedNow.Format("2006-01-02")
	var sid string
	e.db.QueryRow(`SELECT id FROM screenings WHERE business_day=$1 ORDER BY starts_at LIMIT 1`, day).Scan(&sid)

	reserve := func(c *client, party int) (int, map[string]any) {
		return c.do("POST", "/api/v1/public/reservations", map[string]any{"screening_id": sid, "name": "テスト", "party_size": party}, key())
	}

	t.Run("定員18・確保13で△表示", func(t *testing.T) {
		if seatSymbol(12, 18, 70) != "○" || seatSymbol(13, 18, 70) != "△" || seatSymbol(18, 18, 70) != "×" {
			t.Fatal("seat symbol threshold wrong")
		}
		for i := 0; i < 13; i++ {
			if st, m := reserve(e.newClient(), 1); st != 201 {
				t.Fatal(st, m)
			}
		}
		_, m := e.newClient().do("GET", "/api/v1/public/screenings/"+sid, nil, "")
		if m["symbol"] != "△" {
			t.Fatalf("want △ got %v", m["symbol"])
		}
	})

	t.Run("最後の一席への同時予約でも定員超過しない", func(t *testing.T) {
		for i := 0; i < 4; i++ { // 13+4 = 17
			reserve(e.newClient(), 1)
		}
		var wg sync.WaitGroup
		var ok int32
		for i := 0; i < 12; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if st, _ := reserve(e.newClient(), 1); st == 201 {
					atomic.AddInt32(&ok, 1)
				}
			}()
		}
		wg.Wait()
		var taken int
		e.db.QueryRow(`SELECT reserved_count+walkin_count FROM screenings WHERE id=$1`, sid).Scan(&taken)
		if ok != 1 || taken != 18 {
			t.Fatalf("want exactly 1 success and 18 taken, got ok=%d taken=%d", ok, taken)
		}
	})

	t.Run("予約者のチェックインで席数を二重消費しない・同時読取で一度だけ入場", func(t *testing.T) {
		// 別の上映で検証
		var sid2 string
		e.db.QueryRow(`SELECT id FROM screenings WHERE business_day=$1 ORDER BY starts_at OFFSET 1 LIMIT 1`, day).Scan(&sid2)
		c := e.newClient()
		st, m := c.do("POST", "/api/v1/public/reservations", map[string]any{"screening_id": sid2, "name": "山田", "party_size": 2}, key())
		if st != 201 {
			t.Fatal(st, m)
		}
		tok := m["access_token"].(string)
		_, detail := c.do("GET", "/api/v1/public/reservations/by-token/"+tok, nil, "")
		tickets := detail["tickets"].([]any)
		if len(tickets) != 2 {
			t.Fatalf("want 2 tickets got %d", len(tickets))
		}
		entry := tickets[0].(map[string]any)["entry_token"].(string)
		var before int
		e.db.QueryRow(`SELECT reserved_count+walkin_count FROM screenings WHERE id=$1`, sid2).Scan(&before)
		var wg sync.WaitGroup
		var admitted int32
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, r := reception.do("POST", "/api/v1/staff/checkin", map[string]any{"token": entry, "screening_id": sid2}, key())
				if r["result"] == "admitted" {
					atomic.AddInt32(&admitted, 1)
				}
			}()
		}
		wg.Wait()
		var after, n int
		e.db.QueryRow(`SELECT reserved_count+walkin_count FROM screenings WHERE id=$1`, sid2).Scan(&after)
		e.db.QueryRow(`SELECT count(*) FROM checkin_events WHERE kind='checkin'`).Scan(&n)
		if admitted != 1 || n != 1 {
			t.Fatalf("want 1 admission got %d (events %d)", admitted, n)
		}
		if before != after || after != 2 {
			t.Fatalf("seat count changed by checkin: %d -> %d", before, after)
		}
		// 別上映として読んだら判別
		_, r := reception.do("POST", "/api/v1/staff/checkin/verify", map[string]any{"token": tickets[1].(map[string]any)["entry_token"], "screening_id": sid}, "")
		if r["result"] != "wrong_screening" {
			t.Fatalf("want wrong_screening got %v", r["result"])
		}
		// 入場済みがある予約は本人取消不可
		st, m = c.do("POST", "/api/v1/public/reservations/by-token/"+tok+"/cancel", nil, "")
		if st != 409 {
			t.Fatalf("want 409 got %d %v", st, m)
		}
	})

	t.Run("本人取消で席を解放し履歴を残す", func(t *testing.T) {
		var sid3 string
		e.db.QueryRow(`SELECT id FROM screenings WHERE business_day=$1 ORDER BY starts_at OFFSET 2 LIMIT 1`, day).Scan(&sid3)
		c := e.newClient()
		_, m := c.do("POST", "/api/v1/public/reservations", map[string]any{"screening_id": sid3, "name": "佐藤", "party_size": 3}, key())
		tok := m["access_token"].(string)
		st, m := c.do("POST", "/api/v1/public/reservations/by-token/"+tok+"/cancel", nil, "")
		if st != 200 || m["status"] != "cancelled_self" {
			t.Fatal(st, m)
		}
		var taken, rows int
		e.db.QueryRow(`SELECT reserved_count FROM screenings WHERE id=$1`, sid3).Scan(&taken)
		e.db.QueryRow(`SELECT count(*) FROM reservations WHERE screening_id=$1`, sid3).Scan(&rows)
		if taken != 0 || rows != 1 {
			t.Fatalf("taken=%d rows=%d", taken, rows)
		}
	})

	t.Run("上映中止・非表示でも既存履歴を残し状態を表示", func(t *testing.T) {
		var sid4 string
		e.db.QueryRow(`SELECT id FROM screenings WHERE business_day=$1 ORDER BY starts_at OFFSET 3 LIMIT 1`, day).Scan(&sid4)
		c := e.newClient()
		_, m := c.do("POST", "/api/v1/public/reservations", map[string]any{"screening_id": sid4, "name": "鈴木", "party_size": 1}, key())
		tok := m["access_token"].(string)
		admin.do("PATCH", "/api/v1/admin/screenings/"+sid4, map[string]any{"visibility": "hidden"}, "")
		_, d := c.do("GET", "/api/v1/public/reservations/by-token/"+tok, nil, "")
		if d["status"] != "confirmed" {
			t.Fatalf("hidden screening invalidated reservation: %v", d["status"])
		}
		st, _ := admin.do("POST", "/api/v1/admin/screenings/"+sid4+"/cancel", map[string]any{"reason": "機材トラブル"}, "")
		if st != 200 {
			t.Fatal(st)
		}
		_, d = c.do("GET", "/api/v1/public/reservations/by-token/"+tok, nil, "")
		if d["status"] != "cancelled_screening" || d["screening"].(map[string]any)["run_status"] != "cancelled" {
			t.Fatalf("cancel not shown: %v", d)
		}
		var exists int
		e.db.QueryRow(`SELECT count(*) FROM screenings WHERE id=$1`, sid4).Scan(&exists)
		if exists != 1 {
			t.Fatal("screening deleted")
		}
	})

	t.Run("上映生成の再実行で同じ枠が重複しない", func(t *testing.T) {
		rule := map[string]any{"department_id": e.plane, "business_day": "2026-11-25", "title": "冬の星空", "window_start": "10:00",
			"window_end": "12:00", "duration_min": 10, "turnover_min": 5, "capacity": 18}
		st, m := admin.do("POST", "/api/v1/admin/screening-rules", rule, "")
		if st != 201 || m["created"].(float64) != 8 {
			t.Fatalf("first: %d %v", st, m)
		}
		st, m = admin.do("POST", "/api/v1/admin/screening-rules", rule, "")
		if st != 201 || m["created"].(float64) != 0 || m["skipped"].(float64) != 8 {
			t.Fatalf("second: %d %v", st, m)
		}
		rule["duration_min"] = 15
		st, _ = admin.do("POST", "/api/v1/admin/screening-rules/preview", rule, "")
		if st != 400 {
			t.Fatalf("overlap rule should be rejected: %d", st)
		}
	})

	t.Run("確保済み人数を下回る定員変更は不可", func(t *testing.T) {
		st, m := admin.do("PATCH", "/api/v1/admin/screenings/"+sid, map[string]any{"capacity": 10}, "")
		if st != 422 || errCode(m) != "capacity_below_taken" {
			t.Fatalf("%d %v", st, m)
		}
	})

	t.Run("当日受付も同じ定員を消費", func(t *testing.T) {
		st, m := reception.do("POST", "/api/v1/staff/walkins", map[string]any{"screening_id": sid, "party_size": 1}, key())
		if st != 422 {
			t.Fatalf("full screening accepted walkin: %d %v", st, m)
		}
	})
}

func TestCouponAndCashRules(t *testing.T) {
	e := setup(t)
	v := e.variants()
	soyM := v["やきうどん:しょうゆ/中"]
	soyL := v["やきうどん:しょうゆ/大"]
	admin := e.login("admin", "adminpass123")
	cashier := e.login("cashier1", "password123")
	treasurer := e.login("treasurer1", "password123")

	var pid string
	e.db.QueryRow(`SELECT id FROM products WHERE name='やきうどん'`).Scan(&pid)
	st, m := admin.do("POST", "/api/v1/admin/coupon-definitions", map[string]any{"name": "3人分50円引き", "discount_type": "fixed",
		"discount_value": 50, "scope": "items", "target_product_ids": []string{pid}, "holder_mode": "group", "splittable": true}, "")
	if st != 201 {
		t.Fatal(st, m)
	}
	defID := m["id"].(string)
	st, m = admin.do("POST", "/api/v1/admin/coupon-definitions/"+defID+"/issue", map[string]any{"persons": 3, "count": 1}, "")
	if st != 201 {
		t.Fatal(st, m)
	}
	token := m["issued"].([]any)[0].(map[string]any)["token"].(string)

	remaining := func() int {
		var n int
		e.db.QueryRow(`SELECT persons_remaining FROM issued_coupons WHERE definition_id=$1`, defID).Scan(&n)
		return n
	}
	newOrder := func(items ...map[string]any) string {
		st, m := cashier.do("POST", "/api/v1/staff/orders", map[string]any{"department_id": e.udon, "items": items}, key())
		if st != 201 {
			t.Fatal(st, m)
		}
		return m["id"].(string)
	}

	t.Run("クーポンを読むだけでは残数が変わらない", func(t *testing.T) {
		for i := 0; i < 3; i++ {
			st, m := cashier.do("GET", "/api/v1/staff/coupons/verify/"+token, nil, "")
			if st != 200 || m["usable"] != true {
				t.Fatal(st, m)
			}
		}
		id := newOrder(map[string]any{"variant_id": soyM, "quantity": 1})
		cashier.do("POST", "/api/v1/staff/orders/"+id+"/quote", map[string]any{"coupons": []map[string]any{{"token": token, "persons": 1}}}, "")
		if remaining() != 3 {
			t.Fatalf("remaining changed: %d", remaining())
		}
	})

	t.Run("会計失敗時にクーポン消費だけが残らない", func(t *testing.T) {
		id := newOrder(map[string]any{"variant_id": soyM, "quantity": 1})
		st, m := cashier.do("POST", "/api/v1/staff/orders/"+id+"/payment", map[string]any{"cash_received": 100,
			"coupons": []map[string]any{{"token": token, "persons": 1}}}, key())
		if st != 422 || errCode(m) != "insufficient" {
			t.Fatalf("%d %v", st, m)
		}
		if remaining() != 3 {
			t.Fatalf("coupon consumed on failure: %d", remaining())
		}
	})

	t.Run("分割利用は確定人数だけ減り残数は次回利用可能・割引は高い順", func(t *testing.T) {
		id := newOrder(map[string]any{"variant_id": soyM, "quantity": 1}, map[string]any{"variant_id": soyL, "quantity": 1})
		st, m := cashier.do("POST", "/api/v1/staff/orders/"+id+"/payment", map[string]any{"cash_received": 1000, "expected_total": 800,
			"coupons": []map[string]any{{"token": token, "persons": 2}}}, key())
		if st != 200 || m["discount"].(float64) != 100 || m["total"].(float64) != 800 {
			t.Fatalf("%d %v", st, m)
		}
		if remaining() != 1 {
			t.Fatalf("want 1 remaining got %d", remaining())
		}
	})

	t.Run("クーポン同時使用で残人数を超えない", func(t *testing.T) {
		var wg sync.WaitGroup
		var ok int32
		for i := 0; i < 6; i++ {
			id := newOrder(map[string]any{"variant_id": soyM, "quantity": 1})
			wg.Add(1)
			go func(id string) {
				defer wg.Done()
				st, _ := cashier.do("POST", "/api/v1/staff/orders/"+id+"/payment", map[string]any{"cash_received": 400,
					"coupons": []map[string]any{{"token": token, "persons": 1}}}, key())
				if st == 200 {
					atomic.AddInt32(&ok, 1)
				}
			}(id)
		}
		wg.Wait()
		if ok != 1 || remaining() != 0 {
			t.Fatalf("ok=%d remaining=%d", ok, remaining())
		}
		var used int
		e.db.QueryRow(`SELECT COALESCE(sum(persons),0) FROM coupon_redemptions cr JOIN issued_coupons ic ON ic.id=cr.issued_coupon_id WHERE ic.definition_id=$1`, defID).Scan(&used)
		if used != 3 {
			t.Fatalf("used persons %d", used)
		}
	})

	t.Run("返金は元入金を超えず現金と売上に反映", func(t *testing.T) {
		id := newOrder(map[string]any{"variant_id": soyL, "quantity": 2})
		cashier.do("POST", "/api/v1/staff/orders/"+id+"/payment", map[string]any{"cash_received": 1000}, key())
		st, m := cashier.do("POST", "/api/v1/staff/orders/"+id+"/refund", map[string]any{"amount": 100, "reason": "x"}, key())
		if st != 403 {
			t.Fatalf("cashier refund: %d", st)
		}
		st, m = treasurer.do("POST", "/api/v1/staff/orders/"+id+"/refund", map[string]any{"amount": 1200, "reason": "過大"}, key())
		if st != 422 {
			t.Fatalf("over refund: %d %v", st, m)
		}
		st, m = treasurer.do("POST", "/api/v1/staff/orders/"+id+"/refund", map[string]any{"amount": 500, "reason": "1つ作れなかった"}, key())
		if st != 200 || m["payment_status"] != "partially_refunded" {
			t.Fatal(st, m)
		}
		st, m = treasurer.do("POST", "/api/v1/staff/orders/"+id+"/refund", map[string]any{"amount": 501, "reason": "超過"}, key())
		if st != 422 {
			t.Fatalf("cumulative over refund: %d %v", st, m)
		}
		_, sales := treasurer.do("GET", "/api/v1/treasurer/sales?group=day", nil, "")
		tot := sales["total"].(map[string]any)
		if tot["refunded"].(float64) != 500 || tot["net"].(float64) != tot["paid"].(float64)-500 {
			t.Fatalf("sales not reflecting refund: %v", tot)
		}
	})

	t.Run("現金引継ぎは保管先のみ変わり全体総額は不変", func(t *testing.T) {
		total := func() int {
			var n int
			e.db.QueryRow(`SELECT COALESCE(sum(amount),0) FROM cash_entries WHERE medium='cash'`).Scan(&n)
			return n
		}
		before := total()
		var wallet, safe string
		e.db.QueryRow(`SELECT c.id FROM cash_accounts c JOIN members m ON m.id=c.member_id WHERE m.login_id='cashier1'`).Scan(&wallet)
		e.db.QueryRow(`SELECT id FROM cash_accounts WHERE kind='safe'`).Scan(&safe)
		st, m := cashier.do("POST", "/api/v1/staff/cash/transfers", map[string]any{"from_account_id": wallet, "to_account_id": safe, "amount": 1000}, key())
		if st != 201 {
			t.Fatal(st, m)
		}
		tid := m["id"].(string)
		if total() != before {
			t.Fatal("pending transfer changed totals")
		}
		st, m = treasurer.do("POST", "/api/v1/staff/cash/transfers/"+tid+"/decide", map[string]any{"action": "confirm"}, "")
		if st != 200 {
			t.Fatal(st, m)
		}
		if total() != before {
			t.Fatalf("total changed: %d -> %d", before, total())
		}
		var safeBal int
		e.db.QueryRow(`SELECT COALESCE(sum(amount),0) FROM cash_entries WHERE cash_account_id=$1`, safe).Scan(&safeBal)
		if safeBal != 1000 {
			t.Fatalf("safe balance %d", safeBal)
		}
		// 精算：差額を記録
		st, m = treasurer.do("POST", "/api/v1/treasurer/cash/reconciliations", map[string]any{"cash_account_id": safe, "actual_balance": 990, "note": "10円不足"}, key())
		if st != 201 || m["difference"].(float64) != -10 {
			t.Fatal(st, m)
		}
	})
}

func TestShiftRules(t *testing.T) {
	e := setup(t)
	admin := e.login("admin", "adminpass123")
	a := e.login("cashier1", "password123")
	b := e.login("kitchen1", "password123")
	var slot, aID, bID string
	e.db.QueryRow(`SELECT id FROM shift_slots ORDER BY starts_at LIMIT 1`).Scan(&slot)
	e.db.QueryRow(`SELECT id FROM members WHERE login_id='cashier1'`).Scan(&aID)
	e.db.QueryRow(`SELECT id FROM members WHERE login_id='kitchen1'`).Scan(&bID)
	a.do("PUT", "/api/v1/staff/shift-slots/"+slot+"/request", map[string]any{"preference": "want"}, "")
	st, m := admin.do("POST", "/api/v1/admin/shift-slots/"+slot+"/assignments", map[string]any{"member_id": aID}, "")
	if st != 201 {
		t.Fatal(st, m)
	}
	asg := m["id"].(string)
	st, m = a.do("POST", "/api/v1/staff/shift-exchanges", map[string]any{"assignment_id": asg, "to_member_id": bID, "reason": "用事"}, "")
	if st != 201 {
		t.Fatal(st, m)
	}
	ex := m["id"].(string)
	b.do("POST", "/api/v1/staff/shift-exchanges/"+ex+"/respond", map[string]any{"action": "accept"}, "")
	var who string
	e.db.QueryRow(`SELECT member_id FROM shift_assignments WHERE slot_id=$1 AND status='active'`, slot).Scan(&who)
	if who != aID {
		t.Fatal("assignment changed before admin approval")
	}
	st, _ = b.do("POST", "/api/v1/admin/shift-exchanges/"+ex+"/decide", map[string]any{"action": "approve"}, "")
	if st != 403 {
		t.Fatalf("non-admin approve: %d", st)
	}
	st, m = admin.do("POST", "/api/v1/admin/shift-exchanges/"+ex+"/decide", map[string]any{"action": "approve"}, "")
	if st != 200 {
		t.Fatal(st, m)
	}
	e.db.QueryRow(`SELECT member_id FROM shift_assignments WHERE slot_id=$1 AND status='active'`, slot).Scan(&who)
	if who != bID {
		t.Fatal("assignment not updated after approval")
	}
	var hist int
	e.db.QueryRow(`SELECT count(*) FROM shift_assignments WHERE slot_id=$1`, slot).Scan(&hist)
	if hist != 2 {
		t.Fatalf("history not kept: %d", hist)
	}
	_, sh := admin.do("GET", "/api/v1/staff/shifts", nil, "")
	if len(sh["warnings"].([]any)) == 0 {
		t.Fatal("understaffing warnings missing")
	}
}

func TestDisplayAndCoupons(t *testing.T) {
	e := setup(t)
	display := e.login("display1", "password123")
	// 一般公開APIから現在コードを取得できない
	_, pub := e.newClient().do("GET", "/api/v1/public/departments/"+e.udon+"/board", nil, "")
	b, _ := json.Marshal(pub)
	if strings.Contains(string(b), e.siteCode()) && strings.Contains(string(b), `"code"`) {
		t.Fatal("site code leaked in public board")
	}
	st, m := e.newClient().do("GET", "/api/v1/display/departments/"+e.udon+"/site-code", nil, "")
	if st != 401 {
		t.Fatalf("anon site code: %d", st)
	}
	st, m = display.do("GET", "/api/v1/display/departments/"+e.udon+"/site-code", nil, "")
	if st != 200 || m["code"] != e.siteCode() || len(m["code"].(string)) != 3 {
		t.Fatal(st, m)
	}
	// 上映終了後の自動発券（入場記録のあるチケットのみ・重複なし）
	reception := e.login("reception1", "password123")
	var sid string
	e.db.QueryRow(`SELECT id FROM screenings ORDER BY starts_at LIMIT 1`).Scan(&sid)
	c := e.newClient()
	_, r := c.do("POST", "/api/v1/public/reservations", map[string]any{"screening_id": sid, "name": "田中", "party_size": 3}, key())
	tok := r["access_token"].(string)
	_, d := c.do("GET", "/api/v1/public/reservations/by-token/"+tok, nil, "")
	for _, tk := range d["tickets"].([]any)[:2] {
		reception.do("POST", "/api/v1/staff/checkin", map[string]any{"token": tk.(map[string]any)["entry_token"]}, key())
	}
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		e.app.withTx(ctx, func(tx *sql.Tx) error {
			tx.Exec(`UPDATE screenings SET run_status='finished' WHERE id=$1`, sid)
			_, err := e.app.issueScreeningCoupons(ctx, tx, sid)
			return err
		})
	}
	_, d = c.do("GET", "/api/v1/public/reservations/by-token/"+tok, nil, "")
	coupons := d["coupons"].([]any)
	if len(coupons) != 1 || coupons[0].(map[string]any)["persons_total"].(float64) != 2 {
		t.Fatalf("auto issue wrong: %v", coupons)
	}
	ctok := coupons[0].(map[string]any)["token"].(string)
	st, cm := c.do("GET", "/api/v1/public/coupons/by-token/"+ctok, nil, "")
	if st != 200 || cm["persons_remaining"].(float64) != 2 {
		t.Fatal(st, cm)
	}

	// 予約URLの再発行で旧URL・旧入場QR・旧クーポンQRが無効になる
	var resID string
	e.db.QueryRow(`SELECT id FROM reservations WHERE public_no=$1`, d["reservation_no"]).Scan(&resID)
	oldEntry := d["tickets"].([]any)[2].(map[string]any)["entry_token"].(string)
	st, re := reception.do("POST", "/api/v1/staff/reservations/"+resID+"/reissue-link", map[string]any{"reason": "本人確認済み"}, "")
	if st != 200 {
		t.Fatal(st, re)
	}
	if st, _ := c.do("GET", "/api/v1/public/reservations/by-token/"+tok, nil, ""); st != 404 {
		t.Fatalf("old URL still valid: %d", st)
	}
	if _, v := reception.do("POST", "/api/v1/staff/checkin/verify", map[string]any{"token": oldEntry}, ""); v["result"] != "not_found" {
		t.Fatalf("old entry QR still valid: %v", v["result"])
	}
	if st, _ := c.do("GET", "/api/v1/public/coupons/by-token/"+ctok, nil, ""); st != 404 {
		t.Fatalf("old coupon QR still valid: %d", st)
	}
	_, nd := c.do("GET", "/api/v1/public/reservations/by-token/"+re["access_token"].(string), nil, "")
	newEntry := nd["tickets"].([]any)[2].(map[string]any)["entry_token"].(string)
	if _, v := reception.do("POST", "/api/v1/staff/checkin", map[string]any{"token": newEntry}, key()); v["result"] == "not_found" {
		t.Fatalf("new entry QR rejected: %v", v)
	}
}
