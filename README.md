# 学祭部活ポータル

3日間の学祭で、やきうどん販売、プラネタリウム上映（予約・当日受付・QR入場）、会場物販、クーポン、担当現金、部員シフトをまとめて管理するシステムです。
要件は [docs/仕様設計書.md](docs/仕様設計書.md) を基準にしています。仮案として決めた値や判断は [docs/設計メモ.md](docs/設計メモ.md) にまとめました。

## 構成

| ディレクトリ | 内容 |
|---|---|
| `api/` | 業務API（Go 1.24、外部依存は PostgreSQL ドライバのみ）。価格・権限・定員・状態遷移・割引の判定はすべてここで行う |
| `api/migrations/` | DBマイグレーション（起動時に自動適用） |
| `web/` | Web（Next.js 15）。来場者・スタッフ・管理・公開ディスプレイの画面 |
| `ios/` | iOS アプリ（SwiftUI）と来場者注文用 App Clip。XcodeGen でプロジェクトを生成 |
| `android/` | Android アプリ（Kotlin / Jetpack Compose） |
| `deploy/` | Caddy 設定（HTTPS・リバースプロキシ）、App Clip / App Links の検証ファイル |
| `scripts/` | バックアップ・復旧・ダミーデータ投入 |
| `docs/` | 仕様書、OpenAPI（`openapi.yaml`）、設計メモ、当日運用手順 |

```
来場者のスマホ / スタッフ端末 / 表示用ディスプレイ
        │ HTTPS
      Caddy ──/api/*──▶ Go API ──▶ PostgreSQL
        └──その他────▶ Next.js
```

## 起動（本番・Docker Compose）

1. サーバーに Docker と Docker Compose を入れる。
2. `cp .env.example .env` で設定ファイルを作り、値を書き換える。
   - `SITE_ADDRESS` と `PUBLIC_BASE_URL` に実際のドメイン。DNS がサーバーを向いていれば、Caddy が HTTPS 証明書を自動で取る。
   - `POSTGRES_PASSWORD`、`APP_SECRET`（`openssl rand -base64 48` などで生成）、`BOOTSTRAP_ADMIN_PASSWORD`。
3. `docker compose up -d --build`
4. ブラウザで `https://<ドメイン>/staff/login` を開き、`.env` の管理者でログインする。
5. 必要ならダミーデータを入れる：`scripts/seed-demo.sh`（部門が1件もないときだけ入る）。

> この作業環境では Docker Hub につながらなかったため、`docker compose build` は実行できていません。設定ファイルの構文は `docker compose config` で確認済みです。初回はサーバーで実際にビルドして確認してください。

## 開発

```bash
# DB（ローカルの PostgreSQL 16 でも可）
docker run -d --name gs-db -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16-alpine

# API
cd api
export DATABASE_URL="postgres://postgres:dev@127.0.0.1:5432/postgres?sslmode=disable"
export APP_SECRET="dev-secret-dev-secret-dev-secret-0000"
export BOOTSTRAP_ADMIN_LOGIN=admin BOOTSTRAP_ADMIN_PASSWORD=adminpass123
go run ./cmd/server seed   # ダミーデータ
go run ./cmd/server        # :8080

# Web（/api は自動で :8080 に転送）
cd web && npm install && npm run dev   # http://localhost:3000
```

### ダミーデータのアカウント

パスワードはすべて `password123` です（管理者だけ `.env` で指定したもの）。**本番では必ず変更するか削除してください。**

| ログインID | 権限 |
|---|---|
| admin | 管理者（全権限） |
| cashier1 | 会計担当 |
| kitchen1 | キッチン担当 |
| reception1 | プラネ受付 |
| treasurer1 | 会計責任者＋会計担当 |
| display1 | 表示端末（現地コード表示用） |

ダミーデータの価格・開催日・定員・クーポン・シフト枠はすべて仮の値です。

### テスト

仕様書18章の受入条件を、実際の PostgreSQL で確かめる統合テストがあります。同時予約、同時入場、ボタン連打、クーポン同時利用、返金上限、現金引継ぎなどを含みます。

```bash
cd api
TEST_DATABASE_URL="postgres://postgres:dev@127.0.0.1:5432/postgres?sslmode=disable" go test ./... -race
```

テストのたびに一時データベースを作って、終わったら削除します。

## 主な画面

| URL | 用途 |
|---|---|
| `/` | 来場者ポータル |
| `/order/{部門ID}` | 注文（App Clip の起動URLと同じ形） |
| `/o/{token}` | 注文状況・呼出番号 |
| `/planetarium` | 上映一覧・予約 |
| `/r/{token}` | 予約確認・チケットQR・Wallet・取消 |
| `/c/{token}` | クーポン表示 |
| `/staff` | スタッフ（対面注文・会計、注文一覧・受渡、キッチン、プラネ受付、現金、売上・精算、シフト） |
| `/admin` | 管理（営業設定、商品、上映・自動生成、クーポン、ブロック、部員・権限、制限値、シフト配置、監査ログ） |
| `/display/udon/{部門ID}` | やきうどん公開ディスプレイ（呼出番号・現地コード。表示端末アカウントでログイン） |
| `/display/planetarium` | 上映・空席の公開表示 |

## API

- 仕様：[docs/openapi.yaml](docs/openapi.yaml)（OpenAPI 3.1）。
- 状態を変える要求には、Cookie 認証の場合 `X-Requested-With` ヘッダが必要です（CSRF対策）。アプリは `Authorization: Bearer` を使います。
- 注文作成、会計、返金、予約、当日受付、チェックイン、現金移動、精算には `Idempotency-Key` が必要です。同じキーで同じ内容を送ると前回の応答が返り、同じキーで内容が違うとエラーになります。
- リアルタイム反映には SSE（`/api/v1/events`）を使います。通知が来たら画面は API から最新状態を取り直します。切断されたら自動で再接続し、全件を取り直します。

## モバイル

- iOS：[ios/README.md](ios/README.md)。App Clip の起動URLは `https://<ドメイン>/order/{部門ID}` です。`deploy/well-known/apple-app-site-association` の `TEAMID` とバンドルIDを書き換えてください。
- Android：[android/README.md](android/README.md)。`deploy/well-known/assetlinks.json` に署名証明書の SHA-256 を入れてください。
- この作業環境には Xcode と Android SDK がないため、モバイルのコードはビルド未確認です。最初のビルドで型やライブラリのシグネチャの修正が少し出る見込みです。
- 会計、受渡、当日受付、現金、シフトなど、アプリにない業務はアプリから Web のスタッフ画面を開いて行います。

## Apple Wallet

`.env` の `WALLET_*` を設定し、Pass Type ID 証明書（PEM）、秘密鍵（PEM）、Apple WWDR 中間証明書（PEM）を `secrets/wallet/` に置きます。コンテナ内では `/run/secrets/wallet/...` として見えます。
未設定のあいだは Wallet ボタンが出ず、予約確認ページの QR で入場できます。発行済みパスの自動更新（中止・時刻変更の反映）は初期実装に含めていません。予約確認ページで最新の状態が見られます。

## 運用

- 当日の手順と通信断のときの対応：[docs/当日運用手順.md](docs/当日運用手順.md)
- バックアップ：`scripts/backup.sh`（cron で30分おきなど）。復旧：`scripts/restore.sh <ファイル>`
- `APP_SECRET` を変えると、発行済みの QR（入場・クーポン）と現地コードが無効になります。開催中は変えないでください。
- 秘密情報（`.env`、`secrets/`）はリポジトリに入れません（`.gitignore` 済み）。
