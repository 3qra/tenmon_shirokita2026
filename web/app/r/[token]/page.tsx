"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { post } from "@/lib/api";
import { useLive } from "@/lib/hooks";
import { hm, md, mdhm, reservationStatusLabel } from "@/lib/format";
import { ActionButton, Badge, LiveStatus } from "@/components/ui";
import { Qr } from "@/components/Qr";
import { Loading, RetryError, VisitorPage } from "@/components/visitor/common";
import { myReservations } from "@/components/visitor/store";

type Ticket = { id: string; seq: number; ticket_no: string; status: "valid" | "void" | string; admitted_at: string | null; entry_token: string };
type IssuedCoupon = {
  id: string;
  coupon_no: string;
  name: string;
  persons_total: number;
  persons_remaining: number;
  status: string;
  valid_until: string | null;
  token: string;
};
type Reservation = {
  id: string;
  reservation_no: string;
  kind: string;
  name: string;
  party_size: number;
  status: "confirmed" | "cancelled_self" | "cancelled_staff" | "cancelled_screening" | string;
  cancel_reason: string | null;
  created_at: string;
  cancelled_at: string | null;
  screening: {
    id: string;
    title: string;
    starts_at: string;
    ends_at: string;
    run_status: string;
    business_day: string;
    cancel_reason: string | null;
  };
  tickets: Ticket[];
  coupons: IssuedCoupon[];
  wallet_enabled: boolean;
};

export default function ReservationPage() {
  const { token } = useParams<{ token: string }>();
  const path = token ? `/public/reservations/by-token/${encodeURIComponent(token)}` : null;
  const { data: r, error, reload, lastOk, stale, connected, setData } = useLive<Reservation>(path, ["screenings"]);
  const [actionError, setActionError] = useState<unknown>(null);
  const [saved, setSaved] = useState(true);

  useEffect(() => {
    if (!r || !token) return;
    if (!myReservations.has(token)) {
      setSaved(
        myReservations.save({
          token,
          reservation_no: r.reservation_no,
          title: r.screening.title,
          starts_at: r.screening.starts_at,
          saved_at: new Date().toISOString(),
        }),
      );
    }
  }, [r, token]);

  if (!r) {
    return (
      <VisitorPage>
        {error ? <RetryError error={error} onRetry={reload} /> : <Loading label="予約を確認しています…" />}
        <Link href="/my">マイページへ</Link>
      </VisitorPage>
    );
  }

  const screeningCancelled = r.screening.run_status === "cancelled";
  const confirmed = r.status === "confirmed";
  const anyAdmitted = r.tickets.some((t) => !!t.admitted_at);
  const canCancel = confirmed && !anyAdmitted && !screeningCancelled && r.screening.run_status === "scheduled";
  const finished = r.screening.run_status === "finished";

  const cancel = async () => {
    setActionError(null);
    try {
      const res = await post<Reservation>(`/public/reservations/by-token/${encodeURIComponent(token)}/cancel`);
      setData({ ...res, wallet_enabled: res.wallet_enabled ?? r.wallet_enabled });
    } catch (e) {
      setActionError(e);
      reload();
    }
  };

  return (
    <VisitorPage>
      <LiveStatus lastOk={lastOk} stale={stale} connected={connected} error={error} />

      {screeningCancelled && (
        <div className="v-status-big v-status-danger" role="alert">
          <h2>✕ 上映中止</h2>
          <p style={{ margin: "6px 0 0" }}>
            この回は上映中止となりました。ご迷惑をおかけして申し訳ありません。
            {r.screening.cancel_reason && (
              <>
                <br />
                理由：{r.screening.cancel_reason}
              </>
            )}
          </p>
        </div>
      )}

      <section className="card">
        <div className="muted">予約番号</div>
        <div className="v-total num" style={{ fontSize: "2rem" }}>
          {r.reservation_no}
        </div>
        <h1 style={{ margin: "8px 0 4px" }}>{r.screening.title}</h1>
        <p style={{ fontSize: "1.15rem", margin: 0 }}>
          <strong>
            {md(r.screening.business_day)} {hm(r.screening.starts_at)}〜{hm(r.screening.ends_at)}
          </strong>
        </p>
        <p className="muted" style={{ margin: "4px 0" }}>
          {r.name} 様・{r.party_size}人
        </p>
        <div className="row" style={{ alignItems: "center" }}>
          <Badge tone={confirmed ? "ok" : "danger"}>
            {confirmed ? "✓ " : "✕ "}
            {reservationStatusLabel[r.status] ?? r.status}
          </Badge>
          {finished && <Badge tone="neutral">上映終了</Badge>}
          {r.screening.run_status === "running" && <Badge tone="info">♪ 上映中</Badge>}
        </div>
        {!confirmed && (
          <div className="banner banner-danger" role="status">
            この予約は取り消されています{r.cancelled_at ? `（${mdhm(r.cancelled_at)}）` : ""}。
            {r.cancel_reason && (
              <>
                <br />
                理由：{r.cancel_reason}
              </>
            )}
          </div>
        )}
      </section>

      {confirmed && !screeningCancelled && (
        <section aria-labelledby="tickets-title">
          <h2 id="tickets-title">入場チケット（{r.tickets.length}枚）</h2>
          <p className="muted" style={{ fontSize: "0.9rem" }}>
            入場時に受付でQRコードを1人1枚ずつ提示してください。画面を明るくすると読み取りやすくなります。
          </p>
          {r.tickets.map((t) => {
            const admitted = !!t.admitted_at;
            const isVoid = t.status !== "valid";
            return (
              <div key={t.id} className={`v-ticket${admitted ? " admitted" : ""}${isVoid ? " void" : ""}`}>
                <div className="row-between">
                  <strong>
                    {t.seq}人目 / {r.tickets.length}
                  </strong>
                  {admitted ? (
                    <Badge tone="ok">✓ 入場済み {hm(t.admitted_at)}</Badge>
                  ) : isVoid ? (
                    <Badge tone="danger">✕ 無効</Badge>
                  ) : (
                    <Badge tone="info">未入場</Badge>
                  )}
                </div>
                {!isVoid && <Qr value={t.entry_token} size={200} label={t.ticket_no} />}
                {isVoid && <p className="muted">チケット番号 {t.ticket_no}</p>}
                {r.wallet_enabled && !isVoid && !admitted && (
                  <a
                    className="btn btn-block"
                    href={`/api/v1/public/reservations/by-token/${encodeURIComponent(token)}/tickets/${t.seq}/wallet`}
                    download
                    rel="noreferrer"
                  >
                    Apple Walletに追加
                  </a>
                )}
              </div>
            );
          })}
          {r.wallet_enabled && (
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              Walletに追加した後で上映が中止・変更された場合、Walletの表示は自動で更新されないことがあります。最新の状態はこのページでご確認ください。
            </p>
          )}
        </section>
      )}

      {r.coupons.length > 0 && (
        <section aria-labelledby="coupons-title">
          <h2 id="coupons-title">ご鑑賞特典クーポン</h2>
          {r.coupons.map((c) => {
            const expired = !!c.valid_until && new Date(c.valid_until).getTime() < Date.now();
            const usable = c.status === "active" && !expired && c.persons_remaining > 0;
            return (
              <div key={c.id} className="card">
                <div className="row-between">
                  <strong>{c.name}</strong>
                  <Badge tone={usable ? "ok" : "neutral"}>
                    {usable ? "✓ 利用可" : c.status === "used" ? "使用済み" : c.status === "revoked" ? "✕ 無効" : expired ? "期限切れ" : "利用不可"}
                  </Badge>
                </div>
                <p className="muted" style={{ margin: "4px 0" }}>
                  残り {c.persons_remaining} / {c.persons_total} 人分
                  {c.valid_until && `・${mdhm(c.valid_until)}まで`}
                </p>
                {usable && <Qr value={c.token} size={160} label={`クーポン番号 ${c.coupon_no}`} />}
                <Link className="btn btn-block" href={`/c/${encodeURIComponent(c.token)}`}>
                  クーポンを開く
                </Link>
              </div>
            );
          })}
        </section>
      )}

      {actionError ? <RetryError error={actionError} /> : null}

      {canCancel && (
        <section className="card">
          <h2 style={{ marginTop: 0 }}>予約の取り消し</h2>
          <p className="muted">取り消すと席が解放され、元に戻せません。上映直前は取り消しできない場合があります。</p>
          <ActionButton
            className="btn btn-danger btn-block"
            confirm={`予約番号 ${r.reservation_no}（${r.party_size}人）を取り消します。よろしいですか？`}
            onClick={cancel}
          >
            この予約を取り消す
          </ActionButton>
        </section>
      )}
      {confirmed && anyAdmitted && !finished && (
        <p className="muted" style={{ fontSize: "0.9rem" }}>
          入場済みのチケットがあるため、取り消しは会場のスタッフにお申し出ください。
        </p>
      )}

      <div className="banner banner-info v-save-hint">
        <strong>このページのURLを保存してください。</strong>
        お名前だけでは予約を確認できません。ブックマークするか、<Link href="/my">マイページ</Link>から開いてください。
        {!saved && "（この端末には控えを保存できませんでした。URLを必ず控えてください）"}
      </div>
    </VisitorPage>
  );
}
