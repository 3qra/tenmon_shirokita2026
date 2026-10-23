"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, errorMessage, get, post } from "@/lib/api";
import { yen } from "@/lib/format";
import { ActionButton, Badge, ErrorBox, Notice } from "@/components/ui";
import { QrScanner } from "@/components/QrScanner";
import { hasRole, useStaff } from "@/components/StaffShell";
import { extractToken, toIntOr0, useIdempotent } from "./common";
import type { CashAccountsResp, OrderDetail } from "./types";

type CouponInfo = {
  id: string;
  coupon_no: string;
  status: string;
  persons_total: number;
  persons_remaining: number;
  usable: boolean;
  reason?: string;
  summary: string;
  conditions: { name: string; description?: string; splittable: boolean; combinable: boolean; valid_until?: string | null };
};

type CouponLine = { issued_coupon_id: string; coupon_no: string; name: string; persons: number; discount: number; forfeited_persons: number; note?: string };
type Quote = { subtotal: number; discount: number; total: number; coupons: CouponLine[] };
type AppliedCoupon = { token: string; info: CouponInfo; persons: number };

/**
 * 会計パネル。金額はすべてサーバーの見積・確定結果を表示する。
 * - クーポンの読取・見積では消費しない（会計確定と同時に消費される）。
 * - 会計確定は1回の操作につき1つの Idempotency-Key を使い、通信失敗時の再送では同じキーを使う。
 */
export function PaymentPanel({ order, onPaid, onClose }: { order: OrderDetail; onPaid: (o: OrderDetail) => void; onClose?: () => void }) {
  const staff = useStaff();
  const send = useIdempotent();
  const [coupons, setCoupons] = useState<AppliedCoupon[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<{ kind: "ok" | "danger" | "warn"; text: string } | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [cash, setCash] = useState("");
  const [voucher, setVoucher] = useState("");
  const [showVoucher, setShowVoucher] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [accounts, setAccounts] = useState<CashAccountsResp | null>(null);
  const [confirmFree, setConfirmFree] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [errCode, setErrCode] = useState<string | null>(null);
  const [done, setDone] = useState<OrderDetail | null>(null);
  const quoteSeq = useRef(0);
  const verifying = useRef(false);

  const couponReq = useMemo(() => coupons.map((c) => ({ token: c.token, persons: c.persons })), [coupons]);
  const couponKey = JSON.stringify(couponReq);

  const runQuote = useCallback(async () => {
    const seq = ++quoteSeq.current;
    setQuoting(true);
    try {
      const q = await post<Quote>(`/staff/orders/${order.id}/quote`, { coupons: JSON.parse(couponKey) });
      if (seq !== quoteSeq.current) return;
      setQuote(q);
      setQuoteErr(null);
    } catch (e) {
      if (seq !== quoteSeq.current) return;
      setQuote(null);
      setQuoteErr(errorMessage(e));
    } finally {
      if (seq === quoteSeq.current) setQuoting(false);
    }
  }, [order.id, couponKey]);

  useEffect(() => {
    runQuote();
  }, [runQuote]);

  useEffect(() => {
    get<CashAccountsResp>("/staff/cash/accounts")
      .then(setAccounts)
      .catch(() => setAccounts(null));
  }, []);

  // 入金先の候補：自分の財布（既定）・共用レジ・（責任者は）金庫
  const accountOptions = useMemo(() => {
    if (!accounts) return [];
    const isTreasurer = hasRole(staff, "treasurer", "admin");
    return accounts.accounts.filter((a) => a.active && (a.kind === "register" || (a.kind === "safe" && isTreasurer)));
  }, [accounts, staff]);
  const myWallet = accounts?.accounts.find((a) => a.kind === "wallet" && a.member_id === staff.id);

  async function onScanCoupon(text: string) {
    const token = extractToken(text);
    if (!token || verifying.current) return;
    if (coupons.some((c) => c.token === token)) {
      setScanMsg({ kind: "warn", text: "このクーポンは読み取り済みです" });
      return;
    }
    verifying.current = true;
    setScanMsg(null);
    try {
      const info = await get<CouponInfo>(`/staff/coupons/verify/${encodeURIComponent(token)}`);
      if (!info.usable) {
        setScanMsg({ kind: "danger", text: `✕ ${info.coupon_no}：${info.reason ?? "このクーポンは使えません"}` });
        return;
      }
      const qty = order.items.filter((i) => i.cook_status !== "cancelled").reduce((s, i) => s + i.quantity, 0);
      const persons = Math.max(1, Math.min(info.persons_remaining, qty || 1));
      setCoupons((cs) => [...cs, { token, info, persons }]);
      setScanMsg({ kind: "ok", text: `✓ ${info.coupon_no}「${info.conditions.name}」を読み取りました（まだ使用されていません）` });
      setScanning(false);
    } catch (e) {
      setScanMsg({ kind: "danger", text: `✕ ${errorMessage(e)}` });
    } finally {
      verifying.current = false;
    }
  }

  const total = quote?.total ?? null;
  const cashN = toIntOr0(cash);
  const voucherN = showVoucher ? toIntOr0(voucher) : 0;
  const received = cashN + voucherN;
  const isFree = total === 0;
  const short = total !== null ? Math.max(0, total - received) : 0;
  const changePreview = total !== null ? received - total : 0;
  const voucherOverpay = total !== null && changePreview > cashN; // 金券にお釣りが出る形

  const canConfirm = total !== null && !quoting && !quoteErr && (isFree ? confirmFree : received >= total);

  async function confirm() {
    if (total === null) return;
    setErr(null);
    setErrCode(null);
    const body: Record<string, unknown> = {
      cash_received: isFree ? 0 : cashN,
      voucher_received: isFree ? 0 : voucherN,
      coupons: couponReq,
      expected_total: total,
    };
    if (accountId) body.cash_account_id = accountId;
    try {
      const o = await send<OrderDetail>("POST", `/staff/orders/${order.id}/payment`, body);
      setDone(o);
      onPaid(o);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "";
      setErrCode(code);
      if (code === "total_changed") {
        setErr(`${errorMessage(e)}。金額を再計算しました。内容を確認してからもう一度確定してください`);
        runQuote();
      } else if (code === "already_paid") {
        // 前回の送信が実は成功していた場合など。最新の注文を表示する
        try {
          const o = await get<OrderDetail>(`/staff/orders/${order.id}`);
          setDone(o);
          onPaid(o);
        } catch {
          setErr("既に会計済みです。注文一覧で確認してください");
        }
      } else if (code === "coupon_changed") {
        setErr(`${errorMessage(e)}（クーポンを外して読み取り直してください）`);
        runQuote();
      } else if (code === "network") {
        setErr("通信できませんでした。電波を確認して、もう一度「会計を確定」を押してください（同じ操作として扱われ、二重会計にはなりません）");
      } else if (code === "in_progress") {
        setErr("前回の会計を処理中です。数秒待ってからもう一度押してください");
      } else {
        setErr(errorMessage(e));
      }
    }
  }

  if (done) {
    const p = done.payments[done.payments.length - 1];
    return (
      <section className="card" aria-live="polite">
        <div className="result result-ok">
          <div className="mark" aria-hidden>
            ✓
          </div>
          <h2>会計完了</h2>
          <p>呼出番号 {done.call_number}</p>
        </div>
        <dl className="kv">
          <dt>お会計</dt>
          <dd className="num">{yen(done.total)}</dd>
          {done.discount > 0 && (
            <>
              <dt>割引</dt>
              <dd className="num">−{yen(done.discount)}</dd>
            </>
          )}
          {p && (
            <>
              <dt>お預かり（現金）</dt>
              <dd className="num">{yen(p.cash_received)}</dd>
              {p.voucher_received > 0 && (
                <>
                  <dt>お預かり（金券）</dt>
                  <dd className="num">{yen(p.voucher_received)}</dd>
                </>
              )}
              <dt>入金先</dt>
              <dd>{p.cash_account_name ?? "—"}</dd>
            </>
          )}
        </dl>
        {p && (
          <div className="change-box">
            <span>お釣り</span>
            <span className="big-num">{yen(p.change_given)}</span>
          </div>
        )}
        {onClose && (
          <button className="btn btn-primary btn-lg btn-block" onClick={onClose}>
            閉じる
          </button>
        )}
      </section>
    );
  }

  return (
    <section className="card" aria-label="会計">
      <div className="section-title">
        <h2 style={{ margin: 0 }}>会計（呼出番号 {order.call_number}）</h2>
        {onClose && (
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            閉じる
          </button>
        )}
      </div>

      {/* クーポン */}
      <h3>クーポン</h3>
      {coupons.map((c, idx) => {
        const line = quote?.coupons.find((l) => l.coupon_no === c.info.coupon_no);
        const opts = Array.from({ length: c.info.persons_remaining }, (_, i) => i + 1);
        return (
          <div key={c.token} className="coupon-card">
            <div className="row-between">
              <strong>
                {c.info.conditions.name}（{c.info.coupon_no}）
              </strong>
              <button className="btn btn-sm" onClick={() => setCoupons((cs) => cs.filter((_, i) => i !== idx))}>
                外す
              </button>
            </div>
            <p>{c.info.summary}</p>
            <p>
              残り {c.info.persons_remaining}人分 / 発行 {c.info.persons_total}人分
              {!c.info.conditions.splittable && <Badge tone="warn">分割利用不可</Badge>}
            </p>
            <label className="field">
              <span className="label">今回使う人数</span>
              <select
                value={c.persons}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setCoupons((cs) => cs.map((x, i) => (i === idx ? { ...x, persons: v } : x)));
                }}
              >
                {opts.map((n) => (
                  <option key={n} value={n}>
                    {n}人
                  </option>
                ))}
              </select>
            </label>
            {!c.info.conditions.splittable && c.persons < c.info.persons_remaining && (
              <Notice kind="warn">⚠ 分割利用できないクーポンです。使わない残り{c.info.persons_remaining - c.persons}人分は、この会計で失効します（お客様に確認してください）。</Notice>
            )}
            {line && <p>割引額：<strong className="num">−{yen(line.discount)}</strong></p>}
          </div>
        );
      })}
      {scanning ? (
        <div>
          <QrScanner onScan={onScanCoupon} onManual={onScanCoupon} manualLabel="クーポンのコードを手入力" />
          <button className="btn btn-block" onClick={() => setScanning(false)}>
            読み取りをやめる
          </button>
        </div>
      ) : (
        <button className="btn btn-block" onClick={() => setScanning(true)}>
          クーポンQRを読み取る
        </button>
      )}
      {scanMsg && <Notice kind={scanMsg.kind}>{scanMsg.text}</Notice>}
      <p className="muted">読み取り・金額確認ではクーポンは使用されません。会計確定と同時に使用済みになります。</p>

      {/* 金額（サーバー見積） */}
      <h3>お会計</h3>
      {quoteErr && (
        <div>
          <ErrorBox error={quoteErr} />
          <button className="btn btn-sm" onClick={runQuote}>
            再計算
          </button>
        </div>
      )}
      {quote ? (
        <div aria-live="polite" style={{ opacity: quoting ? 0.5 : 1 }}>
          <div className="pay-total">
            <span>小計</span>
            <span className="num">{yen(quote.subtotal)}</span>
          </div>
          {quote.discount > 0 && (
            <div className="pay-total">
              <span>クーポン割引</span>
              <span className="num">−{yen(quote.discount)}</span>
            </div>
          )}
          <div className="pay-total grand">
            <span>合計</span>
            <span className="num">{yen(quote.total)}</span>
          </div>
          {quote.coupons.filter((l) => l.note).map((l) => (
            <Notice key={l.coupon_no} kind="warn">
              ⚠ {l.note}
            </Notice>
          ))}
        </div>
      ) : (
        !quoteErr && <p className="muted">金額を計算中…</p>
      )}

      {/* 受領 */}
      {quote && !isFree && (
        <>
          <label className="field">
            <span className="label">お預かり（現金）</span>
            <input className="amount-input" inputMode="numeric" pattern="[0-9]*" value={cash} onChange={(e) => setCash(e.target.value.replace(/[^\d]/g, ""))} placeholder="0" />
          </label>
          <div className="quick">
            <button className="btn" onClick={() => setCash(String(Math.max(0, quote.total - voucherN)))}>
              ちょうど
            </button>
            {[500, 1000, 5000, 10000].map((n) => (
              <button key={n} className="btn" onClick={() => setCash(String(n))}>
                {n.toLocaleString("ja-JP")}円
              </button>
            ))}
            <button className="btn btn-ghost" onClick={() => setCash("")}>
              クリア
            </button>
          </div>
          {showVoucher ? (
            <label className="field">
              <span className="label">金券（額面の合計）</span>
              <input className="amount-input" inputMode="numeric" pattern="[0-9]*" value={voucher} onChange={(e) => setVoucher(e.target.value.replace(/[^\d]/g, ""))} placeholder="0" />
            </label>
          ) : (
            <button className="btn btn-sm" onClick={() => setShowVoucher(true)}>
              ＋ 金券で受け取る
            </button>
          )}
          <div className={`change-box ${short > 0 ? "short" : ""}`} aria-live="polite">
            <span>{short > 0 ? "不足" : "お釣り（目安）"}</span>
            <span className="big-num">{short > 0 ? `あと${yen(short)}` : yen(changePreview)}</span>
          </div>
          {voucherOverpay && short === 0 && <Notice kind="warn">⚠ 金券分にお釣りが出る形になっています。設定によっては確定できません。</Notice>}
        </>
      )}
      {quote && isFree && (
        <label className="check">
          <input type="checkbox" checked={confirmFree} onChange={(e) => setConfirmFree(e.target.checked)} />
          0円のお会計として確定します（代金の受け取りはありません）
        </label>
      )}

      {/* 入金先 */}
      {quote && !isFree && (
        <label className="field">
          <span className="label">入金先（現金の保管先）</span>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">{myWallet ? `自分の財布（${myWallet.name}）` : "自分の財布（既定）"}</option>
            {accountOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {errCode === "no_wallet" && <Notice kind="warn">あなたの財布が登録されていません。上の「入金先」で共用レジなどを選んでください。</Notice>}

      <ErrorBox error={err} />
      <ActionButton className="btn btn-ok btn-xl" disabled={!canConfirm} onClick={confirm}>
        {total === null ? "金額確認中…" : isFree ? "0円で会計を確定" : `会計を確定（${yen(total)}）`}
      </ActionButton>
    </section>
  );
}
