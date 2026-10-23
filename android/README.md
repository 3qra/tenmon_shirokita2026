# 学祭ポータル Android アプリ

Kotlin / Jetpack Compose（Material 3）製のAndroidクライアントです。minSdk 26・targetSdk 35。
価格計算・権限・定員・状態遷移・割引判定はすべて Go API（`/api/v1`）側で行い、アプリは表示と送信のみを行います。

## できること

| 区分 | 画面 |
|---|---|
| 来場者 | 注文（部門選択 → 商品・選択肢 → カート → サーバー見積 → 3桁の確認コード → 注文確定）、呼出番号と注文状況（SSEで自動更新）、取消 |
| 来場者 | プラネタリウム上映一覧（○△×と状態）、予約、予約確認（人数分の入場QR）、取消 |
| 来場者 | マイチケット・クーポン（この端末で注文・予約・表示したものを暗号化保存）、クーポンQR |
| スタッフ | ログイン、入場チェックイン（QR読取 → 確認 → 入場確定、手入力フォールバック）、クーポン確認（読むだけ・消費しない）、キッチン（調理開始・完了・訂正） |
| スタッフ | 会計・受渡・当日受付・管理などは「その他の業務をブラウザで開く」からWebのスタッフ画面へ |

## Android Studio で開く

1. Android Studio（Ladybug 2024.2 以降推奨）で `android/` フォルダを開きます。
2. Gradle ラッパーの JAR はリポジトリに含めていません。初回だけ次のどちらかで生成してください。
   - Gradle 8.10.2 以降がインストール済みなら：`cd android && gradle wrapper --gradle-version 8.10.2`
   - または Android Studio の Gradle 同期時に表示される案内に従う
3. 同期後、`app` 構成で実行します。JDK 17 以上が必要です。

## 接続先の設定（API_BASE_URL）

`gradle.properties`（またはコマンドライン `-P`、環境変数）で設定します。値は秘密情報ではありません。

| プロパティ | 用途 | 既定値 |
|---|---|---|
| `API_BASE_URL` | リリースビルドのAPI（`/api/v1` は自動で付与） | `https://example.com` |
| `API_BASE_URL_DEBUG` | デバッグビルドのAPI | `http://10.0.2.2:8080`（エミュレーターからホストPC） |
| `WEB_BASE_URL` / `WEB_BASE_URL_DEBUG` | スタッフ用Web画面を開くURL | `https://example.com` / `http://10.0.2.2:3000` |
| `APP_LINK_HOST` | App Links のドメイン | `example.com` |

例：`./gradlew assembleRelease -PAPI_BASE_URL=https://festival.example.jp -PAPP_LINK_HOST=festival.example.jp`

- 実機からPCのAPIへつなぐ場合は `API_BASE_URL_DEBUG=http://<PCのLAN IP>:8080` にし、
  `app/src/debug/res/xml/network_security_config.xml` にそのIPを追加してください（http を許可しているのはデバッグビルドの 10.0.2.2 / localhost のみ）。
- リリースビルドは http（平文通信）を一切許可しません。

## API との約束事

- すべての要求に `X-Requested-With: android`、`X-Client-Id`（端末内で生成したUUID）、`X-Client-Kind: android` を付けます。注文の `channel` は `"android"`。
- スタッフは `POST /auth/login` で得たトークンを `Authorization: Bearer` で送ります。トークンは EncryptedSharedPreferences に保存し、401 を受けたら破棄してログイン画面に戻します。
- `POST /public/orders`、`/public/reservations`、`/staff/checkin` には `Idempotency-Key` を付けます。キーは「1回の操作」ごとに作り、通信失敗・5xx・409・429 で再送するときは同じキーを使います（サーバーはこれらを記録しないため）。内容を変えたときや確定的なエラー後は新しいキーになります。
- エラーは `{"error":{"code","message"}}` の `message` をそのまま表示します。通信できないときは再試行ボタンを出します。
- リアルタイム更新は `GET /api/v1/events?topics=...`（SSE）。通知を受けたら（または再接続したら）最新状態をAPIで取り直します。あわせて定期取得も行い、各画面に「最終更新」と、古くなったときの警告を表示します。
- 現地確認コードは文字列のまま送り、先頭の0（例：007）を保持します。

## App Links（https://<ドメイン>/order/{部門ID}, /r/{token}, /c/{token}, /o/{token}）

1. `APP_LINK_HOST` を実際のドメインに設定してビルドします。
2. 署名証明書の SHA-256 フィンガープリントを確認します：
   `keytool -list -v -keystore <keystore> -alias <alias>`
   （Google Play アプリ署名を使う場合は Play Console の「アプリの完全性」に表示される値）
3. Web サーバーの `https://<ドメイン>/.well-known/assetlinks.json` に次を配置します（`Content-Type: application/json`、リダイレクトなし）。

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "jp.gakusai.portal",
      "sha256_cert_fingerprints": ["AA:BB:...:FF"]
    }
  }
]
```

デバッグビルドのパッケージ名は `jp.gakusai.portal.debug` です。検証したい場合は同じ配列に追加してください。
確認：`adb shell pm get-app-links jp.gakusai.portal`

アプリが入っていない端末では同じURLがWebで開くため、Web側にも同じパスの画面を用意してください。

## リリース署名（鍵はリポジトリに入れない）

署名情報は `~/.gradle/gradle.properties` または環境変数で渡します。指定がなければ未署名で出力されます。

```properties
RELEASE_STORE_FILE=/安全な場所/gakusai-release.jks
RELEASE_STORE_PASSWORD=********
RELEASE_KEY_ALIAS=gakusai
RELEASE_KEY_PASSWORD=********
```

```sh
./gradlew bundleRelease   # app/build/outputs/bundle/release/app-release.aab
```

`.jks` / `.keystore` / `local.properties` は `.gitignore` 済みです。CI では環境変数（同名）で渡してください。

## 構成

```
app/src/main/java/jp/gakusai/portal/
  GakusaiApp.kt / MainActivity.kt   アプリ・App Links の受け口
  data/Models.kt                    APIのJSONに対応するモデル（@SerialName で snake_case）
  data/ApiClient.kt                 OkHttp・エラー変換・Idempotency-Key・SSE
  data/Storage.kt                   端末ID、スタッフセッション、マイチケット、カート
  ui/AppNavHost.kt                  画面遷移
  ui/common/                        共通部品（エラー・最終更新・状態バッジ・QR生成）
  ui/visitor/                       来場者画面
  ui/staff/                         スタッフ画面（QR読取：CameraX + ML Kit）
```

## 既知の制限

- オフラインでの注文・予約・入場確定は行いません（仕様どおりオンライン前提）。
- 会計（入金・クーポン適用）、受け渡し、当日受付、管理機能はアプリに含めず、Webのスタッフ画面を開きます。
- Google Wallet には未対応です（予約画面のQRで入場できます）。
- 画面がバックグラウンドの間も、表示中の画面のSSE接続・定期取得は ViewModel が生きている限り続きます。
