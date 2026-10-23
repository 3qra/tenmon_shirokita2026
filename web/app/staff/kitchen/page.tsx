"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, errorMessage, post } from "@/lib/api";
import { useFetch, useLive } from "@/lib/hooks";
import { cookLabel, elapsed, hm } from "@/lib/format";
import { Badge, Empty, ErrorBox, LiveStatus, Toast } from "@/components/ui";
import { StaffShell } from "@/components/StaffShell";
import { DeptPicker, loadPref, savePref, useStoredDept } from "../_components/common";
import type { Department } from "../_components/types";

type KItem = { id: string; product_name: string; options_label: string; quantity: number; cook_status: string; updated_at: string };
type KOrder = {
  id: string;
  call_number: number;
  payment_status: string;
  status: string;
  channel: string;
  created_at: string;
  elapsed_sec: number;
  long_wait: boolean;
  unpaid_warning: boolean;
  items: KItem[];
};
type KitchenResp = { orders: KOrder[]; server_time: string };

type Flight = { state: "sending" | "ok" | "fail"; msg?: string; from: string; to: string; reason?: string };

export default function KitchenPage() {
  return (
    <StaffShell roles={["kitchen", "cashier", "admin"]} wide>
      <Kitchen />
    </StaffShell>
  );
}

function Kitchen() {
  const { data: allDepts, error: deptErr } = useFetch<Department[]>("/staff/departments");
  const depts = useMemo(() => (allDepts ?? []).filter((d) => d.kind !== "planetarium"), [allDepts]);
  const [deptId, setDeptId] = useStoredDept("staff.kitchen.dept", allDepts ? depts : null);
  const live = useLive<KitchenResp>(deptId ? `/staff/kitchen?department_id=${deptId}` : null, ["orders"], 5000);
  const [flights, setFlights] = useState<Record<string, Flight>>({});
  const [toast, setToast] = useState<string | null>(null);
  const clearToast = useCallback(() => setToast(null), []);
  const [showDone, setShowDone] = useState(false);
  const reload = live.reload;
  const okTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    setShowDone(loadPref("staff.kitchen.showDone") === "1");
  }, []);
  useEffect(() => {
    const timers = okTimers.current;
    return () => Object.values(timers).forEach(clearTimeout);
  }, []);

  // 経過時間を取得後もなめらかに進める（サーバー時刻基準の値に、取得からの経過を足す）
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 10000);
    return () => clearInterval(t);
  }, []);
  const sinceFetch = live.lastOk ? Math.max(0, Math.floor((Date.now() - live.lastOk.getTime()) / 1000)) : 0;

  const send = useCallback(
    async (item: KItem, to: string, reason?: string) => {
      const from = item.cook_status;
      let ok = false;
      setFlights((f) => ({ ...f, [item.id]: { state: "sending", from, to, reason } }));
      try {
        await post(`/staff/order-items/${item.id}/cook`, reason ? { from, to, reason } : { from, to });
        ok = true;
        setFlights((f) => ({ ...f, [item.id]: { state: "ok", from, to } }));
        clearTimeout(okTimers.current[item.id]);
        okTimers.current[item.id] = setTimeout(() => {
          setFlights((f) => {
            if (f[item.id]?.state !== "ok") return f;
            const n = { ...f };
            delete n[item.id];
            return n;
          });
        }, 2500);
      } catch (e) {
        const code = e instanceof ApiError ? e.code : "";
        if (code === "state_changed" || code === "order_closed") {
          // 他の端末で変更済み：最新を取り直して表示を合わせる
          setFlights((f) => {
            const n = { ...f };
            delete n[item.id];
            return n;
          });
          setToast(errorMessage(e));
        } else {
          setFlights((f) => ({ ...f, [item.id]: { state: "fail", from, to, reason, msg: errorMessage(e) } }));
        }
      } finally {
        await reload();
      }
      return ok;
    },
    [reload],
  );

  const orders = useMemo(() => {
    const list = [...(live.data?.orders ?? [])];
    list.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    return list;
  }, [live.data]);

  const isDone = (o: KOrder) => o.status !== "cancelled" && o.items.every((i) => i.cook_status === "cooked" || i.cook_status === "cancelled");
  const doneCount = orders.filter(isDone).length;
  const visible = orders.filter((o) => showDone || !isDone(o));
  const activeItems = orders.filter((o) => o.status !== "cancelled").flatMap((o) => o.items.filter((i) => i.cook_status === "waiting" || i.cook_status === "cooking"));

  if (deptErr) return <ErrorBox error={deptErr} />;

  return (
    <>
      <div className="section-title">
        <h1 style={{ margin: 0 }}>キッチン</h1>
        <LiveStatus lastOk={live.lastOk} stale={live.stale} connected={live.connected} error={live.error} />
      </div>
      <DeptPicker depts={depts} value={deptId} onChange={setDeptId} />
      <div className="row-between">
        <p>
          調理待ち・調理中 <strong>{activeItems.reduce((s, i) => s + i.quantity, 0)}</strong>食
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={showDone}
            onChange={(e) => {
              setShowDone(e.target.checked);
              savePref("staff.kitchen.showDone", e.target.checked ? "1" : "0");
            }}
          />
          調理済の注文も表示（{doneCount}件）
        </label>
      </div>
      {live.error && live.data && <ErrorBox error={live.error} />}
      {live.data && visible.length === 0 && <Empty>調理する注文はありません</Empty>}
      <div className="kitchen-grid">
        {visible.map((o) => {
          const cancelled = o.status === "cancelled";
          const unpaid = o.payment_status === "unpaid";
          const done = isDone(o);
          const sec = o.elapsed_sec + sinceFetch;
          const pending = o.items.filter((i) => i.cook_status === "waiting" || i.cook_status === "cooking");
          const anyFlight = o.items.some((i) => flights[i.id]?.state === "sending");
          return (
            <article key={o.id} className={`kcard ${unpaid && !cancelled ? "unpaid" : ""} ${o.long_wait && !cancelled && !done ? "late" : ""} ${cancelled ? "cancelled" : ""} ${done ? "done" : ""}`} aria-label={`呼出番号${o.call_number}`}>
              <div className="k-head">
                <div>
                  <div className="kno">{o.call_number}</div>
                  <div className="badges">
                    {cancelled && <span className="kstamp">取消</span>}
                    {!cancelled && unpaid && <Badge tone="warn">¥ 未払い</Badge>}
                    {!cancelled && !unpaid && <Badge tone="ok">✓ 支払済</Badge>}
                    {!cancelled && o.long_wait && !done && <Badge tone="danger">⚠ 長時間</Badge>}
                    {done && <Badge tone="ok">✓ 全品調理済</Badge>}
                  </div>
                </div>
                <div className="kmeta">
                  <div className="kel">{elapsed(sec)}</div>
                  <small>{hm(o.created_at)} 受付</small>
                </div>
              </div>
              {o.items.map((it) => (
                <KitchenItem key={it.id} item={it} flight={flights[it.id]} disabled={cancelled} onSend={send} />
              ))}
              {!cancelled && pending.length > 1 && (
                <button
                  className="btn btn-ok btn-block"
                  style={{ marginTop: 8, minHeight: 56 }}
                  disabled={anyFlight}
                  onClick={async () => {
                    for (const it of pending) {
                      await send(it, "cooked");
                    }
                  }}
                >
                  全部調理済にする
                </button>
              )}
            </article>
          );
        })}
      </div>
      <Toast message={toast} onDone={clearToast} />
    </>
  );
}

function KitchenItem({ item, flight, disabled, onSend }: { item: KItem; flight?: Flight; disabled: boolean; onSend: (it: KItem, to: string, reason?: string) => Promise<boolean> }) {
  const [corr, setCorr] = useState(false);
  const [reason, setReason] = useState("");
  const sending = flight?.state === "sending";
  const st = item.cook_status;
  const forward = st === "waiting" ? { to: "cooking", label: "調理開始" } : st === "cooking" ? { to: "cooked", label: "調理済にする" } : null;
  const back = st === "cooking" ? { to: "waiting", label: "待ちに戻す" } : st === "cooked" ? { to: "cooking", label: "調理中に戻す" } : null;

  return (
    <div className="kitem">
      <div>
        <div className="name">
          {item.product_name} <span className="qtyx">×{item.quantity}</span>
        </div>
        {item.options_label && <div className="opts">{item.options_label}</div>}
        <div className="kst">
          状態：<strong>{st === "cooked" ? "✓ " : st === "cooking" ? "▶ " : ""}{cookLabel[st] ?? st}</strong>
        </div>
      </div>
      {!disabled && st !== "cancelled" && (
        <div className="kbtns">
          {forward ? (
            <button className={`btn kbtn ${forward.to === "cooked" ? "btn-ok" : "btn-primary"}`} disabled={sending} aria-busy={sending} onClick={() => onSend(item, forward.to)}>
              {sending && flight?.to === forward.to ? "送信中…" : forward.label}
            </button>
          ) : (
            <div className="kfeedback ok">✓ 調理済</div>
          )}
          {back && !corr && (
            <button className="btn btn-ghost kbtn-corr" disabled={sending} onClick={() => setCorr(true)}>
              訂正
            </button>
          )}
          {back && corr && (
            <div className="stack">
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="訂正理由（任意）" maxLength={200} />
              <button
                className="btn kbtn-corr"
                disabled={sending}
                onClick={async () => {
                  const ok = await onSend(item, back.to, reason.trim() || undefined);
                  if (ok) {
                    setCorr(false);
                    setReason("");
                  }
                }}
              >
                {sending && flight?.to === back.to ? "送信中…" : back.label}
              </button>
              <button className="btn btn-ghost kbtn-corr" onClick={() => setCorr(false)}>
                やめる
              </button>
            </div>
          )}
          {flight?.state === "ok" && <div className="kfeedback ok" role="status">✓ {cookLabel[flight.to]}にしました</div>}
          {flight?.state === "fail" && (
            <button className="btn btn-danger kbtn-corr" onClick={() => onSend({ ...item, cook_status: flight.from }, flight.to, flight.reason)}>
              失敗: 再試行
            </button>
          )}
          {flight?.state === "fail" && flight.msg && <div className="kfeedback ng">{flight.msg}</div>}
        </div>
      )}
    </div>
  );
}
