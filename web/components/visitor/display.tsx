"use client";

import { useEffect, useState } from "react";
import { post } from "@/lib/api";
import { hm } from "@/lib/format";
import "@/app/(visitor)/visitor.css";

/** 1秒ごとに更新される現在時刻（サーバー時刻とのずれ offsetMs を補正） */
export function useNow(intervalMs = 1000, offsetMs = 0) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now === null ? null : now + offsetMs;
}

export function BoardClock({ offsetMs = 0 }: { offsetMs?: number }) {
  const now = useNow(1000, offsetMs);
  if (now === null) return <div className="board-clock">--:--</div>;
  const s = new Date(now).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return (
    <div className="board-clock" aria-label="現在時刻">
      {s}
    </div>
  );
}

/** 通信断の大きな警告。古い情報が最新に見えないようにする。 */
export function StaleBanner({ show, lastOk }: { show: boolean; lastOk: Date | null }) {
  if (!show) return null;
  return (
    <div className="board-stale" role="alert">
      ⚠ 通信が途切れています（最終更新 {lastOk ? hm(lastOk) : "なし"}）。表示は最新ではありません
    </div>
  );
}

/**
 * 表示端末の死活通知（15秒ごと）。401/403 のときは onUnauthorized を呼ぶ。
 */
export function useHeartbeat(screen: string, departmentId: string | null, onUnauthorized?: () => void, onOk?: () => void) {
  useEffect(() => {
    let stopped = false;
    const beat = async () => {
      try {
        await post("/display/heartbeat", { screen, department_id: departmentId ?? "" });
        if (!stopped) onOk?.();
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (!stopped && (status === 401 || status === 403)) onUnauthorized?.();
      }
    };
    beat();
    const t = setInterval(beat, 15000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, departmentId]);
}
