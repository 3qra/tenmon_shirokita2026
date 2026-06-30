# FastAPI Backend Manual

## 目的

城北祭の天文部アプリで使う FastAPI バックエンドの設計メモです。
屋台注文、プラネタリウム予約、スタッフ操作、権限管理を API と DB で一元管理します。

## 基本方針

- 認証はログイン時にアクセストークンを発行し、以後の API は `Authorization: Bearer <token>` で認証する。
- ログアウト時はトークンを無効化する。期限切れ、無効化済み、存在しないトークンは認証失敗にする。
- 権限はユーザーに直接持たせず、ロールとパーミッションで管理する。
- 商品購入は 1 回の注文に複数の商品明細をまとめる。
- 注文番号はサーバー側で発行する。受け渡し待ちや呼び出しに使える短い番号も別に持つ。
- 即時提供商品と待ち商品を区別できるようにする。
- 重要操作はユーザー操作ログに必ず残す。

## ロールと権限

### 想定ロール

| ロール | 用途 |
| --- | --- |
| `admin` | 全体管理、ユーザー管理、売上確認、予約枠管理 |
| `staff` | 注文受付、提供処理、予約確認 |
| `viewer` | 閲覧のみ |

### 想定パーミッション

| パーミッション | 用途 |
| --- | --- |
| `users:read` | ユーザー一覧、詳細の閲覧 |
| `users:write` | ユーザー作成、更新、停止 |
| `orders:read` | 屋台注文の閲覧 |
| `orders:write` | 屋台注文の作成、変更 |
| `orders:serve` | 商品提供、呼び出し、完了処理 |
| `reservations:read` | プラネタリウム予約の閲覧 |
| `reservations:write` | 予約作成、変更、キャンセル |
| `slots:write` | 予約枠の作成、変更 |
| `logs:read` | 操作ログの閲覧 |

## テーブル設計

DB は PostgreSQL を想定します。SQLite でも開発は可能ですが、本番は同時更新と集計を考えて PostgreSQL を推奨します。

### roles

ロール定義です。

| カラム | 型 | 内容 |
| --- | --- | --- |
| `id` | UUID / INT | 主キー |
| `name` | VARCHAR UNIQUE | `admin`, `staff` など |
| `description` | TEXT | 説明 |
| `created_at` | TIMESTAMP | 作成日時 |
| `updated_at` | TIMESTAMP | 更新日時 |

### permissions

権限定義です。

| カラム | 型 | 内容 |
| --- | --- | --- |
| `id` | UUID / INT | 主キー |
| `code` | VARCHAR UNIQUE | `orders:write` など |
| `description` | TEXT | 説明 |
| `created_at` | TIMESTAMP | 作成日時 |

### role_permissions

ロールと権限の中間テーブルです。

| カラム | 型 | 内容 |
| --- | --- | --- |
| `role_id` | FK | `roles.id` |
| `permission_id` | FK | `permissions.id` |

`role_id` と `permission_id` の組み合わせを UNIQUE にします。

### users

管理画面やスタッフ操作を行うユーザー情報です。

| カラム | 型 | 内容 |
| --- | --- | --- |
| `id` | UUID / INT | 主キー |
| `role_id` | FK | `roles.id` |
| `login_id` | VARCHAR UNIQUE | ログインID |
| `password_hash` | VARCHAR | ハッシュ化済みパスワード |
| `display_name` | VARCHAR | 表示名 |
| `email` | VARCHAR NULL | メールアドレス |
| `is_active` | BOOLEAN | 有効ユーザーか |
| `last_login_at` | TIMESTAMP NULL | 最終ログイン日時 |
| `created_at` | TIMESTAMP | 作成日時 |
| `updated_at` | TIMESTAMP | 更新日時 |

### auth_tokens

ログイン中トークンの管理です。

| カラム | 型 | 内容 |
| --- | --- | --- |
| `id` | UUID / INT | 主キー |
| `user_id` | FK | `users.id` |
| `token_hash` | VARCHAR UNIQUE | トークンのハッシュ |
| `expires_at` | TIMESTAMP | 認証期限 |
| `revoked_at` | TIMESTAMP NULL | ログアウトなどで無効化した日時 |
| `ip_address` | VARCHAR NULL | ログイン元IP |
| `user_agent` | TEXT NULL | 端末/ブラウザ情報 |
| `created_at` | TIMESTAMP | 作成日時 |

トークン本体は DB に保存せず、ハッシュだけ保存します。

### menu_items

屋台商品のマスタです。

| カラム | 型 | 内容 |
| --- | --- | --- |
| `id` | UUID / INT | 主キー |
| `name` | VARCHAR | 商品名 |
| `price` | INT | 単価 |
| `is_active` | BOOLEAN | 販売中か |
| `default_immediate` | BOOLEAN | 通常は即時提供か |
| `sort_order` | INT | 表示順 |
| `created_at` | TIMESTAMP | 作成日時 |
| `updated_at` | TIMESTAMP | 更新日時 |

### menu_item_options

商品オプションです。例: マヨネーズ抜き、辛口、トッピングなど。

| カラム | 型 | 内容 |
| --- | --- | --- |
| `id` | UUID / INT | 主キー |
| `menu_item_id` | FK | `menu_items.id` |
| `name` | VARCHAR | オプション名 |
| `price_delta` | INT | 追加料金。無料なら 0 |
| `is_active` | BOOLEAN | 選択可能か |
| `created_at` | TIMESTAMP | 作成日時 |

### stall_orders

屋台注文の親テーブルです。1 回の会計単位です。

| カラム | 型 | 内容 |
| --- | --- | --- |
| `id` | UUID / INT | 主キー |
| `order_no` | VARCHAR UNIQUE | 注文番号。例: `O-20260630-0001` |
| `call_no` | INT NULL | 呼び出し番号 |
| `created_by_user_id` | FK | 受付スタッフ |
| `status` | VARCHAR | `pending`, `preparing`, `ready`, `served`, `cancelled` |
| `total_amount` | INT | 合計金額 |
| `paid_amount` | INT | 受領金額 |
| `payment_method` | VARCHAR | `cash`, `other` など |
| `note` | TEXT NULL | 備考 |
| `created_at` | TIMESTAMP | 注文日時 |
| `updated_at` | TIMESTAMP | 更新日時 |
| `served_at` | TIMESTAMP NULL | 提供完了日時 |
| `cancelled_at` | TIMESTAMP NULL | キャンセル日時 |

### stall_order_items

注文内の商品明細です。

| カラム | 型 | 内容 |
| --- | --- | --- |
| `id` | UUID / INT | 主キー |
| `order_id` | FK | `stall_orders.id` |
| `menu_item_id` | FK | `menu_items.id` |
| `item_name` | VARCHAR | 注文時点の商品名スナップショット |
| `unit_price` | INT | 注文時点の単価 |
| `quantity` | INT | 個数 |
| `line_total` | INT | 小計 |
| `is_immediate` | BOOLEAN | 即時提供か |
| `status` | VARCHAR | `pending`, `preparing`, `ready`, `served`, `cancelled` |
| `provided_at` | TIMESTAMP NULL | 提供日時 |

### stall_order_item_options

明細に対するオプション選択です。

| カラム | 型 | 内容 |
| --- | --- | --- |
| `id` | UUID / INT | 主キー |
| `order_item_id` | FK | `stall_order_items.id` |
| `option_id` | FK NULL | `menu_item_options.id`。削除済み対策で NULL 可 |
| `option_name` | VARCHAR | 注文時点のオプション名 |
| `price_delta` | INT | 注文時点の追加料金 |

### planetarium_slots

プラネタリウム予約枠です。

| カラム | 型 | 内容 |
| --- | --- | --- |
| `id` | UUID / INT | 主キー |
| `title` | VARCHAR | 枠名。例: 第1回 |
| `starts_at` | TIMESTAMP | 開始日時 |
| `ends_at` | TIMESTAMP | 終了日時 |
| `capacity` | INT | 定員 |
| `reserved_count` | INT | 予約済み人数 |
| `is_active` | BOOLEAN | 予約可能か |
| `created_at` | TIMESTAMP | 作成日時 |
| `updated_at` | TIMESTAMP | 更新日時 |

### planetarium_reservations

プラネタリウム予約です。

| カラム | 型 | 内容 |
| --- | --- | --- |
| `id` | UUID / INT | 主キー |
| `slot_id` | FK | `planetarium_slots.id` |
| `reservation_no` | VARCHAR UNIQUE | 予約番号 |
| `name` | VARCHAR | 予約者名 |
| `contact_type` | VARCHAR | `email`, `line`, `apple` |
| `contact_value` | VARCHAR | メアド、LINEユニークID、AppleユニークID |
| `people_count` | INT | 人数 |
| `status` | VARCHAR | `reserved`, `checked_in`, `cancelled`, `no_show` |
| `created_at` | TIMESTAMP | 予約日時 |
| `updated_at` | TIMESTAMP | 更新日時 |
| `checked_in_at` | TIMESTAMP NULL | 入場確認日時 |
| `cancelled_at` | TIMESTAMP NULL | キャンセル日時 |

同じ人の重複予約を防ぐため、基本は `slot_id`, `contact_type`, `contact_value` を UNIQUE にします。

### user_operation_logs

スタッフや管理者の操作ログです。

| カラム | 型 | 内容 |
| --- | --- | --- |
| `id` | UUID / INT | 主キー |
| `user_id` | FK NULL | 操作ユーザー。未ログイン操作なら NULL |
| `action` | VARCHAR | `login`, `logout`, `order.create` など |
| `target_type` | VARCHAR NULL | `order`, `reservation`, `user` など |
| `target_id` | VARCHAR NULL | 対象ID |
| `ip_address` | VARCHAR NULL | IPアドレス |
| `user_agent` | TEXT NULL | 端末/ブラウザ情報 |
| `metadata` | JSON | 変更内容や補足 |
| `created_at` | TIMESTAMP | 操作日時 |

## API 仕様

### 認証

#### POST `/auth/login`

ログインします。

Request:

```json
{
  "login_id": "staff01",
  "password": "password"
}
```

Response:

```json
{
  "access_token": "token",
  "token_type": "bearer",
  "expires_at": "2026-06-30T18:00:00+09:00",
  "user": {
    "id": "user-id",
    "login_id": "staff01",
    "display_name": "受付スタッフ",
    "role": "staff",
    "permissions": ["orders:read", "orders:write"]
  }
}
```

処理:

1. `login_id` でユーザーを検索する。
2. `is_active = true` であることを確認する。
3. パスワードハッシュを検証する。
4. トークンを発行し、`auth_tokens` にハッシュを保存する。
5. `user_operation_logs` に `login` を記録する。

#### POST `/auth/logout`

ログアウトします。

Header:

```http
Authorization: Bearer <token>
```

Response:

```json
{
  "ok": true
}
```

処理:

1. 現在のトークンを特定する。
2. `auth_tokens.revoked_at` に現在時刻を入れる。
3. `user_operation_logs` に `logout` を記録する。

#### GET `/auth/me`

現在ログイン中のユーザー情報を返します。

### 屋台注文

#### POST `/stall/orders`

複数商品をまとめて注文します。

Request:

```json
{
  "payment_method": "cash",
  "paid_amount": 1500,
  "note": "急ぎ",
  "items": [
    {
      "menu_item_id": "item-1",
      "quantity": 2,
      "is_immediate": true,
      "option_ids": ["option-1"]
    },
    {
      "menu_item_id": "item-2",
      "quantity": 1,
      "is_immediate": false,
      "option_ids": []
    }
  ]
}
```

Response:

```json
{
  "id": "order-id",
  "order_no": "O-20260630-0001",
  "call_no": 12,
  "status": "preparing",
  "total_amount": 1300,
  "paid_amount": 1500,
  "change_amount": 200,
  "items": [
    {
      "id": "order-item-id",
      "name": "商品A",
      "quantity": 2,
      "is_immediate": true,
      "status": "served"
    }
  ]
}
```

処理:

1. 商品とオプションの有効性を確認する。
2. 単価、オプション料金、数量から合計金額を計算する。
3. `order_no` と必要なら `call_no` を発行する。
4. 即時提供の商品は `served`、待ち商品のある注文は `preparing` にする。
5. `stall_orders`, `stall_order_items`, `stall_order_item_options` を同一トランザクションで作成する。
6. `user_operation_logs` に `order.create` を記録する。

#### GET `/stall/orders`

注文一覧を取得します。

Query:

| パラメータ | 内容 |
| --- | --- |
| `status` | `pending`, `preparing`, `ready`, `served`, `cancelled` |
| `date` | 対象日 |
| `q` | 注文番号、呼び出し番号検索 |

#### GET `/stall/orders/{order_id}`

注文詳細を取得します。

#### PATCH `/stall/orders/{order_id}/items/{item_id}/status`

商品明細の状態を変更します。

Request:

```json
{
  "status": "ready"
}
```

待ち商品を `ready` にすると呼び出し対象になります。すべての商品が `served` になったら注文全体も `served` にします。

#### PATCH `/stall/orders/{order_id}/cancel`

注文をキャンセルします。キャンセル理由は `note` またはログの `metadata` に残します。

### プラネタリウム予約

#### GET `/planetarium/slots`

予約可能な枠一覧を取得します。

#### POST `/planetarium/slots`

予約枠を作成します。必要権限は `slots:write` です。

Request:

```json
{
  "title": "第1回",
  "starts_at": "2026-07-01T10:00:00+09:00",
  "ends_at": "2026-07-01T10:20:00+09:00",
  "capacity": 30
}
```

#### POST `/planetarium/reservations`

予約を作成します。

Request:

```json
{
  "slot_id": "slot-id",
  "name": "山田太郎",
  "contact_type": "line",
  "contact_value": "line-unique-id",
  "people_count": 2
}
```

Response:

```json
{
  "id": "reservation-id",
  "reservation_no": "P-20260630-0001",
  "status": "reserved"
}
```

処理:

1. 枠が有効で、残席があることを確認する。
2. `people_count` 分の空きがあることを確認する。
3. 同じ `slot_id`, `contact_type`, `contact_value` の予約がないことを確認する。
4. 予約を作成し、枠の `reserved_count` を増やす。
5. 操作ログを残す。

#### PATCH `/planetarium/reservations/{reservation_id}/check-in`

入場確認をします。

#### PATCH `/planetarium/reservations/{reservation_id}/cancel`

予約をキャンセルし、枠の `reserved_count` を戻します。

### ユーザー管理

#### GET `/users`

ユーザー一覧を取得します。必要権限は `users:read` です。

#### POST `/users`

ユーザーを作成します。必要権限は `users:write` です。

#### PATCH `/users/{user_id}`

ユーザー情報、ロール、有効状態を更新します。

### 操作ログ

#### GET `/operation-logs`

操作ログを取得します。必要権限は `logs:read` です。

Query:

| パラメータ | 内容 |
| --- | --- |
| `user_id` | 操作ユーザー |
| `action` | 操作種別 |
| `target_type` | 対象種別 |
| `from` | 開始日時 |
| `to` | 終了日時 |

## ステータス定義

### 注文ステータス

| 値 | 意味 |
| --- | --- |
| `pending` | 受付直後 |
| `preparing` | 調理・準備中 |
| `ready` | 受け渡し可能 |
| `served` | 提供完了 |
| `cancelled` | キャンセル |

### 予約ステータス

| 値 | 意味 |
| --- | --- |
| `reserved` | 予約済み |
| `checked_in` | 入場済み |
| `cancelled` | キャンセル |
| `no_show` | 来場なし |

## 実装時の注意

- パスワードは `passlib` の bcrypt などでハッシュ化する。
- トークンは十分に長いランダム文字列にし、DB にはハッシュだけ保存する。
- 金額計算は必ずサーバー側で行う。クライアントから送られた合計金額は信用しない。
- 注文作成と予約作成はトランザクションで処理する。
- 予約枠の残席更新は競合しやすいので、行ロックまたは条件付き更新で二重予約を防ぐ。
- 個人情報を含む `contact_value` は必要最小限にし、管理画面では表示権限を分ける。
- 操作ログは削除しない。不要になったら別途アーカイブする。

## 推奨ディレクトリ構成

```text
backend/
  main.py
  app/
    api/
      auth.py
      users.py
      stall_orders.py
      planetarium.py
      operation_logs.py
    core/
      config.py
      security.py
      permissions.py
    db/
      session.py
      base.py
    models/
      user.py
      auth_token.py
      role.py
      stall_order.py
      planetarium.py
      operation_log.py
    schemas/
      auth.py
      user.py
      stall_order.py
      planetarium.py
      operation_log.py
    services/
      auth_service.py
      order_service.py
      reservation_service.py
```
