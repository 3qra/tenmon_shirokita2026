"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, errorMessage, get, post } from "@/lib/api";
import { useFetch, useLive } from "@/lib/hooks";
import { mdhm, yen } from "@/lib/format";
import { ActionButton, Badge, Empty, ErrorBox, LiveStatus, Modal, Notice, Toast } from "@/components/ui";
import { hasRole, StaffShell, useStaff } from "@/components/StaffShell";
import { ReasonAction, toIntOr0, useIdempotent } from "../_components/common";
import { accountKindLabel, type CashAccount, type CashAccountsResp } from "../_components/types";

type Transfer = {
  id: string;
  kind: "handover" | "collection";
  medium: "cash" | "voucher";
  amount: number;
  status: "pending" | "confirmed" | "rejected" | "cancelled";
  reason: string;
  created_at: string;
  decided_at: string | null;
  from_account_id: string;
  from_name: string;
  to_account_id: string;
  to_name: string;
  requested_by_name: string;
  decided_by_name: string | null;
  can_confirm: boolean;
  can_cancel: boolean;
};
type Entry = { id: number; medium: string; kind: string; amount: number; reason: string | null; created_at: string; member_name: string; call_number: number | null };
type Recon = { id: string; medium: string; theoretical_balance: number; actual_balance: number; difference: number; note: string; created_at: string; account_name: string; counted_by_name: string; confirmed_by_name: string };

const entryKindLabel: Record<string, string> = {
  opening: "開始釣銭",
  sale: "販売入金",
  refund: "返金",
  transfer_in: "引継ぎ受取",
  transfer_out: "引継ぎ引渡",
  adjustment: "精算差額",
};
const transferStatusLabel: Record<string, string> = { pending: "受取確認待ち", confirmed: "確定", rejected: "差し戻し", cancelled: "取り下げ" };
const mediumLabel: Record<string, string> = { cash: "現金", voucher: "金券" };

export default function CashPage() {
  return (
    <StaffShell roles={["cashier", "treasurer", "admin"]}>
      <Cash />
    </StaffShell>
  );
}

function Cash() {
  const staff = useStaff();
  const isTreasurer = hasRole(staff, "treasurer", "admin");
  const acc = useLive<CashAccountsResp>("/staff/cash/accounts", ["cash"], 20000);
  const pend = useLive<Transfer[]>("/staff/cash/transfers?status=pending", ["cash"], 20000);
  const hist = useLive<Transfer[]>("/staff/cash/transfers", ["cash"], 60000);
  const [entriesOf, setEntriesOf] = useState<CashAccount | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const clearToast = useCallback(() => setToast(null), []);
  const accounts = acc.data?.accounts ?? [];
  const reloadAll = useCallback(() => {
    acc.reload();
    pend.reload();
    hist.reload();
  }, [acc, pend, hist]);

  return (
    <>
      <div className="section-title">
        <h1 style={{ margin: 0 }}>現金</h1>
        <LiveStatus lastOk={acc.lastOk} stale={acc.stale} connected={acc.connected} error={acc.error} />
      </div>
      <Notice kind="info">
        金額は記録上の「理論残高」です。現金の引継ぎ・回収は、送る側が申請し、<strong>受け取る側が「受け取りを確認」したときに確定</strong>します。確認されるまで残高は移りません。
      </Notice>

      <h2>保管先と残高</h2>
      <ErrorBox error={acc.error && !acc.data ? acc.error : null} />
      {acc.data && accounts.length === 0 && <Empty>表示できる保管先がありません</Empty>}
      <div className="grid">
        {accounts.map((a) => (
          <div key={a.id} className="card" style={{ margin: 0 }}>
            <div className="row-between">
              <strong>{a.name}</strong>
              <Badge tone={a.kind === "wallet" && a.member_id === staff.id ? "info" : "neutral"}>
                {a.kind === "wallet" && a.member_id === staff.id ? "自分の財布" : accountKindLabel[a.kind]}
              </Badge>
            </div>
            <div className="big-num">{yen(a.cash_balance)}</div>
            {a.voucher_balance !== 0 && <p>金券 {yen(a.voucher_balance)}</p>}
            {a.pending_transfers > 0 && <Badge tone="warn">⏳ 未確定の移動 {a.pending_transfers}件</Badge>}
            {a.last_reconciliation && (
              <p>
                <small>
                  最終精算 {mdhm(a.last_reconciliation.created_at)}（差額 {a.last_reconciliation.difference >= 0 ? "+" : ""}
                  {yen(a.last_reconciliation.difference)}）
                </small>
              </p>
            )}
            <button className="btn btn-sm" onClick={() => setEntriesOf(a)}>
              明細を見る
            </button>
          </div>
        ))}
      </div>
      {acc.data?.can_view_all && (
        <p>
          全保管先の合計：現金 <strong>{yen(acc.data.total.cash)}</strong>・金券 <strong>{yen(acc.data.total.voucher)}</strong>
        </p>
      )}

      <h2>受取確認・未確定の移動</h2>
      <ErrorBox error={pend.error && !pend.data ? pend.error : null} />
      {pend.data && pend.data.length === 0 && <Empty>未確定の移動はありません</Empty>}
      {pend.data?.map((t) => (
        <TransferCard key={t.id} t={t} onDone={(m) => { setToast(m); reloadAll(); }} />
      ))}

      <TransferForm accounts={accounts} isTreasurer={isTreasurer} onDone={() => { setToast("申請しました。受取側の確認で確定します"); reloadAll(); }} />

      {isTreasurer && <TreasurerTools accounts={accounts} onDone={(m) => { setToast(m); reloadAll(); }} />}

      <h2>移動の履歴</h2>
      {hist.data && hist.data.filter((t) => t.status !== "pending").length === 0 && <Empty>履歴はありません</Empty>}
      {hist.data && hist.data.some((t) => t.status !== "pending") && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>日時</th>
                <th>移動</th>
                <th className="num">金額</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {hist.data
                .filter((t) => t.status !== "pending")
                .slice(0, 50)
                .map((t) => (
                  <tr key={t.id}>
                    <td>{mdhm(t.created_at)}</td>
                    <td>
                      {t.from_name} → {t.to_name}
                      <br />
                      <small>
                        申請 {t.requested_by_name}
                        {t.decided_by_name && `・処理 ${t.decided_by_name}`}
                        {t.reason && `・${t.reason}`}
                      </small>
                    </td>
                    <td className="num">
                      {yen(t.amount)}
                      {t.medium === "voucher" && <small>（金券）</small>}
                    </td>
                    <td>
                      <Badge tone={t.status === "confirmed" ? "ok" : "neutral"}>{transferStatusLabel[t.status]}</Badge>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={!!entriesOf} onClose={() => setEntriesOf(null)} title={entriesOf ? `${entriesOf.name}の明細` : "明細"}>
        {entriesOf && <Entries account={entriesOf} />}
      </Modal>
      <Toast message={toast} onDone={clearToast} />
    </>
  );
}

function TransferCard({ t, onDone }: { t: Transfer; onDone: (m: string) => void }) {
  const [err, setErr] = useState<string | null>(null);
  const decide = async (action: string, reason = "") => {
    setErr(null);
    await post(`/staff/cash/transfers/${t.id}/decide`, { action, reason });
  };
  return (
    <div className="card">
      <div className="row-between">
        <strong>
          {t.from_name} → {t.to_name}
        </strong>
        <Badge tone="warn">⏳ {transferStatusLabel[t.status]}</Badge>
      </div>
      <div className="big-num">
        {yen(t.amount)}
        {t.medium === "voucher" && <small>（金券）</small>}
      </div>
      <p>
        <small>
          {t.kind === "collection" ? "回収" : "引継ぎ"}・申請 {t.requested_by_name}・{mdhm(t.created_at)}
          {t.reason && `・${t.reason}`}
        </small>
      </p>
      <ErrorBox error={err} />
      <div className="actions">
        {t.can_confirm && (
          <ActionButton
            className="btn btn-ok btn-lg"
            confirm={`${t.from_name}から${t.amount.toLocaleString("ja-JP")}円（${mediumLabel[t.medium]}）を実際に受け取り、数えましたか？`}
            onClick={async () => {
              try {
                await decide("confirm");
                onDone("受け取りを確認しました（移動が確定しました）");
              } catch (e) {
                setErr(errorMessage(e));
              }
            }}
          >
            ✓ 受け取りを確認
          </ActionButton>
        )}
        {t.can_confirm && (
          <ReasonAction
            label="差し戻す"
            className="btn"
            submitClassName="btn btn-danger"
            placeholder="例：金額が合わない"
            onSubmit={async (reason) => {
              await decide("reject", reason);
              onDone("差し戻しました");
            }}
          />
        )}
        {t.can_cancel && (
          <ActionButton
            className="btn"
            confirm="この申請を取り下げますか？"
            onClick={async () => {
              try {
                await decide("cancel");
                onDone("申請を取り下げました");
              } catch (e) {
                setErr(errorMessage(e));
              }
            }}
          >
            取り下げ
          </ActionButton>
        )}
        {!t.can_confirm && !t.can_cancel && <p className="muted">受取側の確認待ちです。</p>}
      </div>
    </div>
  );
}

function TransferForm({ accounts, isTreasurer, onDone }: { accounts: CashAccount[]; isTreasurer: boolean; onDone: () => void }) {
  const staff = useStaff();
  const send = useIdempotent();
  const fromOptions = useMemo(
    () => accounts.filter((a) => isTreasurer || a.kind === "register" || (a.kind === "wallet" && a.member_id === staff.id)),
    [accounts, isTreasurer, staff.id],
  );
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [medium, setMedium] = useState<"cash" | "voucher">("cash");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!from && fromOptions.length) {
      const mine = fromOptions.find((a) => a.kind === "wallet" && a.member_id === staff.id);
      setFrom((mine ?? fromOptions[0]).id);
    }
  }, [fromOptions, from, staff.id]);

  // 送り先候補はAPIの一覧（全員の財布・金庫・共用レジ。残高は含まない）
  const [destinations, setDestinations] = useState<{ id: string; name: string; kind: string; member_name?: string | null }[]>([]);
  useEffect(() => {
    get<typeof destinations>("/staff/cash/destinations").then(setDestinations).catch(() => setDestinations([]));
  }, []);
  const toOptions = (destinations.length ? destinations : accounts).filter((a) => a.id !== from);
  const fromAcc = accounts.find((a) => a.id === from);
  const amt = toIntOr0(amount);
  const available = fromAcc ? (medium === "cash" ? fromAcc.cash_balance : fromAcc.voucher_balance) : 0;

  return (
    <section className="card">
      <h2 style={{ marginTop: 0 }}>引継ぎ・回収を申請</h2>
      <label className="field">
        <span className="label">移動元</span>
        <select value={from} onChange={(e) => setFrom(e.target.value)}>
          {fromOptions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}（現金 {yen(a.cash_balance)}）
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="label">移動先（受け取る人・場所）</span>
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">選んでください</option>
          {toOptions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}（{accountKindLabel[a.kind as keyof typeof accountKindLabel] ?? a.kind}）
            </option>
          ))}
        </select>
      </label>
      <p className="muted">申請後、受け取る側が確認した時点で移動が確定します。</p>
      <div className="row">
        <label className="grow">
          <span className="label">種類</span>
          <select value={medium} onChange={(e) => setMedium(e.target.value as "cash" | "voucher")}>
            <option value="cash">現金</option>
            <option value="voucher">金券</option>
          </select>
        </label>
        <label className="grow">
          <span className="label">金額（円）</span>
          <input className="amount-input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))} placeholder="0" />
        </label>
      </div>
      {fromAcc && (
        <p className="muted">
          移動元の理論残高：{yen(available)}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAmount(String(Math.max(0, available)))}>
            全額
          </button>
        </p>
      )}
      <label className="field">
        <span className="label">メモ（任意）</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="例：シフト交代のため" />
      </label>
      <ErrorBox error={err} />
      <ActionButton
        className="btn btn-primary btn-lg btn-block"
        disabled={!from || !to || amt <= 0}
        onClick={async () => {
          setErr(null);
          try {
            await send("POST", "/staff/cash/transfers", { from_account_id: from, to_account_id: to, amount: amt, medium, reason: reason.trim() });
            setAmount("");
            setReason("");
            setTo("");
            onDone();
          } catch (e) {
            setErr(e instanceof ApiError && e.code === "network" ? "通信できませんでした。もう一度押してください（同じ申請として扱われます）" : errorMessage(e));
          }
        }}
      >
        申請する（{yen(amt)}）
      </ActionButton>
    </section>
  );
}

function Entries({ account }: { account: CashAccount }) {
  const { data, error } = useFetch<Entry[]>(`/staff/cash/accounts/${account.id}/entries`);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="empty">読み込み中…</p>;
  if (!data.length) return <Empty>明細はありません</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>日時</th>
            <th>内容</th>
            <th className="num">金額</th>
          </tr>
        </thead>
        <tbody>
          {data.map((e) => (
            <tr key={e.id}>
              <td>{mdhm(e.created_at)}</td>
              <td>
                {entryKindLabel[e.kind] ?? e.kind}
                {e.medium === "voucher" && "（金券）"}
                {e.call_number != null && ` #${e.call_number}`}
                <br />
                <small>
                  {e.member_name}
                  {e.reason && `・${e.reason}`}
                </small>
              </td>
              <td className="num">
                {e.amount > 0 ? "+" : ""}
                {yen(e.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TreasurerTools({ accounts, onDone }: { accounts: CashAccount[]; onDone: (m: string) => void }) {
  const send = useIdempotent();
  const recons = useLive<Recon[]>("/treasurer/cash/reconciliations", ["cash"], 60000);
  const { data: members } = useFetch<{ id: string; name: string }[]>("/staff/members/directory");

  // 開始釣銭
  const [oAcc, setOAcc] = useState("");
  const [oAmt, setOAmt] = useState("");
  const [oMedium, setOMedium] = useState<"cash" | "voucher">("cash");
  const [oReason, setOReason] = useState("開始釣銭");
  const [oErr, setOErr] = useState<string | null>(null);

  // 精算
  const [rAcc, setRAcc] = useState("");
  const [rMedium, setRMedium] = useState<"cash" | "voucher">("cash");
  const [rActual, setRActual] = useState("");
  const [rNote, setRNote] = useState("");
  const [rCounted, setRCounted] = useState("");
  const [rErr, setRErr] = useState<string | null>(null);
  const [rRes, setRRes] = useState<{ theoretical_balance: number; actual_balance: number; difference: number } | null>(null);

  const rAccount = accounts.find((a) => a.id === rAcc);
  const theo = rAccount ? (rMedium === "cash" ? rAccount.cash_balance : rAccount.voucher_balance) : null;
  const diffPreview = theo !== null && rActual !== "" ? toIntOr0(rActual) - theo : null;

  return (
    <>
      <section className="card">
        <h2 style={{ marginTop: 0 }}>開始釣銭の登録（会計責任者）</h2>
        <label className="field">
          <span className="label">保管先</span>
          <select value={oAcc} onChange={(e) => setOAcc(e.target.value)}>
            <option value="">選んでください</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <label className="grow">
            <span className="label">種類</span>
            <select value={oMedium} onChange={(e) => setOMedium(e.target.value as "cash" | "voucher")}>
              <option value="cash">現金</option>
              <option value="voucher">金券</option>
            </select>
          </label>
          <label className="grow">
            <span className="label">金額（円）</span>
            <input className="amount-input" inputMode="numeric" value={oAmt} onChange={(e) => setOAmt(e.target.value.replace(/[^\d]/g, ""))} placeholder="0" />
          </label>
        </div>
        <label className="field">
          <span className="label">メモ</span>
          <input value={oReason} onChange={(e) => setOReason(e.target.value)} maxLength={200} />
        </label>
        <ErrorBox error={oErr} />
        <ActionButton
          className="btn btn-primary btn-block"
          disabled={!oAcc || toIntOr0(oAmt) <= 0}
          confirm={`${toIntOr0(oAmt).toLocaleString("ja-JP")}円を開始釣銭として登録しますか？`}
          onClick={async () => {
            setOErr(null);
            try {
              await send("POST", "/treasurer/cash/opening", { cash_account_id: oAcc, amount: toIntOr0(oAmt), medium: oMedium, reason: oReason.trim() });
              setOAmt("");
              onDone("開始釣銭を登録しました");
            } catch (e) {
              setOErr(errorMessage(e));
            }
          }}
        >
          開始釣銭を登録
        </ActionButton>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>締め精算（会計責任者）</h2>
        <p className="muted">実際に数えた金額を入力すると、理論残高との差額を記録します。未確定の移動がある保管先は精算できません。</p>
        <label className="field">
          <span className="label">保管先</span>
          <select
            value={rAcc}
            onChange={(e) => {
              setRAcc(e.target.value);
              setRRes(null);
            }}
          >
            <option value="">選んでください</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.pending_transfers > 0 ? "（未確定の移動あり）" : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <label className="grow">
            <span className="label">種類</span>
            <select value={rMedium} onChange={(e) => setRMedium(e.target.value as "cash" | "voucher")}>
              <option value="cash">現金</option>
              <option value="voucher">金券</option>
            </select>
          </label>
          <label className="grow">
            <span className="label">実際の金額（円）</span>
            <input className="amount-input" inputMode="numeric" value={rActual} onChange={(e) => setRActual(e.target.value.replace(/[^\d]/g, ""))} placeholder="0" />
          </label>
        </div>
        {theo !== null && (
          <dl className="kv">
            <dt>理論残高（現在）</dt>
            <dd className="num">{yen(theo)}</dd>
            {diffPreview !== null && (
              <>
                <dt>差額（目安）</dt>
                <dd className="num">
                  {diffPreview === 0 ? "±0円（一致）" : `${diffPreview > 0 ? "+" : "−"}${yen(Math.abs(diffPreview))}（${diffPreview > 0 ? "多い" : "不足"}）`}
                </dd>
              </>
            )}
          </dl>
        )}
        <label className="field">
          <span className="label">数えた人</span>
          <select value={rCounted} onChange={(e) => setRCounted(e.target.value)}>
            <option value="">自分</option>
            {members?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">メモ{diffPreview ? "（差額があるため必須）" : "（任意）"}</span>
          <input value={rNote} onChange={(e) => setRNote(e.target.value)} maxLength={200} />
        </label>
        <ErrorBox error={rErr} />
        <ActionButton
          className="btn btn-primary btn-block"
          disabled={!rAcc || rActual === "" || (!!diffPreview && !rNote.trim())}
          confirm="この内容で精算を記録しますか？"
          onClick={async () => {
            setRErr(null);
            const body: Record<string, unknown> = { cash_account_id: rAcc, medium: rMedium, actual_balance: toIntOr0(rActual), note: rNote.trim() };
            if (rCounted) body.counted_by = rCounted;
            try {
              const r = await send<{ theoretical_balance: number; actual_balance: number; difference: number }>("POST", "/treasurer/cash/reconciliations", body);
              setRRes(r);
              setRActual("");
              setRNote("");
              recons.reload();
              onDone("精算を記録しました");
            } catch (e) {
              setRErr(errorMessage(e));
            }
          }}
        >
          精算を記録
        </ActionButton>
        {rRes && (
          <div className={`result ${rRes.difference === 0 ? "result-ok" : "result-warn"}`}>
            <h2>{rRes.difference === 0 ? "✓ 一致しました" : "⚠ 差額があります"}</h2>
            <p>
              理論残高 {yen(rRes.theoretical_balance)} ／ 実残高 {yen(rRes.actual_balance)}
            </p>
            <p className="big-num">
              差額 {rRes.difference > 0 ? "+" : rRes.difference < 0 ? "−" : "±"}
              {yen(Math.abs(rRes.difference))}
            </p>
          </div>
        )}
      </section>

      <h2>精算の履歴</h2>
      <ErrorBox error={recons.error} />
      {recons.data && recons.data.length === 0 && <Empty>精算の記録はありません</Empty>}
      {recons.data && recons.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>日時</th>
                <th>保管先</th>
                <th className="num">理論</th>
                <th className="num">実際</th>
                <th className="num">差額</th>
                <th>確認</th>
              </tr>
            </thead>
            <tbody>
              {recons.data.map((r) => (
                <tr key={r.id}>
                  <td>{mdhm(r.created_at)}</td>
                  <td>
                    {r.account_name}
                    {r.medium === "voucher" && "（金券）"}
                    {r.note && (
                      <>
                        <br />
                        <small>{r.note}</small>
                      </>
                    )}
                  </td>
                  <td className="num">{yen(r.theoretical_balance)}</td>
                  <td className="num">{yen(r.actual_balance)}</td>
                  <td className="num">
                    {r.difference > 0 ? "+" : ""}
                    {yen(r.difference)}
                  </td>
                  <td>
                    <small>
                      数えた人 {r.counted_by_name}
                      <br />
                      確認 {r.confirmed_by_name}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
