"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { post } from "@/lib/api";
import { useLive } from "@/lib/hooks";
import { cookLabel, hm, payLabel, yen } from "@/lib/format";
import { ActionButton, Badge, LiveStatus } from "@/components/ui";
import { Loading, RetryError, VisitorPage } from "@/components/visitor/common";
import { myOrders } from "@/components/visitor/store";

type OrderItem = {
  id: string;
  product_name: string;
  options_label: string;
  unit_price: number;
  quantity: number;
  line_total: number;
  discount: number;
  needs_cooking: boolean;
  cook_status: string;
};
type Order = {
  id: string;
  department_name: string;
  call_number: number;
  status: "accepted" | "cancelled" | "completed" | string;
  payment_status: string;
  handoff_status: "pending" | "handed" | string;
  subtotal: number;
  discount: number;
  total: number;
  created_at: string;
  handed_at: string | null;
  ready: boolean;
  items: OrderItem[];
  coupons: { name: string; persons: number; discount: number; status: string }[];
};

const cookTone = (s: string) => (s === "cooked" || s === "not_required" ? "ok" : s === "cooking" ? "info" : s === "cancelled" ? "danger" : "neutral");
const cookMark = (s: string) => (s === "cooked" ? "✓" : s === "cooking" ? "♨" : s === "cancelled" ? "✕" : s === "not_required" ? "✓" : "…");

export default function OrderStatusPage() {
  const { token } = useParams<{ token: string }>();
  const path = token ? `/public/orders/by-token/${encodeURIComponent(token)}` : null;
  const { data: o, error, reload, lastOk, stale, connected, setData } = useLive<Order>(path, ["orders"]);
  const [actionError, setActionError] = useState<unknown>(null);
  const [saved, setSaved] = useState(true);

  // このページを開いた端末のマイページにも控えを残す
  useEffect(() => {
    if (!o || !token) return;
    if (!myOrders.has(token)) {
      setSaved(myOrders.save({ token, department_name: o.department_name, call_number: o.call_number, saved_at: new Date().toISOString() }));
    }
  }, [o, token]);

  if (!o) {
    return (
      <VisitorPage>
        {error ? <RetryError error={error} onRetry={reload} /> : <Loading label="注文を確認しています…" />}
        <Link href="/my">マイページへ</Link>
      </VisitorPage>
    );
  }

  const active = o.items.filter((i) => i.cook_status !== "cancelled");
  const cookable = active.filter((i) => i.needs_cooking);
  const anyStarted = o.items.some((i) => i.cook_status === "cooking" || i.cook_status === "cooked");
  const allCooked = cookable.every((i) => i.cook_status === "cooked");
  const unpaid = o.payment_status === "unpaid";
  const handed = o.handoff_status === "handed";
  const cancelled = o.status === "cancelled";
  const canCancel = o.status === "accepted" && unpaid && !anyStarted && !handed;

  // 進行段階: 受付 → 調理中 → 受け取り可能 → 受け渡し済み
  const stage = handed ? 3 : o.ready ? 2 : anyStarted ? 1 : 0;
  const stages = ["受付済み", "調理中", "受け取り可能", "受け渡し済み"];

  let headline: { tone: string; title: string; body: string };
  if (cancelled) headline = { tone: "danger", title: "✕ この注文は取り消されました", body: "ご不明な点は店頭のスタッフにお声がけください。" };
  else if (handed) headline = { tone: "neutral", title: "✓ お受け取り済みです", body: "ご利用ありがとうございました。" };
  else if (o.ready && unpaid)
    headline = { tone: "warn", title: "受け取り可能です（お支払いがまだです）", body: "店頭でお支払いのうえ、呼出番号をお伝えしてお受け取りください。" };
  else if (o.ready) headline = { tone: "ok", title: "✓ 受け取り可能です", body: "店頭で呼出番号をお伝えしてお受け取りください。" };
  else if (unpaid)
    headline = {
      tone: "warn",
      title: "店頭でお支払いください",
      body: anyStarted ? "調理を進めています。お支払いは店頭で受け付けています。" : "お支払いを済ませてお待ちください。調理はお支払い前に始まる場合があります。",
    };
  else headline = { tone: "info", title: anyStarted ? "♨ 調理中です" : "お支払い済み・調理をお待ちください", body: "できあがると、この画面と会場の画面でお知らせします。" };

  const cancel = async () => {
    setActionError(null);
    try {
      const res = await post<Order>(`/public/orders/by-token/${encodeURIComponent(token)}/cancel`);
      setData(res);
    } catch (e) {
      setActionError(e);
      reload();
    }
  };

  return (
    <VisitorPage>
      <LiveStatus lastOk={lastOk} stale={stale} connected={connected} error={error} />

      <section className="card center" aria-labelledby="callno-label">
        <div id="callno-label" className="muted">
          {o.department_name}・呼出番号
        </div>
        <div className="call-number" aria-label={`呼出番号 ${o.call_number}番`}>
          {o.call_number}
        </div>
        <div className="muted" style={{ fontSize: "0.9rem" }}>
          注文時刻 {hm(o.created_at)}
        </div>
      </section>

      <div className={`v-status-big v-status-${headline.tone}`} role="status" aria-live="polite">
        <h2>{headline.title}</h2>
        <p style={{ margin: "6px 0 0" }}>{headline.body}</p>
      </div>

      {!cancelled && (
        <ol className="v-steps" aria-label="進行状況">
          {stages.map((s, i) => (
            <li key={s} className={i < stage ? "done" : i === stage ? "current" : ""} aria-current={i === stage ? "step" : undefined}>
              {i < stage ? "✓ " : i === stage ? "▶ " : ""}
              {s}
            </li>
          ))}
        </ol>
      )}

      <section className="card">
        <div className="row-between">
          <h2 style={{ margin: 0 }}>ご注文内容</h2>
          <Badge tone={unpaid ? "warn" : o.payment_status === "paid" ? "ok" : "info"}>
            {unpaid ? "! " : "✓ "}
            {payLabel[o.payment_status] ?? o.payment_status}
          </Badge>
        </div>
        <ul style={{ listStyle: "none", padding: 0, margin: "8px 0" }}>
          {o.items.map((i) => (
            <li key={i.id} className="v-cart-line">
              <div>
                <strong style={i.cook_status === "cancelled" ? { textDecoration: "line-through" } : undefined}>{i.product_name}</strong>
                {i.options_label && <span className="muted">（{i.options_label}）</span>}
                <span> × {i.quantity}</span>
                <div>
                  {i.needs_cooking || i.cook_status === "cancelled" ? (
                    <Badge tone={cookTone(i.cook_status)}>
                      {cookMark(i.cook_status)} {cookLabel[i.cook_status] ?? i.cook_status}
                    </Badge>
                  ) : null}
                </div>
              </div>
              <div className="num right">{yen(i.line_total)}</div>
            </li>
          ))}
        </ul>
        {o.discount > 0 && (
          <div className="row-between">
            <span>小計</span>
            <span className="num">{yen(o.subtotal)}</span>
          </div>
        )}
        {o.coupons
          .filter((c) => c.status === "applied")
          .map((c, idx) => (
            <div className="row-between" key={idx}>
              <span>クーポン：{c.name}（{c.persons}人分）</span>
              <span className="num">−{yen(c.discount)}</span>
            </div>
          ))}
        <div className="row-between" style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8 }}>
          <strong>合計</strong>
          <span className="v-total">{yen(o.total)}</span>
        </div>
        {cookable.length > 0 && !cancelled && !handed && (
          <p className="muted" style={{ fontSize: "0.9rem" }}>
            調理状況：{cookable.filter((i) => i.cook_status === "cooked").length} / {cookable.length} 品できあがり
            {allCooked ? "" : "（順番に調理しています）"}
          </p>
        )}
      </section>

      {actionError ? <RetryError error={actionError} /> : null}

      {canCancel && (
        <section className="card">
          <h2 style={{ marginTop: 0 }}>注文の取り消し</h2>
          <p className="muted">お支払い前・調理開始前の注文に限り、ここから取り消せます。</p>
          <ActionButton className="btn btn-danger btn-block" confirm={`呼出番号 ${o.call_number} の注文を取り消します。よろしいですか？`} onClick={cancel}>
            この注文を取り消す
          </ActionButton>
        </section>
      )}
      {!canCancel && o.status === "accepted" && !handed && (
        <p className="muted" style={{ fontSize: "0.9rem" }}>
          {unpaid ? "調理が始まっているため、取り消しは店頭のスタッフにお申し出ください。" : "お支払い済みの注文の取り消し・返金は店頭のスタッフにお申し出ください。"}
        </p>
      )}

      <div className="banner banner-info v-save-hint">
        このページのURLが注文の控えです。ブックマークするか、<Link href="/my">マイページ</Link>から開いてください。
        {!saved && "（この端末には控えを保存できませんでした。URLを控えてください）"}
      </div>
    </VisitorPage>
  );
}
