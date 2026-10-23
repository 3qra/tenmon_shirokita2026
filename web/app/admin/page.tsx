"use client";

import Link from "next/link";
import { useLive } from "@/lib/hooks";
import { businessLabel, mdhm } from "@/lib/format";
import { Badge, Empty, ErrorBox, LiveStatus, Notice } from "@/components/ui";
import { ADMIN_LINKS } from "./_components/AdminNav";
import { AdminPage, businessTone, Department, kindLabel } from "./_components/admin";

type Display = { name: string; screen: string; last_seen_at: string; department_name: string | null; stale: boolean };

const screenLabel: Record<string, string> = {
  sitecode: "現地コード表示",
  board: "呼出状況表示",
  screenings: "上映状況表示",
};

export default function AdminHome() {
  const depts = useLive<Department[]>("/staff/departments", ["departments"]);
  const displays = useLive<Display[]>("/admin/displays", [], 10000);
  const staleCount = displays.data?.filter((d) => d.stale).length ?? 0;

  return (
    <AdminPage title="管理">
      <LiveStatus lastOk={depts.lastOk} stale={depts.stale} connected={depts.connected} error={depts.error} />

      <h2>部門の状況</h2>
      <ErrorBox error={depts.error} />
      {depts.data && depts.data.length === 0 && <Empty>部門がありません</Empty>}
      <div className="grid">
        {depts.data?.map((d) => (
          <Link key={d.id} href="/admin/departments" className="card card-link">
            <div className="row-between">
              <strong>{d.name}</strong>
              <Badge tone={businessTone[d.business_status]}>{businessLabel[d.business_status] ?? d.business_status}</Badge>
            </div>
            <small>{kindLabel[d.kind] ?? d.kind}</small>
            <div className="chips" style={{ marginTop: 6 }}>
              {d.kind === "food" && (
                <Badge tone={d.mobile_order_enabled ? "ok" : "neutral"}>モバイル受付 {d.mobile_order_enabled ? "ON" : "OFF"}</Badge>
              )}
              <Badge tone={d.site_code_enabled ? "info" : "neutral"}>現地コード {d.site_code_enabled ? "ON" : "OFF"}</Badge>
            </div>
            {d.notice && <p className="muted" style={{ fontSize: "0.85rem" }}>案内：{d.notice}</p>}
          </Link>
        ))}
      </div>

      <h2>表示端末</h2>
      <ErrorBox error={displays.error} />
      {staleCount > 0 && (
        <Notice kind="danger">⚠ 応答のない表示端末が{staleCount}台あります。端末の電源・通信・ログイン状態を確認してください。</Notice>
      )}
      {displays.data && displays.data.length === 0 && <Empty>接続記録のある表示端末はありません</Empty>}
      {displays.data && displays.data.length > 0 && (
        <div className="table-wrap card">
          <table>
            <thead>
              <tr>
                <th>端末（アカウント）</th>
                <th>表示内容</th>
                <th>部門</th>
                <th>最終応答</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {displays.data.map((d) => (
                <tr key={d.name + d.last_seen_at} className={d.stale ? "row-danger" : ""}>
                  <td>{d.name}</td>
                  <td>{screenLabel[d.screen] ?? d.screen ?? "—"}</td>
                  <td>{d.department_name ?? "—"}</td>
                  <td className="num">{mdhm(d.last_seen_at)}</td>
                  <td>{d.stale ? <Badge tone="danger">⚠ 応答なし</Badge> : <Badge tone="ok">✓ 正常</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>管理メニュー</h2>
      <div className="grid">
        {ADMIN_LINKS.filter((l) => l.href !== "/admin").map((l) => (
          <Link key={l.href} href={l.href} className="card card-link">
            <strong>{l.label}</strong>
            <p className="muted" style={{ fontSize: "0.9rem" }}>{l.desc}</p>
          </Link>
        ))}
      </div>
    </AdminPage>
  );
}
