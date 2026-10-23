"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useLive } from "@/lib/hooks";
import { mdhm } from "@/lib/format";
import { Badge, LiveStatus } from "@/components/ui";
import { Qr } from "@/components/Qr";
import { Loading, RetryError, VisitorPage } from "@/components/visitor/common";

type Coupon = {
  id: string;
  coupon_no: string;
  name: string;
  description: string | null;
  summary: string;
  conditions: { splittable?: boolean; combinable?: boolean; holder_mode?: string } | null;
  persons_total: number;
  persons_remaining: number;
  status: "active" | "used" | "revoked" | string;
  valid_from: string | null;
  valid_until: string | null;
  token: string;
};

export default function CouponPage() {
  const { token } = useParams<{ token: string }>();
  const { data: c, error, reload, lastOk, stale, connected } = useLive<Coupon>(
    token ? `/public/coupons/by-token/${encodeURIComponent(token)}` : null,
    ["orders"],
    30000,
  );

  if (!c) {
    return (
      <VisitorPage>
        {error ? <RetryError error={error} onRetry={reload} /> : <Loading label="クーポンを確認しています…" />}
      </VisitorPage>
    );
  }

  const now = Date.now();
  const notYet = !!c.valid_from && new Date(c.valid_from).getTime() > now;
  const expired = !!c.valid_until && new Date(c.valid_until).getTime() < now;
  const usable = c.status === "active" && !expired && !notYet && c.persons_remaining > 0;
  const splittable = c.conditions?.splittable !== false;

  let state: { tone: "ok" | "warn" | "danger" | "neutral"; text: string };
  if (c.status === "revoked") state = { tone: "danger", text: "✕ このクーポンは無効になりました" };
  else if (c.status === "used" || c.persons_remaining <= 0) state = { tone: "neutral", text: "使用済みです" };
  else if (expired) state = { tone: "neutral", text: "有効期限が切れています" };
  else if (notYet) state = { tone: "warn", text: `${mdhm(c.valid_from)}から利用できます` };
  else state = { tone: "ok", text: "✓ 利用できます" };

  return (
    <VisitorPage>
      <LiveStatus lastOk={lastOk} stale={stale} connected={connected} error={error} />
      <section className="card center">
        <div className="muted">クーポン</div>
        <h1 style={{ margin: "4px 0" }}>{c.name}</h1>
        {c.summary && <p style={{ fontWeight: 700 }}>{c.summary}</p>}
        {c.description && <p className="muted" style={{ whiteSpace: "pre-wrap" }}>{c.description}</p>}
        <div style={{ margin: "8px 0" }}>
          <Badge tone={state.tone}>{state.text}</Badge>
        </div>

        {usable || notYet ? (
          <>
            <Qr value={c.token} size={260} label={`クーポン番号 ${c.coupon_no}`} />
            <p>お会計の前に、このQRコードを係の人に見せてください。</p>
          </>
        ) : (
          <p className="muted">クーポン番号 {c.coupon_no}</p>
        )}

        <div className="v-total" style={{ margin: "8px 0" }}>
          残り {c.persons_remaining} / {c.persons_total} 人分
        </div>
        <p className="muted" style={{ margin: 0 }}>
          有効期間：{c.valid_from ? mdhm(c.valid_from) : "発行時"}〜{c.valid_until ? mdhm(c.valid_until) : "期限なし"}
        </p>
      </section>

      {usable && !splittable && c.persons_total > 1 && (
        <div className="banner banner-warn" role="note">
          <strong>! 分割利用できないクーポンです。</strong>
          一度使うと、そのとき使わなかった人数分も含めて失効します。全員分をまとめてご利用ください。
        </div>
      )}
      {usable && !splittable && c.persons_total <= 1 && (
        <div className="banner banner-info" role="note">
          1回のお会計で使い切りのクーポンです。
        </div>
      )}
      {usable && splittable && c.persons_remaining > 1 && (
        <div className="banner banner-info" role="note">
          何回かに分けて使えます。使った人数分だけ残りが減ります。
        </div>
      )}

      <p className="muted" style={{ fontSize: "0.9rem" }}>
        割引額はお会計時にスタッフの端末で確定します。このページのURLは他の人に共有しないでください。
      </p>
      <Link href="/my">マイページへ</Link>
    </VisitorPage>
  );
}
