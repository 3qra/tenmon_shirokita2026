"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, newIdempotencyKey, post } from "@/lib/api";
import { useLive } from "@/lib/hooks";
import { businessLabel, yen } from "@/lib/format";
import { ActionButton, Badge, LiveStatus } from "@/components/ui";
import { isFinalError, Loading, RetryError, VisitorPage } from "@/components/visitor/common";
import { myOrders } from "@/components/visitor/store";

type OptionValue = { id: string; name: string; active: boolean; sort_order: number };
type OptionGroup = { id: string; name: string; active: boolean; sort_order: number; values: OptionValue[] };
type Variant = {
  id: string;
  label: string;
  option_value_ids: string[];
  price: number;
  sale_status: "on_sale" | "sold_out" | "stopped" | string;
  active: boolean;
  visibility: string;
  sort_order: number;
};
type Product = {
  id: string;
  name: string;
  description: string;
  active: boolean;
  needs_cooking: boolean;
  option_groups: OptionGroup[];
  variants: Variant[];
  sort_order: number;
};
type Dept = {
  id: string;
  name: string;
  business_status: string;
  mobile_order_enabled: boolean;
  site_code_enabled: boolean;
  notice: string;
};
type ProductsRes = { department: Dept; products: Product[] };
type QuoteItem = { variant_id: string; product_name: string; options_label: string; unit_price: number; quantity: number; line_total: number };
type Quote = { items: QuoteItem[]; subtotal: number };
type CreateRes = { id: string; call_number: number; total: number; access_token: string };

const MAX_QTY = 20;

const saleText = (s: string) => (s === "sold_out" ? "売り切れ" : s === "stopped" ? "販売停止中" : "");

export default function OrderPage() {
  const { deptId } = useParams<{ deptId: string }>();
  const router = useRouter();
  const { data, error, reload, lastOk, stale, connected } = useLive<ProductsRes>(
    deptId ? `/public/departments/${encodeURIComponent(deptId)}/products` : null,
    ["products", "departments"],
  );

  const [cart, setCart] = useState<Record<string, number>>({});
  const [siteCode, setSiteCode] = useState("");
  const [quote, setQuote] = useState<{ key: string; data: Quote } | null>(null);
  const [quoteError, setQuoteError] = useState<unknown>(null);
  const [quoting, setQuoting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [added, setAdded] = useState<string | null>(null);
  // 1回の注文操作につき1つの操作ID。通信失敗時の再送や二重タップでも同じIDを送る。
  const idem = useRef<{ key: string; body: string } | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const dept = data?.department;
  const products = useMemo(() => (data?.products ?? []).filter((p) => p.active), [data]);
  const canOrder = !!dept && dept.business_status === "open" && dept.mobile_order_enabled;

  const variantIndex = useMemo(() => {
    const m: Record<string, { product: Product; variant: Variant }> = {};
    for (const p of products) for (const v of p.variants) m[v.id] = { product: p, variant: v };
    return m;
  }, [products]);

  const cartLines = Object.entries(cart).filter(([, q]) => q > 0);
  const cartKey = JSON.stringify(cartLines.sort(([a], [b]) => a.localeCompare(b)));
  const totalQty = cartLines.reduce((s, [, q]) => s + q, 0);

  // サーバーで価格を確定（見積）。画面側で金額を計算して確定に使うことはしない。
  const quoteSeq = useRef(0);
  useEffect(() => {
    if (!deptId || cartLines.length === 0) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    const seq = ++quoteSeq.current;
    setQuoting(true);
    const t = setTimeout(async () => {
      try {
        const q = await post<Quote>("/public/orders/quote", {
          department_id: deptId,
          items: cartLines.map(([variant_id, quantity]) => ({ variant_id, quantity })),
        });
        if (seq !== quoteSeq.current) return;
        setQuote({ key: cartKey, data: q });
        setQuoteError(null);
      } catch (e) {
        if (seq !== quoteSeq.current) return;
        setQuote(null);
        setQuoteError(e);
      } finally {
        if (seq === quoteSeq.current) setQuoting(false);
      }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartKey, deptId, data]);

  const quoteCurrent = quote && quote.key === cartKey ? quote.data : null;

  const setQty = (variantId: string, qty: number) => {
    setSubmitError(null);
    setCart((c) => {
      const next = { ...c };
      if (qty <= 0) delete next[variantId];
      else next[variantId] = Math.min(qty, MAX_QTY);
      return next;
    });
  };

  const addToCart = (variantId: string, label: string) => {
    setQty(variantId, (cart[variantId] ?? 0) + 1);
    setAdded(`${label} をカートに追加しました`);
  };

  useEffect(() => {
    if (!added) return;
    const t = setTimeout(() => setAdded(null), 2500);
    return () => clearTimeout(t);
  }, [added]);

  const codeOk = !dept?.site_code_enabled || /^\d{3}$/.test(siteCode);
  const readyToSubmit = canOrder && cartLines.length > 0 && !!quoteCurrent && !quoting && codeOk;

  const submit = async () => {
    if (!dept || !readyToSubmit) return;
    const body = {
      department_id: dept.id,
      items: cartLines.map(([variant_id, quantity]) => ({ variant_id, quantity })),
      site_code: dept.site_code_enabled ? siteCode : "",
      channel: "web",
    };
    const bodyStr = JSON.stringify(body);
    if (!idem.current || idem.current.body !== bodyStr) idem.current = { key: newIdempotencyKey(), body: bodyStr };
    setSubmitError(null);
    try {
      const res = await post<CreateRes>("/public/orders", body, idem.current.key);
      myOrders.save({
        token: res.access_token,
        department_name: dept.name,
        call_number: res.call_number,
        saved_at: new Date().toISOString(),
      });
      idem.current = null;
      router.push(`/o/${encodeURIComponent(res.access_token)}`);
    } catch (e) {
      // サーバーが結果を確定した失敗（コード違い・売り切れ等）は、次回は新しい操作IDで送る。
      // 通信断・処理中・混雑は同じIDのまま再送できるよう保持する。
      if (isFinalError(e)) idem.current = null;
      setSubmitError(e);
      if (e instanceof ApiError) {
        if (e.code === "site_code_invalid") {
          setSiteCode("");
          codeRef.current?.focus();
        }
        if (["sold_out", "item_stopped", "item_unavailable", "not_open", "mobile_order_off"].includes(e.code)) reload();
      }
    }
  };

  if (!data) {
    return (
      <VisitorPage>
        {error ? <RetryError error={error} onRetry={reload} /> : <Loading />}
        <Link href="/">← ホームへ戻る</Link>
      </VisitorPage>
    );
  }

  return (
    <VisitorPage>
      <p style={{ margin: "4px 0" }}>
        <Link href="/">← ホーム</Link>
      </p>
      <h1>{dept!.name}</h1>
      <LiveStatus lastOk={lastOk} stale={stale} connected={connected} error={error} />

      {dept!.notice && (
        <div className="banner banner-info" style={{ whiteSpace: "pre-wrap" }}>
          <strong>お知らせ：</strong>
          {dept!.notice}
        </div>
      )}

      {!canOrder && (
        <div className="banner banner-warn" role="status">
          <strong>
            ⚠{" "}
            {dept!.business_status !== "open"
              ? `現在は${businessLabel[dept!.business_status] ?? "受付時間外"}のため、注文できません。`
              : "現在、スマートフォンからの注文は受け付けていません。"}
          </strong>
          <br />
          {dept!.business_status === "open" ? "店頭でご注文ください。" : "営業中に店頭でご注文ください。"}以下はメニューのご案内です。
        </div>
      )}

      <h2>メニュー</h2>
      {products.length === 0 && <p className="empty">現在ご案内できる商品はありません。</p>}
      {products.map((p) => (
        <ProductCard key={p.id} product={p} canOrder={canOrder} onAdd={addToCart} />
      ))}

      {canOrder && (
        <section id="cart" className="card" aria-labelledby="cart-title">
          <h2 id="cart-title" style={{ marginTop: 0 }}>
            カート{totalQty > 0 && `（${totalQty}点）`}
          </h2>
          {cartLines.length === 0 ? (
            <p className="muted">まだ商品が入っていません。上のメニューから選んでください。</p>
          ) : (
            <div>
              {cartLines.map(([vid, qty]) => {
                const info = variantIndex[vid];
                const q = quoteCurrent?.items.find((i) => i.variant_id === vid);
                const name = info ? info.product.name : q?.product_name ?? "商品";
                const label = info ? info.variant.label : q?.options_label ?? "";
                const unavailable = info && info.variant.sale_status !== "on_sale";
                return (
                  <div className="v-cart-line" key={vid}>
                    <div>
                      <strong>{name}</strong>
                      {label && <div className="muted">{label}</div>}
                      {!info && <Badge tone="danger">✕ 販売終了</Badge>}
                      {unavailable && <Badge tone="danger">✕ {saleText(info.variant.sale_status)}</Badge>}
                    </div>
                    <div className="qty">
                      <button
                        type="button"
                        className="btn"
                        aria-label={`${name} ${label} を1つ減らす`}
                        onClick={() => setQty(vid, qty - 1)}
                      >
                        {qty === 1 ? "🗑" : "−"}
                      </button>
                      <output aria-live="polite" aria-label="数量">
                        {qty}
                      </output>
                      <button
                        type="button"
                        className="btn"
                        aria-label={`${name} ${label} を1つ増やす`}
                        disabled={qty >= MAX_QTY || !!unavailable || !info}
                        onClick={() => setQty(vid, qty + 1)}
                      >
                        ＋
                      </button>
                    </div>
                    <div className="v-line-total muted num">{q ? yen(q.line_total) : "—"}</div>
                  </div>
                );
              })}
            </div>
          )}

          {quoteError ? <RetryError error={quoteError} /> : null}

          {cartLines.length > 0 && dept!.site_code_enabled && (
            <div className="field">
              <label htmlFor="site-code">
                <strong>確認コード（3桁）</strong>
                <span className="muted" style={{ display: "block", fontSize: "0.9rem" }}>
                  会場の画面に表示されている3桁の数字を入力してください。コードは一定時間ごとに変わります。
                </span>
              </label>
              <div className="v-code-box">
                <input
                  id="site-code"
                  ref={codeRef}
                  className="code-input"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="one-time-code"
                  maxLength={3}
                  placeholder="000"
                  value={siteCode}
                  onChange={(e) => {
                    setSiteCode(e.target.value.replace(/\D/g, "").slice(0, 3));
                    setSubmitError(null);
                  }}
                  aria-describedby="site-code-help"
                />
              </div>
              <p id="site-code-help" className="muted center" style={{ fontSize: "0.85rem" }}>
                {siteCode.length > 0 && siteCode.length < 3 ? `あと${3 - siteCode.length}桁入力してください` : " "}
              </p>
            </div>
          )}

          {cartLines.length > 0 && (
            <p className="muted" style={{ fontSize: "0.9rem" }}>
              お支払いは注文後に店頭で行います（現金・金券）。受け取り時に呼出番号をお伝えください。
            </p>
          )}

          {submitError ? <RetryError error={submitError} /> : null}
        </section>
      )}

      {canOrder && cartLines.length > 0 && (
        <div className="total-bar">
          <div>
            <div className="muted" style={{ fontSize: "0.8rem" }}>
              合計（{totalQty}点）
            </div>
            <div className="v-total" aria-live="polite">
              {quoting || !quoteCurrent ? (quoteError ? "—" : "計算中…") : yen(quoteCurrent.subtotal)}
            </div>
          </div>
          <ActionButton className="btn btn-primary btn-lg" onClick={submit} disabled={!readyToSubmit}>
            {!codeOk ? "コードを入力" : submitError && !isFinalError(submitError) ? "もう一度送信" : "注文を確定する"}
          </ActionButton>
        </div>
      )}

      {added && (
        <div className="toast" role="status">
          {added}
        </div>
      )}
    </VisitorPage>
  );
}

function ProductCard({ product, canOrder, onAdd }: { product: Product; canOrder: boolean; onAdd: (variantId: string, label: string) => void }) {
  const variants = product.variants.filter((v) => v.active && v.visibility !== "hidden");
  const groups = product.option_groups
    .filter((g) => g.active)
    .map((g) => ({ ...g, values: g.values.filter((v) => v.active && variants.some((x) => x.option_value_ids.includes(v.id))) }))
    .filter((g) => g.values.length > 0)
    .sort((a, b) => a.sort_order - b.sort_order);

  const [sel, setSel] = useState<Record<string, string>>({});
  const [pickVariant, setPickVariant] = useState<string | null>(variants.length === 1 && groups.length === 0 ? variants[0].id : null);

  // 他の選択と組み合わせたときに該当するバリエーション
  const matching = (groupId: string, valueId: string) =>
    variants.filter(
      (v) =>
        v.option_value_ids.includes(valueId) &&
        groups.every((g) => g.id === groupId || !sel[g.id] || v.option_value_ids.includes(sel[g.id])),
    );

  let resolved: Variant | null = null;
  if (groups.length > 0) {
    if (groups.every((g) => sel[g.id])) {
      resolved = variants.find((v) => groups.every((g) => v.option_value_ids.includes(sel[g.id]))) ?? null;
    }
  } else if (pickVariant) {
    resolved = variants.find((v) => v.id === pickVariant) ?? null;
  }
  const missing = groups.find((g) => !sel[g.id]);
  const prices = variants.filter((v) => v.sale_status === "on_sale").map((v) => v.price);
  const allOut = variants.length > 0 && prices.length === 0;
  const priceText = resolved
    ? yen(resolved.price)
    : prices.length === 0
      ? ""
      : Math.min(...prices) === Math.max(...prices)
        ? yen(prices[0])
        : `${yen(Math.min(...prices))}〜${yen(Math.max(...prices))}`;

  return (
    <article className="card" aria-labelledby={`p-${product.id}`}>
      <div className="row-between">
        <h3 id={`p-${product.id}`} style={{ margin: 0 }}>
          {product.name}
        </h3>
        <span className="price">{priceText}</span>
      </div>
      {product.description && <p className="muted">{product.description}</p>}
      {allOut && (
        <p>
          <Badge tone="danger">✕ {variants.every((v) => v.sale_status === "stopped") ? "販売停止中" : "売り切れ"}</Badge>
        </p>
      )}

      {groups.map((g) => (
        <fieldset key={g.id} className="v-fieldset">
          <legend>{g.name}を選択</legend>
          <div className="v-options">
            {g.values.map((v) => {
              const m = matching(g.id, v.id);
              const anyOnSale = m.some((x) => x.sale_status === "on_sale");
              const note = m.length === 0 ? "この組合せなし" : anyOnSale ? "" : m.every((x) => x.sale_status === "stopped") ? "販売停止" : "売り切れ";
              return (
                <button
                  key={v.id}
                  type="button"
                  className="v-opt"
                  aria-pressed={sel[g.id] === v.id}
                  onClick={() => setSel((s) => ({ ...s, [g.id]: v.id }))}
                >
                  {v.name}
                  {note && <span className="v-opt-note">✕ {note}</span>}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}

      {groups.length === 0 && variants.length > 1 && (
        <fieldset className="v-fieldset">
          <legend>種類を選択</legend>
          <div className="v-options">
            {variants.map((v) => (
              <button key={v.id} type="button" className="v-opt" aria-pressed={pickVariant === v.id} onClick={() => setPickVariant(v.id)}>
                {v.label || product.name}（{yen(v.price)}）
                {v.sale_status !== "on_sale" && <span className="v-opt-note">✕ {saleText(v.sale_status)}</span>}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {resolved && resolved.sale_status !== "on_sale" && (
        <div className="banner banner-danger" role="status">
          ✕ {resolved.label ? `「${resolved.label}」は` : ""}
          {saleText(resolved.sale_status)}です。{resolved.sale_status === "sold_out" ? "ほかの組み合わせをお選びください。" : ""}
        </div>
      )}
      {groups.length > 0 && !missing && !resolved && <div className="banner banner-warn">この組み合わせはご用意していません。</div>}

      {canOrder && !allOut && (
        <button
          type="button"
          className="btn btn-primary btn-block"
          style={{ marginTop: 8 }}
          disabled={!resolved || resolved.sale_status !== "on_sale"}
          onClick={() => resolved && onAdd(resolved.id, `${product.name}${resolved.label ? `（${resolved.label}）` : ""}`)}
        >
          {missing
            ? `「${missing.name}」を選んでください`
            : !resolved
              ? groups.length === 0
                ? "種類を選んでください"
                : "選べない組み合わせです"
              : resolved.sale_status !== "on_sale"
                ? `✕ ${saleText(resolved.sale_status)}`
                : `カートに追加（${yen(resolved.price)}）`}
        </button>
      )}
    </article>
  );
}
