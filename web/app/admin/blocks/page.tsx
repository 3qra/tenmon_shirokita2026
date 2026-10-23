"use client";

import { useState } from "react";
import { post } from "@/lib/api";
import { useFetch } from "@/lib/hooks";
import { ActionButton, Badge, Empty, ErrorBox, Modal, Notice } from "@/components/ui";
import { AdminPage, fmtDateTime, useActions } from "../_components/admin";

type Block = {
  id: string;
  scope: string;
  reason: string;
  source_type: string;
  source_id: string;
  starts_at: string;
  ends_at: string | null;
  lifted_at: string | null;
  lift_reason: string | null;
  created_at: string;
  client_kind: string;
  created_by_name: string;
  lifted_by_name: string | null;
  effective: boolean;
};

const scopeLabel: Record<string, string> = { order: "注文のみ", reservation: "予約のみ", both: "注文・予約の両方" };
const sourceLabel: Record<string, string> = { order: "注文", reservation: "予約" };
const clientLabel: Record<string, string> = { web: "Webブラウザ", appclip: "App Clip", ios: "iOSアプリ", android: "Androidアプリ" };

function stateOf(b: Block): { label: string; tone: "danger" | "neutral" | "warn" } {
  if (b.lifted_at) return { label: "解除済み", tone: "neutral" };
  if (!b.effective) return { label: "期限切れ", tone: "warn" };
  return { label: "● 制限中", tone: "danger" };
}

export default function BlocksPage() {
  const { run, ui } = useActions();
  const blocks = useFetch<Block[]>("/admin/blocks");
  const [lifting, setLifting] = useState<Block | null>(null);
  const [reason, setReason] = useState("");
  const [onlyActive, setOnlyActive] = useState(false);
  const rows = (blocks.data ?? []).filter((b) => !onlyActive || b.effective);

  return (
    <AdminPage title="利用制限（ブロック）">
      <Notice kind="info">
        ブロックは<strong>端末・ブラウザごとの識別情報</strong>（WebのCookie、アプリの識別値）に対して行います。同一人物であることを保証するものではなく、
        別のブラウザ・別の端末や、Cookie・アプリデータの削除により識別できなくなる場合があります。IPアドレスによる恒久ブロックは行いません。
      </Notice>
      <p className="help">
        新しいブロックは、注文一覧・予約詳細の画面から対象の取引を選んで作成します（スタッフ入力の取引には来場者識別がないためブロックできません）。
        ブロックしても既存の注文・予約は自動で取り消されません。必要に応じてスタッフが個別に判断してください。
      </p>
      <div className="row-between">
        <label className="check">
          <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
          制限中のものだけ表示
        </label>
        <button className="btn btn-sm" onClick={() => blocks.reload()}>
          再読み込み
        </button>
      </div>
      <ErrorBox error={blocks.error} />
      {blocks.data && rows.length === 0 && <Empty>ブロックはありません</Empty>}
      {rows.length > 0 && (
        <div className="table-wrap card">
          <table className="compact">
            <thead>
              <tr>
                <th>状態</th>
                <th>範囲</th>
                <th>理由</th>
                <th>元の取引</th>
                <th>識別の種類</th>
                <th>期間</th>
                <th>実施者</th>
                <th>解除</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const st = stateOf(b);
                return (
                  <tr key={b.id} className={b.effective ? "" : "row-muted"}>
                    <td>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </td>
                    <td>{scopeLabel[b.scope] ?? b.scope}</td>
                    <td>{b.reason}</td>
                    <td>
                      {sourceLabel[b.source_type] ?? b.source_type}
                      <div className="mono help" title={b.source_id}>
                        {b.source_id.slice(0, 8)}…
                      </div>
                    </td>
                    <td>{clientLabel[b.client_kind] ?? b.client_kind}</td>
                    <td className="help">
                      {fmtDateTime(b.starts_at)}〜
                      <br />
                      {b.ends_at ? fmtDateTime(b.ends_at) : "期限なし"}
                    </td>
                    <td>
                      {b.created_by_name}
                      <div className="help">{fmtDateTime(b.created_at)}</div>
                    </td>
                    <td>
                      {b.lifted_at ? (
                        <div className="help">
                          {fmtDateTime(b.lifted_at)}（{b.lifted_by_name}）
                          <br />
                          理由：{b.lift_reason}
                        </div>
                      ) : (
                        <button
                          className="btn btn-sm"
                          onClick={() => {
                            setReason("");
                            setLifting(b);
                          }}
                        >
                          解除
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {lifting && (
        <Modal open onClose={() => setLifting(null)} title="ブロックの解除">
          <p>
            範囲：{scopeLabel[lifting.scope]}／理由：{lifting.reason}
          </p>
          <label className="field">
            <span className="label">解除理由（必須・記録に残ります）</span>
            <textarea maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setLifting(null)}>
              やめる
            </button>
            <ActionButton
              className="btn btn-primary"
              disabled={!reason.trim()}
              onClick={async () => {
                const ok = await run(async () => {
                  await post(`/admin/blocks/${lifting.id}/lift`, { reason: reason.trim() });
                  await blocks.reload();
                }, "ブロックを解除しました");
                if (ok) setLifting(null);
              }}
            >
              解除する
            </ActionButton>
          </div>
        </Modal>
      )}
      {ui}
    </AdminPage>
  );
}
