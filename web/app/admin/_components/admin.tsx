"use client";

import { ReactNode, useCallback, useState } from "react";
import { errorMessage } from "@/lib/api";
import { Toast } from "@/components/ui";
import { StaffShell } from "@/components/StaffShell";
import { AdminNav } from "./AdminNav";

/** 管理画面の共通枠（管理者権限・サブメニュー） */
export function AdminPage({ title, children, lead }: { title: string; children: ReactNode; lead?: ReactNode }) {
  return (
    <StaffShell roles={["admin"]} wide>
      <div className="admin-page">
        <AdminNav />
        <h1>{title}</h1>
        {lead}
        {children}
      </div>
    </StaffShell>
  );
}

/**
 * 更新操作の共通処理。成功時はトースト、失敗時はAPIのメッセージを画面下部に表示する。
 * run() は成功なら true を返す（ActionButton の中で使う）。
 */
export function useActions() {
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clearToast = useCallback(() => setToast(null), []);
  const run = useCallback(async (fn: () => Promise<unknown>, ok?: string): Promise<boolean> => {
    setError(null);
    try {
      await fn();
      if (ok) setToast(ok);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  }, []);
  const ui = (
    <>
      {error && (
        <div className="banner banner-danger admin-float" role="alert">
          <span>⚠ {error}</span>
          <button className="btn btn-sm" onClick={() => setError(null)}>
            閉じる
          </button>
        </div>
      )}
      <Toast message={toast} onDone={clearToast} />
    </>
  );
  return { run, ui, setError, setToast };
}

// ---- 時刻（APIはRFC3339、入力欄は日本時間） ----

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** RFC3339 → datetime-local 用の "YYYY-MM-DDTHH:mm"（日本時間） */
export function toJstInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 16);
}

/** datetime-local（日本時間として解釈）→ RFC3339。空なら null */
export function fromJstInput(v: string): string | null {
  if (!v) return null;
  const base = v.length === 16 ? `${v}:00` : v.slice(0, 19);
  return `${base}+09:00`;
}

/** "YYYY-MM-DD" と "HH:mm" → RFC3339（日本時間） */
export function jstDateTime(day: string, time: string): string {
  return `${day}T${time.length === 5 ? `${time}:00` : time}+09:00`;
}

/** 日本時間の "YYYY/MM/DD HH:mm" */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 数値入力欄の値 → 数値（空なら null） */
export function numOrNull(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export const kindLabel: Record<string, string> = {
  food: "飲食（調理あり）",
  planetarium: "プラネタリウム",
  goods: "物販",
};

export const businessTone: Record<string, "neutral" | "ok" | "warn" | "danger" | "info"> = {
  before: "neutral",
  open: "ok",
  paused: "warn",
  closed: "danger",
};

export type Department = {
  id: string;
  code: string;
  name: string;
  kind: string;
  business_status: string;
  mobile_order_enabled: boolean;
  site_code_enabled: boolean;
  site_code_interval_sec: number;
  site_code_grace_sec: number;
  notice: string;
  sort_order: number;
};

export type BusinessDays = { days: { id: string; day: string; label: string }[]; today: string };

/** 営業日タブ */
export function DayTabs({ days, value, onChange }: { days: BusinessDays["days"]; value: string; onChange: (d: string) => void }) {
  return (
    <div className="tabs" role="tablist" aria-label="営業日">
      {days.map((d) => (
        <button key={d.day} role="tab" aria-selected={d.day === value} onClick={() => onChange(d.day)}>
          {d.label || d.day}（{new Date(`${d.day}T00:00:00+09:00`).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short" })}）
        </button>
      ))}
    </div>
  );
}

/** 営業日の初期選択：今日が営業日なら今日、なければ最初の営業日 */
export function pickDefaultDay(bd: BusinessDays | null): string {
  if (!bd) return "";
  if (bd.days.some((d) => d.day === bd.today)) return bd.today;
  return bd.days[0]?.day ?? bd.today;
}
