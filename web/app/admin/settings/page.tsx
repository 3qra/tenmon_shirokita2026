"use client";

import { useEffect, useState } from "react";
import { put } from "@/lib/api";
import { useFetch } from "@/lib/hooks";
import { ActionButton, Badge, ErrorBox, Notice } from "@/components/ui";
import { AdminPage, numOrNull, useActions } from "../_components/admin";

type Limits = Record<string, number>;

type Field = { key: string; label: string; unit: string; help: string; min: number; max?: number; provisional: boolean; def: number };

/** 仮案＝変更可能な設計初期値（仕様書 第19章の未確定事項に関わるもの） */
const GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: "プラネタリウム",
    fields: [
      { key: "seat_threshold_percent", label: "空席「△」表示の閾値", unit: "％", help: "確保済人数÷定員がこの割合以上で△、満席で×。定員18人・70％なら13人から△", min: 1, max: 100, provisional: false, def: 70 },
      { key: "max_party_size", label: "1予約あたりの人数上限", unit: "人", help: "事前予約1件で申し込める最大人数", min: 1, provisional: true, def: 6 },
      { key: "max_future_reservations", label: "将来予約数の上限", unit: "件", help: "同じ端末識別から同時に持てる未来の予約の数", min: 1, provisional: true, def: 2 },
      { key: "reservations_per_minute", label: "予約作成の頻度上限", unit: "回／分", help: "同じ端末識別から1分間に作成できる予約の数", min: 1, provisional: true, def: 3 },
      { key: "visitor_cancel_before_min", label: "本人キャンセルの締切", unit: "分前", help: "上映開始の何分前まで予約者本人がキャンセルできるか（0＝開始まで可）", min: 0, provisional: true, def: 0 },
    ],
  },
  {
    title: "注文・キッチン",
    fields: [
      { key: "unpaid_warn_minutes", label: "未払い注意表示までの時間", unit: "分", help: "注文から この時間を過ぎても未払いの注文を注意表示します（自動取消はしません）", min: 0, provisional: true, def: 15 },
      { key: "cooking_warn_minutes", label: "調理の長時間経過の注意", unit: "分", help: "キッチン画面で経過時間が長い注文を強調表示します", min: 0, provisional: true, def: 15 },
      { key: "max_unpaid_orders", label: "未払い注文数の上限", unit: "件", help: "同じ端末識別から同時に持てる未払いのモバイル注文の数", min: 1, provisional: true, def: 2 },
      { key: "max_items_per_order", label: "1注文の数量上限", unit: "点", help: "1注文に含められる商品数量の合計", min: 1, provisional: true, def: 10 },
      { key: "orders_per_minute", label: "注文作成の頻度上限", unit: "回／分", help: "同じ端末識別から1分間に作成できる注文の数", min: 1, provisional: true, def: 3 },
    ],
  },
  {
    title: "現地確認コード・表示端末",
    fields: [
      { key: "site_code_fail_limit", label: "現地コードの失敗回数上限", unit: "回", help: "下の期間内にこの回数間違えると、しばらく注文できなくなります", min: 1, provisional: true, def: 5 },
      { key: "site_code_fail_window_min", label: "失敗回数を数える期間", unit: "分", help: "現地コードの失敗回数を数える時間の長さ", min: 1, provisional: true, def: 10 },
      { key: "display_stale_seconds", label: "表示端末を「応答なし」とみなす時間", unit: "秒", help: "表示端末からの最終応答がこれより古いと管理画面で警告します", min: 1, provisional: true, def: 30 },
    ],
  },
];

export default function SettingsPage() {
  const { run, ui } = useActions();
  const limits = useFetch<Limits>("/admin/settings/limits");
  const [form, setForm] = useState<Record<string, string>>({});
  useEffect(() => {
    if (limits.data) setForm(Object.fromEntries(Object.entries(limits.data).map(([k, v]) => [k, String(v)])));
  }, [limits.data]);

  const all = GROUPS.flatMap((g) => g.fields);
  const invalid = all.filter((f) => {
    const n = numOrNull(form[f.key] ?? "");
    return n === null || n < f.min || (f.max !== undefined && n > f.max);
  });
  const changed = limits.data ? all.filter((f) => String(limits.data![f.key]) !== form[f.key]) : [];

  return (
    <AdminPage title="制限・設定値">
      <Notice kind="info">
        <Badge tone="warn">仮案</Badge> の付いた値は、運用方法が未確定のため仮に置いている設計初期値です。当日の運用に合わせて確認・変更してください。
        変更は監査ログに記録されます。
      </Notice>
      <ErrorBox error={limits.error} />
      {limits.data &&
        GROUPS.map((g) => (
          <section key={g.title} className="card">
            <h2 style={{ marginTop: 0 }}>{g.title}</h2>
            <div className="form-grid">
              {g.fields.map((f) => {
                const n = numOrNull(form[f.key] ?? "");
                const bad = n === null || n < f.min || (f.max !== undefined && n > f.max);
                return (
                  <label key={f.key} className="span-2">
                    <span className="label">
                      {f.label}（{f.unit}） {f.provisional && <Badge tone="warn">仮案</Badge>}
                    </span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={f.min}
                      max={f.max}
                      value={form[f.key] ?? ""}
                      aria-invalid={bad}
                      onChange={(e) => setForm((x) => ({ ...x, [f.key]: e.target.value }))}
                    />
                    <span className="help">
                      {f.help}。初期値 {f.def}
                      {f.unit}
                      {bad && <strong style={{ color: "var(--danger)" }}>　※{f.min}以上{f.max !== undefined ? `${f.max}以下` : ""}で入力してください</strong>}
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
        ))}
      {limits.data && (
        <div className="row" style={{ position: "sticky", bottom: 0, background: "var(--bg)", padding: "8px 0" }}>
          <ActionButton
            className="btn btn-primary btn-lg"
            disabled={invalid.length > 0 || changed.length === 0}
            confirm={`次の設定を変更します：\n${changed.map((f) => `・${f.label}：${limits.data![f.key]} → ${form[f.key]}${f.unit}`).join("\n")}`}
            onClick={() =>
              run(async () => {
                const body: Record<string, number> = { ...limits.data! };
                for (const f of all) body[f.key] = numOrNull(form[f.key]) ?? body[f.key];
                const saved = await put<Limits>("/admin/settings/limits", body);
                limits.setData(saved);
              }, "設定を保存しました")
            }
          >
            設定を保存{changed.length > 0 ? `（${changed.length}件の変更）` : ""}
          </ActionButton>
          <button className="btn" disabled={changed.length === 0} onClick={() => limits.data && setForm(Object.fromEntries(Object.entries(limits.data).map(([k, v]) => [k, String(v)])))}>
            変更を取り消す
          </button>
        </div>
      )}

      <VoucherChange run={run} />
      {ui}
    </AdminPage>
  );
}

function VoucherChange({ run }: { run: ReturnType<typeof useActions>["run"] }) {
  const [last, setLast] = useState<boolean | null>(null);
  return (
    <section className="card">
      <h2 style={{ marginTop: 0 }}>
        金券のお釣り <Badge tone="warn">仮案</Badge>
      </h2>
      <p>
        学祭金券で支払われたとき、お釣りを現金で出すことを許可するかどうかです。許可しない場合、金券の額面が請求額を超える会計はエラーになります。
        お釣りのルールは未確定（要確認）のため、運用が決まったら設定してください。
      </p>
      <p className="help">
        ※ 現在の設定値を取得する手段がないため、この画面では現在値を表示できません（一度も設定していない場合は「許可しない」として動作します）。
        {last !== null && (
          <strong>
            {" "}
            この画面で最後に設定した値：{last ? "許可する" : "許可しない"}
          </strong>
        )}
      </p>
      <div className="row">
        <ActionButton
          className="btn"
          confirm="金券のお釣りを「許可する」に設定します。よろしいですか？"
          onClick={() =>
            run(async () => {
              await put("/admin/settings/voucher-change", { allowed: true });
              setLast(true);
            }, "金券のお釣りを許可しました")
          }
        >
          許可する
        </ActionButton>
        <ActionButton
          className="btn"
          confirm="金券のお釣りを「許可しない」に設定します。よろしいですか？"
          onClick={() =>
            run(async () => {
              await put("/admin/settings/voucher-change", { allowed: false });
              setLast(false);
            }, "金券のお釣りを許可しないように設定しました")
          }
        >
          許可しない
        </ActionButton>
      </div>
    </section>
  );
}
