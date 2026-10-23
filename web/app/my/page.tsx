"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ApiError, get } from "@/lib/api";
import { hm, md, payLabel, reservationStatusLabel } from "@/lib/format";
import { Badge } from "@/components/ui";
import { friendlyError, VisitorPage } from "@/components/visitor/common";
import { myOrders, myReservations, SavedOrder, SavedReservation } from "@/components/visitor/store";

type OrderSummary = { call_number: number; department_name: string; status: string; payment_status: string; handoff_status: string; ready: boolean; total: number };
type ResSummary = {
  reservation_no: string;
  status: string;
  party_size: number;
  screening: { title: string; starts_at: string; business_day: string; run_status: string };
};
type Result<T> = { state: "loading" } | { state: "ok"; data: T } | { state: "gone" } | { state: "error"; message: string };

function orderState(o: OrderSummary): { tone: "ok" | "warn" | "info" | "neutral" | "danger"; text: string } {
  if (o.status === "cancelled") return { tone: "danger", text: "✕ 取消" };
  if (o.handoff_status === "handed") return { tone: "neutral", text: "✓ 受け取り済み" };
  if (o.ready) return { tone: "ok", text: o.payment_status === "unpaid" ? "受け取り可能（未払い）" : "✓ 受け取り可能" };
  if (o.payment_status === "unpaid") return { tone: "warn", text: "! 未払い・店頭でお支払いください" };
  return { tone: "info", text: "調理待ち・調理中" };
}

export default function MyPage() {
  const [orders, setOrders] = useState<SavedOrder[] | null>(null);
  const [reservations, setReservations] = useState<SavedReservation[] | null>(null);
  const [oStatus, setOStatus] = useState<Record<string, Result<OrderSummary>>>({});
  const [rStatus, setRStatus] = useState<Record<string, Result<ResSummary>>>({});

  const load = useCallback(() => {
    const os = myOrders.list();
    const rs = myReservations.list();
    setOrders(os);
    setReservations(rs);
    for (const o of os) {
      setOStatus((m) => ({ ...m, [o.token]: m[o.token]?.state === "ok" ? m[o.token] : { state: "loading" } }));
      get<OrderSummary>(`/public/orders/by-token/${encodeURIComponent(o.token)}`)
        .then((d) => setOStatus((m) => ({ ...m, [o.token]: { state: "ok", data: d } })))
        .catch((e) =>
          setOStatus((m) => ({
            ...m,
            [o.token]: e instanceof ApiError && e.status === 404 ? { state: "gone" } : { state: "error", message: friendlyError(e) },
          })),
        );
    }
    for (const r of rs) {
      setRStatus((m) => ({ ...m, [r.token]: m[r.token]?.state === "ok" ? m[r.token] : { state: "loading" } }));
      get<ResSummary>(`/public/reservations/by-token/${encodeURIComponent(r.token)}`)
        .then((d) => setRStatus((m) => ({ ...m, [r.token]: { state: "ok", data: d } })))
        .catch((e) =>
          setRStatus((m) => ({
            ...m,
            [r.token]: e instanceof ApiError && e.status === 404 ? { state: "gone" } : { state: "error", message: friendlyError(e) },
          })),
        );
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const removeOrder = (token: string) => {
    if (!window.confirm("この注文をマイページの一覧から外します（注文自体は取り消されません）。よろしいですか？")) return;
    myOrders.remove(token);
    setOrders(myOrders.list());
  };
  const removeRes = (token: string) => {
    if (!window.confirm("この予約をマイページの一覧から外します（予約自体は取り消されません）。URLを控えていない場合、再表示できなくなります。よろしいですか？"))
      return;
    myReservations.remove(token);
    setReservations(myReservations.list());
  };

  return (
    <VisitorPage>
      <h1>マイページ</h1>
      <p className="muted">
        この端末のこのブラウザで行った注文・予約の控えです。別の端末やブラウザ、履歴を消去した場合は表示されません。
      </p>
      <div className="row" style={{ marginBottom: 8 }}>
        <button type="button" className="btn btn-sm" onClick={load}>
          最新の状態に更新
        </button>
      </div>

      <h2>注文</h2>
      {orders === null ? (
        <p className="empty">読み込み中…</p>
      ) : orders.length === 0 ? (
        <p className="empty">保存されている注文はありません。</p>
      ) : (
        orders.map((o) => {
          const st = oStatus[o.token];
          return (
            <div key={o.token} className="card">
              <div className="row-between">
                <div>
                  <div className="muted" style={{ fontSize: "0.85rem" }}>
                    {o.department_name}・{md(o.saved_at)} {hm(o.saved_at)}
                  </div>
                  <div style={{ fontSize: "1.6rem", fontWeight: 800 }} className="num">
                    呼出番号 {o.call_number}
                  </div>
                </div>
                {st?.state === "ok" && <Badge tone={orderState(st.data).tone}>{orderState(st.data).text}</Badge>}
              </div>
              {st?.state === "ok" && st.data.payment_status !== "unpaid" && (
                <div className="muted" style={{ fontSize: "0.85rem" }}>
                  {payLabel[st.data.payment_status] ?? st.data.payment_status}
                </div>
              )}
              {st?.state === "loading" && <p className="muted">状態を確認中…</p>}
              {st?.state === "gone" && <p className="muted">この注文は見つかりませんでした。</p>}
              {st?.state === "error" && <p style={{ color: "var(--danger)" }}>⚠ {st.message}</p>}
              <div className="row" style={{ marginTop: 8 }}>
                {st?.state !== "gone" && (
                  <Link className="btn btn-primary grow" href={`/o/${encodeURIComponent(o.token)}`}>
                    注文を見る
                  </Link>
                )}
                <button type="button" className="btn" onClick={() => removeOrder(o.token)} aria-label={`呼出番号${o.call_number}を一覧から外す`}>
                  一覧から外す
                </button>
              </div>
            </div>
          );
        })
      )}

      <h2>プラネタリウムの予約</h2>
      {reservations === null ? (
        <p className="empty">読み込み中…</p>
      ) : reservations.length === 0 ? (
        <p className="empty">
          保存されている予約はありません。<Link href="/planetarium">上映スケジュールを見る</Link>
        </p>
      ) : (
        reservations.map((r) => {
          const st = rStatus[r.token];
          const cancelledScreening = st?.state === "ok" && st.data.screening.run_status === "cancelled";
          const confirmed = st?.state === "ok" && st.data.status === "confirmed";
          return (
            <div key={r.token} className="card">
              <div className="row-between">
                <div>
                  <div className="muted" style={{ fontSize: "0.85rem" }}>
                    予約番号 {r.reservation_no}
                  </div>
                  <strong>{r.title}</strong>
                  <div>
                    {md(r.starts_at)} {hm(r.starts_at)} 開始
                    {st?.state === "ok" && `・${st.data.party_size}人`}
                  </div>
                </div>
                {st?.state === "ok" && (
                  <Badge tone={cancelledScreening ? "danger" : confirmed ? "ok" : "danger"}>
                    {cancelledScreening ? "✕ 上映中止" : `${confirmed ? "✓ " : "✕ "}${reservationStatusLabel[st.data.status] ?? st.data.status}`}
                  </Badge>
                )}
              </div>
              {st?.state === "loading" && <p className="muted">状態を確認中…</p>}
              {st?.state === "gone" && <p className="muted">この予約は見つかりませんでした（URLが再発行された可能性があります）。</p>}
              {st?.state === "error" && <p style={{ color: "var(--danger)" }}>⚠ {st.message}</p>}
              <div className="row" style={{ marginTop: 8 }}>
                {st?.state !== "gone" && (
                  <Link className="btn btn-primary grow" href={`/r/${encodeURIComponent(r.token)}`}>
                    チケットを表示
                  </Link>
                )}
                <button type="button" className="btn" onClick={() => removeRes(r.token)} aria-label={`予約番号${r.reservation_no}を一覧から外す`}>
                  一覧から外す
                </button>
              </div>
            </div>
          );
        })
      )}
    </VisitorPage>
  );
}
