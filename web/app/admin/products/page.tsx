"use client";

import { useEffect, useState } from "react";
import { patch, post } from "@/lib/api";
import { useLive } from "@/lib/hooks";
import { yen } from "@/lib/format";
import { ActionButton, Badge, Empty, ErrorBox, LiveStatus, Notice } from "@/components/ui";
import { AdminPage, Department, kindLabel, numOrNull, useActions } from "../_components/admin";

type Run = ReturnType<typeof useActions>["run"];

type OptionValue = { id: string; name: string; sort_order: number; active: boolean };
type OptionGroup = { id: string; name: string; sort_order: number; active: boolean; values: OptionValue[] };
type Variant = {
  id: string;
  price: number;
  visibility: string;
  sale_status: string;
  active: boolean;
  sort_order: number;
  option_value_ids: string[];
  label: string;
};
type Product = {
  id: string;
  department_id: string;
  name: string;
  description: string;
  needs_cooking: boolean;
  visibility: string;
  active: boolean;
  sort_order: number;
  option_groups: OptionGroup[];
  variants: Variant[];
};
type Catalog = { department: Department; products: Product[] };

const saleLabel: Record<string, string> = { on_sale: "販売中", sold_out: "売り切れ", stopped: "販売停止" };
const visLabel: Record<string, string> = { public: "公開", hidden: "非表示" };

/** 「しょうゆ、しお」「中,大」などを配列に */
const splitValues = (s: string) =>
  s
    .split(/[、,，\n]/)
    .map((v) => v.trim())
    .filter(Boolean);

export default function ProductsPage() {
  const { run, ui } = useActions();
  const depts = useLive<Department[]>("/staff/departments", ["departments"]);
  const [deptId, setDeptId] = useState("");
  useEffect(() => {
    if (!deptId && depts.data?.length) setDeptId(depts.data[0].id);
  }, [depts.data, deptId]);
  const cat = useLive<Catalog>(deptId ? `/staff/departments/${deptId}/products` : null, ["products"]);
  const dept = depts.data?.find((d) => d.id === deptId);
  const [showInactive, setShowInactive] = useState(false);

  return (
    <AdminPage title="商品・価格">
      <Notice kind="warn">
        <strong>⚠ 初期データの価格はダミー価格です。</strong>
        しょうゆ・しお（中400円／大500円）などの初期価格は正式価格ではありません。公開・営業開始前に必ず正式価格を確認し、各組み合わせの価格を設定してください。
      </Notice>
      <p className="help">
        履歴に残る商品・選択肢は削除せず「無効化」します。価格の変更は今後の注文にのみ反映され、過去の注文の販売価格は変わりません。
      </p>

      <div className="tabs" role="tablist" aria-label="部門">
        {depts.data?.map((d) => (
          <button key={d.id} role="tab" aria-selected={d.id === deptId} onClick={() => setDeptId(d.id)}>
            {d.name}
          </button>
        ))}
      </div>
      <ErrorBox error={depts.error} />
      {deptId && <LiveStatus lastOk={cat.lastOk} stale={cat.stale} connected={cat.connected} error={cat.error} />}
      <ErrorBox error={cat.error} />

      <label className="check">
        <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
        無効化した商品・組み合わせも表示する
      </label>

      {cat.data && cat.data.products.filter((p) => showInactive || p.active).length === 0 && <Empty>この部門の商品はまだありません</Empty>}
      {cat.data?.products
        .filter((p) => showInactive || p.active)
        .map((p) => (
          <ProductCard key={p.id} p={p} run={run} reload={cat.reload} showInactive={showInactive} />
        ))}

      {dept && <CreateProduct dept={dept} run={run} reload={cat.reload} />}
      {ui}
    </AdminPage>
  );
}

function ProductCard({ p, run, reload, showInactive }: { p: Product; run: Run; reload: () => Promise<void>; showInactive: boolean }) {
  const [name, setName] = useState(p.name);
  const [desc, setDesc] = useState(p.description);
  useEffect(() => setName(p.name), [p.name]);
  useEffect(() => setDesc(p.description), [p.description]);

  const savePatch = (body: Record<string, unknown>, ok: string) =>
    run(async () => {
      await patch(`/admin/products/${p.id}`, body);
      await reload();
    }, ok);

  // 無効な選択肢を含む組み合わせは来場者に表示されない
  const inactiveValueIds = new Set<string>();
  for (const g of p.option_groups) for (const v of g.values) if (!g.active || !v.active) inactiveValueIds.add(v.id);
  const variants = p.variants.filter((v) => showInactive || v.active);
  const hiddenCount = p.variants.length - variants.length;

  return (
    <section className="card" style={p.active ? undefined : { opacity: 0.75, borderStyle: "dashed" }}>
      <div className="row-between">
        <h2 style={{ margin: 0 }}>{p.name}</h2>
        <div className="chips">
          {!p.active && <Badge tone="danger">無効</Badge>}
          <Badge tone={p.visibility === "public" ? "ok" : "neutral"}>{visLabel[p.visibility] ?? p.visibility}</Badge>
          <Badge tone="info">{p.needs_cooking ? "調理あり" : "調理不要"}</Badge>
        </div>
      </div>

      <details style={{ marginTop: 8 }}>
        <summary>商品情報を編集</summary>
        <div className="form-grid" style={{ marginTop: 8 }}>
          <label>
            <span className="label">商品名</span>
            <input value={name} maxLength={50} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="span-2">
            <span className="label">説明</span>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} />
          </label>
          <div>
            <ActionButton
              className="btn btn-primary"
              disabled={!name.trim() || (name === p.name && desc === p.description)}
              onClick={() => savePatch({ name: name.trim(), description: desc }, "商品情報を保存しました")}
            >
              保存
            </ActionButton>
          </div>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <ActionButton className="btn btn-sm" onClick={() => savePatch({ needs_cooking: !p.needs_cooking }, "調理の要否を変更しました")}>
            {p.needs_cooking ? "調理不要に変更" : "調理ありに変更"}
          </ActionButton>
          <ActionButton
            className="btn btn-sm"
            onClick={() => savePatch({ visibility: p.visibility === "public" ? "hidden" : "public" }, "公開状態を変更しました")}
          >
            {p.visibility === "public" ? "非表示にする" : "公開する"}
          </ActionButton>
          <ActionButton
            className={p.active ? "btn btn-sm btn-danger" : "btn btn-sm btn-ok"}
            confirm={p.active ? `「${p.name}」を無効化します。新しい注文で選べなくなります（過去の注文履歴は残ります）。よろしいですか？` : undefined}
            onClick={() => savePatch({ active: !p.active }, p.active ? "商品を無効化しました" : "商品を有効にしました")}
          >
            {p.active ? "商品を無効化" : "商品を有効に戻す"}
          </ActionButton>
        </div>
        <span className="help">調理不要の商品はキッチン画面に表示されず、そのまま受け渡せます（物販など）。</span>
      </details>

      <h3>選択肢（味・サイズなど）</h3>
      {p.option_groups.length === 0 && <p className="muted">選択肢はありません（単一の価格で販売）</p>}
      {p.option_groups.map((g) => (
        <GroupEditor key={g.id} g={g} run={run} reload={reload} />
      ))}
      <AddGroup productId={p.id} run={run} reload={reload} />

      <h3>組み合わせごとの価格・販売状態</h3>
      <div className="table-wrap">
        <table className="compact">
          <thead>
            <tr>
              <th>組み合わせ</th>
              <th className="num">価格（円）</th>
              <th>販売状態</th>
              <th>公開</th>
              <th>有効</th>
            </tr>
          </thead>
          <tbody>
            {variants.map((v) => (
              <VariantRow key={v.id} v={v} run={run} reload={reload} hasInactiveOption={v.option_value_ids.some((id) => inactiveValueIds.has(id))} />
            ))}
          </tbody>
        </table>
      </div>
      {variants.length === 0 && <Empty>組み合わせがありません</Empty>}
      {hiddenCount > 0 && <p className="help">無効な組み合わせが{hiddenCount}件あります（「無効化した…も表示する」で確認できます）。</p>}
    </section>
  );
}

function VariantRow({ v, run, reload, hasInactiveOption }: { v: Variant; run: Run; reload: () => Promise<void>; hasInactiveOption: boolean }) {
  const [price, setPrice] = useState(String(v.price));
  useEffect(() => setPrice(String(v.price)), [v.price]);
  const save = (body: Record<string, unknown>, ok: string) =>
    run(async () => {
      await patch(`/staff/variants/${v.id}`, body);
      await reload();
    }, ok);
  const priceNum = numOrNull(price);
  const label = v.label || "（選択肢なし）";
  return (
    <tr className={v.active ? "" : "row-muted"}>
      <td>
        {label}
        {hasInactiveOption && (
          <div>
            <Badge tone="warn">無効な選択肢を含む・来場者に非表示</Badge>
          </div>
        )}
      </td>
      <td className="num">
        <div className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
          <input
            type="number"
            min={0}
            inputMode="numeric"
            className="inline-input"
            aria-label={`${label}の価格`}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          <ActionButton
            className="btn btn-sm btn-primary"
            disabled={priceNum === null || priceNum < 0 || priceNum === v.price}
            confirm={`「${label}」の価格を ${yen(v.price)} → ${yen(priceNum ?? 0)} に変更します。今後の注文から適用されます。よろしいですか？`}
            onClick={() => save({ price: priceNum }, "価格を変更しました")}
          >
            保存
          </ActionButton>
        </div>
      </td>
      <td>
        <select
          className="inline-input"
          aria-label={`${label}の販売状態`}
          value={v.sale_status}
          onChange={(e) => save({ sale_status: e.target.value }, `${saleLabel[e.target.value]}にしました`)}
        >
          {Object.entries(saleLabel).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </td>
      <td>
        <select
          className="inline-input"
          aria-label={`${label}の公開状態`}
          value={v.visibility}
          onChange={(e) => save({ visibility: e.target.value }, `${visLabel[e.target.value]}にしました`)}
        >
          <option value="public">公開</option>
          <option value="hidden">非表示</option>
        </select>
      </td>
      <td>
        <ActionButton
          className="btn btn-sm"
          confirm={v.active ? `「${label}」を無効化します。よろしいですか？` : undefined}
          onClick={() => save({ active: !v.active }, v.active ? "無効化しました" : "有効にしました")}
        >
          {v.active ? "✓ 有効（無効化）" : "無効（有効にする）"}
        </ActionButton>
      </td>
    </tr>
  );
}

function GroupEditor({ g, run, reload }: { g: OptionGroup; run: Run; reload: () => Promise<void> }) {
  const [name, setName] = useState(g.name);
  const [newVal, setNewVal] = useState("");
  const [newPrice, setNewPrice] = useState("");
  useEffect(() => setName(g.name), [g.name]);
  const priceNum = numOrNull(newPrice);
  return (
    <div className="card" style={{ margin: "8px 0", background: "var(--surface-2)" }}>
      <div className="row">
        <label className="grow" style={{ maxWidth: 260 }}>
          <span className="label">選択肢の種類{!g.active && "（無効）"}</span>
          <input className="inline-input" value={name} maxLength={30} onChange={(e) => setName(e.target.value)} />
        </label>
        <ActionButton
          className="btn btn-sm"
          disabled={!name.trim() || name === g.name}
          onClick={() =>
            run(async () => {
              await patch(`/admin/option-groups/${g.id}`, { name: name.trim() });
              await reload();
            }, "名称を変更しました")
          }
        >
          名称を保存
        </ActionButton>
        <ActionButton
          className="btn btn-sm"
          confirm={
            g.active
              ? `選択肢の種類「${g.name}」を無効化します。これを含む組み合わせはすべて来場者に表示されなくなります。よろしいですか？`
              : undefined
          }
          onClick={() =>
            run(async () => {
              await patch(`/admin/option-groups/${g.id}`, { active: !g.active });
              await reload();
            }, g.active ? "無効化しました" : "有効にしました")
          }
        >
          {g.active ? "種類を無効化" : "種類を有効に戻す"}
        </ActionButton>
      </div>
      <ul style={{ margin: "8px 0", paddingLeft: 0, listStyle: "none" }}>
        {g.values.map((v) => (
          <ValueEditor key={v.id} v={v} run={run} reload={reload} />
        ))}
      </ul>
      <div className="row">
        <label>
          <span className="label">選択肢を追加</span>
          <input className="inline-input" value={newVal} maxLength={30} onChange={(e) => setNewVal(e.target.value)} placeholder="例：カレー" />
        </label>
        <label>
          <span className="label">新しい組み合わせの初期価格（円）</span>
          <input type="number" min={0} inputMode="numeric" className="inline-input" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} />
        </label>
        <ActionButton
          className="btn btn-sm btn-primary"
          disabled={!newVal.trim() || priceNum === null || priceNum < 0}
          onClick={() =>
            run(async () => {
              await post(`/admin/option-groups/${g.id}/values`, { name: newVal.trim(), default_price: priceNum });
              setNewVal("");
              setNewPrice("");
              await reload();
            }, "選択肢を追加しました（新しい組み合わせを作成）")
          }
        >
          追加
        </ActionButton>
      </div>
      <span className="help">追加すると、他の選択肢との新しい組み合わせが初期価格で作成されます。作成後に個別の価格を確認してください。</span>
    </div>
  );
}

function ValueEditor({ v, run, reload }: { v: OptionValue; run: Run; reload: () => Promise<void> }) {
  const [name, setName] = useState(v.name);
  useEffect(() => setName(v.name), [v.name]);
  return (
    <li className="row" style={{ margin: "4px 0", alignItems: "center" }}>
      <input
        className="inline-input"
        style={{ maxWidth: 200 }}
        aria-label="選択肢の名前"
        value={name}
        maxLength={30}
        onChange={(e) => setName(e.target.value)}
      />
      {!v.active && <Badge tone="danger">無効</Badge>}
      <ActionButton
        className="btn btn-sm"
        disabled={!name.trim() || name === v.name}
        onClick={() =>
          run(async () => {
            await patch(`/admin/option-values/${v.id}`, { name: name.trim() });
            await reload();
          }, "名称を変更しました")
        }
      >
        名称を保存
      </ActionButton>
      <ActionButton
        className="btn btn-sm btn-ghost"
        confirm={v.active ? `「${v.name}」を無効化します。これを含む組み合わせは来場者に表示されなくなります。よろしいですか？` : undefined}
        onClick={() =>
          run(async () => {
            await patch(`/admin/option-values/${v.id}`, { active: !v.active });
            await reload();
          }, v.active ? "無効化しました" : "有効にしました")
        }
      >
        {v.active ? "無効化" : "有効に戻す"}
      </ActionButton>
    </li>
  );
}

function AddGroup({ productId, run, reload }: { productId: string; run: Run; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [values, setValues] = useState("");
  const [price, setPrice] = useState("");
  const priceNum = numOrNull(price);
  const vals = splitValues(values);
  if (!open)
    return (
      <button className="btn btn-sm" onClick={() => setOpen(true)}>
        ＋ 選択肢の種類を追加
      </button>
    );
  return (
    <div className="card" style={{ borderColor: "var(--warn)" }}>
      <Notice kind="warn">
        ⚠ 選択肢の種類を追加すると、<strong>既存の組み合わせはすべて無効化され、新しい組み合わせが初期価格で作り直されます。</strong>
        設定済みの価格・販売状態は引き継がれないため、追加後に全組み合わせの価格を確認してください。
      </Notice>
      <div className="form-grid">
        <label>
          <span className="label">種類の名前</span>
          <input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} placeholder="例：トッピング" />
        </label>
        <label className="span-2">
          <span className="label">選択肢（「、」または「,」区切り）</span>
          <input value={values} onChange={(e) => setValues(e.target.value)} placeholder="例：なし、たまご" />
        </label>
        <label>
          <span className="label">組み合わせの初期価格（円）</span>
          <input type="number" min={0} inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>
          やめる
        </button>
        <ActionButton
          className="btn btn-primary"
          disabled={!name.trim() || vals.length === 0 || priceNum === null || priceNum < 0}
          confirm="既存の組み合わせをすべて無効化し、新しい組み合わせを作り直します。よろしいですか？"
          onClick={() =>
            run(async () => {
              await post(`/admin/products/${productId}/option-groups`, { name: name.trim(), values: vals, default_price: priceNum });
              setName("");
              setValues("");
              setPrice("");
              setOpen(false);
              await reload();
            }, "選択肢の種類を追加しました。価格を確認してください")
          }
        >
          追加して組み合わせを作り直す
        </ActionButton>
      </div>
    </div>
  );
}

function CreateProduct({ dept, run, reload }: { dept: Department; run: Run; reload: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [needsCooking, setNeedsCooking] = useState(dept.kind === "food");
  const [visibility, setVisibility] = useState("hidden");
  const [price, setPrice] = useState("");
  const [groups, setGroups] = useState<{ name: string; values: string }[]>([]);
  useEffect(() => setNeedsCooking(dept.kind === "food"), [dept.kind]);
  const priceNum = numOrNull(price);
  const parsed = groups.map((g) => ({ name: g.name.trim(), values: splitValues(g.values) }));
  const combos = parsed.reduce((n, g) => n * Math.max(g.values.length, 0), 1);
  const groupsOk = parsed.every((g) => g.name && g.values.length > 0);

  return (
    <section className="card">
      <h2 style={{ marginTop: 0 }}>商品を追加（{dept.name}）</h2>
      <div className="form-grid">
        <label>
          <span className="label">商品名</span>
          <input value={name} maxLength={50} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="span-2">
          <span className="label">説明（任意）</span>
          <input value={desc} onChange={(e) => setDesc(e.target.value)} />
        </label>
        <label>
          <span className="label">初期価格（円・全組み合わせ共通）</span>
          <input type="number" min={0} inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label>
          <span className="label">公開状態</span>
          <select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
            <option value="hidden">非表示（価格確認後に公開）</option>
            <option value="public">公開</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={needsCooking} onChange={(e) => setNeedsCooking(e.target.checked)} />
          調理が必要（キッチンに表示）
        </label>
      </div>
      <h3>選択肢</h3>
      {groups.map((g, i) => (
        <div key={i} className="row" style={{ marginBottom: 6 }}>
          <label>
            <span className="label">種類</span>
            <input
              className="inline-input"
              value={g.name}
              maxLength={30}
              placeholder="例：味"
              onChange={(e) => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
            />
          </label>
          <label className="grow">
            <span className="label">選択肢（「、」区切り）</span>
            <input
              className="inline-input"
              value={g.values}
              placeholder="例：しょうゆ、しお"
              onChange={(e) => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, values: e.target.value } : x)))}
            />
          </label>
          <button className="btn btn-sm btn-ghost" onClick={() => setGroups((gs) => gs.filter((_, j) => j !== i))}>
            削除
          </button>
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => setGroups((gs) => [...gs, { name: "", values: "" }])}>
        ＋ 選択肢の種類（味・サイズなど）
      </button>
      <p className="help">
        {kindLabel[dept.kind]}の部門に追加します。作成される組み合わせ：{groupsOk ? combos : "—"}通り（すべて初期価格。作成後に個別に変更できます）。
      </p>
      <ActionButton
        className="btn btn-primary"
        disabled={!name.trim() || priceNum === null || priceNum < 0 || !groupsOk}
        onClick={() =>
          run(async () => {
            await post("/admin/products", {
              department_id: dept.id,
              name: name.trim(),
              description: desc,
              needs_cooking: needsCooking,
              visibility,
              option_groups: parsed,
              default_price: priceNum,
            });
            setName("");
            setDesc("");
            setPrice("");
            setGroups([]);
            await reload();
          }, "商品を追加しました")
        }
      >
        商品を追加
      </ActionButton>
    </section>
  );
}
