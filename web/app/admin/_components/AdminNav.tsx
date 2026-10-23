"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const ADMIN_LINKS: { href: string; label: string; desc: string }[] = [
  { href: "/admin", label: "管理トップ", desc: "表示端末・部門の状況" },
  { href: "/admin/departments", label: "営業設定", desc: "営業状態・モバイル受付・現地コード・営業日" },
  { href: "/admin/products", label: "商品・価格", desc: "商品・味・サイズ・組み合わせごとの価格と販売状態" },
  { href: "/admin/screenings", label: "上映管理", desc: "上映枠の確認・変更・中止・自動生成" },
  { href: "/admin/coupons", label: "クーポン", desc: "クーポン定義・手動発券・失効" },
  { href: "/admin/blocks", label: "利用制限", desc: "ブロックの確認・解除" },
  { href: "/admin/members", label: "部員・現金保管先", desc: "アカウント・権限・保管先" },
  { href: "/admin/settings", label: "制限・設定値", desc: "上限値・注意時間などの設定値" },
  { href: "/admin/shifts", label: "シフト配置", desc: "シフト枠・配置・交代の承認" },
  { href: "/admin/audit", label: "監査ログ", desc: "重要操作の履歴" },
];

/** 管理画面のサブメニュー */
export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className="admin-nav no-print" aria-label="管理メニュー">
      {ADMIN_LINKS.map((l) => {
        const active = l.href === "/admin" ? pathname === "/admin" : pathname.startsWith(l.href);
        return (
          <Link key={l.href} href={l.href} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
