"use client";

import Link from "next/link";
import { ReactNode } from "react";
import { ApiError, errorMessage } from "@/lib/api";
import "@/app/(visitor)/visitor.css";

/** 来場者画面の共通ヘッダー */
export function VisitorHeader() {
  return (
    <header className="v-header no-print">
      <Link href="/" className="v-brand">
        学祭ポータル
      </Link>
      <nav aria-label="来場者メニュー" className="v-nav">
        <Link href="/">ホーム</Link>
        <Link href="/planetarium">プラネ</Link>
        <Link href="/my">マイページ</Link>
      </nav>
    </header>
  );
}

export function VisitorPage({ children }: { children: ReactNode }) {
  return (
    <>
      <VisitorHeader />
      <main className="container v-main">{children}</main>
    </>
  );
}

export function Loading({ label = "読み込み中…" }: { label?: string }) {
  return (
    <p className="empty" role="status" aria-live="polite">
      {label}
    </p>
  );
}

/** 来場者向けの分かりやすいエラーメッセージ */
const FRIENDLY: Record<string, string> = {
  network: "通信できませんでした。電波の良い場所で、もう一度お試しください",
  rate_limited: "短時間に操作が続いたため、一時的に受け付けを止めています。少し待ってからお試しください",
  site_code_invalid: "確認コードが違います。会場の画面に表示されている3桁の数字を入力してください",
  site_code_locked: "確認コードの入力ミスが続いたため、しばらく注文できません。店頭のスタッフにお声がけください",
  mobile_order_off: "現在、スマートフォンからの注文は受け付けていません。店頭でご注文ください",
  not_open: "現在、受け付けていません。営業時間をご確認ください",
  too_many_unpaid: "お支払いが済んでいない注文があります。先に店頭でお支払いください",
  in_progress: "同じ操作を処理中です。数秒待ってから、もう一度お試しください",
  idempotency_mismatch: "送信内容が変わりました。もう一度お試しください",
  blocked: "現在、この端末からはご利用いただけません。スタッフにお声がけください",
};

export function friendlyError(e: unknown): string {
  if (e instanceof ApiError) {
    // sold_out などはサーバーのメッセージに商品名が入るのでそのまま使う
    if (e.code === "sold_out" || e.code === "item_stopped" || e.code === "item_unavailable") return e.message;
    if (FRIENDLY[e.code]) return FRIENDLY[e.code];
    if (e.status === 404) return "見つかりませんでした。URLが正しいかご確認ください";
    if (e.status >= 500) return "サーバーで問題が発生しました。少し待ってからお試しください";
  }
  return errorMessage(e);
}

/** 再試行できるエラー表示 */
export function RetryError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="banner banner-danger" role="alert">
      <p style={{ margin: 0 }}>⚠ {friendlyError(error)}</p>
      {onRetry && (
        <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={onRetry}>
          再読み込み
        </button>
      )}
    </div>
  );
}

/** 一度失敗が確定した（サーバーが結果を記録した）エラーか。こうした場合は次回新しい操作IDを使う。 */
export function isFinalError(e: unknown): boolean {
  return e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 409 && e.status !== 429;
}
