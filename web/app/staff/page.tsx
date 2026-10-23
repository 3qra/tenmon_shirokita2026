"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { get } from "@/lib/api";
import { useFetch } from "@/lib/hooks";
import { hm, roleLabel, todayJST, yen } from "@/lib/format";
import { Badge, Notice } from "@/components/ui";
import { hasRole, StaffShell, useStaff } from "@/components/StaffShell";

type Shortcut = { href: string; title: string; desc: string; roles: string[] };

const SHORTCUTS: Shortcut[] = [
  { href: "/staff/register", title: "対面注文・会計", desc: "店頭で注文を受けて会計する", roles: ["cashier", "treasurer", "admin"] },
  { href: "/staff/orders", title: "注文一覧・受渡", desc: "未払い・受渡待ちの確認、受け渡し", roles: ["cashier", "treasurer", "admin"] },
  { href: "/staff/kitchen", title: "キッチン", desc: "調理開始・調理済の操作", roles: ["kitchen", "cashier", "admin"] },
  { href: "/staff/reception", title: "プラネ受付", desc: "QR入場・当日受付・予約検索", roles: ["reception", "admin"] },
  { href: "/staff/cash", title: "現金", desc: "残高・引継ぎ・受取確認", roles: ["cashier", "treasurer", "admin"] },
  { href: "/staff/sales", title: "売上集計", desc: "日別・部門別・商品別の売上", roles: ["treasurer", "admin"] },
  { href: "/staff/shifts", title: "シフト", desc: "担当の確認・希望提出・交代申請", roles: [] },
  { href: "/staff/notifications", title: "通知", desc: "お知らせ・依頼の確認", roles: [] },
  { href: "/admin", title: "管理", desc: "営業設定・商品・上映・部員", roles: ["admin"] },
];

type Transfer = { id: string; amount: number; from_name: string; can_confirm: boolean };
type Slot = { id: string; location: string; starts_at: string; ends_at: string; mine: boolean };

export default function StaffHome() {
  return (
    <StaffShell>
      <Home />
    </StaffShell>
  );
}

function Home() {
  const staff = useStaff();
  const canCash = hasRole(staff, "cashier", "treasurer", "admin");
  const [unread, setUnread] = useState<number | null>(null);
  const [toConfirm, setToConfirm] = useState<Transfer[] | null>(null);
  const { data: shifts } = useFetch<{ slots: Slot[] }>(`/staff/shifts?day=${todayJST()}`);

  useEffect(() => {
    get<{ unread_notifications: number }>("/auth/me")
      .then((d) => setUnread(d.unread_notifications))
      .catch(() => {});
    if (canCash) {
      get<Transfer[]>("/staff/cash/transfers?status=pending")
        .then((list) => setToConfirm(list.filter((t) => t.can_confirm)))
        .catch(() => {});
    }
  }, [canCash]);

  const hour = Number(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false }));
  const greet = hour < 10 ? "おはようございます" : "お疲れさまです";
  const cards = SHORTCUTS.filter((s) => !s.roles.length || hasRole(staff, ...s.roles));
  const myShifts = (shifts?.slots ?? []).filter((s) => s.mine);

  return (
    <>
      <h1>
        {staff.name}さん、{greet}
      </h1>
      <p>
        {staff.roles
          .filter((r) => r !== "member")
          .map((r) => (
            <Badge key={r} tone="info">
              {roleLabel[r] ?? r}
            </Badge>
          ))}
      </p>

      {unread !== null && unread > 0 && (
        <Link href="/staff/notifications" className="card-link">
          <Notice kind="info">● 未読の通知が {unread}件 あります（タップで確認）</Notice>
        </Link>
      )}
      {toConfirm && toConfirm.length > 0 && (
        <Link href="/staff/cash" className="card-link">
          <Notice kind="warn">
            ⏳ 受け取り確認が必要な現金の移動が {toConfirm.length}件 あります（合計 {yen(toConfirm.reduce((s, t) => s + t.amount, 0))}）。現金を受け取ったら確認してください。
          </Notice>
        </Link>
      )}

      {myShifts.length > 0 && (
        <section className="card">
          <h2 style={{ marginTop: 0 }}>今日のあなたのシフト</h2>
          <ul>
            {myShifts.map((s) => (
              <li key={s.id}>
                {hm(s.starts_at)}–{hm(s.ends_at)} {s.location}
              </li>
            ))}
          </ul>
        </section>
      )}

      <h2>業務メニュー</h2>
      <div className="home-cards">
        {cards.map((c) => (
          <Link key={c.href} href={c.href} className="home-card">
            <strong>{c.title}</strong>
            <small>{c.desc}</small>
            {c.href === "/staff/notifications" && unread ? <Badge tone="danger">未読 {unread}</Badge> : null}
            {c.href === "/staff/cash" && toConfirm && toConfirm.length > 0 ? <Badge tone="warn">確認待ち {toConfirm.length}</Badge> : null}
          </Link>
        ))}
      </div>
    </>
  );
}
