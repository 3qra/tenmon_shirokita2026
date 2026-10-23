export const yen = (n: number | null | undefined) => `${(n ?? 0).toLocaleString("ja-JP")}円`;

const tz = "Asia/Tokyo";

export function hm(iso: string | Date | null | undefined) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("ja-JP", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
}

export function mdhm(iso: string | Date | null | undefined) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("ja-JP", { timeZone: tz, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function md(iso: string | Date | null | undefined) {
  if (!iso) return "";
  const d = typeof iso === "string" && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00+09:00`) : new Date(iso);
  return d.toLocaleDateString("ja-JP", { timeZone: tz, month: "numeric", day: "numeric", weekday: "short" });
}

export function elapsed(sec: number) {
  if (sec < 60) return `${sec}秒`;
  const m = Math.floor(sec / 60);
  return `${m}分`;
}

export function todayJST() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: tz });
}

export const roleLabel: Record<string, string> = {
  admin: "管理者",
  cashier: "会計担当",
  kitchen: "キッチン担当",
  reception: "プラネ受付",
  treasurer: "会計責任者",
  member: "部員",
  display: "表示端末",
};

export const cookLabel: Record<string, string> = {
  waiting: "待ち",
  cooking: "調理中",
  cooked: "調理済",
  cancelled: "取消",
  not_required: "調理不要",
};

export const payLabel: Record<string, string> = {
  unpaid: "未払い",
  paid: "支払済",
  partially_refunded: "一部返金",
  refunded: "全額返金",
};

export const orderStatusLabel: Record<string, string> = {
  accepted: "受付済",
  cancelled: "取消",
  completed: "完了",
};

export const businessLabel: Record<string, string> = {
  before: "営業前",
  open: "営業中",
  paused: "一時停止",
  closed: "営業終了",
};

export const reservationStatusLabel: Record<string, string> = {
  confirmed: "予約確定",
  cancelled_self: "キャンセル済み",
  cancelled_staff: "スタッフにより取消",
  cancelled_screening: "上映中止のため取消",
};
