"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, ReactNode, useContext, useEffect, useState } from "react";
import { get, post } from "@/lib/api";
import { roleLabel } from "@/lib/format";

export type StaffInfo = { id: string; name: string; login_id: string; roles: string[] };

const StaffCtx = createContext<StaffInfo | null>(null);
export const useStaff = () => useContext(StaffCtx)!;
export const hasRole = (s: StaffInfo | null, ...roles: string[]) => !!s && roles.some((r) => s.roles.includes(r));

const NAV: { href: string; label: string; roles: string[] }[] = [
  { href: "/staff", label: "ホーム", roles: [] },
  { href: "/staff/register", label: "対面注文・会計", roles: ["cashier", "treasurer", "admin"] },
  { href: "/staff/orders", label: "注文一覧・受渡", roles: ["cashier", "treasurer", "admin"] },
  { href: "/staff/kitchen", label: "キッチン", roles: ["kitchen", "cashier", "admin"] },
  { href: "/staff/reception", label: "プラネ受付", roles: ["reception", "admin"] },
  { href: "/staff/cash", label: "現金", roles: ["cashier", "treasurer", "admin"] },
  { href: "/staff/sales", label: "売上・精算", roles: ["treasurer", "admin"] },
  { href: "/staff/shifts", label: "シフト", roles: [] },
  { href: "/admin", label: "管理", roles: ["admin"] },
];

/**
 * スタッフ画面の共通枠。ログイン確認と権限による表示切替を行う。
 * 画面の表示制御は利便性のためで、権限の判定はAPI側で必ず行われる。
 */
export function StaffShell({ children, roles = [], wide = false, bare = false }: { children: ReactNode; roles?: string[]; wide?: boolean; bare?: boolean }) {
  const [staff, setStaff] = useState<StaffInfo | null>(null);
  const [unread, setUnread] = useState(0);
  const [checked, setChecked] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    get<{ staff: StaffInfo; unread_notifications: number }>("/auth/me")
      .then((d) => {
        setStaff(d.staff);
        setUnread(d.unread_notifications);
      })
      .catch(() => router.replace(`/staff/login?next=${encodeURIComponent(pathname)}`))
      .finally(() => setChecked(true));
  }, [pathname, router]);

  if (!checked || !staff) return <main className="container"><p className="empty">読み込み中…</p></main>;
  if (roles.length && !hasRole(staff, ...roles)) {
    return (
      <main className="container">
        <h1>権限がありません</h1>
        <p>この画面を使うには「{roles.map((r) => roleLabel[r]).join("・")}」の権限が必要です。</p>
        <Link className="btn" href="/staff">ホームへ</Link>
      </main>
    );
  }
  const nav = NAV.filter((n) => !n.roles.length || hasRole(staff, ...n.roles));
  return (
    <StaffCtx.Provider value={staff}>
      {!bare && (
        <header className="staff-header">
          <nav className="staff-nav" aria-label="スタッフメニュー">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className={pathname === n.href || (n.href !== "/staff" && pathname.startsWith(n.href)) ? "active" : ""}>
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="staff-user">
            <Link href="/staff/notifications" className="notif">
              通知{unread > 0 && <span className="badge badge-danger">{unread}</span>}
            </Link>
            <span>{staff.name}</span>
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                await post("/auth/logout").catch(() => {});
                router.replace("/staff/login");
              }}
            >
              ログアウト
            </button>
          </div>
        </header>
      )}
      <main className={wide ? "container-wide" : "container"}>{children}</main>
    </StaffCtx.Provider>
  );
}
