"use client";

import { useState } from "react";
import { errorMessage, get, post } from "@/lib/api";
import { useLive } from "@/lib/hooks";
import { cookLabel, mdhm, orderStatusLabel, payLabel, yen } from "@/lib/format";
import { ActionButton, Badge, ErrorBox, Notice } from "@/components/ui";
import { hasRole, useStaff } from "@/components/StaffShell";
import { PaymentPanel } from "./PaymentPanel";
import { ReasonAction, toIntOr0, useIdempotent } from "./common";
import { channelLabel, eventKindLabel, type CashAccountsResp, type OrderDetail } from "./types";

export function payTone(p: string): "ok" | "warn" | "danger" | "info" {
  if (p === "paid") return "ok";
  if (p === "unpaid") return "warn";
  return "info";
}

export function OrderBadges({ o }: { o: { status: string; payment_status: string; handoff_status: string; ready: boolean } }) {
  return (
    <>
      {o.status === "cancelled" && <Badge tone="danger">✕ 取消</Badge>}
      <Badge tone={payTone(o.payment_status)}>
        {o.payment_status === "paid" ? "✓ " : o.payment_status === "unpaid" ? "¥ " : ""}
        {payLabel[o.payment_status] ?? o.payment_status}
      </Badge>
      {o.handoff_status === "handed" ? (
        <Badge tone="neutral">受渡済</Badge>
      ) : o.status !== "cancelled" && o.ready ? (
        <Badge tone="ok">● 受渡可</Badge>
      ) : null}
    </>
  );
}

/** 注文詳細と操作（会計・受渡・取消・返金・ブロック） */
export function OrderDetailView({ orderId, onToast }: { orderId: string; onToast?: (m: string) => void }) {
  const staff = useStaff();
  const { data: o, error, reload, setData } = useLive<OrderDetail>(`/staff/orders/${orderId}`, ["orders"], 15000);
  const [paying, setPaying] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);
  const isTreasurer = hasRole(staff, "treasurer", "admin");
  const isAdmin = hasRole(staff, "admin");
  const toast = (m: string) => onToast?.(m);

  if (!o) return error ? <ErrorBox error={error} /> : <p className="empty">読み込み中…</p>;

  const accepted = o.status === "accepted";
  const unpaid = o.payment_status === "unpaid";
  const paidAmount = o.payments.reduce((s, p) => s + p.amount, 0);
  const refunded = o.payments.reduce((s, p) => s + p.refunded, 0);
  const refundable = paidAmount - refunded;

  async function act(fn: () => Promise<OrderDetail | unknown>, msg: string) {
    setActErr(null);
    const r = await fn();
    if (r && typeof r === "object" && "id" in (r as object) && "items" in (r as object)) setData(r as OrderDetail);
    else await reload();
    toast(msg);
  }

  return (
    <div>
      <div className="row-between">
        <div>
          <div className="big-num">#{o.call_number}</div>
          <small>
            {o.department_name}・{channelLabel[o.channel] ?? o.channel}・{mdhm(o.created_at)}
            {o.created_by_name && `・受付 ${o.created_by_name}`}
          </small>
        </div>
        <div className="badges">
          <Badge tone="neutral">{orderStatusLabel[o.status] ?? o.status}</Badge> <OrderBadges o={o} />
        </div>
      </div>
      {o.cancel_reason && <Notice kind="danger">取消理由：{o.cancel_reason}</Notice>}
      {o.unpaid_handoff_reason && <Notice kind="warn">未払い受渡の理由：{o.unpaid_handoff_reason}</Notice>}

      <h3>明細</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>商品</th>
              <th className="num">数量</th>
              <th className="num">金額</th>
              <th>調理</th>
            </tr>
          </thead>
          <tbody>
            {o.items.map((it) => (
              <tr key={it.id} className={it.cook_status === "cancelled" ? "strike" : ""}>
                <td>
                  {it.product_name}
                  {it.options_label && <small>（{it.options_label}）</small>}
                  {accepted && unpaid && it.cook_status !== "cancelled" && (
                    <ReasonAction
                      label="明細取消"
                      className="btn btn-sm"
                      submitClassName="btn btn-danger btn-sm"
                      placeholder="例：注文間違い"
                      onSubmit={(reason) => act(() => post(`/staff/orders/${o.id}/items/${it.id}/cancel`, { reason }), "明細を取り消しました")}
                    />
                  )}
                </td>
                <td className="num">{it.quantity}</td>
                <td className="num">
                  {yen(it.line_total)}
                  {!!it.discount && <small>（−{yen(it.discount)}）</small>}
                </td>
                <td>{cookLabel[it.cook_status] ?? it.cook_status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="kv">
        <dt>小計</dt>
        <dd className="num">{yen(o.subtotal)}</dd>
        {o.discount > 0 && (
          <>
            <dt>割引</dt>
            <dd className="num">−{yen(o.discount)}</dd>
          </>
        )}
        <dt>合計</dt>
        <dd className="num">{yen(o.total)}</dd>
        {refunded > 0 && (
          <>
            <dt>返金済み</dt>
            <dd className="num">{yen(refunded)}</dd>
          </>
        )}
      </dl>

      <ErrorBox error={actErr} />

      {/* 会計 */}
      {accepted && unpaid && !paying && (
        <button className="btn btn-primary btn-lg btn-block" onClick={() => setPaying(true)}>
          ¥ 会計する
        </button>
      )}
      {paying && (
        <PaymentPanel
          order={o}
          onPaid={(p) => {
            setData(p);
            toast("会計を確定しました");
          }}
          onClose={() => setPaying(false)}
        />
      )}

      {/* 受け渡し */}
      {accepted && o.handoff_status === "pending" && !paying && (
        <div className="actions">
          {!unpaid ? (
            <ActionButton
              className="btn btn-ok btn-lg"
              disabled={!o.ready}
              onClick={async () => {
                try {
                  await act(() => post(`/staff/orders/${o.id}/handoff`, {}), `#${o.call_number} を受け渡しました`);
                } catch (e) {
                  setActErr(errorMessage(e));
                }
              }}
            >
              {o.ready ? "✓ 受け渡し" : "受け渡し（調理待ち）"}
            </ActionButton>
          ) : (
            <p className="muted">未払いのため受け渡しできません。先に会計してください。</p>
          )}
          {unpaid && isTreasurer && o.ready && (
            <ReasonAction
              label="未払いのまま受け渡す（責任者）"
              className="btn btn-sm"
              submitClassName="btn btn-danger"
              placeholder="例：後払いを確認済み"
              note={<Notice kind="warn">⚠ 例外操作です。理由とともに記録されます。</Notice>}
              onSubmit={(reason) => act(() => post(`/staff/orders/${o.id}/handoff`, { unpaid_reason: reason }), "未払いのまま受け渡しました")}
            />
          )}
        </div>
      )}
      {o.handoff_status === "handed" && (
        <div className="actions">
          <p>
            受渡済 {mdhm(o.handed_at)}
            {o.handed_by_name && `（${o.handed_by_name}）`}
          </p>
          <ReasonAction
            label="受渡を取り消す"
            className="btn btn-sm"
            submitClassName="btn btn-danger"
            placeholder="例：誤って受渡を押した"
            onSubmit={(reason) => act(() => post(`/staff/orders/${o.id}/handoff/revert`, { reason }), "受渡を取り消しました")}
          />
        </div>
      )}

      {/* 注文取消 */}
      {accepted && !paying && (
        <div className="actions">
          {unpaid || isTreasurer ? (
            <ReasonAction
              label="注文を取り消す"
              className="btn btn-sm"
              submitClassName="btn btn-danger"
              placeholder="例：お客様都合"
              note={!unpaid ? <Notice kind="warn">支払済みの注文です。取消だけでは返金されません。返金は下の「返金」で行ってください。</Notice> : undefined}
              onSubmit={(reason) => act(() => post(`/staff/orders/${o.id}/cancel`, { reason }), "注文を取り消しました")}
            />
          ) : (
            <p className="muted">支払済み注文の取消・返金は会計責任者が行います。</p>
          )}
        </div>
      )}

      {/* 返金 */}
      {isTreasurer && !unpaid && refundable > 0 && <RefundForm order={o} refundable={refundable} onDone={(r) => { setData(r); toast("返金を記録しました"); }} />}

      {/* ブロック */}
      {isAdmin && o.has_client_identity && <BlockForm sourceType="order" sourceId={o.id} onDone={() => toast("ブロックを登録しました")} />}

      {o.coupons.length > 0 && (
        <>
          <h3>クーポン利用</h3>
          <ul>
            {o.coupons.map((c) => (
              <li key={c.id}>
                {c.name}（{c.coupon_no}）{c.persons}人分 −{yen(c.discount)}
                {c.forfeited_persons > 0 && `・失効${c.forfeited_persons}人分`}
                {c.status === "reversed" && <Badge tone="warn">取消済</Badge>}
              </li>
            ))}
          </ul>
        </>
      )}

      {o.payments.length > 0 && (
        <>
          <h3>入金</h3>
          <ul>
            {o.payments.map((p) => (
              <li key={p.id}>
                {mdhm(p.created_at)} {yen(p.amount)}（現金 {yen(p.cash_received)}
                {p.voucher_received > 0 && `・金券 ${yen(p.voucher_received)}`}・お釣り {yen(p.change_given)}）{p.member_name}・{p.cash_account_name}
              </li>
            ))}
          </ul>
        </>
      )}
      {o.refunds.length > 0 && (
        <>
          <h3>返金</h3>
          <ul>
            {o.refunds.map((r) => (
              <li key={r.id}>
                {mdhm(r.created_at)} {yen(r.amount)}：{r.reason}（{r.member_name}）
              </li>
            ))}
          </ul>
        </>
      )}
      <details>
        <summary>操作履歴（{o.events.length}件）</summary>
        <ul>
          {o.events.map((e) => (
            <li key={e.id}>
              {mdhm(e.created_at)} {eventKindLabel[e.kind] ?? e.kind}
              {e.from && e.to && `（${cookLabel[e.from] ?? payLabel[e.from] ?? e.from} → ${cookLabel[e.to] ?? payLabel[e.to] ?? e.to}）`}
              {e.member_name && `・${e.member_name}`}
              {e.reason && `・${e.reason}`}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function RefundForm({ order, refundable, onDone }: { order: OrderDetail; refundable: number; onDone: (o: OrderDetail) => void }) {
  const send = useIdempotent();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(refundable));
  const [reason, setReason] = useState("");
  const [cancelOrder, setCancelOrder] = useState(false);
  const [restore, setRestore] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [accounts, setAccounts] = useState<CashAccountsResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const amt = toIntOr0(amount);

  if (!open) {
    return (
      <div className="actions">
        <button
          className="btn btn-sm"
          onClick={() => {
            setOpen(true);
            get<CashAccountsResp>("/staff/cash/accounts").then(setAccounts).catch(() => {});
          }}
        >
          返金する（返金可能 {yen(refundable)}）
        </button>
      </div>
    );
  }
  return (
    <div className="reason-box">
      <h3 style={{ marginTop: 0 }}>返金（返金可能 {yen(refundable)}）</h3>
      <label className="field">
        <span className="label">返金額（円）</span>
        <input className="amount-input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))} />
      </label>
      <label className="field">
        <span className="label">理由（必須）</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="例：商品の提供ができなかった" />
      </label>
      <label className="field">
        <span className="label">返金元（現金を出す保管先）</span>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">自分の財布（既定）</option>
          {accounts?.accounts
            .filter((a) => a.kind !== "wallet")
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}（現金 {yen(a.cash_balance)}）
              </option>
            ))}
        </select>
      </label>
      {order.status === "accepted" && (
        <label className="check">
          <input type="checkbox" checked={cancelOrder} onChange={(e) => setCancelOrder(e.target.checked)} />
          注文も取り消す
        </label>
      )}
      {order.coupons.some((c) => c.status === "applied") && (
        <label className="check">
          <input type="checkbox" checked={restore} onChange={(e) => setRestore(e.target.checked)} />
          使用したクーポンを再利用できるよう戻す
        </label>
      )}
      <ErrorBox error={err} />
      <div className="row">
        <ActionButton
          className="btn btn-danger"
          disabled={amt <= 0 || amt > refundable || !reason.trim()}
          confirm={`${amt.toLocaleString("ja-JP")}円を返金します。現金をお客様に渡しましたか？`}
          onClick={async () => {
            setErr(null);
            const body: Record<string, unknown> = { amount: amt, reason: reason.trim(), cancel_order: cancelOrder, restore_coupons: restore };
            if (accountId) body.cash_account_id = accountId;
            try {
              const o = await send<OrderDetail>("POST", `/staff/orders/${order.id}/refund`, body);
              setOpen(false);
              onDone(o);
            } catch (e) {
              setErr(errorMessage(e));
            }
          }}
        >
          返金を記録
        </ActionButton>
        <button className="btn btn-ghost" onClick={() => setOpen(false)}>
          やめる
        </button>
      </div>
    </div>
  );
}

/** 管理者：来場者識別のブロック（注文・予約から） */
export function BlockForm({ sourceType, sourceId, onDone }: { sourceType: "order" | "reservation"; sourceId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<"order" | "reservation" | "both">(sourceType);
  const [reason, setReason] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (!open)
    return (
      <div className="actions">
        <button className="btn btn-sm" onClick={() => setOpen(true)}>
          この来場者をブロック（管理者）
        </button>
      </div>
    );
  return (
    <div className="reason-box">
      <h3 style={{ marginTop: 0 }}>来場者のブロック</h3>
      <p className="muted">この端末からの新規受付を止めます。既存の注文・予約は自動では取り消されません。</p>
      <label className="field">
        <span className="label">制限範囲</span>
        <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          <option value="order">注文のみ</option>
          <option value="reservation">予約のみ</option>
          <option value="both">注文と予約</option>
        </select>
      </label>
      <label className="field">
        <span className="label">理由（必須）</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
      </label>
      <label className="field">
        <span className="label">終了日時（空欄なら解除するまで）</span>
        <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
      </label>
      <ErrorBox error={err} />
      <div className="row">
        <ActionButton
          className="btn btn-danger"
          disabled={!reason.trim()}
          confirm="この来場者をブロックしますか？"
          onClick={async () => {
            setErr(null);
            const body: Record<string, unknown> = { source_type: sourceType, source_id: sourceId, scope, reason: reason.trim() };
            if (endsAt) body.ends_at = new Date(endsAt).toISOString();
            try {
              await post("/admin/blocks", body);
              setOpen(false);
              onDone();
            } catch (e) {
              setErr(errorMessage(e));
            }
          }}
        >
          ブロックを登録
        </ActionButton>
        <button className="btn btn-ghost" onClick={() => setOpen(false)}>
          やめる
        </button>
      </div>
    </div>
  );
}
