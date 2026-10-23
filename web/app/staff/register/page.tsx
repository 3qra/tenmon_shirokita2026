"use client";

import { useCallback, useMemo, useState } from "react";
import { ApiError, errorMessage, patch } from "@/lib/api";
import { useFetch, useLive } from "@/lib/hooks";
import { businessLabel, yen } from "@/lib/format";
import { ActionButton, ErrorBox, LiveStatus, Notice, Toast } from "@/components/ui";
import { StaffShell } from "@/components/StaffShell";
import { PaymentPanel } from "../_components/PaymentPanel";
import { DeptPicker, useIdempotent, useStoredDept } from "../_components/common";
import type { Department, OrderDetail, Product, Variant } from "../_components/types";

type Catalog = { department: Department; products: Product[] };
type CartLine = { variant: Variant; product: Product; qty: number };

export default function RegisterPage() {
  return (
    <StaffShell roles={["cashier", "treasurer", "admin"]}>
      <Register />
    </StaffShell>
  );
}

function Register() {
  const { data: allDepts, error: deptErr } = useFetch<Department[]>("/staff/departments");
  const depts = useMemo(() => (allDepts ?? []).filter((d) => d.kind !== "planetarium"), [allDepts]);
  const [deptId, setDeptId] = useStoredDept("staff.register.dept", allDepts ? depts : null);
  const live = useLive<Catalog>(deptId ? `/staff/departments/${deptId}/products` : null, ["products", "departments"], 30000);
  const send = useIdempotent();
  const [cart, setCart] = useState<CartLine[]>([]);
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [paid, setPaid] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const clearToast = useCallback(() => setToast(null), []);

  const cat = live.data;
  const dept = cat?.department;
  const cartCount = cart.reduce((s, l) => s + l.qty, 0);
  const cartPreview = cart.reduce((s, l) => s + l.variant.price * l.qty, 0);

  function add(product: Product, variant: Variant) {
    setCart((c) => {
      const i = c.findIndex((l) => l.variant.id === variant.id);
      if (i >= 0) return c.map((l, j) => (j === i ? { ...l, qty: Math.min(99, l.qty + 1) } : l));
      return [...c, { product, variant, qty: 1 }];
    });
  }
  function setQty(variantId: string, qty: number) {
    setCart((c) => (qty <= 0 ? c.filter((l) => l.variant.id !== variantId) : c.map((l) => (l.variant.id === variantId ? { ...l, qty: Math.min(99, qty) } : l))));
  }

  async function toggleSoldOut(v: Variant, p: Product) {
    const next = v.sale_status === "on_sale" ? "sold_out" : "on_sale";
    const msg = next === "sold_out" ? `「${p.name} ${v.label}」を売り切れにしますか？` : `「${p.name} ${v.label}」の販売を再開しますか？`;
    if (!window.confirm(msg)) return;
    try {
      await patch(`/staff/variants/${v.id}`, { sale_status: next });
      setToast(next === "sold_out" ? "売り切れにしました" : "販売を再開しました");
      await live.reload();
    } catch (e) {
      setErr(errorMessage(e));
    }
  }

  async function placeOrder() {
    setErr(null);
    try {
      const o = await send<OrderDetail>("POST", "/staff/orders", {
        department_id: deptId,
        items: cart.map((l) => ({ variant_id: l.variant.id, quantity: l.qty })),
      });
      setOrder(o);
      setPaid(false);
      setCart([]);
    } catch (e) {
      if (e instanceof ApiError && e.code === "network") {
        setErr("通信できませんでした。もう一度「注文を確定」を押してください（同じ注文として扱われ、二重登録にはなりません）");
      } else {
        setErr(errorMessage(e));
        if (e instanceof ApiError && (e.code === "sold_out" || e.code === "item_stopped")) live.reload();
      }
    }
  }

  function next() {
    setOrder(null);
    setPaid(false);
    setErr(null);
  }

  if (deptErr) return <ErrorBox error={deptErr} />;

  // 注文確定後：呼出番号と会計
  if (order) {
    return (
      <>
        <h1>対面注文・会計</h1>
        <div className="card center">
          <p>呼出番号</p>
          <div className="call-number">{order.call_number}</div>
          <p>
            {order.items.map((i) => `${i.product_name}${i.options_label ? `（${i.options_label}）` : ""}×${i.quantity}`).join("、")}
          </p>
          <p className="muted">お客様に呼出番号をお伝えください。</p>
        </div>
        <PaymentPanel order={order} onPaid={() => setPaid(true)} />
        <div className="actions">
          {!paid && (
            <button className="btn" onClick={next}>
              会計はあとで（未払いのまま次へ）
            </button>
          )}
          {paid && (
            <button className="btn btn-primary btn-xl" onClick={next}>
              次の注文へ
            </button>
          )}
        </div>
        <Toast message={toast} onDone={clearToast} />
      </>
    );
  }

  return (
    <>
      <div className="section-title">
        <h1>対面注文・会計</h1>
        <LiveStatus lastOk={live.lastOk} stale={live.stale} connected={live.connected} error={live.error} />
      </div>
      <DeptPicker depts={depts} value={deptId} onChange={(id) => { setDeptId(id); setCart([]); }} />
      {dept && dept.business_status !== "open" && (
        <Notice kind="warn">⚠ {dept.name}は現在「{businessLabel[dept.business_status] ?? dept.business_status}」です。注文は確定できません。</Notice>
      )}
      <ErrorBox error={live.error && !cat ? live.error : null} />

      <label className="check">
        <input type="checkbox" checked={editMode} onChange={(e) => setEditMode(e.target.checked)} />
        売り切れ切替モード（商品を押すと売り切れ／販売再開を切り替え）
      </label>
      {editMode && <Notice kind="warn">売り切れ切替モード中です。商品を押してもカートには入りません。</Notice>}

      {cat && (
        <div className="ptiles">
          {cat.products
            .filter((p) => p.active)
            .flatMap((p) =>
              p.variants
                .filter((v) => v.active)
                .map((v) => {
                  const inCart = cart.find((l) => l.variant.id === v.id)?.qty ?? 0;
                  const sold = v.sale_status !== "on_sale";
                  const statusText = v.sale_status === "sold_out" ? "✕ 売り切れ" : v.sale_status === "stopped" ? "✕ 販売停止" : "";
                  return (
                    <button
                      key={v.id}
                      type="button"
                      className={`ptile ${sold ? "sold" : ""} ${editMode ? "edit" : ""}`}
                      disabled={!editMode && sold ? true : editMode && v.sale_status === "stopped"}
                      onClick={() => (editMode ? toggleSoldOut(v, p) : add(p, v))}
                      aria-label={`${p.name} ${v.label} ${v.price}円 ${statusText}`}
                    >
                      <span className="pname">{p.name}</span>
                      {v.label && <span className="plabel">{v.label}</span>}
                      <span className="pprice">{yen(v.price)}</span>
                      {statusText && <strong>{statusText}</strong>}
                      {editMode && v.sale_status !== "stopped" && <small>{v.sale_status === "on_sale" ? "押すと売り切れに" : "押すと販売再開"}</small>}
                      {inCart > 0 && <span className="incart">{inCart}</span>}
                    </button>
                  );
                }),
            )}
          {cat.products.length === 0 && <p className="empty">商品が登録されていません</p>}
        </div>
      )}

      <div className="cart-bar">
        {cart.length === 0 ? (
          <p className="muted center">商品を押すとカートに入ります</p>
        ) : (
          <>
            {cart.map((l) => (
              <div key={l.variant.id} className="cart-line">
                <div>
                  <strong>{l.product.name}</strong> {l.variant.label && <span>（{l.variant.label}）</span>}
                  <br />
                  <small className="num">
                    {yen(l.variant.price)} × {l.qty}
                  </small>
                </div>
                <div className="qty">
                  <button className="btn" aria-label="1つ減らす" onClick={() => setQty(l.variant.id, l.qty - 1)}>
                    −
                  </button>
                  <output aria-live="polite">{l.qty}</output>
                  <button className="btn" aria-label="1つ増やす" onClick={() => setQty(l.variant.id, l.qty + 1)}>
                    ＋
                  </button>
                </div>
              </div>
            ))}
            <div className="row-between" style={{ marginTop: 8 }}>
              <span>
                {cartCount}点・小計（目安）<strong className="num">{yen(cartPreview)}</strong>
              </span>
              <button className="btn btn-ghost btn-sm" onClick={() => setCart([])}>
                すべて削除
              </button>
            </div>
            <ErrorBox error={err} />
            <ActionButton className="btn btn-primary btn-xl" disabled={!deptId || cart.length === 0 || dept?.business_status !== "open"} onClick={placeOrder}>
              注文を確定（{cartCount}点）
            </ActionButton>
            <small className="muted">金額は確定時にサーバーで再計算されます。</small>
          </>
        )}
      </div>
      <Toast message={toast} onDone={clearToast} />
    </>
  );
}
