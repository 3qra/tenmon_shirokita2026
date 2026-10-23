"use client";

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage, newIdempotencyKey } from "@/lib/api";
import { ActionButton, ErrorBox } from "@/components/ui";
import type { Department } from "./types";

/**
 * Idempotency-Key 付きで送信するためのフック。
 * - 同じ操作（同じ宛先・同じ内容）の再送では同じキーを再利用する（通信断の再試行で二重登録しない）。
 * - 成功した、または確定的な4xxが返ったらキーを捨て、次の操作では新しいキーを作る。
 * - 409 in_progress（処理中）と 429・通信エラー・5xx ではキーを保持する。
 */
export function useIdempotent() {
  const keys = useRef(new Map<string, string>());
  return useCallback(async <T = any,>(method: string, path: string, body: unknown): Promise<T> => {
    const sig = `${method} ${path}\n${JSON.stringify(body ?? {})}`;
    let key = keys.current.get(sig);
    if (!key) {
      key = newIdempotencyKey();
      keys.current.set(sig, key);
    }
    try {
      const r = await api<T>(method, path, { body: body ?? {}, idempotencyKey: key });
      keys.current.delete(sig);
      return r;
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429 && e.code !== "in_progress") {
        keys.current.delete(sig);
      }
      throw e;
    }
  }, []);
}

/** localStorage を安全に読み書きする（プライベートモード等で例外になっても動く） */
export function loadPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function savePref(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 保存できなくても動作は続ける */
  }
}

/** 端末ごとに選んだ部門を覚えておく */
export function useStoredDept(storageKey: string, depts: Department[] | null) {
  const [deptId, setDeptId] = useState<string>("");
  useEffect(() => {
    if (!depts || !depts.length) return;
    if (deptId && depts.some((d) => d.id === deptId)) return;
    const saved = loadPref(storageKey);
    const pick = depts.find((d) => d.id === saved) ?? depts[0];
    setDeptId(pick.id);
  }, [depts, deptId, storageKey]);
  const set = useCallback(
    (id: string) => {
      setDeptId(id);
      savePref(storageKey, id);
    },
    [storageKey],
  );
  return [deptId, set] as const;
}

export function DeptPicker({ depts, value, onChange, label = "部門" }: { depts: Department[]; value: string; onChange: (id: string) => void; label?: string }) {
  if (depts.length <= 1) return null;
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {depts.map((d) => (
        <button key={d.id} type="button" role="radio" aria-checked={d.id === value} className={d.id === value ? "seg-on" : ""} onClick={() => onChange(d.id)}>
          {d.id === value ? "● " : ""}
          {d.name}
        </button>
      ))}
    </div>
  );
}

/**
 * 理由入力つきの操作ボタン。押すと入力欄が開き、確定ボタンで送信する。
 * 送信中は二重送信を防ぎ、失敗時はその場にエラーを出す。
 */
export function ReasonAction({
  label,
  submitLabel,
  placeholder = "理由を入力",
  required = true,
  className = "btn",
  submitClassName = "btn btn-primary",
  note,
  onSubmit,
}: {
  label: string;
  submitLabel?: string;
  placeholder?: string;
  required?: boolean;
  className?: string;
  submitClassName?: string;
  note?: ReactNode;
  onSubmit: (reason: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (!open) {
    return (
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }
  return (
    <div className="reason-box">
      <label className="field">
        <span className="label">
          {label}：{required ? "理由（必須）" : "理由（任意）"}
        </span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={placeholder} maxLength={200} autoFocus />
      </label>
      {note}
      <ErrorBox error={err} />
      <div className="row">
        <ActionButton
          className={submitClassName}
          disabled={required && !reason.trim()}
          onClick={async () => {
            setErr(null);
            try {
              await onSubmit(reason.trim());
              setOpen(false);
              setReason("");
            } catch (e) {
              setErr(errorMessage(e));
            }
          }}
        >
          {submitLabel ?? `${label}を確定`}
        </ActionButton>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setOpen(false);
            setErr(null);
          }}
        >
          やめる
        </button>
      </div>
    </div>
  );
}

/** QRの読み取り結果からトークンを取り出す（URL形式なら最後のパス要素） */
export function extractToken(text: string): string {
  let t = text.trim();
  t = t.split("#")[0].split("?")[0];
  const i = t.lastIndexOf("/");
  if (i >= 0) t = t.slice(i + 1);
  return t;
}

export function toIntOr0(s: string): number {
  const n = parseInt(s.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}
