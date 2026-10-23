package app

import (
	"context"
	"database/sql"
	"log/slog"
	"time"
)

// SeedDemo はダミー初期データを入れる（部門が1件もない場合のみ）。
// 価格・日付・定員はすべて仮の値。公開前に管理画面で必ず確認・修正すること。
func (a *App) SeedDemo(ctx context.Context) error {
	var n int
	if err := a.DB.QueryRowContext(ctx, `SELECT count(*) FROM departments`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		slog.Info("seed skipped: departments already exist")
		return nil
	}
	return a.withTx(ctx, func(tx *sql.Tx) error {
		var eventID string
		if err := tx.QueryRowContext(ctx, `INSERT INTO festival_events(name) VALUES ('学園祭（ダミー）') RETURNING id`).Scan(&eventID); err != nil {
			return err
		}
		// ダミー開催日：今日から3日間
		base := a.Now().In(jst)
		days := []string{}
		for i := 0; i < 3; i++ {
			d := base.AddDate(0, 0, i).Format("2006-01-02")
			days = append(days, d)
			if _, err := tx.ExecContext(ctx, `INSERT INTO business_days(event_id, day, label) VALUES ($1,$2,$3)`, eventID, d, []string{"1日目", "2日目", "3日目"}[i]); err != nil {
				return err
			}
		}
		var udon, plane, goods string
		if err := tx.QueryRowContext(ctx, `INSERT INTO departments(code, name, kind, business_status, mobile_order_enabled, site_code_enabled, sort_order)
			VALUES ('udon','やきうどん','food','open',true,true,0) RETURNING id`).Scan(&udon); err != nil {
			return err
		}
		if err := tx.QueryRowContext(ctx, `INSERT INTO departments(code, name, kind, business_status, sort_order)
			VALUES ('planetarium','プラネタリウム','planetarium','open',1) RETURNING id`).Scan(&plane); err != nil {
			return err
		}
		if err := tx.QueryRowContext(ctx, `INSERT INTO departments(code, name, kind, business_status, sort_order)
			VALUES ('goods','プラネ物販','goods','open',2) RETURNING id`).Scan(&goods); err != nil {
			return err
		}

		// やきうどん（味×サイズ）— ダミー価格
		var pid string
		if err := tx.QueryRowContext(ctx, `INSERT INTO products(department_id, name, needs_cooking) VALUES ($1,'やきうどん',true) RETURNING id`, udon).Scan(&pid); err != nil {
			return err
		}
		groups := []struct {
			name   string
			values []string
		}{{"味", []string{"しょうゆ", "しお"}}, {"サイズ", []string{"中", "大"}}}
		ids := map[string]string{}
		for gi, g := range groups {
			var gid string
			if err := tx.QueryRowContext(ctx, `INSERT INTO option_groups(product_id, name, sort_order) VALUES ($1,$2,$3) RETURNING id`, pid, g.name, gi).Scan(&gid); err != nil {
				return err
			}
			for vi, v := range g.values {
				var vid string
				if err := tx.QueryRowContext(ctx, `INSERT INTO option_values(group_id, name, sort_order) VALUES ($1,$2,$3) RETURNING id`, gid, v, vi).Scan(&vid); err != nil {
					return err
				}
				ids[v] = vid
			}
		}
		prices := []struct {
			flavor, size string
			price        int
		}{{"しょうゆ", "中", 400}, {"しょうゆ", "大", 500}, {"しお", "中", 400}, {"しお", "大", 500}}
		for i, p := range prices {
			if err := insertVariant(ctx, tx, pid, []string{ids[p.flavor], ids[p.size]}, p.price, i); err != nil {
				return err
			}
		}
		// 物販（調理不要）— ダミー
		for i, g := range []struct {
			name  string
			price int
		}{{"星座ポストカード", 100}, {"星座早見盤", 300}, {"缶バッジ", 200}} {
			var gp string
			if err := tx.QueryRowContext(ctx, `INSERT INTO products(department_id, name, needs_cooking, sort_order) VALUES ($1,$2,false,$3) RETURNING id`,
				goods, g.name, i).Scan(&gp); err != nil {
				return err
			}
			if err := insertVariant(ctx, tx, gp, nil, g.price, 0); err != nil {
				return err
			}
		}

		// 上映枠：各日 10:00〜16:00、開始間隔15分、上映10分＋入替5分、定員18（ダミー）
		for _, d := range days {
			day, _ := time.ParseInLocation("2006-01-02", d, jst)
			for t := day.Add(10 * time.Hour); !t.Add(10 * time.Minute).After(day.Add(16 * time.Hour)); t = t.Add(15 * time.Minute) {
				if _, err := tx.ExecContext(ctx, `INSERT INTO screenings(department_id, title, business_day, starts_at, ends_at, occupied_until, capacity, booking_closes_at)
					VALUES ($1,'秋の星空',$2,$3,$4,$5,18,$3)`, plane, d, t, t.Add(10*time.Minute), t.Add(15*time.Minute)); err != nil {
					return err
				}
			}
		}

		// 保管先：金庫・共用レジ
		if _, err := tx.ExecContext(ctx, `INSERT INTO cash_accounts(name, kind) VALUES ('部の金庫','safe'), ('やきうどん共用レジ','register')`); err != nil {
			return err
		}

		// クーポン（ダミー）：プラネ鑑賞者向け、やきうどん1点50円引き、併用不可
		var cid string
		if err := tx.QueryRowContext(ctx, `INSERT INTO coupon_definitions(name, description, discount_type, discount_value, scope, target_department_id,
			items_per_person, holder_mode, splittable, combinable, auto_issue)
			VALUES ('プラネ鑑賞特典','やきうどん1点50円引き（ダミー）','fixed',50,'items',$1,1,'group',true,false,'screening_attended') RETURNING id`, udon).Scan(&cid); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO coupon_targets(definition_id, product_id) VALUES ($1,$2)`, cid, pid); err != nil {
			return err
		}

		// デモ用スタッフ（パスワードは本番前に必ず変更）
		demo := []struct {
			name, login string
			roles       []string
		}{
			{"会計 太郎", "cashier1", []string{"cashier", "member"}},
			{"キッチン 花子", "kitchen1", []string{"kitchen", "member"}},
			{"受付 次郎", "reception1", []string{"reception", "member"}},
			{"会計責任者 三郎", "treasurer1", []string{"treasurer", "cashier", "member"}},
			{"表示端末", "display1", []string{"display"}},
		}
		hash, err := hashPassword("password123")
		if err != nil {
			return err
		}
		for _, m := range demo {
			var id string
			if err := tx.QueryRowContext(ctx, `INSERT INTO members(name, login_id, password_hash) VALUES ($1,$2,$3) ON CONFLICT (login_id) DO NOTHING RETURNING id`,
				m.name, m.login, hash).Scan(&id); err != nil {
				if err == sql.ErrNoRows {
					continue
				}
				return err
			}
			for _, r := range m.roles {
				if _, err := tx.ExecContext(ctx, `INSERT INTO member_roles(member_id, role) VALUES ($1,$2)`, id, r); err != nil {
					return err
				}
			}
			if m.login != "display1" {
				if _, err := tx.ExecContext(ctx, `INSERT INTO cash_accounts(name, kind, member_id) VALUES ($1 || 'の財布','wallet',$2)`, m.name, id); err != nil {
					return err
				}
			}
		}
		// 管理者（Bootstrapで作成済みなら財布を補完）
		if _, err := tx.ExecContext(ctx, `INSERT INTO cash_accounts(name, kind, member_id)
			SELECT m.name || 'の財布', 'wallet', m.id FROM members m JOIN member_roles r ON r.member_id=m.id AND r.role='admin'
			WHERE NOT EXISTS (SELECT 1 FROM cash_accounts c WHERE c.member_id=m.id AND c.kind='wallet')`); err != nil {
			return err
		}

		// シフト枠（ダミー）
		for _, d := range days {
			day, _ := time.ParseInLocation("2006-01-02", d, jst)
			for _, sl := range []struct {
				loc   string
				start int
				req   int
			}{{"やきうどん調理", 10, 3}, {"やきうどん会計", 10, 2}, {"プラネ受付", 10, 2}, {"やきうどん調理", 13, 3}, {"やきうどん会計", 13, 2}, {"プラネ受付", 13, 2}} {
				st := day.Add(time.Duration(sl.start) * time.Hour)
				if _, err := tx.ExecContext(ctx, `INSERT INTO shift_slots(business_day, location, starts_at, ends_at, required_count) VALUES ($1,$2,$3,$4,$5)`,
					d, sl.loc, st, st.Add(3*time.Hour), sl.req); err != nil {
					return err
				}
			}
		}
		slog.Info("demo data seeded", "days", days)
		return nil
	})
}
