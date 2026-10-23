"use client";

import { useEffect, useState } from "react";
import { useFetch } from "@/lib/hooks";
import { md, yen } from "@/lib/format";
import { Empty, ErrorBox } from "@/components/ui";
import { StaffShell } from "@/components/StaffShell";
import type { BusinessDays } from "../_components/types";

type Row = { key: string; orders: number; quantity: number; gross: number; discount: number; paid: number; unpaid: number; refunded: number; net: number };
type SalesResp = { group: string; label: string; rows: Row[]; total: Row };

const GROUPS = [
  { key: "day", label: "日別" },
  { key: "department", label: "部門別" },
  { key: "product", label: "商品別" },
  { key: "hour", label: "時間帯別" },
  { key: "cashier", label: "入金担当者別" },
] as const;

export default function SalesPage() {
  return (
    <StaffShell roles={["treasurer", "admin"]}>
      <Sales />
    </StaffShell>
  );
}

function Sales() {
  const { data: days } = useFetch<BusinessDays>("/business-days");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [group, setGroup] = useState<(typeof GROUPS)[number]["key"]>("day");

  useEffect(() => {
    if (!days || from || to) return;
    if (days.days.length) {
      setFrom(days.days[0].day);
      setTo(days.days[days.days.length - 1].day);
    } else {
      setFrom(days.today);
      setTo(days.today);
    }
  }, [days, from, to]);

  const q = new URLSearchParams({ group });
  if (from) q.set("from", from);
  if (to) q.set("to", to);
  const ready = !!days;
  const { data, error, loading, reload } = useFetch<SalesResp>(ready ? `/treasurer/sales?${q.toString()}` : null);
  const csvHref = `/api/v1/treasurer/sales?${q.toString()}&format=csv`;

  return (
    <>
      <h1>売上集計</h1>
      <p className="muted">釣銭の受け渡し・引継ぎは売上に含みません。「純売上」は入金から返金を引いた金額です。</p>
      {days && days.days.length > 0 && (
        <div className="seg" aria-label="期間のかんたん選択">
          <button
            type="button"
            className={from === days.days[0].day && to === days.days[days.days.length - 1].day ? "seg-on" : ""}
            onClick={() => {
              setFrom(days.days[0].day);
              setTo(days.days[days.days.length - 1].day);
            }}
          >
            全日程
          </button>
          {days.days.map((d) => (
            <button
              key={d.day}
              type="button"
              className={from === d.day && to === d.day ? "seg-on" : ""}
              onClick={() => {
                setFrom(d.day);
                setTo(d.day);
              }}
            >
              {d.label}（{md(d.day)}）
            </button>
          ))}
        </div>
      )}
      <div className="row">
        <label className="grow">
          <span className="label">開始日</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="grow">
          <span className="label">終了日</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <div className="tabs" role="tablist">
        {GROUPS.map((g) => (
          <button key={g.key} role="tab" aria-selected={group === g.key} onClick={() => setGroup(g.key)}>
            {g.label}
          </button>
        ))}
      </div>
      <div className="row-between">
        <button className="btn btn-sm" onClick={reload} disabled={loading}>
          {loading ? "集計中…" : "再集計"}
        </button>
        <a className="btn btn-sm" href={csvHref} download>
          CSVをダウンロード
        </a>
      </div>
      <ErrorBox error={error} />
      {data && data.rows.length === 0 && <Empty>該当する売上はありません</Empty>}
      {data && data.rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{data.label}</th>
                <th className="num">注文数</th>
                <th className="num">数量</th>
                <th className="num">値引前</th>
                <th className="num">値引</th>
                <th className="num">入金</th>
                <th className="num">返金</th>
                <th className="num">純売上</th>
                <th className="num">未払い</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <SalesRow key={r.key} r={r} />
              ))}
            </tbody>
            <tfoot>
              <SalesRow r={data.total} bold />
            </tfoot>
          </table>
        </div>
      )}
      {data && <p className="muted">合計行の注文数は、期間内の取消を除く注文の件数です。</p>}
    </>
  );
}

function SalesRow({ r, bold }: { r: Row; bold?: boolean }) {
  const s = bold ? { fontWeight: 800 } : undefined;
  return (
    <tr style={s}>
      <td>{r.key}</td>
      <td className="num">{r.orders.toLocaleString("ja-JP")}</td>
      <td className="num">{r.quantity.toLocaleString("ja-JP")}</td>
      <td className="num">{yen(r.gross)}</td>
      <td className="num">{r.discount ? `−${yen(r.discount)}` : yen(0)}</td>
      <td className="num">{yen(r.paid)}</td>
      <td className="num">{r.refunded ? `−${yen(r.refunded)}` : yen(0)}</td>
      <td className="num">{yen(r.net)}</td>
      <td className="num">{r.unpaid ? `⚠ ${yen(r.unpaid)}` : yen(0)}</td>
    </tr>
  );
}
