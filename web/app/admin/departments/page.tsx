"use client";

import { useEffect, useState } from "react";
import { patch, post, put } from "@/lib/api";
import { useFetch, useLive } from "@/lib/hooks";
import { businessLabel } from "@/lib/format";
import { ActionButton, Badge, Empty, ErrorBox, LiveStatus, Notice } from "@/components/ui";
import { AdminPage, BusinessDays, businessTone, Department, kindLabel, numOrNull, useActions } from "../_components/admin";

type Run = ReturnType<typeof useActions>["run"];

const STATUSES = ["before", "open", "paused", "closed"] as const;

export default function DepartmentsPage() {
  const { run, ui } = useActions();
  const depts = useLive<Department[]>("/staff/departments", ["departments"]);

  return (
    <AdminPage title="営業設定">
      <Notice kind="info">
        <strong>「新規受付の停止」と「既存の注文・予約の取消」は別の操作です。</strong>
        営業状態を「一時停止」「営業終了」にしたり、モバイル注文受付をOFFにしても、受付済みの注文の会計・調理・受け渡し、
        既存予約の照会・入場はそのまま行えます。個別の取消は注文一覧・予約詳細から行ってください。
      </Notice>
      <LiveStatus lastOk={depts.lastOk} stale={depts.stale} connected={depts.connected} error={depts.error} />
      <ErrorBox error={depts.error} />
      {depts.data?.length === 0 && <Empty>部門がありません</Empty>}
      {depts.data?.map((d) => <DeptCard key={d.id} d={d} run={run} reload={depts.reload} />)}

      <CreateDept run={run} reload={depts.reload} />
      <BusinessDaysEditor run={run} />
      {ui}
    </AdminPage>
  );
}

function DeptCard({ d, run, reload }: { d: Department; run: Run; reload: () => Promise<void> }) {
  const [interval, setInterval_] = useState(String(d.site_code_interval_sec));
  const [grace, setGrace] = useState(String(d.site_code_grace_sec));
  const [notice, setNotice] = useState(d.notice);
  const [name, setName] = useState(d.name);
  useEffect(() => {
    setInterval_(String(d.site_code_interval_sec));
    setGrace(String(d.site_code_grace_sec));
  }, [d.site_code_interval_sec, d.site_code_grace_sec]);
  useEffect(() => setNotice(d.notice), [d.notice]);
  useEffect(() => setName(d.name), [d.name]);

  const save = (body: Record<string, unknown>, ok: string) =>
    run(async () => {
      await patch(`/admin/departments/${d.id}`, body);
      await reload();
    }, ok);

  return (
    <section className="card">
      <div className="row-between">
        <h2 style={{ margin: 0 }}>
          {d.name} <small className="muted">（{kindLabel[d.kind] ?? d.kind}・コード {d.code}）</small>
        </h2>
        <Badge tone={businessTone[d.business_status]}>{businessLabel[d.business_status]}</Badge>
      </div>

      <h3>営業状態</h3>
      <div className="seg" role="group" aria-label="営業状態">
        {STATUSES.map((s) => (
          <ActionButton
            key={s}
            className={d.business_status === s ? "btn btn-sm btn-primary" : "btn btn-sm"}
            disabled={d.business_status === s}
            confirm={
              s === "paused" || s === "closed"
                ? `「${d.name}」を「${businessLabel[s]}」にします。新規受付が止まります（既存の注文・予約は取り消されません）。よろしいですか？`
                : undefined
            }
            onClick={() => save({ business_status: s }, `${businessLabel[s]}にしました`)}
          >
            {d.business_status === s ? `● ${businessLabel[s]}（現在）` : businessLabel[s]}
          </ActionButton>
        ))}
      </div>
      <span className="help">営業状態は新規受付の可否を決めます。受付済みの注文・予約は状態変更で取り消されません。</span>

      <div className="grid-2" style={{ marginTop: 8 }}>
        <div>
          <h3>モバイル注文受付</h3>
          <p>
            現在：<Badge tone={d.mobile_order_enabled ? "ok" : "neutral"}>{d.mobile_order_enabled ? "ON（受付中）" : "OFF（停止中）"}</Badge>
          </p>
          <ActionButton
            className={d.mobile_order_enabled ? "btn btn-sm" : "btn btn-sm btn-primary"}
            confirm={d.mobile_order_enabled ? "モバイル注文の新規受付を停止します。受付済みの注文はそのまま処理できます。よろしいですか？" : undefined}
            onClick={() =>
              save({ mobile_order_enabled: !d.mobile_order_enabled }, d.mobile_order_enabled ? "モバイル注文受付を停止しました" : "モバイル注文受付を開始しました")
            }
          >
            {d.mobile_order_enabled ? "OFFにする" : "ONにする"}
          </ActionButton>
          <span className="help">部門の営業状態とは別に設定します。スタッフの対面注文には影響しません。</span>
        </div>

        <div>
          <h3>現地確認コード</h3>
          <p>
            現在：<Badge tone={d.site_code_enabled ? "info" : "neutral"}>{d.site_code_enabled ? "ON（入力必須）" : "OFF"}</Badge>
          </p>
          <div className="row">
            <ActionButton
              className="btn btn-sm"
              onClick={() => save({ site_code_enabled: !d.site_code_enabled }, d.site_code_enabled ? "現地コード確認をOFFにしました" : "現地コード確認をONにしました")}
            >
              {d.site_code_enabled ? "OFFにする" : "ONにする"}
            </ActionButton>
            <ActionButton
              className="btn btn-sm"
              confirm="現地コードを今すぐ新しいコードに変更します。表示中のコードはすぐに使えなくなります。よろしいですか？"
              onClick={() => save({ rotate_site_code: true }, "現地コードを更新しました")}
            >
              今すぐコード更新
            </ActionButton>
          </div>
          <span className="help">現地のディスプレイに表示する3桁の共有コードです。個人の認証ではありません。</span>
        </div>
      </div>

      <div className="form-grid" style={{ marginTop: 8 }}>
        <label>
          <span className="label">コード更新間隔（秒）</span>
          <input type="number" min={30} max={86400} inputMode="numeric" value={interval} onChange={(e) => setInterval_(e.target.value)} />
          <span className="help">30〜86400秒。仮案の初期値は300秒（5分）</span>
        </label>
        <label>
          <span className="label">更新直後の猶予（秒）</span>
          <input type="number" min={0} inputMode="numeric" value={grace} onChange={(e) => setGrace(e.target.value)} />
          <span className="help">更新後この秒数は直前のコードも有効（仮案30秒）</span>
        </label>
        <div>
          <ActionButton
            className="btn btn-primary"
            disabled={interval === String(d.site_code_interval_sec) && grace === String(d.site_code_grace_sec)}
            onClick={() => {
              const iv = numOrNull(interval);
              const gr = numOrNull(grace);
              if (iv === null || gr === null || iv < 30 || iv > 86400 || gr < 0) {
                return run(async () => {
                  throw new Error("更新間隔は30〜86400秒、猶予は0秒以上で入力してください");
                });
              }
              return save({ site_code_interval_sec: iv, site_code_grace_sec: gr }, "コード設定を保存しました");
            }}
          >
            間隔を保存
          </ActionButton>
        </div>
      </div>

      <div className="form-grid" style={{ marginTop: 8 }}>
        <label className="span-2">
          <span className="label">来場者向け案内文（200文字まで）</span>
          <textarea maxLength={200} value={notice} onChange={(e) => setNotice(e.target.value)} placeholder="例：ただいま混雑しています。お渡しまで15分ほどかかります" />
        </label>
        <div>
          <ActionButton className="btn btn-primary" disabled={notice === d.notice} onClick={() => save({ notice }, "案内文を保存しました")}>
            案内文を保存
          </ActionButton>
        </div>
        <label>
          <span className="label">部門名</span>
          <input value={name} maxLength={50} onChange={(e) => setName(e.target.value)} />
        </label>
        <div>
          <ActionButton className="btn" disabled={!name.trim() || name === d.name} onClick={() => save({ name: name.trim() }, "部門名を保存しました")}>
            部門名を保存
          </ActionButton>
        </div>
      </div>
    </section>
  );
}

function CreateDept({ run, reload }: { run: Run; reload: () => Promise<void> }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("food");
  return (
    <section className="card">
      <h2 style={{ marginTop: 0 }}>部門を追加</h2>
      <div className="form-grid">
        <label>
          <span className="label">コード（英数字・重複不可）</span>
          <input value={code} maxLength={30} onChange={(e) => setCode(e.target.value)} placeholder="例：goods2" />
        </label>
        <label>
          <span className="label">部門名</span>
          <input value={name} maxLength={50} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span className="label">種類</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(kindLabel).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <div>
          <ActionButton
            className="btn btn-primary"
            disabled={!code.trim() || !name.trim()}
            onClick={() =>
              run(async () => {
                await post("/admin/departments", { code: code.trim(), name: name.trim(), kind });
                setCode("");
                setName("");
                await reload();
              }, "部門を追加しました")
            }
          >
            追加
          </ActionButton>
        </div>
      </div>
      <span className="help">追加直後の営業状態は「営業前」です。</span>
    </section>
  );
}

function BusinessDaysEditor({ run }: { run: Run }) {
  const bd = useFetch<BusinessDays>("/business-days");
  const [eventName, setEventName] = useState("");
  const [rows, setRows] = useState<{ day: string; label: string; isNew: boolean }[]>([]);
  useEffect(() => {
    if (bd.data) setRows(bd.data.days.map((d) => ({ day: d.day, label: d.label, isNew: false })));
  }, [bd.data]);

  const update = (i: number, patchRow: Partial<{ day: string; label: string }>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patchRow } : r)));

  return (
    <section className="card">
      <h2 style={{ marginTop: 0 }}>開催回・営業日</h2>
      <ErrorBox error={bd.error} />
      <p className="help">
        営業日は追加と表示名の変更ができます（削除はできません。上映・シフト等の履歴と結びつくため）。日付はAsia/Tokyo基準です。
      </p>
      <label className="field">
        <span className="label">開催名（空欄なら変更しません）</span>
        <input value={eventName} maxLength={100} onChange={(e) => setEventName(e.target.value)} placeholder="例：第50回 学園祭" />
      </label>
      <div className="table-wrap">
        <table className="compact">
          <thead>
            <tr>
              <th>日付</th>
              <th>表示名</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  {r.isNew ? (
                    <input type="date" className="inline-input" value={r.day} onChange={(e) => update(i, { day: e.target.value })} />
                  ) : (
                    <span className="num">{r.day}</span>
                  )}
                </td>
                <td>
                  <input className="inline-input" value={r.label} maxLength={30} onChange={(e) => update(i, { label: e.target.value })} placeholder="例：1日目" />
                </td>
                <td>
                  {r.isNew && (
                    <button className="btn btn-sm btn-ghost" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                      取りやめ
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn btn-sm" onClick={() => setRows((rs) => [...rs, { day: "", label: `${rs.length + 1}日目`, isNew: true }])}>
          ＋ 営業日を追加
        </button>
        <ActionButton
          className="btn btn-primary"
          disabled={rows.some((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.day))}
          onClick={() =>
            run(async () => {
              await put("/admin/business-days", {
                event_name: eventName.trim(),
                days: rows.map((r) => ({ day: r.day, label: r.label.trim() })),
              });
              setEventName("");
              await bd.reload();
            }, "営業日を保存しました")
          }
        >
          営業日を保存
        </ActionButton>
      </div>
    </section>
  );
}
