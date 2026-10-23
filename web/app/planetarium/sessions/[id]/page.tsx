"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { newIdempotencyKey, post } from "@/lib/api";
import { useLive } from "@/lib/hooks";
import { hm, md } from "@/lib/format";
import { ActionButton, LiveStatus } from "@/components/ui";
import { isFinalError, Loading, RetryError, VisitorPage } from "@/components/visitor/common";
import { AvailabilityBadges, SeatSymbol, SymbolLegend, symbolText } from "@/components/visitor/planetarium";
import { myReservations } from "@/components/visitor/store";

type Screening = {
  id: string;
  title: string;
  business_day: string;
  starts_at: string;
  ends_at: string;
  symbol: string;
  status_text: string;
  advance_open: boolean;
  advance_available: boolean;
  walkin_available: boolean;
  max_party_size: number;
  run_status: string;
};
type CreateRes = { id: string; reservation_no: string; access_token: string };

export default function ScreeningDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: s, error, reload, lastOk, stale, connected } = useLive<Screening>(
    id ? `/public/screenings/${encodeURIComponent(id)}` : null,
    ["screenings"],
  );
  const [name, setName] = useState("");
  const [party, setParty] = useState(1);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);
  const idem = useRef<{ key: string; body: string } | null>(null);

  if (!s) {
    return (
      <VisitorPage>
        {error ? <RetryError error={error} onRetry={reload} /> : <Loading />}
        <Link href="/planetarium">← 上映スケジュールへ</Link>
      </VisitorPage>
    );
  }

  const cancelled = s.run_status === "cancelled";
  const canBook = s.advance_open && s.advance_available && s.max_party_size > 0 && !cancelled;
  const maxParty = Math.max(1, s.max_party_size);
  const partyValue = Math.min(party, maxParty);
  const nameTrim = name.trim();
  const nameError = touched && !nameTrim ? "お名前を入力してください" : nameTrim.length > 30 ? "お名前は30文字以内で入力してください" : "";

  const submit = async () => {
    setTouched(true);
    if (!nameTrim || nameTrim.length > 30) return;
    const body = { screening_id: s.id, name: nameTrim, party_size: partyValue };
    const bodyStr = JSON.stringify(body);
    if (!idem.current || idem.current.body !== bodyStr) idem.current = { key: newIdempotencyKey(), body: bodyStr };
    setSubmitError(null);
    try {
      const res = await post<CreateRes>("/public/reservations", body, idem.current.key);
      myReservations.save({
        token: res.access_token,
        reservation_no: res.reservation_no,
        title: s.title,
        starts_at: s.starts_at,
        saved_at: new Date().toISOString(),
      });
      idem.current = null;
      router.push(`/r/${encodeURIComponent(res.access_token)}`);
    } catch (e) {
      if (isFinalError(e)) idem.current = null;
      setSubmitError(e);
      reload();
    }
  };

  return (
    <VisitorPage>
      <p style={{ margin: "4px 0" }}>
        <Link href="/planetarium">← 上映スケジュール</Link>
      </p>
      <h1>{s.title}</h1>
      <LiveStatus lastOk={lastOk} stale={stale} connected={connected} error={error} />

      <section className="card">
        <div className="v-screening">
          <span className="v-time">{hm(s.starts_at)}</span>
          <div>
            {md(s.business_day)}
            <div className="muted" style={{ fontSize: "0.9rem" }}>
              {hm(s.starts_at)}〜{hm(s.ends_at)}
            </div>
          </div>
          <div className="center">
            <SeatSymbol symbol={s.symbol} cancelled={cancelled} />
            {!cancelled && <div style={{ fontSize: "0.8rem" }}>{symbolText[s.symbol]}</div>}
          </div>
          {!cancelled && <AvailabilityBadges advanceOk={s.advance_open && s.advance_available} walkinOk={s.walkin_available} />}
        </div>
        {cancelled ? (
          <div className="banner banner-danger" role="alert">
            ✕ この回は上映中止となりました。
          </div>
        ) : s.status_text ? (
          <div className="banner banner-warn">! {s.status_text}</div>
        ) : null}
        <SymbolLegend />
      </section>

      {canBook ? (
        <section className="card" aria-labelledby="form-title">
          <h2 id="form-title" style={{ marginTop: 0 }}>
            事前予約
          </h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
            }}
            noValidate
          >
            <div className="field">
              <label htmlFor="r-name">
                お名前 <span className="badge badge-danger">必須</span>
              </label>
              <input
                id="r-name"
                type="text"
                autoComplete="name"
                maxLength={30}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setTouched(true)}
                aria-invalid={!!nameError}
                aria-describedby="r-name-help"
                placeholder="例：山田"
              />
              <small id="r-name-help" style={nameError ? { color: "var(--danger)", fontWeight: 700 } : undefined}>
                {nameError ? `⚠ ${nameError}` : "受付で確認するためのお名前です（ニックネーム・名字のみでも可）"}
              </small>
            </div>
            <div className="field">
              <label htmlFor="r-party">人数</label>
              <select id="r-party" value={partyValue} onChange={(e) => setParty(Number(e.target.value))}>
                {Array.from({ length: maxParty }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}人
                  </option>
                ))}
              </select>
              <small>1回の予約で{maxParty}人まで。人数分の入場チケット（QRコード）が発行されます。</small>
            </div>

            <div className="banner banner-info" style={{ fontSize: "0.9rem" }}>
              予約後に表示されるページ（URL）が予約の控えです。<strong>お名前だけでは予約を確認・取り消しできません</strong>
              ので、ブックマークやスクリーンショットで保存してください。この端末のマイページにも自動で保存されます。
            </div>

            {submitError ? <RetryError error={submitError} /> : null}

            <ActionButton type="submit" className="btn btn-primary btn-lg btn-block" onClick={submit}>
              {submitError && !isFinalError(submitError) ? "もう一度送信" : `${partyValue}人で予約する`}
            </ActionButton>
          </form>
        </section>
      ) : (
        !cancelled && (
          <div className="banner banner-warn" role="status">
            この回は現在、事前予約を受け付けていません。
            {s.walkin_available ? "空きがあれば当日、会場の受付で参加できます。" : ""}
          </div>
        )
      )}
    </VisitorPage>
  );
}
