"use client";

import Link from "next/link";
import { useLive } from "@/lib/hooks";
import { businessLabel } from "@/lib/format";
import { Badge, LiveStatus } from "@/components/ui";
import { Loading, RetryError, VisitorPage } from "@/components/visitor/common";

type Department = {
  id: string;
  code: string;
  name: string;
  kind: "food" | "planetarium" | "goods" | string;
  business_status: "before" | "open" | "paused" | "closed" | string;
  mobile_order_enabled: boolean;
  site_code_enabled: boolean;
  notice: string;
  sort_order: number;
};

const statusTone = (s: string) => (s === "open" ? "ok" : s === "paused" ? "warn" : s === "closed" ? "danger" : "neutral");
const statusMark = (s: string) => (s === "open" ? "●" : s === "paused" ? "‖" : s === "closed" ? "■" : "…");

export default function PortalHome() {
  const { data, error, reload, lastOk, stale, connected } = useLive<Department[]>("/public/departments", ["departments"], 30000);

  return (
    <VisitorPage>
      <section className="hero">
        <h1>学祭ポータル</h1>
        <p className="muted">やきうどんのモバイル注文、プラネタリウムの予約、物販のご案内です。</p>
      </section>

      <LiveStatus lastOk={lastOk} stale={stale} connected={connected} error={error} />
      {!data && error && <RetryError error={error} onRetry={reload} />}
      {!data && !error && <Loading />}

      {data && data.length === 0 && <p className="empty">現在ご案内できる出店はありません。</p>}

      {data?.map((d) => {
        const open = d.business_status === "open";
        return (
          <section key={d.id} className="card" aria-labelledby={`dept-${d.id}`}>
            <div className="v-dept-head">
              <h2 id={`dept-${d.id}`}>{d.name}</h2>
              <Badge tone={statusTone(d.business_status)}>
                {statusMark(d.business_status)} {businessLabel[d.business_status] ?? d.business_status}
              </Badge>
            </div>
            {d.notice && (
              <div className="banner banner-info" style={{ whiteSpace: "pre-wrap" }}>
                <strong>お知らせ：</strong>
                {d.notice}
              </div>
            )}
            <div className="v-links">
              {d.kind === "planetarium" ? (
                <>
                  <Link className="btn btn-primary btn-lg" href="/planetarium">
                    上映スケジュール・予約
                  </Link>
                  <p className="muted" style={{ margin: 0 }}>
                    事前予約のほか、空きがあれば当日その場でも参加できます。
                  </p>
                </>
              ) : d.mobile_order_enabled && open ? (
                <>
                  <Link className="btn btn-primary btn-lg" href={`/order/${d.id}`}>
                    スマホで注文する
                  </Link>
                  <p className="muted" style={{ margin: 0 }}>
                    注文後、店頭でお支払いください。{d.site_code_enabled && "注文時に会場の画面に表示された3桁の確認コードが必要です。"}
                  </p>
                </>
              ) : (
                <>
                  <Link className="btn btn-lg" href={`/order/${d.id}`}>
                    メニュー・価格を見る
                  </Link>
                  <p className="muted" style={{ margin: 0 }}>
                    {open ? "ご注文・ご購入は店頭で受け付けています。" : "現在は受け付けていません。"}
                  </p>
                </>
              )}
            </div>
          </section>
        );
      })}

      <section className="card">
        <h2 style={{ marginTop: 0 }}>マイページ</h2>
        <p>この端末で行った注文・予約の確認やキャンセルはマイページから行えます。</p>
        <Link className="btn btn-block" href="/my">
          マイページを開く
        </Link>
      </section>
    </VisitorPage>
  );
}
