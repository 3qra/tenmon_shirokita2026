"use client";

import { useEffect, useState } from "react";
import { post, put } from "@/lib/api";
import { useFetch } from "@/lib/hooks";
import { yen } from "@/lib/format";
import { ActionButton, Badge, Empty, ErrorBox, Modal, Notice } from "@/components/ui";
import { Qr } from "@/components/Qr";
import { AdminPage, Department, fmtDateTime, fromJstInput, numOrNull, toJstInput, useActions } from "../_components/admin";

type Run = ReturnType<typeof useActions>["run"];

type CouponDef = {
  id: string;
  name: string;
  description: string;
  discount_type: "fixed" | "percent";
  discount_value: number;
  scope: "order" | "items";
  target_department_id: string | null;
  target_product_ids: string[];
  target_variant_ids: string[];
  items_per_person: number;
  allocation: string;
  max_discount: number | null;
  holder_mode: string;
  splittable: boolean;
  combinable: boolean;
  valid_from: string | null;
  valid_until: string | null;
  max_issues: number | null;
  auto_issue: string;
  active: boolean;
  issued_count: number;
  used_persons: number;
  created_at: string;
};

type Issued = {
  id: string;
  public_no: string;
  definition_id: string;
  name: string;
  persons_total: number;
  persons_remaining: number;
  status: string;
  valid_from: string | null;
  valid_until: string | null;
  source_kind: string;
  created_at: string;
  revoke_reason: string | null;
  reservation_no: string | null;
};

type IssuedResult = { id: string; coupon_no: string; token: string; url: string };

type CatalogProduct = { id: string; name: string; active: boolean; variants: { id: string; label: string; price: number; active: boolean }[] };

const allocationLabel: Record<string, string> = {
  highest_price_first: "価格の高い商品から",
  lowest_price_first: "価格の安い商品から",
};
const holderLabel: Record<string, string> = { per_person: "一人一枚", group: "一枚で複数人分" };
const autoLabel: Record<string, string> = { none: "なし（手動発券のみ）", screening_attended: "上映鑑賞者へ自動発券" };
const issuedStatusLabel: Record<string, string> = { active: "有効", used: "使用済", revoked: "失効", expired: "期限切れ" };
const issuedTone: Record<string, "ok" | "neutral" | "danger" | "warn"> = { active: "ok", used: "neutral", revoked: "danger", expired: "warn" };

function discountText(d: Pick<CouponDef, "discount_type" | "discount_value" | "scope" | "max_discount">) {
  const base =
    d.discount_type === "percent"
      ? `${d.discount_value}%引き`
      : d.scope === "items"
        ? `1点${yen(d.discount_value)}引き`
        : `1人あたり${yen(d.discount_value)}引き`;
  return d.max_discount !== null && d.max_discount !== undefined ? `${base}（上限${yen(d.max_discount)}）` : base;
}

export default function CouponsPage() {
  const { run, ui, setToast } = useActions();
  const defs = useFetch<CouponDef[]>("/admin/coupon-definitions");
  const depts = useFetch<Department[]>("/staff/departments");
  const [editing, setEditing] = useState<CouponDef | "new" | null>(null);
  const [issuing, setIssuing] = useState<CouponDef | null>(null);
  const [results, setResults] = useState<{ name: string; persons: number; items: IssuedResult[] } | null>(null);
  const [filter, setFilter] = useState("");
  const [issuedVersion, setIssuedVersion] = useState(0);
  const deptName = (id: string | null) => depts.data?.find((d) => d.id === id)?.name;

  return (
    <AdminPage title="クーポン">
      <Notice kind="info">
        クーポン定義を変更しても、<strong>発券済みのクーポンには反映されません</strong>（発券時の条件で固定されます）。条件を変えたい場合は新しい定義を作るか、発券済みを失効させて再発券してください。
      </Notice>

      {results && (
        <section className="card coupon-print">
          <div className="row-between no-print">
            <h2 style={{ margin: 0 }}>発券結果（{results.items.length}枚）</h2>
            <div className="row">
              <button
                className="btn btn-primary"
                onClick={() => {
                  document.body.classList.add("admin-print-coupons");
                  const done = () => {
                    document.body.classList.remove("admin-print-coupons");
                    window.removeEventListener("afterprint", done);
                  };
                  window.addEventListener("afterprint", done);
                  window.print();
                }}
              >
                印刷
              </button>
              <button className="btn" onClick={() => setResults(null)}>
                閉じる
              </button>
            </div>
          </div>
          <p className="no-print help">QRコードは来場者に渡すためのものです。この画面を閉じると再表示できません（番号は一覧に残ります）。</p>
          <div className="coupon-print-grid">
            {results.items.map((c) => (
              <div key={c.id} className="coupon-print-card">
                <div>{results.name}</div>
                <Qr value={c.url} size={160} label={c.coupon_no} />
                <div className="no">{c.coupon_no}</div>
                <small>{results.persons}人分</small>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="row-between">
        <h2>クーポン定義</h2>
        <button className="btn btn-primary" onClick={() => setEditing("new")}>
          ＋ 新しいクーポン定義
        </button>
      </div>
      <ErrorBox error={defs.error} />
      {defs.data?.length === 0 && <Empty>クーポン定義はまだありません</Empty>}
      {defs.data && defs.data.length > 0 && (
        <div className="table-wrap card">
          <table className="compact">
            <thead>
              <tr>
                <th>名前</th>
                <th>割引</th>
                <th>対象</th>
                <th>利用方法</th>
                <th>期間</th>
                <th className="num">発行／上限</th>
                <th className="num">利用人数</th>
                <th>自動発券</th>
                <th>状態</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {defs.data.map((d) => (
                <tr key={d.id} className={d.active ? "" : "row-muted"}>
                  <td>
                    <strong>{d.name}</strong>
                    {d.description && <div className="help">{d.description}</div>}
                  </td>
                  <td>{discountText(d)}</td>
                  <td>
                    {d.scope === "order" ? "注文全体" : "特定の商品"}
                    {d.target_department_id && <div className="help">部門：{deptName(d.target_department_id) ?? "—"}</div>}
                    {d.scope === "items" && (
                      <div className="help">
                        商品{d.target_product_ids.length}件・組み合わせ{d.target_variant_ids.length}件／1人{d.items_per_person}点・{allocationLabel[d.allocation] ?? d.allocation}
                      </div>
                    )}
                  </td>
                  <td>
                    {holderLabel[d.holder_mode] ?? d.holder_mode}
                    <div className="help">
                      {d.splittable ? "分割利用可" : "分割利用不可"}・{d.combinable ? "併用可" : "併用不可"}
                    </div>
                  </td>
                  <td className="help">
                    {d.valid_from || d.valid_until ? (
                      <>
                        {fmtDateTime(d.valid_from) || "—"}〜
                        <br />
                        {fmtDateTime(d.valid_until) || "—"}
                      </>
                    ) : (
                      "期限なし"
                    )}
                  </td>
                  <td className="num">
                    {d.issued_count}／{d.max_issues ?? "上限なし"}
                  </td>
                  <td className="num">{d.used_persons}</td>
                  <td>{d.auto_issue === "screening_attended" ? <Badge tone="info">鑑賞者へ自動</Badge> : "—"}</td>
                  <td>{d.active ? <Badge tone="ok">有効</Badge> : <Badge tone="neutral">無効</Badge>}</td>
                  <td>
                    <div className="row" style={{ flexWrap: "nowrap" }}>
                      <button className="btn btn-sm" onClick={() => setEditing(d)}>
                        編集
                      </button>
                      <button className="btn btn-sm" disabled={!d.active} onClick={() => setIssuing(d)}>
                        発券
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => {
                          setFilter(d.id);
                          document.getElementById("issued-coupons")?.scrollIntoView({ behavior: "smooth" });
                        }}
                      >
                        発券一覧
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <DefForm
          def={editing === "new" ? null : editing}
          depts={depts.data ?? []}
          onClose={() => setEditing(null)}
          run={run}
          onSaved={async () => {
            setEditing(null);
            await defs.reload();
          }}
        />
      )}

      {issuing && (
        <IssueModal
          def={issuing}
          onClose={() => setIssuing(null)}
          onIssued={async (items, persons) => {
            setResults({ name: issuing.name, persons, items });
            setIssuing(null);
            setToast(`${items.length}枚発券しました`);
            setIssuedVersion((v) => v + 1);
            await defs.reload();
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        />
      )}

      <IssuedList defs={defs.data ?? []} filter={filter} setFilter={setFilter} run={run} version={issuedVersion} />
      {ui}
    </AdminPage>
  );
}

// ---------------------------------------------------------------

type FormState = {
  name: string;
  description: string;
  discount_type: "fixed" | "percent";
  discount_value: string;
  scope: "order" | "items";
  target_department_id: string;
  target_product_ids: string[];
  target_variant_ids: string[];
  items_per_person: string;
  allocation: string;
  max_discount: string;
  holder_mode: string;
  splittable: boolean;
  combinable: boolean;
  valid_from: string;
  valid_until: string;
  max_issues: string;
  auto_issue: string;
  active: boolean;
};

function toForm(d: CouponDef | null): FormState {
  return {
    name: d?.name ?? "",
    description: d?.description ?? "",
    discount_type: d?.discount_type ?? "fixed",
    discount_value: d ? String(d.discount_value) : "",
    scope: d?.scope ?? "items",
    target_department_id: d?.target_department_id ?? "",
    target_product_ids: d?.target_product_ids ?? [],
    target_variant_ids: d?.target_variant_ids ?? [],
    items_per_person: d ? String(d.items_per_person) : "1",
    allocation: d?.allocation ?? "highest_price_first",
    max_discount: d?.max_discount != null ? String(d.max_discount) : "",
    holder_mode: d?.holder_mode ?? "per_person",
    splittable: d?.splittable ?? false,
    combinable: d?.combinable ?? false,
    valid_from: toJstInput(d?.valid_from),
    valid_until: toJstInput(d?.valid_until),
    max_issues: d?.max_issues != null ? String(d.max_issues) : "",
    auto_issue: d?.auto_issue ?? "none",
    active: d?.active ?? true,
  };
}

function DefForm({ def, depts, onClose, onSaved, run }: { def: CouponDef | null; depts: Department[]; onClose: () => void; onSaved: () => Promise<void>; run: Run }) {
  const [f, setF] = useState<FormState>(() => toForm(def));
  useEffect(() => setF(toForm(def)), [def]);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((x) => ({ ...x, [k]: v }));
  const catalog = useFetch<{ products: CatalogProduct[] }>(f.target_department_id ? `/staff/departments/${f.target_department_id}/products` : null);
  const toggle = (k: "target_product_ids" | "target_variant_ids", id: string) =>
    setF((x) => ({ ...x, [k]: x[k].includes(id) ? x[k].filter((v) => v !== id) : [...x[k], id] }));

  const value = numOrNull(f.discount_value);
  const errors: string[] = [];
  if (!f.name.trim()) errors.push("クーポン名を入力してください");
  if (value === null || value <= 0 || (f.discount_type === "percent" && value > 100)) errors.push("割引額（率）を正しく入力してください");
  if (f.scope === "items" && f.target_product_ids.length + f.target_variant_ids.length === 0) errors.push("対象商品を1つ以上選んでください");
  if (f.valid_from && f.valid_until && f.valid_from >= f.valid_until) errors.push("利用終了は利用開始より後にしてください");

  const submit = () =>
    run(async () => {
      const body = {
        name: f.name.trim(),
        description: f.description,
        discount_type: f.discount_type,
        discount_value: value,
        scope: f.scope,
        target_department_id: f.target_department_id,
        target_product_ids: f.scope === "items" ? f.target_product_ids : [],
        target_variant_ids: f.scope === "items" ? f.target_variant_ids : [],
        items_per_person: numOrNull(f.items_per_person) ?? 1,
        allocation: f.allocation,
        max_discount: numOrNull(f.max_discount),
        holder_mode: f.holder_mode,
        splittable: f.splittable,
        combinable: f.combinable,
        valid_from: fromJstInput(f.valid_from),
        valid_until: fromJstInput(f.valid_until),
        max_issues: numOrNull(f.max_issues),
        auto_issue: f.auto_issue,
        active: f.active,
      };
      if (def) await put(`/admin/coupon-definitions/${def.id}`, body);
      else await post("/admin/coupon-definitions", body);
      await onSaved();
    }, def ? "クーポン定義を保存しました" : "クーポン定義を作成しました");

  return (
    <Modal open onClose={onClose} title={def ? `クーポン定義の編集` : "クーポン定義の作成"}>
      {def && (
        <Notice kind="warn">
          変更は今後発券するクーポンにのみ適用されます。発券済み（{def.issued_count}枚）の条件は変わりません。
        </Notice>
      )}
      <label className="field">
        <span className="label">クーポン名（来場者に表示）</span>
        <input value={f.name} maxLength={50} onChange={(e) => set("name", e.target.value)} />
      </label>
      <label className="field">
        <span className="label">説明（来場者に表示）</span>
        <textarea value={f.description} onChange={(e) => set("description", e.target.value)} />
      </label>

      <h3>割引</h3>
      <div className="form-grid">
        <label>
          <span className="label">種類</span>
          <select value={f.discount_type} onChange={(e) => set("discount_type", e.target.value as FormState["discount_type"])}>
            <option value="fixed">定額（何円引き）</option>
            <option value="percent">定率（何％引き）</option>
          </select>
        </label>
        <label>
          <span className="label">{f.discount_type === "fixed" ? "割引額（円）" : "割引率（％）"}</span>
          <input type="number" min={1} max={f.discount_type === "percent" ? 100 : undefined} inputMode="numeric" value={f.discount_value} onChange={(e) => set("discount_value", e.target.value)} />
        </label>
        <label>
          <span className="label">割引上限（円・任意）</span>
          <input type="number" min={0} inputMode="numeric" value={f.max_discount} onChange={(e) => set("max_discount", e.target.value)} />
        </label>
      </div>
      <span className="help">
        定額の場合、「特定の商品」では対象商品1点あたり、「注文全体」では1人あたりの割引額です。定率は1円未満切り捨て。割引は対象金額を超えません。
      </span>

      <h3>対象</h3>
      <div className="form-grid">
        <label>
          <span className="label">適用範囲</span>
          <select value={f.scope} onChange={(e) => set("scope", e.target.value as FormState["scope"])}>
            <option value="order">注文全体</option>
            <option value="items">特定の商品</option>
          </select>
        </label>
        <label>
          <span className="label">対象部門{f.scope === "order" ? "（任意）" : ""}</span>
          <select
            value={f.target_department_id}
            onChange={(e) => setF((x) => ({ ...x, target_department_id: e.target.value, target_product_ids: [], target_variant_ids: [] }))}
          >
            <option value="">指定なし（全部門）</option>
            {depts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        {f.scope === "items" && (
          <>
            <label>
              <span className="label">1人あたりの対象点数</span>
              <input type="number" min={1} inputMode="numeric" value={f.items_per_person} onChange={(e) => set("items_per_person", e.target.value)} />
            </label>
            <label>
              <span className="label">対象商品が複数あるときの割当順</span>
              <select value={f.allocation} onChange={(e) => set("allocation", e.target.value)}>
                {Object.entries(allocationLabel).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
      {f.scope === "items" && (
        <div className="field">
          <span className="label">対象商品（商品全体、または特定の組み合わせを選択）</span>
          {!f.target_department_id && <p className="help">対象部門を選ぶと商品を選択できます。</p>}
          <ErrorBox error={catalog.error} />
          {catalog.data?.products.map((p) => (
            <div key={p.id} style={{ marginBottom: 4 }}>
              <label className="check">
                <input type="checkbox" checked={f.target_product_ids.includes(p.id)} onChange={() => toggle("target_product_ids", p.id)} />
                <strong>{p.name}</strong>（すべての組み合わせ）{!p.active && <Badge tone="neutral">無効</Badge>}
              </label>
              {!f.target_product_ids.includes(p.id) && p.variants.length > 1 && (
                <div className="sub-list check-list">
                  {p.variants
                    .filter((v) => v.active || f.target_variant_ids.includes(v.id))
                    .map((v) => (
                      <label key={v.id} className="check">
                        <input type="checkbox" checked={f.target_variant_ids.includes(v.id)} onChange={() => toggle("target_variant_ids", v.id)} />
                        {v.label || p.name}
                      </label>
                    ))}
                </div>
              )}
            </div>
          ))}
          <p className="help">
            選択中：商品{f.target_product_ids.length}件・組み合わせ{f.target_variant_ids.length}件
          </p>
        </div>
      )}

      <h3>利用方法</h3>
      <div className="form-grid">
        <label>
          <span className="label">人数の扱い</span>
          <select value={f.holder_mode} onChange={(e) => set("holder_mode", e.target.value)}>
            <option value="per_person">一人一枚</option>
            <option value="group">一枚で複数人分</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={f.splittable} onChange={(e) => set("splittable", e.target.checked)} />
          分割利用可（残り人数を次回に使える）
        </label>
        <label className="check">
          <input type="checkbox" checked={f.combinable} onChange={(e) => set("combinable", e.target.checked)} />
          他のクーポンと併用可
        </label>
      </div>
      <span className="help">分割利用不可の場合、一度の会計で使わなかった人数分は持ち越されません（会計前に表示されます）。</span>

      <h3>期間・発行</h3>
      <div className="form-grid">
        <label>
          <span className="label">利用開始（日本時間・任意）</span>
          <input type="datetime-local" value={f.valid_from} onChange={(e) => set("valid_from", e.target.value)} />
        </label>
        <label>
          <span className="label">利用終了（日本時間・任意）</span>
          <input type="datetime-local" value={f.valid_until} onChange={(e) => set("valid_until", e.target.value)} />
        </label>
        <label>
          <span className="label">発行枚数の上限（任意）</span>
          <input type="number" min={1} inputMode="numeric" value={f.max_issues} onChange={(e) => set("max_issues", e.target.value)} />
        </label>
        <label>
          <span className="label">自動発券</span>
          <select value={f.auto_issue} onChange={(e) => set("auto_issue", e.target.value)}>
            {Object.entries(autoLabel).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={f.active} onChange={(e) => set("active", e.target.checked)} />
          有効（無効にすると新たな発券ができません）
        </label>
      </div>
      {f.auto_issue === "screening_attended" && (
        <span className="help">上映が「終了」になったとき、入場記録のあるチケットを対象に自動で発券します（仮案）。</span>
      )}

      {errors.length > 0 && (
        <ul className="help" style={{ color: "var(--danger)" }}>
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>
          閉じる
        </button>
        <ActionButton className="btn btn-primary" disabled={errors.length > 0} onClick={submit}>
          {def ? "保存" : "作成"}
        </ActionButton>
      </div>
    </Modal>
  );
}

function IssueModal({ def, onClose, onIssued }: { def: CouponDef; onClose: () => void; onIssued: (items: IssuedResult[], persons: number) => Promise<void> }) {
  const [persons, setPersons] = useState("1");
  const [count, setCount] = useState("1");
  const [err, setErr] = useState<string | null>(null);
  const p = numOrNull(persons);
  const c = numOrNull(count);
  return (
    <Modal open onClose={onClose} title={`手動発券：${def.name}`}>
      <p className="help">
        {discountText(def)}・{holderLabel[def.holder_mode]}。発行済み {def.issued_count}枚{def.max_issues !== null ? `／上限 ${def.max_issues}枚` : ""}。
      </p>
      {err && (
        <div className="banner banner-danger" role="alert">
          {err}
        </div>
      )}
      <div className="form-grid">
        <label>
          <span className="label">1枚あたりの人数（1〜50）</span>
          <input type="number" min={1} max={50} inputMode="numeric" value={persons} onChange={(e) => setPersons(e.target.value)} />
        </label>
        <label>
          <span className="label">枚数（1〜200）</span>
          <input type="number" min={1} max={200} inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} />
        </label>
      </div>
      <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>
          閉じる
        </button>
        <ActionButton
          className="btn btn-primary"
          disabled={!p || p < 1 || p > 50 || !c || c < 1 || c > 200}
          confirm={`${p}人分のクーポンを${c}枚発券します。よろしいですか？`}
          onClick={async () => {
            setErr(null);
            try {
              const r = await post<{ issued: IssuedResult[] }>(`/admin/coupon-definitions/${def.id}/issue`, { persons: p, count: c });
              await onIssued(r.issued, p ?? 1);
            } catch (e) {
              setErr(e instanceof Error ? e.message : "発券に失敗しました");
            }
          }}
        >
          発券する
        </ActionButton>
      </div>
    </Modal>
  );
}

function IssuedList({ defs, filter, setFilter, run, version }: { defs: CouponDef[]; filter: string; setFilter: (v: string) => void; run: Run; version: number }) {
  const list = useFetch<Issued[]>(`/admin/issued-coupons${filter ? `?definition_id=${filter}` : ""}`);
  const reloadList = list.reload;
  useEffect(() => {
    if (version > 0) void reloadList();
  }, [version, reloadList]);
  const [revoking, setRevoking] = useState<Issued | null>(null);
  const [reason, setReason] = useState("");
  return (
    <section id="issued-coupons">
      <div className="row-between">
        <h2>発券済みクーポン</h2>
        <div className="row">
          <label>
            <span className="label">定義で絞り込み</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">すべて</option>
              {defs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-sm" onClick={() => list.reload()}>
            再読み込み
          </button>
        </div>
      </div>
      <ErrorBox error={list.error} />
      {list.data?.length === 0 && <Empty>発券済みのクーポンはありません</Empty>}
      {list.data && list.data.length > 0 && (
        <div className="table-wrap card">
          <table className="compact">
            <thead>
              <tr>
                <th>番号</th>
                <th>名前</th>
                <th className="num">残り／人数</th>
                <th>状態</th>
                <th>発券元</th>
                <th>有効期間</th>
                <th>発券日時</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id} className={c.status === "active" ? "" : "row-muted"}>
                  <td className="mono">{c.public_no}</td>
                  <td>{c.name}</td>
                  <td className="num">
                    {c.persons_remaining}／{c.persons_total}
                  </td>
                  <td>
                    <Badge tone={issuedTone[c.status] ?? "neutral"}>{issuedStatusLabel[c.status] ?? c.status}</Badge>
                    {c.revoke_reason && <div className="help">理由：{c.revoke_reason}</div>}
                  </td>
                  <td>
                    {c.source_kind === "auto_screening" ? "上映鑑賞（自動）" : "手動"}
                    {c.reservation_no && <div className="help">予約 {c.reservation_no}</div>}
                  </td>
                  <td className="help">
                    {c.valid_from || c.valid_until ? `${fmtDateTime(c.valid_from) || "—"}〜${fmtDateTime(c.valid_until) || "—"}` : "期限なし"}
                  </td>
                  <td className="help">{fmtDateTime(c.created_at)}</td>
                  <td>
                    {c.status === "active" && (
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => {
                          setReason("");
                          setRevoking(c);
                        }}
                      >
                        失効
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.data.length >= 1000 && <p className="help">最新1000件まで表示しています。</p>}
        </div>
      )}
      {revoking && (
        <Modal open onClose={() => setRevoking(null)} title={`クーポン ${revoking.public_no} を失効`}>
          <Notice kind="danger">失効したクーポンは会計で使えなくなります。過去の利用履歴は残ります。</Notice>
          <label className="field">
            <span className="label">理由（必須）</span>
            <textarea maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setRevoking(null)}>
              やめる
            </button>
            <ActionButton
              className="btn btn-danger"
              disabled={!reason.trim()}
              confirm="このクーポンを失効させますか？"
              onClick={async () => {
                const ok = await run(async () => {
                  await post(`/admin/issued-coupons/${revoking.id}/revoke`, { reason: reason.trim() });
                  await list.reload();
                }, "クーポンを失効させました");
                if (ok) setRevoking(null);
              }}
            >
              失効させる
            </ActionButton>
          </div>
        </Modal>
      )}
    </section>
  );
}
