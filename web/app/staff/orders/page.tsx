"use client";

import { useCallback, useMemo, useState } from "react";
import { useFetch, useLive } from "@/lib/hooks";
import { elapsed, hm, md, yen } from "@/lib/format";
import { Badge, Empty, ErrorBox, LiveStatus, Modal, Toast } from "@/components/ui";
import { StaffShell } from "@/components/StaffShell";
import { OrderBadges, OrderDetailView } from "../_components/OrderDetailView";
import { DeptPicker, useStoredDept } from "../_components/common";
import type { BusinessDays, Department, OrderSummary } from "../_components/types";

export default function OrdersPage() {
  return (
    <StaffShell roles={["cashier", "treasurer", "admin"]}>
      <Orders />
    </StaffShell>
  );
}

const FILTERS = [
  { key: "active", label: "受付中" },
  { key: "unpaid", label: "未払い" },
  { key: "all", label: "すべて" },
] as const;

function cookSummary(o: OrderSummary): { text: string; tone: "ok" | "warn" | "info" | "neutral" } {
  const live = o.items.filter((i) => i.cook_status !== "cancelled");
  if (o.status === "cancelled") return { text: "", tone: "neutral" };
  if (live.some((i) => i.cook_status === "cooking")) return { text: "調理中", tone: "info" };
  if (live.some((i) => i.cook_status === "waiting")) return { text: "調理待ち", tone: "warn" };
  if (live.length) return { text: "✓ 調理済", tone: "ok" };
  return { text: "", tone: "neutral" };
}

function Orders() {
  const { data: allDepts, error: deptErr } = useFetch<Department[]>("/staff/departments");
  const depts = useMemo(() => (allDepts ?? []).filter((d) => d.kind !== "planetarium"), [allDepts]);
  const [deptId, setDeptId] = useStoredDept("staff.orders.dept", allDepts ? depts : null);
  const { data: days } = useFetch<BusinessDays>("/business-days");
  const [day, setDay] = useState<string>("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("active");
  const [callNo, setCallNo] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const clearToast = useCallback(() => setToast(null), []);

  const dayParam = day || days?.today || "";
  const q = new URLSearchParams({ department_id: deptId, filter });
  if (dayParam) q.set("day", dayParam);
  const cn = parseInt(callNo, 10);
  if (cn > 0) q.set("call_number", String(cn));
  const live = useLive<OrderSummary[]>(deptId ? `/staff/orders?${q.toString()}` : null, ["orders"], 15000);
  const orders = live.data ?? [];

  if (deptErr) return <ErrorBox error={deptErr} />;

  return (
    <>
      <div className="section-title">
        <h1>注文一覧・受渡</h1>
        <LiveStatus lastOk={live.lastOk} stale={live.stale} connected={live.connected} error={live.error} />
      </div>
      <DeptPicker depts={depts} value={deptId} onChange={setDeptId} />
      <div className="row">
        {days && days.days.length > 0 && (
          <label className="grow" style={{ maxWidth: 220 }}>
            <span className="label">営業日</span>
            <select value={dayParam} onChange={(e) => setDay(e.target.value)}>
              {!days.days.some((d) => d.day === days.today) && <option value={days.today}>今日（{md(days.today)}）</option>}
              {days.days.map((d) => (
                <option key={d.day} value={d.day}>
                  {d.label}（{md(d.day)}）{d.day === days.today ? "・今日" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="grow" style={{ maxWidth: 200 }}>
          <span className="label">呼出番号で検索</span>
          <input inputMode="numeric" value={callNo} onChange={(e) => setCallNo(e.target.value.replace(/[^\d]/g, ""))} placeholder="例：12" />
        </label>
        {callNo && (
          <button className="btn btn-ghost" onClick={() => setCallNo("")}>
            クリア
          </button>
        )}
      </div>
      <div className="tabs" role="tablist">
        {FILTERS.map((f) => (
          <button key={f.key} role="tab" aria-selected={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>
      {live.error && <ErrorBox error={live.error} />}
      {live.data && orders.length === 0 && <Empty>該当する注文はありません</Empty>}
      {orders.map((o) => {
        const cs = cookSummary(o);
        const unpaid = o.payment_status === "unpaid" && o.status === "accepted";
        return (
          <button key={o.id} className={`orow ${unpaid ? "unpaid" : ""} ${o.status === "cancelled" ? "cancelled" : ""}`} onClick={() => setOpenId(o.id)}>
            <span className="ono">{o.call_number}</span>
            <span>
              <span>
                {o.items
                  .filter((i) => i.cook_status !== "cancelled")
                  .map((i) => `${i.product_name}${i.options_label ? `（${i.options_label}）` : ""}×${i.quantity}`)
                  .join("、") || "（明細なし）"}
              </span>
              <span className="badges">
                <OrderBadges o={o} />
                {cs.text && <Badge tone={cs.tone}>{cs.text}</Badge>}
                {o.unpaid_warning && <Badge tone="danger">⚠ 未払いのまま{elapsed(o.elapsed_sec)}</Badge>}
              </span>
            </span>
            <span className="right">
              <strong className="num">{yen(o.total)}</strong>
              <br />
              <small>
                {hm(o.created_at)}・{elapsed(o.elapsed_sec)}前
              </small>
            </span>
          </button>
        );
      })}
      <Modal open={!!openId} onClose={() => setOpenId(null)} title="注文の詳細">
        {openId && <OrderDetailView orderId={openId} onToast={setToast} />}
      </Modal>
      <Toast message={toast} onDone={clearToast} />
    </>
  );
}
