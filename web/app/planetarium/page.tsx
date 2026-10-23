"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useFetch, useLive } from "@/lib/hooks";
import { hm, md } from "@/lib/format";
import { LiveStatus } from "@/components/ui";
import { Loading, RetryError, VisitorPage } from "@/components/visitor/common";
import { AvailabilityBadges, SeatSymbol, SymbolLegend } from "@/components/visitor/planetarium";

type Days = { days: { id: string; day: string; label: string }[]; today: string };
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
  run_status: string;
};

export default function PlanetariumList() {
  const days = useFetch<Days>("/business-days");
  const [day, setDay] = useState<string | null>(null);

  useEffect(() => {
    if (day || !days.data) return;
    const list = days.data.days;
    const today = days.data.today;
    const pick = list.find((d) => d.day === today) ?? list.find((d) => d.day > today) ?? list[list.length - 1];
    setDay(pick?.day ?? today);
  }, [days.data, day]);

  const live = useLive<{ screenings: Screening[] }>(day ? `/public/screenings?day=${encodeURIComponent(day)}` : null, ["screenings"]);
  const { error, reload, lastOk, stale, connected } = live;
  // 日付タブ切替直後に前の日の一覧が見えないようにする
  const data = live.data && live.data.screenings.every((s) => s.business_day === day) ? live.data : null;

  return (
    <VisitorPage>
      <h1>プラネタリウム 上映スケジュール</h1>
      <p className="muted">
        予約は1回につきお名前と人数だけで完了します。空きがあれば、予約なしでも当日その場で参加できます。
      </p>

      {days.error && !days.data && <RetryError error={days.error} onRetry={days.reload} />}
      {days.data && days.data.days.length > 0 && (
        <div className="tabs" role="tablist" aria-label="開催日">
          {days.data.days.map((d) => (
            <button key={d.day} role="tab" type="button" aria-selected={d.day === day} onClick={() => setDay(d.day)}>
              {d.label}（{md(d.day)}）{d.day === days.data!.today ? "・本日" : ""}
            </button>
          ))}
        </div>
      )}

      <SymbolLegend />
      <LiveStatus lastOk={lastOk} stale={stale} connected={connected} error={error} />

      {!day || (!data && !error) ? <Loading /> : null}
      {!data && error && <RetryError error={error} onRetry={reload} />}

      {data && data.screenings.length === 0 && <p className="empty">この日に予定されている上映はありません（終了した上映は表示されません）。</p>}

      <div role="tabpanel">
        {data?.screenings.map((s) => {
          const cancelled = s.run_status === "cancelled";
          const advanceOk = s.advance_open && s.advance_available;
          return (
            <Link key={s.id} href={`/planetarium/sessions/${s.id}`} className="card card-link" aria-label={`${hm(s.starts_at)}開始 ${s.title} の詳細`}>
              <div className="v-screening">
                <span className="v-time">{hm(s.starts_at)}</span>
                <div>
                  <strong>{s.title}</strong>
                  <div className="muted" style={{ fontSize: "0.85rem" }}>
                    {hm(s.starts_at)}〜{hm(s.ends_at)}
                  </div>
                </div>
                <SeatSymbol symbol={s.symbol} cancelled={cancelled} />
                {(s.status_text || cancelled) && (
                  <div style={{ gridColumn: "1 / -1" }}>
                    <strong style={{ color: cancelled ? "var(--danger)" : undefined }}>
                      {cancelled ? "✕ " : "! "}
                      {s.status_text || "上映中止"}
                    </strong>
                  </div>
                )}
                {!cancelled && <AvailabilityBadges advanceOk={advanceOk} walkinOk={s.walkin_available} />}
              </div>
            </Link>
          );
        })}
      </div>

      <p className="muted" style={{ fontSize: "0.9rem" }}>
        予約した上映は<Link href="/my">マイページ</Link>から確認できます。
      </p>
    </VisitorPage>
  );
}
