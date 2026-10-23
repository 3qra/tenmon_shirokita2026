-- 学祭部活ポータル 初期スキーマ
-- 金額はすべて整数の円。時刻は timestamptz（UTC保存）、営業日は Asia/Tokyo 基準の date。

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------
-- 共通設定
-- ---------------------------------------------------------------
CREATE TABLE settings (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE festival_events (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE business_days (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id   uuid NOT NULL REFERENCES festival_events(id),
    day        date NOT NULL UNIQUE,
    label      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- 部員・権限・セッション
-- ---------------------------------------------------------------
CREATE TABLE members (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name          text NOT NULL,
    login_id      text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    active        boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE member_roles (
    member_id  uuid NOT NULL REFERENCES members(id),
    role       text NOT NULL CHECK (role IN ('admin','cashier','kitchen','reception','treasurer','member','display')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (member_id, role)
);

CREATE TABLE staff_sessions (
    token_hash  text PRIMARY KEY,
    member_id   uuid NOT NULL REFERENCES members(id),
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON staff_sessions(member_id);

-- ---------------------------------------------------------------
-- 部門・営業設定
-- ---------------------------------------------------------------
CREATE TABLE departments (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code                   text NOT NULL UNIQUE,
    name                   text NOT NULL,
    kind                   text NOT NULL CHECK (kind IN ('food','planetarium','goods')),
    business_status        text NOT NULL DEFAULT 'before' CHECK (business_status IN ('before','open','paused','closed')),
    mobile_order_enabled   boolean NOT NULL DEFAULT false,
    site_code_enabled      boolean NOT NULL DEFAULT false,
    site_code_interval_sec integer NOT NULL DEFAULT 300 CHECK (site_code_interval_sec BETWEEN 30 AND 86400),
    site_code_grace_sec    integer NOT NULL DEFAULT 30 CHECK (site_code_grace_sec >= 0),
    site_code_epoch        integer NOT NULL DEFAULT 0,  -- 手動で即時更新するときに加算
    notice                 text NOT NULL DEFAULT '',
    sort_order             integer NOT NULL DEFAULT 0,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

-- 表示端末の生存確認（現地コード表示が止まっていないか）
CREATE TABLE display_heartbeats (
    member_id    uuid PRIMARY KEY REFERENCES members(id),
    department_id uuid REFERENCES departments(id),
    screen       text NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- 商品
-- ---------------------------------------------------------------
CREATE TABLE products (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id uuid NOT NULL REFERENCES departments(id),
    name          text NOT NULL,
    description   text NOT NULL DEFAULT '',
    needs_cooking boolean NOT NULL DEFAULT true,
    visibility    text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','hidden')),
    active        boolean NOT NULL DEFAULT true,
    sort_order    integer NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 選択肢の軸（味・サイズなど）。軸も選択肢も管理画面から追加でき、DB構造を変えない。
CREATE TABLE option_groups (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id uuid NOT NULL REFERENCES products(id),
    name       text NOT NULL,          -- 例：味、サイズ
    sort_order integer NOT NULL DEFAULT 0,
    active     boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE option_values (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id   uuid NOT NULL REFERENCES option_groups(id),
    name       text NOT NULL,          -- 例：しょうゆ、中
    sort_order integer NOT NULL DEFAULT 0,
    active     boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- 組み合わせごとの価格・状態。option_key は選択肢IDをソートして連結したもの（重複防止用）。
CREATE TABLE product_variants (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id  uuid NOT NULL REFERENCES products(id),
    option_key  text NOT NULL DEFAULT '',
    price       integer NOT NULL CHECK (price >= 0),
    visibility  text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','hidden')),
    sale_status text NOT NULL DEFAULT 'on_sale' CHECK (sale_status IN ('on_sale','sold_out','stopped')),
    active      boolean NOT NULL DEFAULT true,
    sort_order  integer NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (product_id, option_key)
);

CREATE TABLE product_variant_options (
    variant_id uuid NOT NULL REFERENCES product_variants(id),
    value_id   uuid NOT NULL REFERENCES option_values(id),
    PRIMARY KEY (variant_id, value_id)
);

-- ---------------------------------------------------------------
-- 来場者識別・ブロック
-- ---------------------------------------------------------------
CREATE TABLE client_identities (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind        text NOT NULL CHECK (kind IN ('web','appclip','ios','android')),
    value_hash  text NOT NULL,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (kind, value_hash)
);

CREATE TABLE access_blocks (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_identity_id uuid NOT NULL REFERENCES client_identities(id),
    scope              text NOT NULL CHECK (scope IN ('order','reservation','both')),
    reason             text NOT NULL,
    source_type        text,           -- order / reservation
    source_id          uuid,
    created_by         uuid NOT NULL REFERENCES members(id),
    starts_at          timestamptz NOT NULL DEFAULT now(),
    ends_at            timestamptz,
    lifted_at          timestamptz,
    lifted_by          uuid REFERENCES members(id),
    lift_reason        text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX ON access_blocks(client_identity_id);

-- 現地コード入力・レート制限の試行記録
CREATE TABLE attempt_logs (
    id          bigserial PRIMARY KEY,
    kind        text NOT NULL,      -- site_code / order_create / reservation_create / qr_verify
    subject     text NOT NULL,      -- 識別子ハッシュ or IPハッシュ
    success     boolean NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON attempt_logs(kind, subject, created_at);

-- ---------------------------------------------------------------
-- 現金保管先（個人財布・金庫・共用レジ）
-- ---------------------------------------------------------------
CREATE TABLE cash_accounts (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    kind       text NOT NULL CHECK (kind IN ('wallet','safe','register')),
    member_id  uuid REFERENCES members(id),   -- 個人財布の持ち主
    active     boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (kind <> 'wallet' OR member_id IS NOT NULL)
);
CREATE UNIQUE INDEX cash_accounts_one_wallet ON cash_accounts(member_id) WHERE kind = 'wallet' AND active;

-- ---------------------------------------------------------------
-- 注文
-- ---------------------------------------------------------------
CREATE TABLE order_counters (
    department_id uuid NOT NULL REFERENCES departments(id),
    business_day  date NOT NULL,
    last_number   integer NOT NULL DEFAULT 0,
    PRIMARY KEY (department_id, business_day)
);

CREATE TABLE orders (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id      uuid NOT NULL REFERENCES departments(id),
    business_day       date NOT NULL,
    call_number        integer NOT NULL CHECK (call_number > 0),
    channel            text NOT NULL CHECK (channel IN ('staff','web','appclip','ios','android')),
    client_identity_id uuid REFERENCES client_identities(id),
    access_token_hash  text UNIQUE,
    status             text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','cancelled','completed')),
    payment_status     text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','partially_refunded','refunded')),
    handoff_status     text NOT NULL DEFAULT 'pending' CHECK (handoff_status IN ('pending','handed')),
    subtotal           integer NOT NULL CHECK (subtotal >= 0),
    discount           integer NOT NULL DEFAULT 0 CHECK (discount >= 0),
    total              integer NOT NULL CHECK (total >= 0),
    created_by         uuid REFERENCES members(id),
    cancelled_by       uuid REFERENCES members(id),
    cancel_reason      text,
    handed_by          uuid REFERENCES members(id),
    handed_at          timestamptz,
    unpaid_handoff_reason text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (department_id, business_day, call_number),
    CHECK (discount <= subtotal),
    CHECK (total = subtotal - discount)
);
CREATE INDEX ON orders(department_id, business_day, status);
CREATE INDEX ON orders(client_identity_id);

CREATE TABLE order_items (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id      uuid NOT NULL REFERENCES orders(id),
    variant_id    uuid NOT NULL REFERENCES product_variants(id),
    product_id    uuid NOT NULL REFERENCES products(id),
    -- 販売時点のスナップショット
    product_name  text NOT NULL,
    options_label text NOT NULL DEFAULT '',
    options_json  jsonb NOT NULL DEFAULT '[]',
    unit_price    integer NOT NULL CHECK (unit_price >= 0),
    quantity      integer NOT NULL CHECK (quantity > 0),
    line_total    integer NOT NULL CHECK (line_total >= 0),
    discount      integer NOT NULL DEFAULT 0 CHECK (discount >= 0),
    needs_cooking boolean NOT NULL,
    cook_status   text NOT NULL CHECK (cook_status IN ('waiting','cooking','cooked','cancelled','not_required')),
    excluded      boolean NOT NULL DEFAULT false,  -- 支払前に明細取消され、請求から除外された
    sort_order    integer NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (line_total = unit_price * quantity),
    CHECK (discount <= line_total)
);
CREATE INDEX ON order_items(order_id);

CREATE TABLE order_events (
    id         bigserial PRIMARY KEY,
    order_id   uuid NOT NULL REFERENCES orders(id),
    item_id    uuid REFERENCES order_items(id),
    kind       text NOT NULL,   -- cook / handoff / cancel / correction / payment / refund
    from_state text,
    to_state   text,
    member_id  uuid REFERENCES members(id),
    reason     text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON order_events(order_id);

CREATE TABLE payments (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id         uuid NOT NULL REFERENCES orders(id),
    amount           integer NOT NULL CHECK (amount >= 0),         -- 請求額（割引後）
    cash_received    integer NOT NULL DEFAULT 0 CHECK (cash_received >= 0),
    voucher_received integer NOT NULL DEFAULT 0 CHECK (voucher_received >= 0),
    change_given     integer NOT NULL DEFAULT 0 CHECK (change_given >= 0),
    cash_account_id  uuid REFERENCES cash_accounts(id),
    member_id        uuid NOT NULL REFERENCES members(id),
    status           text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CHECK (cash_received + voucher_received - change_given = amount),
    CHECK (amount = 0 OR cash_account_id IS NOT NULL)
);
CREATE UNIQUE INDEX payments_one_per_order ON payments(order_id) WHERE status = 'completed';

CREATE TABLE refunds (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id      uuid NOT NULL REFERENCES payments(id),
    order_id        uuid NOT NULL REFERENCES orders(id),
    amount          integer NOT NULL CHECK (amount > 0),
    cash_account_id uuid NOT NULL REFERENCES cash_accounts(id),
    member_id       uuid NOT NULL REFERENCES members(id),
    reason          text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON refunds(payment_id);

-- 返金累計が元入金を超えないことをDBでも保証
CREATE FUNCTION refunds_not_exceed() RETURNS trigger AS $$
DECLARE paid integer; refunded integer;
BEGIN
    SELECT amount INTO paid FROM payments WHERE id = NEW.payment_id FOR UPDATE;
    SELECT COALESCE(SUM(amount),0) INTO refunded FROM refunds WHERE payment_id = NEW.payment_id;
    IF refunded + NEW.amount > paid THEN
        RAISE EXCEPTION 'refund exceeds payment' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER refunds_not_exceed BEFORE INSERT ON refunds FOR EACH ROW EXECUTE FUNCTION refunds_not_exceed();

-- ---------------------------------------------------------------
-- 現金移動
-- ---------------------------------------------------------------
CREATE TABLE cash_transfers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind            text NOT NULL CHECK (kind IN ('handover','collection')),
    from_account_id uuid NOT NULL REFERENCES cash_accounts(id),
    to_account_id   uuid NOT NULL REFERENCES cash_accounts(id),
    medium          text NOT NULL DEFAULT 'cash' CHECK (medium IN ('cash','voucher')),
    amount          integer NOT NULL CHECK (amount > 0),
    status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected','cancelled')),
    reason          text NOT NULL DEFAULT '',
    requested_by    uuid NOT NULL REFERENCES members(id),
    decided_by      uuid REFERENCES members(id),
    decided_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (from_account_id <> to_account_id)
);

CREATE TABLE cash_reconciliations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cash_account_id     uuid NOT NULL REFERENCES cash_accounts(id),
    medium              text NOT NULL DEFAULT 'cash' CHECK (medium IN ('cash','voucher')),
    theoretical_balance integer NOT NULL,
    actual_balance      integer NOT NULL CHECK (actual_balance >= 0),
    difference          integer NOT NULL,
    note                text NOT NULL DEFAULT '',
    counted_by          uuid NOT NULL REFERENCES members(id),
    confirmed_by        uuid NOT NULL REFERENCES members(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    CHECK (difference = actual_balance - theoretical_balance)
);

-- 残高計算用の入出金明細（符号付き）。理論残高 = SUM(amount)
CREATE TABLE cash_entries (
    id                bigserial PRIMARY KEY,
    cash_account_id   uuid NOT NULL REFERENCES cash_accounts(id),
    medium            text NOT NULL DEFAULT 'cash' CHECK (medium IN ('cash','voucher')),
    kind              text NOT NULL CHECK (kind IN ('opening','sale','refund','transfer_in','transfer_out','adjustment')),
    amount            integer NOT NULL CHECK (amount <> 0),
    payment_id        uuid REFERENCES payments(id),
    refund_id         uuid REFERENCES refunds(id),
    transfer_id       uuid REFERENCES cash_transfers(id),
    reconciliation_id uuid REFERENCES cash_reconciliations(id),
    member_id         uuid NOT NULL REFERENCES members(id),
    reason            text NOT NULL DEFAULT '',
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON cash_entries(cash_account_id, medium);

-- ---------------------------------------------------------------
-- プラネタリウム
-- ---------------------------------------------------------------
CREATE TABLE screening_rules (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id  uuid NOT NULL REFERENCES departments(id),
    business_day   date NOT NULL,
    title          text NOT NULL,
    window_start   time NOT NULL,
    window_end     time NOT NULL,
    interval_min   integer NOT NULL DEFAULT 15 CHECK (interval_min > 0),
    duration_min   integer NOT NULL CHECK (duration_min > 0),
    turnover_min   integer NOT NULL DEFAULT 0 CHECK (turnover_min >= 0),
    capacity       integer NOT NULL CHECK (capacity > 0),
    reserve_quota  integer CHECK (reserve_quota IS NULL OR reserve_quota >= 0),
    booking_opens_before_min  integer,   -- 上映開始の何分前から予約受付（NULL=即時）
    booking_closes_before_min integer NOT NULL DEFAULT 0,
    created_by     uuid REFERENCES members(id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CHECK (window_end > window_start)
);

CREATE TABLE screenings (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id      uuid NOT NULL REFERENCES departments(id),
    rule_id            uuid REFERENCES screening_rules(id),
    title              text NOT NULL,
    business_day       date NOT NULL,
    starts_at          timestamptz NOT NULL,
    ends_at            timestamptz NOT NULL,
    occupied_until     timestamptz NOT NULL,   -- 終了＋入替時間
    capacity           integer NOT NULL CHECK (capacity > 0),
    reserve_quota      integer CHECK (reserve_quota IS NULL OR (reserve_quota >= 0 AND reserve_quota <= capacity)),
    reserved_count     integer NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),  -- 事前予約の確保人数
    walkin_count       integer NOT NULL DEFAULT 0 CHECK (walkin_count >= 0),    -- 当日受付の確保人数
    booking_opens_at   timestamptz,
    booking_closes_at  timestamptz,
    visibility         text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','hidden')),
    booking_status     text NOT NULL DEFAULT 'open' CHECK (booking_status IN ('open','paused','closed')),
    run_status         text NOT NULL DEFAULT 'scheduled' CHECK (run_status IN ('scheduled','running','finished','cancelled')),
    manually_edited    boolean NOT NULL DEFAULT false,
    coupons_issued_at  timestamptz,
    cancel_reason      text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at),
    CHECK (occupied_until >= ends_at),
    CHECK (reserved_count + walkin_count <= capacity),
    CHECK (reserve_quota IS NULL OR reserved_count <= reserve_quota),
    EXCLUDE USING gist (department_id WITH =, tstzrange(starts_at, occupied_until) WITH &&) WHERE (run_status <> 'cancelled')
);
CREATE INDEX ON screenings(business_day, starts_at);

CREATE TABLE reservation_counters (
    business_day date PRIMARY KEY,
    last_number  integer NOT NULL DEFAULT 0
);

CREATE TABLE reservations (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    screening_id       uuid NOT NULL REFERENCES screenings(id),
    public_no          text NOT NULL UNIQUE,
    kind               text NOT NULL CHECK (kind IN ('advance','walkin')),
    name               text NOT NULL DEFAULT '',
    party_size         integer NOT NULL CHECK (party_size > 0),
    status             text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled_self','cancelled_staff','cancelled_screening')),
    access_token_hash  text UNIQUE,
    client_identity_id uuid REFERENCES client_identities(id),
    created_by         uuid REFERENCES members(id),
    cancelled_by       uuid REFERENCES members(id),
    cancel_reason      text,
    cancelled_at       timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON reservations(screening_id);
CREATE INDEX ON reservations(client_identity_id);

CREATE TABLE admission_tickets (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id   uuid NOT NULL REFERENCES reservations(id),
    screening_id     uuid NOT NULL REFERENCES screenings(id),
    seq              integer NOT NULL CHECK (seq > 0),
    public_no        text NOT NULL UNIQUE,
    entry_token_hash text NOT NULL UNIQUE,
    status           text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','void')),
    admitted_at      timestamptz,
    admitted_by      uuid REFERENCES members(id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (reservation_id, seq)
);

CREATE TABLE checkin_events (
    id          bigserial PRIMARY KEY,
    ticket_id   uuid NOT NULL REFERENCES admission_tickets(id),
    kind        text NOT NULL CHECK (kind IN ('checkin','revert','rejected')),
    detail      text NOT NULL DEFAULT '',
    member_id   uuid REFERENCES members(id),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON checkin_events(ticket_id);

CREATE TABLE wallet_passes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id   uuid NOT NULL UNIQUE REFERENCES admission_tickets(id),
    serial      text NOT NULL UNIQUE,
    version     integer NOT NULL DEFAULT 1,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- クーポン
-- ---------------------------------------------------------------
CREATE TABLE coupon_definitions (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name               text NOT NULL,
    description        text NOT NULL DEFAULT '',
    discount_type      text NOT NULL CHECK (discount_type IN ('fixed','percent')),
    discount_value     integer NOT NULL CHECK (discount_value > 0),
    -- order: 注文全体から割引 / items: 対象商品から割引
    scope              text NOT NULL CHECK (scope IN ('order','items')),
    target_department_id uuid REFERENCES departments(id),
    items_per_person   integer NOT NULL DEFAULT 1 CHECK (items_per_person > 0),
    -- 対象商品が複数あるときの割当順（明示設定）
    allocation         text NOT NULL DEFAULT 'highest_price_first' CHECK (allocation IN ('highest_price_first','lowest_price_first')),
    max_discount       integer CHECK (max_discount IS NULL OR max_discount > 0),
    holder_mode        text NOT NULL DEFAULT 'per_person' CHECK (holder_mode IN ('per_person','group')),
    splittable         boolean NOT NULL DEFAULT true,
    combinable         boolean NOT NULL DEFAULT false,
    valid_from         timestamptz,
    valid_until        timestamptz,
    max_issues         integer CHECK (max_issues IS NULL OR max_issues > 0),
    auto_issue         text NOT NULL DEFAULT 'none' CHECK (auto_issue IN ('none','screening_attended')),
    active             boolean NOT NULL DEFAULT true,
    created_by         uuid REFERENCES members(id),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CHECK (discount_type <> 'percent' OR discount_value <= 100),
    CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from)
);

CREATE TABLE coupon_targets (
    definition_id uuid NOT NULL REFERENCES coupon_definitions(id),
    product_id    uuid REFERENCES products(id),
    variant_id    uuid REFERENCES product_variants(id),
    CHECK ((product_id IS NULL) <> (variant_id IS NULL))
);
CREATE UNIQUE INDEX ON coupon_targets(definition_id, COALESCE(product_id, variant_id));

CREATE TABLE issued_coupons (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    definition_id      uuid NOT NULL REFERENCES coupon_definitions(id),
    public_no          text NOT NULL UNIQUE,
    token_hash         text NOT NULL UNIQUE,
    snapshot           jsonb NOT NULL,        -- 発券時の条件（定義変更を遡及させない）
    persons_total      integer NOT NULL CHECK (persons_total > 0),
    persons_remaining  integer NOT NULL CHECK (persons_remaining >= 0),
    status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','revoked')),
    valid_from         timestamptz,
    valid_until        timestamptz,
    source_kind        text NOT NULL CHECK (source_kind IN ('auto_screening','manual')),
    source_reservation_id uuid REFERENCES reservations(id),
    source_ticket_id   uuid REFERENCES admission_tickets(id),
    issued_by          uuid REFERENCES members(id),
    revoked_by         uuid REFERENCES members(id),
    revoke_reason      text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CHECK (persons_remaining <= persons_total)
);
CREATE UNIQUE INDEX issued_coupons_auto_ticket ON issued_coupons(definition_id, source_ticket_id) WHERE source_kind = 'auto_screening' AND source_ticket_id IS NOT NULL;
CREATE UNIQUE INDEX issued_coupons_auto_reservation ON issued_coupons(definition_id, source_reservation_id) WHERE source_kind = 'auto_screening' AND source_ticket_id IS NULL;
CREATE INDEX ON issued_coupons(source_reservation_id);

CREATE TABLE coupon_redemptions (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    issued_coupon_id  uuid NOT NULL REFERENCES issued_coupons(id),
    order_id          uuid NOT NULL REFERENCES orders(id),
    payment_id        uuid NOT NULL REFERENCES payments(id),
    persons           integer NOT NULL CHECK (persons > 0),
    discount          integer NOT NULL CHECK (discount >= 0),
    forfeited_persons integer NOT NULL DEFAULT 0 CHECK (forfeited_persons >= 0),
    status            text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','reversed')),
    member_id         uuid NOT NULL REFERENCES members(id),
    reversed_by       uuid REFERENCES members(id),
    reversed_at       timestamptz,
    reverse_reason    text,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON coupon_redemptions(issued_coupon_id);
CREATE INDEX ON coupon_redemptions(order_id);

-- ---------------------------------------------------------------
-- シフト
-- ---------------------------------------------------------------
CREATE TABLE shift_slots (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_day   date NOT NULL,
    location       text NOT NULL,
    starts_at      timestamptz NOT NULL,
    ends_at        timestamptz NOT NULL,
    required_count integer NOT NULL CHECK (required_count > 0),
    note           text NOT NULL DEFAULT '',
    active         boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at)
);

CREATE TABLE shift_requests (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slot_id     uuid NOT NULL REFERENCES shift_slots(id),
    member_id   uuid NOT NULL REFERENCES members(id),
    preference  text NOT NULL CHECK (preference IN ('want','ok','ng')),
    note        text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (slot_id, member_id)
);

CREATE TABLE shift_assignments (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slot_id     uuid NOT NULL REFERENCES shift_slots(id),
    member_id   uuid NOT NULL REFERENCES members(id),
    status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
    assigned_by uuid NOT NULL REFERENCES members(id),
    removed_by  uuid REFERENCES members(id),
    remove_reason text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    removed_at  timestamptz
);
CREATE UNIQUE INDEX shift_assignments_active ON shift_assignments(slot_id, member_id) WHERE status = 'active';

CREATE TABLE shift_exchanges (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    assignment_id  uuid NOT NULL REFERENCES shift_assignments(id),
    from_member_id uuid NOT NULL REFERENCES members(id),
    to_member_id   uuid NOT NULL REFERENCES members(id),
    status         text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','accepted','approved','declined','rejected','cancelled')),
    reason         text NOT NULL DEFAULT '',
    responded_at   timestamptz,
    decided_by     uuid REFERENCES members(id),
    decided_at     timestamptz,
    new_assignment_id uuid REFERENCES shift_assignments(id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CHECK (from_member_id <> to_member_id)
);
CREATE UNIQUE INDEX shift_exchanges_open ON shift_exchanges(assignment_id) WHERE status IN ('requested','accepted');

-- ---------------------------------------------------------------
-- 通知・監査・冪等性
-- ---------------------------------------------------------------
CREATE TABLE notifications (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id  uuid NOT NULL REFERENCES members(id),
    kind       text NOT NULL,
    title      text NOT NULL,
    body       text NOT NULL DEFAULT '',
    link       text NOT NULL DEFAULT '',
    read_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON notifications(member_id, read_at);

CREATE TABLE audit_logs (
    id          bigserial PRIMARY KEY,
    member_id   uuid REFERENCES members(id),
    action      text NOT NULL,
    target_type text NOT NULL,
    target_id   text NOT NULL,
    detail      jsonb NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_logs(target_type, target_id);
CREATE INDEX ON audit_logs(created_at);

CREATE TABLE idempotency_records (
    scope         text NOT NULL,
    key           text NOT NULL,
    request_hash  text NOT NULL,
    status        text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','done')),
    response_code integer,
    response_body bytea,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (scope, key)
);
