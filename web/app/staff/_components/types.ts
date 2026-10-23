// スタッフ画面で使うAPIレスポンスの型（Go API の JSON に合わせる）

export type Department = {
  id: string;
  code: string;
  name: string;
  kind: "food" | "planetarium" | "goods";
  business_status: string;
  mobile_order_enabled: boolean;
  site_code_enabled: boolean;
  notice: string;
  sort_order: number;
};

export type Variant = {
  id: string;
  label: string;
  price: number;
  sale_status: "on_sale" | "sold_out" | "stopped";
  visibility: string;
  active: boolean;
  sort_order: number;
};

export type Product = {
  id: string;
  name: string;
  description: string;
  needs_cooking: boolean;
  visibility: string;
  active: boolean;
  variants: Variant[];
};

export type OrderItem = {
  id: string;
  product_name: string;
  options_label: string;
  unit_price?: number;
  quantity: number;
  line_total: number;
  discount?: number;
  needs_cooking?: boolean;
  cook_status: string;
};

export type OrderSummary = {
  id: string;
  call_number: number;
  channel: string;
  status: string;
  payment_status: string;
  handoff_status: string;
  subtotal: number;
  discount: number;
  total: number;
  created_at: string;
  elapsed_sec: number;
  unpaid_warning: boolean;
  ready: boolean;
  items: OrderItem[];
};

export type Payment = {
  id: string;
  amount: number;
  cash_received: number;
  voucher_received: number;
  change_given: number;
  created_at: string;
  member_name: string | null;
  cash_account_name: string | null;
  refunded: number;
};

export type OrderDetail = {
  id: string;
  department_id: string;
  department_name: string;
  business_day: string;
  call_number: number;
  channel: string;
  status: string;
  payment_status: string;
  handoff_status: string;
  subtotal: number;
  discount: number;
  total: number;
  created_at: string;
  handed_at: string | null;
  items: OrderItem[];
  coupons: { id: string; coupon_no: string; name: string; persons: number; discount: number; status: string; forfeited_persons: number }[];
  ready: boolean;
  has_client_identity: boolean;
  created_by_name: string | null;
  handed_by_name: string | null;
  cancel_reason: string | null;
  unpaid_handoff_reason: string | null;
  payments: Payment[];
  refunds: { id: string; amount: number; reason: string; created_at: string; member_name: string | null }[];
  events: { id: number; kind: string; from: string | null; to: string | null; reason: string | null; created_at: string; member_name: string | null }[];
};

export type CashAccount = {
  id: string;
  name: string;
  kind: "wallet" | "safe" | "register";
  member_id: string | null;
  member_name: string | null;
  active: boolean;
  cash_balance: number;
  voucher_balance: number;
  pending_transfers: number;
  last_reconciliation: { created_at: string; difference: number } | null;
};

export type CashAccountsResp = { accounts: CashAccount[]; total: { cash: number; voucher: number }; can_view_all: boolean };

export type Screening = {
  id: string;
  title: string;
  business_day: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  reserve_quota: number | null;
  reserved_count: number;
  walkin_count: number;
  booking_status: string;
  run_status: "scheduled" | "running" | "finished" | "cancelled";
  admitted_count: number;
  taken: number;
  symbol: string;
  status_text: string;
  walkin_available: number;
  advance_available: number;
  cancel_reason?: string | null;
};

export type BusinessDays = { days: { id: string; day: string; label: string }[]; today: string };

export const eventKindLabel: Record<string, string> = {
  create: "注文受付",
  payment: "会計",
  cancel: "注文取消",
  item_cancel: "明細取消",
  cook: "調理",
  cook_correction: "調理の訂正",
  handoff: "受け渡し",
  handoff_correction: "受渡の取消",
  refund: "返金",
};

export const channelLabel: Record<string, string> = {
  staff: "対面",
  web: "Web",
  appclip: "App Clip",
  ios: "iOS",
  android: "Android",
};

export const accountKindLabel: Record<string, string> = {
  wallet: "財布",
  safe: "金庫",
  register: "共用レジ",
};

export const runStatusLabel: Record<string, string> = {
  scheduled: "予定",
  running: "上映中",
  finished: "上映終了",
  cancelled: "上映中止",
};
