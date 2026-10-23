"use client";

import { ReactNode, useEffect, useState } from "react";
import { hm } from "@/lib/format";

/** 通信状態・最終更新の表示。古い情報が最新に見えないようにする。 */
export function LiveStatus({ lastOk, stale, connected, error }: { lastOk: Date | null; stale: boolean; connected: boolean; error?: Error | null }) {
  if (stale || (error && !lastOk)) {
    return (
      <div className="banner banner-danger" role="alert">
        ⚠ 通信が途切れています{lastOk ? `（最終更新 ${hm(lastOk)}）` : ""}。表示が古い可能性があります
      </div>
    );
  }
  return (
    <div className="live-status" aria-live="polite">
      <span className={`dot ${connected ? "dot-ok" : "dot-warn"}`} aria-hidden />
      {connected ? "自動更新中" : "再接続中"} {lastOk && `・最終更新 ${lastOk.toLocaleTimeString("ja-JP")}`}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="banner banner-danger" role="alert">
      {msg}
    </div>
  );
}

export function Notice({ kind = "info", children }: { kind?: "info" | "warn" | "danger" | "ok"; children: ReactNode }) {
  return <div className={`banner banner-${kind}`}>{children}</div>;
}

/** 状態バッジ。色だけに頼らず文字と記号を併記する。 */
export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "warn" | "danger" | "info"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Toast({ message, onDone }: { message: string | null; onDone: () => void }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDone, 2500);
    return () => clearTimeout(t);
  }, [message, onDone]);
  if (!message) return null;
  return (
    <div className="toast" role="status">
      {message}
    </div>
  );
}

/** 送信中は二重押しを防ぎ、状態を文字で表示するボタン */
export function ActionButton({
  onClick,
  children,
  className = "btn",
  disabled,
  confirm,
  type = "button",
}: {
  onClick: () => Promise<unknown> | void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  confirm?: string;
  type?: "button" | "submit";
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type={type}
      className={className}
      disabled={disabled || busy}
      aria-busy={busy}
      onClick={async () => {
        if (busy) return;
        if (confirm && !window.confirm(confirm)) return;
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "送信中…" : children}
    </button>
  );
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
