package app

import (
	"context"
	"database/sql"
	"net/http"
	"sort"
	"strings"

	"github.com/lib/pq"
)

// 商品カタログ（JSON）。visibleOnly=true なら来場者向け（公開・有効のみ）。
func (a *App) catalog(ctx context.Context, q queryer, deptID string, visibleOnly bool) (any, error) {
	vis := ""
	if visibleOnly {
		vis = " AND p.visibility='public' AND p.active"
	}
	var out any
	err := queryJSON(ctx, q, &out, `SELECT COALESCE(json_agg(p ORDER BY p.sort_order, p.name), '[]') FROM (
		SELECT p.id, p.department_id, p.name, p.description, p.needs_cooking, p.visibility, p.active, p.sort_order,
		  COALESCE((SELECT json_agg(g ORDER BY g.sort_order, g.name) FROM (
		    SELECT g.id, g.name, g.sort_order, g.active,
		      COALESCE((SELECT json_agg(json_build_object('id',v.id,'name',v.name,'sort_order',v.sort_order,'active',v.active)
		        ORDER BY v.sort_order, v.name) FROM option_values v WHERE v.group_id=g.id `+ifStr(visibleOnly, "AND v.active", "")+`), '[]') AS values
		    FROM option_groups g WHERE g.product_id=p.id `+ifStr(visibleOnly, "AND g.active", "")+`) g), '[]') AS option_groups,
		  COALESCE((SELECT json_agg(x ORDER BY x.sort_order, x.price) FROM (
		    SELECT pv.id, pv.price, pv.visibility, pv.sale_status, pv.active, pv.sort_order,
		      COALESCE((SELECT json_agg(o.value_id) FROM product_variant_options o WHERE o.variant_id=pv.id), '[]') AS option_value_ids,
		      COALESCE((SELECT string_agg(ov.name, ' / ' ORDER BY og.sort_order, og.name)
		        FROM product_variant_options o JOIN option_values ov ON ov.id=o.value_id JOIN option_groups og ON og.id=ov.group_id
		        WHERE o.variant_id=pv.id), '') AS label
		    FROM product_variants pv WHERE pv.product_id=p.id `+ifStr(visibleOnly, `AND pv.active AND pv.visibility='public'
		      AND NOT EXISTS (SELECT 1 FROM product_variant_options o JOIN option_values ov ON ov.id=o.value_id
		        JOIN option_groups og ON og.id=ov.group_id WHERE o.variant_id=pv.id AND (NOT ov.active OR NOT og.active))`, "")+`) x), '[]') AS variants
		FROM products p WHERE p.department_id=$1`+vis+`) p`, deptID)
	return out, err
}

func ifStr(c bool, a, b string) string {
	if c {
		return a
	}
	return b
}

// GET /api/v1/public/departments/{id}/products
func (a *App) handlePublicProducts(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	d, err := a.getDept(ctx, a.DB, id, false)
	if err != nil {
		return err
	}
	cat, err := a.catalog(ctx, a.DB, id, true)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"department": d, "products": cat})
	return nil
}

// GET /api/v1/staff/departments/{id}/products（非表示も含む）
func (a *App) handleStaffProducts(w http.ResponseWriter, r *http.Request, s *Staff) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	d, err := a.getDept(ctx, a.DB, id, false)
	if err != nil {
		return err
	}
	cat, err := a.catalog(ctx, a.DB, id, false)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"department": d, "products": cat})
	return nil
}

type optionGroupInput struct {
	Name   string   `json:"name"`
	Values []string `json:"values"`
}

// POST /api/v1/admin/products
// {department_id, name, description, needs_cooking, option_groups:[{name, values:[...]}], default_price}
// 選択肢の全組み合わせを default_price で作成する（後から個別に価格・販売可否を変更できる）。
func (a *App) handleCreateProduct(w http.ResponseWriter, r *http.Request, s *Staff) error {
	var in struct {
		DepartmentID string             `json:"department_id"`
		Name         string             `json:"name"`
		Description  string             `json:"description"`
		NeedsCooking bool               `json:"needs_cooking"`
		Visibility   string             `json:"visibility"`
		SortOrder    int                `json:"sort_order"`
		OptionGroups []optionGroupInput `json:"option_groups"`
		DefaultPrice int                `json:"default_price"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if !isUUID(in.DepartmentID) {
		return badRequest("部門を指定してください")
	}
	if err := requireText("商品名", in.Name, 50); err != nil {
		return err
	}
	if in.DefaultPrice < 0 {
		return badRequest("価格は0円以上にしてください")
	}
	if in.Visibility == "" {
		in.Visibility = "public"
	}
	ctx := r.Context()
	var pid string
	err := a.withTx(ctx, func(tx *sql.Tx) error {
		if err := tx.QueryRowContext(ctx, `INSERT INTO products(department_id, name, description, needs_cooking, visibility, sort_order)
			VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, in.DepartmentID, strings.TrimSpace(in.Name), in.Description,
			in.NeedsCooking, in.Visibility, in.SortOrder).Scan(&pid); err != nil {
			return err
		}
		var groups [][]string
		for gi, g := range in.OptionGroups {
			if err := requireText("選択肢の種類", g.Name, 30); err != nil {
				return err
			}
			if len(g.Values) == 0 {
				return badRequest("「%s」の選択肢を1つ以上入力してください", g.Name)
			}
			var gid string
			if err := tx.QueryRowContext(ctx, `INSERT INTO option_groups(product_id, name, sort_order) VALUES ($1,$2,$3) RETURNING id`,
				pid, strings.TrimSpace(g.Name), gi).Scan(&gid); err != nil {
				return err
			}
			var ids []string
			for vi, v := range g.Values {
				if err := requireText("選択肢", v, 30); err != nil {
					return err
				}
				var vid string
				if err := tx.QueryRowContext(ctx, `INSERT INTO option_values(group_id, name, sort_order) VALUES ($1,$2,$3) RETURNING id`,
					gid, strings.TrimSpace(v), vi).Scan(&vid); err != nil {
					return err
				}
				ids = append(ids, vid)
			}
			groups = append(groups, ids)
		}
		for i, combo := range combinations(groups) {
			if err := insertVariant(ctx, tx, pid, combo, in.DefaultPrice, i); err != nil {
				return err
			}
		}
		if err := audit(ctx, tx, s, "product.create", "product", pid, in); err != nil {
			return err
		}
		return publish(ctx, tx, "products")
	})
	if err != nil {
		return err
	}
	writeJSON(w, 201, map[string]any{"id": pid})
	return nil
}

func combinations(groups [][]string) [][]string {
	out := [][]string{{}}
	for _, g := range groups {
		var next [][]string
		for _, prefix := range out {
			for _, v := range g {
				c := append(append([]string{}, prefix...), v)
				next = append(next, c)
			}
		}
		out = next
	}
	return out
}

func optionKey(ids []string) string {
	s := append([]string{}, ids...)
	sort.Strings(s)
	return strings.Join(s, ",")
}

func insertVariant(ctx context.Context, tx *sql.Tx, productID string, valueIDs []string, price, sortOrder int) error {
	var vid string
	err := tx.QueryRowContext(ctx, `INSERT INTO product_variants(product_id, option_key, price, sort_order) VALUES ($1,$2,$3,$4)
		ON CONFLICT (product_id, option_key) DO NOTHING RETURNING id`, productID, optionKey(valueIDs), price, sortOrder).Scan(&vid)
	if err == sql.ErrNoRows {
		return nil // 既存の組み合わせは変更しない
	}
	if err != nil {
		return err
	}
	for _, v := range valueIDs {
		if _, err := tx.ExecContext(ctx, `INSERT INTO product_variant_options(variant_id, value_id) VALUES ($1,$2)`, vid, v); err != nil {
			return err
		}
	}
	return nil
}

// PATCH /api/v1/admin/products/{id}
func (a *App) handleUpdateProduct(w http.ResponseWriter, r *http.Request, s *Staff) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Name         *string `json:"name"`
		Description  *string `json:"description"`
		NeedsCooking *bool   `json:"needs_cooking"`
		Visibility   *string `json:"visibility"`
		Active       *bool   `json:"active"`
		SortOrder    *int    `json:"sort_order"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if in.Name != nil {
		if err := requireText("商品名", *in.Name, 50); err != nil {
			return err
		}
	}
	ctx := r.Context()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE products SET name=COALESCE($2,name), description=COALESCE($3,description),
			needs_cooking=COALESCE($4,needs_cooking), visibility=COALESCE($5,visibility), active=COALESCE($6,active),
			sort_order=COALESCE($7,sort_order), updated_at=now() WHERE id=$1`,
			id, in.Name, in.Description, in.NeedsCooking, in.Visibility, in.Active, in.SortOrder)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return notFound("商品")
		}
		if err := audit(ctx, tx, s, "product.update", "product", id, in); err != nil {
			return err
		}
		if err := publish(ctx, tx, "products"); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return nil
	})
}

// POST /api/v1/admin/products/{id}/option-groups {name, values:[...], default_price}
// 新しい軸を追加すると既存の組み合わせとの掛け合わせが必要になるため、既存バリエーションは無効化し新たに作成する。
func (a *App) handleAddOptionGroup(w http.ResponseWriter, r *http.Request, s *Staff) error {
	pid, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		optionGroupInput
		DefaultPrice int `json:"default_price"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if err := requireText("選択肢の種類", in.Name, 30); err != nil {
		return err
	}
	if len(in.Values) == 0 {
		return badRequest("選択肢を1つ以上入力してください")
	}
	if in.DefaultPrice < 0 {
		return badRequest("価格は0円以上にしてください")
	}
	ctx := r.Context()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		var gid string
		if err := tx.QueryRowContext(ctx, `INSERT INTO option_groups(product_id, name, sort_order)
			VALUES ($1,$2,(SELECT COALESCE(max(sort_order)+1,0) FROM option_groups WHERE product_id=$1)) RETURNING id`,
			pid, strings.TrimSpace(in.Name)).Scan(&gid); err != nil {
			return err
		}
		for i, v := range in.Values {
			if err := requireText("選択肢", v, 30); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO option_values(group_id, name, sort_order) VALUES ($1,$2,$3)`, gid, strings.TrimSpace(v), i); err != nil {
				return err
			}
		}
		// 旧バリエーションを無効化し、新しい組み合わせを作る。新しい組み合わせの価格・販売状態は、
		// それを含む旧組み合わせから引き継ぐ（例：しょうゆ/中 → しょうゆ/中/辛口）。
		rows, err := tx.QueryContext(ctx, `UPDATE product_variants SET active=false, updated_at=now() WHERE product_id=$1 AND active RETURNING id`, pid)
		if err != nil {
			return err
		}
		var oldIDs []string
		for rows.Next() {
			var x string
			if err := rows.Scan(&x); err != nil {
				rows.Close()
				return err
			}
			oldIDs = append(oldIDs, x)
		}
		rows.Close()
		if err := regenerateVariants(ctx, tx, pid, in.DefaultPrice); err != nil {
			return err
		}
		if len(oldIDs) > 0 {
			if _, err := tx.ExecContext(ctx, `UPDATE product_variants nv SET price=ov.price, sale_status=ov.sale_status, visibility=ov.visibility
				FROM product_variants ov
				WHERE nv.product_id=$1 AND nv.active AND ov.id = ANY($2::uuid[])
				  AND NOT EXISTS (SELECT value_id FROM product_variant_options WHERE variant_id=ov.id
				                  EXCEPT SELECT value_id FROM product_variant_options WHERE variant_id=nv.id)`,
				pid, pq.Array(oldIDs)); err != nil {
				return err
			}
		}
		if err := audit(ctx, tx, s, "product.option_group.add", "product", pid, in); err != nil {
			return err
		}
		if err := publish(ctx, tx, "products"); err != nil {
			return err
		}
		writeJSON(w, 201, map[string]any{"id": gid})
		return nil
	})
}

// regenerateVariants は有効な選択肢の組み合わせのうち未作成のものを作る。
func regenerateVariants(ctx context.Context, tx *sql.Tx, pid string, price int) error {
	rows, err := tx.QueryContext(ctx, `SELECT g.id, v.id FROM option_groups g JOIN option_values v ON v.group_id=g.id
		WHERE g.product_id=$1 AND g.active AND v.active ORDER BY g.sort_order, g.id, v.sort_order`, pid)
	if err != nil {
		return err
	}
	var groups [][]string
	last := ""
	for rows.Next() {
		var g, v string
		if err := rows.Scan(&g, &v); err != nil {
			rows.Close()
			return err
		}
		if g != last {
			groups = append(groups, nil)
			last = g
		}
		groups[len(groups)-1] = append(groups[len(groups)-1], v)
	}
	rows.Close()
	for i, c := range combinations(groups) {
		if err := insertVariant(ctx, tx, pid, c, price, 1000+i); err != nil {
			return err
		}
	}
	return nil
}

// POST /api/v1/admin/option-groups/{id}/values {name, default_price}
func (a *App) handleAddOptionValue(w http.ResponseWriter, r *http.Request, s *Staff) error {
	gid, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Name         string `json:"name"`
		DefaultPrice int    `json:"default_price"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if err := requireText("選択肢", in.Name, 30); err != nil {
		return err
	}
	if in.DefaultPrice < 0 {
		return badRequest("価格は0円以上にしてください")
	}
	ctx := r.Context()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		var pid, vid string
		if err := tx.QueryRowContext(ctx, `SELECT product_id FROM option_groups WHERE id=$1`, gid).Scan(&pid); err != nil {
			return err
		}
		if err := tx.QueryRowContext(ctx, `INSERT INTO option_values(group_id, name, sort_order)
			VALUES ($1,$2,(SELECT COALESCE(max(sort_order)+1,0) FROM option_values WHERE group_id=$1)) RETURNING id`,
			gid, strings.TrimSpace(in.Name)).Scan(&vid); err != nil {
			return err
		}
		if err := regenerateVariants(ctx, tx, pid, in.DefaultPrice); err != nil {
			return err
		}
		if err := audit(ctx, tx, s, "product.option_value.add", "product", pid, in); err != nil {
			return err
		}
		if err := publish(ctx, tx, "products"); err != nil {
			return err
		}
		writeJSON(w, 201, map[string]any{"id": vid})
		return nil
	})
}

// PATCH /api/v1/admin/option-groups/{id} / option-values/{id} {name, active, sort_order}
func (a *App) handleUpdateOption(table string) func(w http.ResponseWriter, r *http.Request, s *Staff) error {
	return func(w http.ResponseWriter, r *http.Request, s *Staff) error {
		id, err := pathID(r, "id")
		if err != nil {
			return err
		}
		var in struct {
			Name      *string `json:"name"`
			Active    *bool   `json:"active"`
			SortOrder *int    `json:"sort_order"`
		}
		if err := decodeJSON(r, &in); err != nil {
			return err
		}
		if in.Name != nil {
			if err := requireText("名称", *in.Name, 30); err != nil {
				return err
			}
		}
		ctx := r.Context()
		return a.withTx(ctx, func(tx *sql.Tx) error {
			res, err := tx.ExecContext(ctx, `UPDATE `+table+` SET name=COALESCE($2,name), active=COALESCE($3,active),
				sort_order=COALESCE($4,sort_order), updated_at=now() WHERE id=$1`, id, in.Name, in.Active, in.SortOrder)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n == 0 {
				return notFound("選択肢")
			}
			if err := audit(ctx, tx, s, table+".update", table, id, in); err != nil {
				return err
			}
			if err := publish(ctx, tx, "products"); err != nil {
				return err
			}
			writeJSON(w, 200, map[string]any{"ok": true})
			return nil
		})
	}
}

// PATCH /api/v1/staff/variants/{id} {price, sale_status, visibility, active}
// 売り切れ切替は会計担当も可能。価格・公開・有効の変更は管理者のみ。
func (a *App) handleUpdateVariant(w http.ResponseWriter, r *http.Request, s *Staff) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Price      *int    `json:"price"`
		SaleStatus *string `json:"sale_status"`
		Visibility *string `json:"visibility"`
		Active     *bool   `json:"active"`
		SortOrder  *int    `json:"sort_order"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return err
	}
	if (in.Price != nil || in.Visibility != nil || in.Active != nil || in.SortOrder != nil) && !s.Has("admin") {
		return forbidden("価格・公開設定の変更は管理者のみ可能です")
	}
	if in.Price != nil && *in.Price < 0 {
		return badRequest("価格は0円以上にしてください")
	}
	ctx := r.Context()
	return a.withTx(ctx, func(tx *sql.Tx) error {
		var old struct {
			Price  int
			Status string
		}
		if err := tx.QueryRowContext(ctx, `SELECT price, sale_status FROM product_variants WHERE id=$1 FOR UPDATE`, id).Scan(&old.Price, &old.Status); err != nil {
			if err == sql.ErrNoRows {
				return notFound("商品")
			}
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE product_variants SET price=COALESCE($2,price), sale_status=COALESCE($3,sale_status),
			visibility=COALESCE($4,visibility), active=COALESCE($5,active), sort_order=COALESCE($6,sort_order), updated_at=now() WHERE id=$1`,
			id, in.Price, in.SaleStatus, in.Visibility, in.Active, in.SortOrder); err != nil {
			return err
		}
		if err := audit(ctx, tx, s, "variant.update", "product_variant", id, map[string]any{"before": old, "change": in}); err != nil {
			return err
		}
		if err := publish(ctx, tx, "products"); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"ok": true})
		return nil
	})
}
