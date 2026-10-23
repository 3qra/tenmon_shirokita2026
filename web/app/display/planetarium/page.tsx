"use client";

import { useEffect, useState } from "react";
import { useLive } from "@/lib/hooks";
import { hm } from "@/lib/format";
import { BoardClock, StaleBanner, useHeartbeat } from "@/components/visitor/display";

type Row = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  symbol: string;
  status_text: string;
  run_status: string;
  advance_open: boolean;
  walkin_available: boolean;
};

const symbolText: Record<string, string> = { "○": "空席あり", "△": "残りわずか", "×": "満席" };

export default function PlanetariumDisplay() {
  const { data, error, lastOk, stale } = useLive<{ screenings: Row[]; server_time: string }>("/public/screening-board", ["screenings"], 10000);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (data?.server_time && lastOk) setOffset(new Date(data.server_time).getTime() - lastOk.getTime());
  }, [data, lastOk]);
  // 表示端末としてログインしていれば死活を通知（未ログインでも表示は続ける）
  useHeartbeat("planetarium", null);

  return (
    <main className="board">
      <div className="board-head">
        <h1>プラネタリウム 本日の上映</h1>
        <BoardClock offsetMs={offset} />
      </div>
      <StaleBanner show={stale || !!error} lastOk={lastOk} />

      <div className="board-legend" aria-label="空席記号の見かた">
        <span>○ 空席あり</span>
        <span>△ 残りわずか</span>
        <span>× 満席</span>
      </div>

      {!data && !error && <p className="board-empty">読み込み中…</p>}
      {data && data.screenings.length === 0 && <p className="board-empty">本日のこれからの上映はありません</p>}

      {data && data.screenings.length > 0 && (
        <table className="board-table">
          <thead>
            <tr>
              <th scope="col">開始</th>
              <th scope="col">演目</th>
              <th scope="col" style={{ textAlign: "center" }}>
                空席
              </th>
              <th scope="col">事前予約</th>
              <th scope="col">当日参加</th>
              <th scope="col">状況</th>
            </tr>
          </thead>
          <tbody>
            {data.screenings.map((s) => {
              const cancelled = s.run_status === "cancelled";
              return (
                <tr key={s.id} className={cancelled ? "cancelled" : undefined}>
                  <td className="num">
                    <strong>{hm(s.starts_at)}</strong>
                  </td>
                  <td>{s.title}</td>
                  <td className="sym" aria-label={cancelled ? "上映中止" : symbolText[s.symbol] ?? s.symbol}>
                    {cancelled ? "―" : s.symbol}
                  </td>
                  <td>{cancelled ? "―" : s.advance_open ? "○ 可" : "× 不可"}</td>
                  <td>{cancelled ? "―" : s.walkin_available ? "○ 可" : "× 不可"}</td>
                  <td className="st">{cancelled ? "✕ 上映中止" : s.status_text || (s.run_status === "scheduled" ? "受付中" : "")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="board-meta">
        最終更新 {lastOk ? lastOk.toLocaleTimeString("ja-JP") : "—"}・ご予約はスマートフォンから「プラネタリウム」ページへ
      </div>
    </main>
  );
}
