"use client";

import { useState } from "react";
import { useFetch } from "@/lib/hooks";
import { Empty, ErrorBox } from "@/components/ui";
import { AdminPage, fmtDateTime } from "../_components/admin";

type Log = { id: number; action: string; target_type: string; target_id: string; detail: unknown; created_at: string; member_name: string | null };

const actionLabel: Record<string, string> = {
  "department.create": "部門の追加",
  "department.update": "営業設定の変更",
  "business_days.update": "営業日の変更",
  "product.create": "商品の追加",
  "product.update": "商品の変更",
  "product.option_group.add": "選択肢の種類の追加",
  "product.option_value.add": "選択肢の追加",
  "option_groups.update": "選択肢の種類の変更",
  "option_values.update": "選択肢の変更",
  "variant.update": "価格・販売状態の変更",
  "member.create": "部員の追加",
  "member.update": "部員の変更",
  "cash_account.create": "保管先の追加",
  "cash_account.update": "保管先の変更",
  "cash.opening": "開始釣銭",
  "cash.reconcile": "締め精算",
  "cash.transfer_request": "現金移動の申請",
  "order.cancel": "注文の取消",
  "order.item_cancel": "注文明細の取消",
  "order.refund": "返金",
  "order.handoff_revert": "受け渡しの取り消し",
  "order.unpaid_handoff": "未払いでの受け渡し",
  "reservation.cancel": "予約のスタッフ取消",
  "reservation.reissue_link": "予約URLの再発行",
  "ticket.checkin_revert": "入場の取り消し",
  "screening.generate": "上映枠の自動生成",
  "screening.create": "上映枠の追加",
  "screening.update": "上映枠の変更",
  "screening.cancel": "上映中止",
  "coupon_definition.create": "クーポン定義の作成",
  "coupon_definition.update": "クーポン定義の変更",
  "coupon.issue_manual": "クーポン手動発券",
  "coupon.revoke": "クーポン失効",
  "coupon.redemption_reverse": "クーポン利用取消",
  "block.create": "ブロック",
  "block.lift": "ブロック解除",
  "settings.limits": "制限値の変更",
  "settings.voucher_change": "金券お釣り設定",
  "shift_slot.create": "シフト枠の追加",
  "shift_slot.update": "シフト枠の変更",
  "shift.assign": "シフト配置",
  "shift.unassign": "シフト配置の解除",
  "shift.exchange_request": "交代申請",
  "shift.exchange_accept": "交代の承諾",
  "shift.exchange_decline": "交代の辞退",
  "shift.exchange_cancel": "交代申請の取り下げ",
  "shift.exchange_approve": "交代の承認",
  "shift.exchange_reject": "交代の却下",
};

const TARGET_TYPES: [string, string][] = [
  ["", "すべて"],
  ["department", "部門"],
  ["product", "商品"],
  ["product_variant", "商品の組み合わせ"],
  ["option_groups", "選択肢の種類"],
  ["option_values", "選択肢"],
  ["order", "注文"],
  ["screening", "上映"],
  ["screening_rule", "上映生成ルール"],
  ["reservation", "予約"],
  ["admission_ticket", "入場チケット"],
  ["coupon_definition", "クーポン定義"],
  ["issued_coupon", "発券クーポン"],
  ["coupon_redemption", "クーポン利用"],
  ["access_block", "ブロック"],
  ["member", "部員"],
  ["cash_account", "現金保管先"],
  ["cash_transfer", "現金移動"],
  ["shift_slot", "シフト枠"],
  ["shift_assignment", "シフト配置"],
  ["shift_exchange", "シフト交代"],
  ["settings", "設定"],
  ["festival_event", "開催回"],
];

export default function AuditPage() {
  const [type, setType] = useState("");
  const [targetId, setTargetId] = useState("");
  const [limit, setLimit] = useState("200");
  const [query, setQuery] = useState({ type: "", targetId: "", limit: "200" });
  const qs = new URLSearchParams();
  if (query.type) qs.set("target_type", query.type);
  if (query.targetId) qs.set("target_id", query.targetId);
  qs.set("limit", query.limit);
  const logs = useFetch<Log[]>(`/admin/audit-logs?${qs.toString()}`);

  return (
    <AdminPage title="監査ログ">
      <p className="help">返金・強制取消・ブロック・設定変更など重要な操作の記録です。記録は変更・削除できません。</p>
      <form
        className="card form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery({ type, targetId: targetId.trim(), limit });
        }}
      >
        <label>
          <span className="label">対象の種類</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {TARGET_TYPES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
                {k ? `（${k}）` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="span-2">
          <span className="label">対象ID（任意）</span>
          <input value={targetId} onChange={(e) => setTargetId(e.target.value)} placeholder="例：注文や上映のID" className="mono" />
        </label>
        <label>
          <span className="label">表示件数</span>
          <select value={limit} onChange={(e) => setLimit(e.target.value)}>
            {["50", "200", "500", "1000"].map((n) => (
              <option key={n} value={n}>
                最新{n}件
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <button type="submit" className="btn btn-primary">
            検索
          </button>
          <button type="button" className="btn" onClick={() => logs.reload()}>
            再読み込み
          </button>
        </div>
      </form>
      <ErrorBox error={logs.error} />
      {logs.loading && !logs.data && <p className="empty">読み込み中…</p>}
      {logs.data?.length === 0 && <Empty>該当する記録はありません</Empty>}
      {logs.data && logs.data.length > 0 && (
        <div className="table-wrap card">
          <table className="compact">
            <thead>
              <tr>
                <th>日時</th>
                <th>操作者</th>
                <th>操作</th>
                <th>対象</th>
                <th>内容</th>
              </tr>
            </thead>
            <tbody>
              {logs.data.map((l) => (
                <tr key={l.id}>
                  <td className="num" style={{ whiteSpace: "nowrap" }}>
                    {fmtDateTime(l.created_at)}
                  </td>
                  <td>{l.member_name ?? "（システム）"}</td>
                  <td>
                    {actionLabel[l.action] ?? l.action}
                    <div className="help mono">{l.action}</div>
                  </td>
                  <td>
                    {TARGET_TYPES.find(([k]) => k === l.target_type)?.[1] ?? l.target_type}
                    <div>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost mono"
                        title="この対象で絞り込む"
                        onClick={() => {
                          setType(l.target_type);
                          setTargetId(l.target_id);
                          setQuery({ type: l.target_type, targetId: l.target_id, limit });
                        }}
                      >
                        {l.target_id.length > 12 ? `${l.target_id.slice(0, 8)}…` : l.target_id}
                      </button>
                    </div>
                  </td>
                  <td>
                    {l.detail != null && (
                      <details>
                        <summary>詳細</summary>
                        <pre className="json">{JSON.stringify(l.detail, null, 2)}</pre>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminPage>
  );
}
